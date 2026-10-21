import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext, TLSSocket, type ConnectionOptions } from "node:tls";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { openDatabase, type Database } from "./db.js";

const databases: Database[] = [];
let directory: string;
const file = (name: string) => join(directory, name);
const database = (url: string) => {
  const sql = openDatabase(url);
  databases.push(sql);
  return sql;
};

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "prentice-db-tls-"));
  // Disposable keys only. No production credentials or certificates are used.
  const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: directory, stdio: "pipe" });
  writeFileSync(file("ca.cnf"), "[req]\ndistinguished_name=dn\n[dn]\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n");
  for (const name of ["trusted", "other"]) {
    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.pem`, "-days", "2", "-subj", `/CN=Prentice ${name} test CA`, "-config", "ca.cnf", "-extensions", "ca");
  }
  openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=localhost");
  for (const name of ["valid", "mismatch", "expired"]) {
    writeFileSync(file(`${name}.cnf`), `[server]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${name === "mismatch" ? "DNS:wrong.example.test" : "DNS:localhost,IP:127.0.0.1"}\n`);
    if (name === "expired") {
      writeFileSync(file("index.txt"), "");
      writeFileSync(file("serial"), "03\n");
      writeFileSync(file("expired-ca.cnf"), "[ca]\ndefault_ca=local\n[local]\ndatabase=index.txt\nserial=serial\nnew_certs_dir=.\ncertificate=trusted.pem\nprivate_key=trusted.key\ndefault_md=sha256\npolicy=policy\nx509_extensions=server\n[policy]\ncommonName=supplied\n" + readFileSync(file("expired.cnf"), "utf8"));
      openssl("ca", "-batch", "-notext", "-config", "expired-ca.cnf", "-in", "server.csr", "-out", "expired.pem", "-startdate", "20000101000000Z", "-enddate", "20010101000000Z");
    } else {
      openssl("x509", "-req", "-in", "server.csr", "-CA", "trusted.pem", "-CAkey", "trusted.key", "-set_serial", name === "valid" ? "1" : "2", "-out", `${name}.pem`, "-days", "2", "-extfile", `${name}.cnf`, "-extensions", "server");
    }
  }
}, 20_000);

afterEach(async () => {
  await Promise.all(databases.splice(0).map(sql => sql.end({ timeout: 0 })));
  vi.unstubAllEnvs();
});
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

it.each(["disable", "prefer", "allow", "require", "verify-ca", "verify-full"])("cannot downgrade remote verification with sslmode=%s", mode => {
  vi.stubEnv("PRENTICE_DATABASE_CA_FILE", "");
  vi.stubEnv("PGSSL", "disable");
  const sql = database(`postgres://test:password@db.example.test/postgres?sslmode=${mode}`);
  expect(sql.options.ssl).toMatchObject({ rejectUnauthorized: true, servername: "db.example.test" });
  expect((sql.options.ssl as ConnectionOptions).ca).toBeUndefined();
  expect(sql.options.prepare).toBe(false);
  expect(sql.options.max).toBe(10);
});

it("retains plaintext loopback defaults for Docker development", () => {
  vi.stubEnv("PRENTICE_DATABASE_CA_FILE", "");
  for (const host of ["localhost", "127.0.0.1"]) {
    expect(database(`postgres://test:password@${host}/postgres`).options.ssl).toBe(false);
  }
  expect(database("postgres://test:password@localhost/postgres?sslmode=verify-full").options.ssl).toMatchObject({ rejectUnauthorized: true });
});

it("loads URL CA files itself rather than forwarding sslrootcert as a PostgreSQL parameter", () => {
  vi.stubEnv("PRENTICE_DATABASE_CA_FILE", "");
  const url = new URL("postgres://test:password@db.example.test/postgres?application_name=prentice-test");
  url.searchParams.set("sslrootcert", file("trusted.pem"));
  const sql = database(url.toString());
  expect((sql.options.ssl as ConnectionOptions).ca).toEqual(readFileSync(file("trusted.pem")));
  expect(sql.options.connection).not.toHaveProperty("sslrootcert");
  expect(sql.options.connection.application_name).toBe("prentice-test");
  expect(database("postgres://test:password@db.example.test/postgres?sslrootcert=system").options.ssl).toMatchObject({ rejectUnauthorized: true });
});

it("fails closed with sanitized configuration errors", () => {
  const secret = "do-not-print-this-secret";
  vi.stubEnv("PRENTICE_DATABASE_CA_FILE", file("missing.pem"));
  expect(() => database(`postgres://test:${secret}@db.example.test/postgres`)).toThrow("The database CA file must be readable and contain a PEM CA certificate.");
  writeFileSync(file("invalid.pem"), secret);
  vi.stubEnv("PRENTICE_DATABASE_CA_FILE", file("invalid.pem"));
  expect(() => database(`postgres://test:${secret}@db.example.test/postgres`)).toThrow("The database CA file must be readable and contain a PEM CA certificate.");
  expect(() => database(`invalid-${secret}`)).toThrow("DATABASE_URL must be a PostgreSQL URL with a single hostname.");
  expect(() => database("https://db.example.test/postgres")).toThrow("DATABASE_URL must be a PostgreSQL URL with a single hostname.");
  expect(() => database("postgres://test:password@db.example.test/postgres?sslrootcert=system")).toThrow("not conflicting values");
});

// A real PostgreSQL SSLRequest exchange and TLS handshake through the installed
// driver. After TLS, deliberately refuse authentication with a recognizable PG
// error: success means certificate verification completed BEFORE startup/auth.
async function tlsPostgres(certificate: string, acceptTls = true) {
  const context = createSecureContext({ key: readFileSync(file("server.key")), cert: readFileSync(file(`${certificate}.pem`)) });
  const sockets = new Set<Socket>();
  let startupReceived = false;
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", request => {
      if (!request.equals(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]))) return socket.destroy();
      if (!acceptTls) { socket.end("N"); return; }
      socket.write("S");
      const tls = new TLSSocket(socket, { isServer: true, secureContext: context });
      sockets.add(tls);
      tls.on("error", () => {});
      tls.on("close", () => sockets.delete(tls));
      tls.once("data", () => {
        startupReceived = true;
        const fields = Buffer.from("SERROR\0C28000\0MTLS test reached PostgreSQL\0\0");
        const length = Buffer.alloc(4);
        length.writeUInt32BE(fields.length + 4);
        tls.end(Buffer.concat([Buffer.from("E"), length, fields]));
      });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    port: (server.address() as { port: number }).port,
    startupReceived: () => startupReceived,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

it.each(["localhost", "127.0.0.1"])("accepts a trusted certificate matching %s through the PostgreSQL driver", async host => {
  vi.stubEnv("PRENTICE_DATABASE_CA_FILE", file("trusted.pem"));
  const server = await tlsPostgres("valid");
  try {
    const sql = database(`postgres://test:password@${host}:${server.port}/postgres?sslmode=require`);
    await expect(sql`select 1`).rejects.toMatchObject({ code: "28000", message: "TLS test reached PostgreSQL" });
    expect(server.startupReceived()).toBe(true);
  } finally { await server.close(); }
});

it.each([
  ["valid", "other.pem", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "localhost"],
  ["mismatch", "trusted.pem", "ERR_TLS_CERT_ALTNAME_INVALID", "localhost"],
  ["mismatch", "trusted.pem", "ERR_TLS_CERT_ALTNAME_INVALID", "127.0.0.1"],
  ["expired", "trusted.pem", "CERT_HAS_EXPIRED", "localhost"],
])("rejects %s certificate with %s before PostgreSQL startup (%s, %s)", async (certificate, ca, code, host) => {
  vi.stubEnv("PRENTICE_DATABASE_CA_FILE", file(ca));
  const server = await tlsPostgres(certificate);
  try {
    const sql = database(`postgres://test:password@${host}:${server.port}/postgres?sslmode=disable`);
    await expect(sql`select 1`).rejects.toMatchObject({ code });
    expect(server.startupReceived()).toBe(false);
  } finally { await server.close(); }
});

it("does not fall back to plaintext when the server refuses TLS", async () => {
  vi.stubEnv("PRENTICE_DATABASE_CA_FILE", file("trusted.pem"));
  const server = await tlsPostgres("valid", false);
  try {
    const sql = database(`postgres://test:password@localhost:${server.port}/postgres?sslmode=prefer`);
    await expect(sql`select 1`).rejects.toBeDefined();
    expect(server.startupReceived()).toBe(false);
  } finally { await server.close(); }
});

import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { checkServerIdentity, type ConnectionOptions } from "node:tls";
import postgres, { type Sql } from "postgres";

export type Database = Sql;

/** Transaction-mode pooler safe: prepared statements stay off. */
export function openDatabase(url: string): Database {
  let address: URL;
  try {
    address = new URL(url);
    if (!["postgres:", "postgresql:"].includes(address.protocol) || !address.hostname || address.hostname.includes(",")) throw new Error();
  } catch {
    // URL parser errors can contain the password-bearing input.
    throw new Error("DATABASE_URL must be a PostgreSQL URL with a single hostname.");
  }
  const host = address.hostname;
  const local = host === "127.0.0.1" || host === "localhost";
  const rootCert = address.searchParams.get("sslrootcert");
  const caFile = process.env.PRENTICE_DATABASE_CA_FILE?.trim() || undefined;
  if (caFile && rootCert && rootCert !== caFile) {
    throw new Error("Configure the database CA with either PRENTICE_DATABASE_CA_FILE or sslrootcert, not conflicting values.");
  }
  const caPath = caFile ?? (rootCert && rootCert !== "system" ? rootCert : undefined);
  const mode = address.searchParams.get("sslmode") ?? address.searchParams.get("ssl");
  // The driver otherwise forwards sslrootcert to PostgreSQL as a startup parameter.
  for (const name of ["sslrootcert", "sslmode", "ssl"]) address.searchParams.delete(name);
  const useTls = !local || Boolean(caPath || rootCert || (mode && mode !== "disable" && mode !== "false"));
  let ssl: ConnectionOptions | false = false;
  if (useTls) {
    let ca: Buffer | undefined;
    if (caPath) {
      try {
        ca = readFileSync(caPath);
        if (!ca.includes("-----BEGIN CERTIFICATE-----") || !new X509Certificate(ca).ca) throw new Error();
      } catch {
        // Never include file contents, credential-bearing URLs, or underlying errors.
        throw new Error("The database CA file must be readable and contain a PEM CA certificate.");
      }
    }
    ssl = {
      rejectUnauthorized: true,
      ...(ca ? { ca } : {}),
      ...(isIP(host) ? {} : { servername: host }),
      // Bind verification to DATABASE_URL even when the driver supplies a socket
      // without a DNS servername (for example, an IP-address connection).
      checkServerIdentity: (_servername, certificate) => checkServerIdentity(host, certificate),
    };
  }
  return postgres(address.toString(), {
    max: 10,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 15,
    ssl,
  });
}

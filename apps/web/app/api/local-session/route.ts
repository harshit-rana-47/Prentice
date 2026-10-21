import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export async function GET(request: Request) {
  const host = request.headers.get("host") ?? "";
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
    return Response.json({ error: { message: "The local session is only available on this machine." } }, { status: 403 });
  }
  const home = process.env.PRENTICE_HOME ?? join(homedir(), ".prentice");
  try {
    const parsed = JSON.parse(await readFile(join(home, "runtime.json"), "utf8")) as { token: string; port: number };
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) return Response.json({ error: { message: "Sign in to Prentice first." } }, { status: 401 });
    const runtimeUrl = `http://127.0.0.1:${parsed.port}`;
    const response = await fetch(`${runtimeUrl}/v1/local/activate`, {
      method: "POST", headers: { "content-type": "application/json", "x-prentice-bootstrap": parsed.token },
      body: JSON.stringify({ accessToken: authorization.slice(7) }), cache: "no-store",
    });
    if (!response.ok) return Response.json({ error: { message: "Prentice could not verify this account on the local connector." } }, { status: response.status });
    const activated = await response.json() as { token: string };
    return Response.json({ token: activated.token, runtimeUrl });
  } catch {
    return Response.json(
      { error: { message: "The Prentice runtime is not running. Start it with npm run dev from the repository root." } },
      { status: 503 },
    );
  }
}

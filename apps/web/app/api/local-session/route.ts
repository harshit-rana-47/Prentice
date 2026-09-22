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
    return Response.json({ token: parsed.token, runtimeUrl: `http://127.0.0.1:${parsed.port}` });
  } catch {
    return Response.json(
      { error: { message: "The Prentice runtime is not running. Start it with npm run dev from the repository root." } },
      { status: 503 },
    );
  }
}

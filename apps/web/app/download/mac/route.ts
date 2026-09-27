import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { join } from "node:path";

export async function GET() {
  const configured = process.env.PRENTICE_MAC_ZIP?.trim();
  const candidates = [configured, join(process.cwd(), "dist/Prentice-Mac.zip"), join(process.cwd(), "../../dist/Prentice-Mac.zip")].filter(
    (file): file is string => Boolean(file),
  );
  for (const file of candidates) {
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
      return new Response(stream, {
        headers: {
          "content-type": "application/zip",
          "content-length": String(info.size),
          "content-disposition": 'attachment; filename="Prentice-Mac.zip"',
        },
      });
    } catch {
      // Try the next location. The route never accepts a path from the request.
    }
  }
  return new Response("The Mac app is not packaged yet.", { status: 404 });
}

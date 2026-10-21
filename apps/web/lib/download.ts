import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

/**
 * Desktop app downloads. A hosted site redirects to PRENTICE_DOWNLOAD_BASE_URL (object storage, a CDN, or a
 * release page) and never serves the artifact from its own filesystem. Local development falls back to dist/.
 */
export async function downloadResponse(file: "Prentice-Mac.zip" | "Prentice-Windows.msi", envOverride?: string): Promise<Response> {
  const base = process.env.PRENTICE_DOWNLOAD_BASE_URL?.trim();
  if (base) {
    try {
      const target = new URL(file, base.endsWith("/") ? base : `${base}/`);
      if (target.username || target.password || (process.env.NODE_ENV === "production" && target.protocol !== "https:")) {
        return new Response("Downloads are not configured for this site yet.", { status: 404 });
      }
      return Response.redirect(target.toString(), 302);
    } catch {
      return new Response("Downloads are not configured for this site yet.", { status: 404 });
    }
  }
  if (process.env.NODE_ENV === "production") {
    return new Response("Downloads are not configured for this site yet.", { status: 404 });
  }
  const candidates = [envOverride?.trim(), join(process.cwd(), "dist", file), join(process.cwd(), "../../dist", file)].filter(
    (path): path is string => Boolean(path),
  );
  for (const path of candidates) {
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      const stream = Readable.toWeb(createReadStream(path)) as ReadableStream;
      return new Response(stream, {
        headers: {
          "content-type": file.endsWith(".msi") ? "application/x-msi" : "application/zip",
          "content-length": String(info.size),
          "content-disposition": `attachment; filename="${file}"`,
        },
      });
    } catch {
      // Try the next location. The route never accepts a path from the request.
    }
  }
  return new Response("The app is not packaged yet. Run npm run package:mac or npm run package:win.", { status: 404 });
}

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";

type DownloadFile = "Prentice-Mac.zip" | "Prentice-Windows.msi";

// Published, checksum-verified beta. Operators can override its asset directory.
const macBetaUrl = "https://github.com/harshit-rana-47/Prentice/releases/download/v0.1.0-beta.2/Prentice-Mac.zip";

export function publicDownloadUrl(file: DownloadFile): string | null {
  const base = process.env.PRENTICE_DOWNLOAD_BASE_URL?.trim();
  if (!base) return process.env.NODE_ENV === "production" && file === "Prentice-Mac.zip" ? macBetaUrl : null;
  try {
    const target = new URL(file, base.endsWith("/") ? base : `${base}/`);
    if (target.username || target.password || !["http:", "https:"].includes(target.protocol)
      || (process.env.NODE_ENV === "production" && target.protocol !== "https:")) return null;
    return target.toString();
  } catch {
    return null;
  }
}

/**
 * Desktop app downloads. A hosted site redirects to PRENTICE_DOWNLOAD_BASE_URL (object storage, a CDN, or a
 * release page) and never serves the artifact from its own filesystem. Local development falls back to dist/.
 */
export async function downloadResponse(file: DownloadFile, envOverride?: string): Promise<Response> {
  const base = process.env.PRENTICE_DOWNLOAD_BASE_URL?.trim();
  const target = publicDownloadUrl(file);
  if (target) return Response.redirect(target, 302);
  if (base || process.env.NODE_ENV === "production") {
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

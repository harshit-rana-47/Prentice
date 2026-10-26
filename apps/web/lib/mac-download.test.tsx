import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import MacDownloadPage from "../app/download/mac/page";
import { GET } from "../app/download/mac/file/route";

afterEach(() => vi.unstubAllEnvs());

it("offers the published Mac beta in production without dashboard configuration", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("PRENTICE_DOWNLOAD_BASE_URL", "");
  const html = renderToStaticMarkup(<MacDownloadPage />);
  expect(html).toContain("Unsigned beta");
  expect(html).toContain('href="/download/mac/file"');
  const response = await GET();
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("https://github.com/harshit-rana-47/Prentice/releases/download/v0.1.0-beta.4/Prentice-Mac.zip");
});

it("labels the unsigned beta and explains installation and pairing before download", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("PRENTICE_DOWNLOAD_BASE_URL", "https://downloads.example.test/beta/");
  const html = renderToStaticMarkup(<MacDownloadPage />);
  expect(html).toContain("Unsigned beta");
  expect(html).toContain("Open Anyway");
  expect(html).toContain('href="/download/mac/file"');
  expect(html).toContain('href="http://127.0.0.1:4732/"');
  const response = await GET();
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("https://downloads.example.test/beta/Prentice-Mac.zip");
});

it.each(["http://downloads.example.test", "file:///tmp/", "https://user:private@example.test", "not a URL"])("hides unsafe production Mac download configuration", async (base) => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("PRENTICE_DOWNLOAD_BASE_URL", base);
  const html = renderToStaticMarkup(<MacDownloadPage />);
  expect(html).toContain("The Mac beta is being prepared");
  expect(html).not.toContain('href="/download/mac/file"');
  expect(html).not.toContain("private@");
  expect((await GET()).status).toBe(404);
});

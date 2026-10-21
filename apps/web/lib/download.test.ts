import { afterEach, expect, it, vi } from "vitest";
import { GET } from "../app/download/windows/route";

afterEach(() => vi.unstubAllEnvs());
it.each(["http://downloads.example.test/", "not a URL", "https://user:secret@downloads.example.test/"])("rejects unsafe production download configuration: %s", async (base) => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("PRENTICE_WINDOWS_MSI_READY", "1");
  vi.stubEnv("PRENTICE_DOWNLOAD_BASE_URL", base);
  expect((await GET()).status).toBe(404);
});
it("keeps the Windows download disabled until installer validation is explicitly confirmed", async () => {
  vi.stubEnv("PRENTICE_WINDOWS_MSI_READY", "");
  vi.stubEnv("PRENTICE_DOWNLOAD_BASE_URL", "https://downloads.example.test/");
  expect((await GET()).status).toBe(404);
});
it("uses the MSI artifact and never the development ZIP after validation", async () => {
  vi.stubEnv("PRENTICE_WINDOWS_MSI_READY", "1");
  vi.stubEnv("PRENTICE_DOWNLOAD_BASE_URL", "https://downloads.example.test/releases");
  const result = await GET();
  expect(result.status).toBe(302);
  expect(result.headers.get("location")).toBe("https://downloads.example.test/releases/Prentice-Windows.msi");
});
it("does not distribute a local MSI from the production web server", async () => {
  vi.stubEnv("PRENTICE_WINDOWS_MSI_READY", "1");
  vi.stubEnv("PRENTICE_DOWNLOAD_BASE_URL", "");
  vi.stubEnv("PRENTICE_WINDOWS_MSI", "/private/tmp/local-candidate.msi");
  vi.stubEnv("NODE_ENV", "production");
  expect((await GET()).status).toBe(404);
});

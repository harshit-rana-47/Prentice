import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { cloudConfigFromEnv } from "./local-supabase.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn(() => 'API_URL="http://127.0.0.1:54321"\nSERVICE_ROLE_KEY="local-secret"\nANON_KEY="local-public"\nDB_URL="postgres://local"') }));
vi.mock("node:fs", () => ({ readFileSync: () => "" }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it("defaults to local Supabase even when a shell exports hosted credentials", () => {
  vi.stubEnv("PRENTICE_TEST_SUPABASE", "");
  for (const name of ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "SUPABASE_PUBLISHABLE_KEY", "DATABASE_URL", "API_URL", "SERVICE_ROLE_KEY", "ANON_KEY", "DB_URL"]) vi.stubEnv(name, "hosted-do-not-use");
  expect(cloudConfigFromEnv()).toEqual({ supabaseUrl: "http://127.0.0.1:54321", secretKey: "local-secret", publishableKey: "local-public", databaseUrl: "postgres://local" });
});

it("never falls back to Docker when hosted test configuration is incomplete", () => {
  vi.stubEnv("PRENTICE_TEST_SUPABASE", "hosted");
  vi.stubEnv("DATABASE_URL", "");
  expect(() => cloudConfigFromEnv()).toThrow("Tests need all four");
  expect(execFileSync).not.toHaveBeenCalled();
});

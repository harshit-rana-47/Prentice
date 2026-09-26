import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_GROQ_MODEL, readGroqConfig } from "./groq.js";

const originalKey = process.env.GROQ_API_KEY;
const originalModel = process.env.GROQ_MODEL;

afterEach(() => {
  if (originalKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalKey;
  if (originalModel === undefined) delete process.env.GROQ_MODEL;
  else process.env.GROQ_MODEL = originalModel;
});

describe("Groq configuration", () => {
  it("uses the default model and refuses to teach without a key", () => {
    delete process.env.GROQ_API_KEY;
    delete process.env.GROQ_MODEL;
    const missing = readGroqConfig();
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toMatch(/GROQ_API_KEY/);
    process.env.GROQ_API_KEY = "test-key";
    const configured = readGroqConfig();
    expect(configured.ok).toBe(true);
    if (configured.ok) expect(configured.config.model).toBe(DEFAULT_GROQ_MODEL);
    process.env.GROQ_MODEL = "openai/gpt-oss-20b";
    const override = readGroqConfig();
    if (override.ok) expect(override.config.model).toBe("openai/gpt-oss-20b");
  });
});
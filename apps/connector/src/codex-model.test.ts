import { describe, expect, it } from "vitest";
import { codexModelPlan, codexUnavailableSlug, type CodexCatalogModel } from "./codex-model.js";

const catalog: CodexCatalogModel[] = [
  { slug: "gpt-hidden", visibility: "hide", priority: 1 },
  { slug: "gpt-later", visibility: "list", priority: 8 },
  { slug: "gpt-first", visibility: "list", priority: 3 },
  { slug: "gpt-configured", visibility: "list", priority: 12 },
];

describe("Codex model attempts", () => {
  it("uses listed catalog models in priority order and does not consult a configured model", () => {
    expect(codexModelPlan(catalog)).toEqual({ selection: "automatic", models: ["gpt-first", "gpt-later", "gpt-configured"] });
  });

  it("keeps an explicit Prentice model separate from the catalog", () => {
    expect(codexModelPlan(catalog, "gpt-chosen")).toEqual({ selection: "explicit", models: ["gpt-chosen"] });
  });

  it("reads a model-unavailable failure and ignores other failures", () => {
    expect(codexUnavailableSlug("The model `gpt-5.5` does not exist or you do not have access to it.")).toBe("gpt-5.5");
    expect(codexUnavailableSlug("The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.")).toBe(
      "gpt-6-sol",
    );
    expect(codexUnavailableSlug("Codex reported a destructive command.")).toBeNull();
  });
});

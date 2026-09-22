import type { Intensity, ProviderCapabilities, ResolvedProfile } from "./types.js";

export type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type CodexEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

/**
 * Internal intensity is not a claim that every provider has the same knob.
 * `max` / ultra is never selected unless the user explicitly overrides.
 */
export function resolveProfile(
  capabilities: ProviderCapabilities,
  intensity: Intensity,
  useProviderMax = false,
): ResolvedProfile {
  if (capabilities.providerId === "fixture") {
    return {
      intensity,
      delegated: true,
      summary: "Fixture does not call a model. Intensity is recorded and not applied.",
      useProviderMax: false,
    };
  }

  if (capabilities.effortMapping === "native-effort" && capabilities.effortControl) {
    const effort = nativeEffort(intensity, useProviderMax);
    return {
      intensity,
      delegated: false,
      summary: useProviderMax
        ? "Provider maximum effort, because you explicitly requested it."
        : `Reasoning effort: ${effort}.`,
      useProviderMax,
    };
  }

  if (capabilities.effortMapping === "model-params") {
    return {
      intensity,
      delegated: false,
      summary: cursorProfileSummary(intensity),
      useProviderMax: false,
    };
  }

  return {
    intensity,
    delegated: true,
    summary: `${capabilities.displayName} chooses depth. Prentice did not set an effort control this provider does not expose.`,
    useProviderMax: false,
  };
}

export function nativeEffort(intensity: Intensity, useProviderMax: boolean): ClaudeEffort {
  if (useProviderMax) return "max";
  switch (intensity) {
    case "fast":
      return "low";
    case "balanced":
      return "medium";
    case "deep":
      return "high";
    case "maximum":
      return "xhigh";
  }
}

/** Codex uses a similar scale. `max` is not part of the Codex effort enum we send. */
export function codexEffort(intensity: Intensity, useProviderMax: boolean): CodexEffort {
  if (useProviderMax) return "xhigh";
  switch (intensity) {
    case "fast":
      return "low";
    case "balanced":
      return "medium";
    case "deep":
      return "high";
    case "maximum":
      return "xhigh";
  }
}

export type CursorDepthPreference = "fast" | "default" | "stronger";

export function cursorDepthPreference(intensity: Intensity): CursorDepthPreference {
  switch (intensity) {
    case "fast":
      return "fast";
    case "balanced":
      return "default";
    case "deep":
    case "maximum":
      return "stronger";
  }
}

function cursorProfileSummary(intensity: Intensity): string {
  const preference = cursorDepthPreference(intensity);
  if (preference === "fast") {
    return "Cursor fast mode when the selected model's catalog lists a fast param. Otherwise Cursor's default.";
  }
  if (preference === "default") {
    return "Cursor's default model selection. Effort is not a Cursor control.";
  }
  return "A stronger listed Cursor model when the catalog has one. If it does not, Cursor is choosing depth.";
}

export function nativeEffortLabel(effort: ClaudeEffort | CodexEffort): string {
  return `effort ${effort}`;
}

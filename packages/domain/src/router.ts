import { isRealProvider } from "./capabilities.js";
import { classifyTask } from "./classify.js";
import { resolveProfile } from "./intensity.js";
import type {
  ConnectedProvider,
  ProjectContext,
  ProviderId,
  RoutingDecision,
  RoutingOverride,
  RoutingPreferences,
  TaskClassification,
  TelemetryPrior,
} from "./types.js";

export const TELEMETRY_NOTE =
  "Telemetry is stored for later. It does not affect routing in this version.";

export function routeTask(input: {
  prompt: string;
  project: ProjectContext;
  connected: ConnectedProvider[];
  preferences?: RoutingPreferences;
  override?: RoutingOverride;
  telemetry?: TelemetryPrior;
  classification?: TaskClassification;
}): RoutingDecision {
  const connected = [...input.connected].sort((a, b) => a.connectionOrder - b.connectionOrder);
  if (connected.length === 0) {
    throw new Error("Connect a provider before routing a task.");
  }

  const classification = input.classification ?? classifyTask(input.prompt, input.project);
  const real = connected.filter((provider) => isRealProvider(provider.providerId));
  const pool = real.length > 0 ? real : connected;
  const recommended = recommend(pool, classification);
  const override = input.override;
  const pinned = input.preferences?.pinnedProviderId;
  let selected = recommended;
  let overridden = false;
  const why = [...classification.reasons];

  const overriddenProvider = override?.providerId
    ? connected.find((provider) => provider.providerId === override.providerId)
    : undefined;
  const pinnedProvider = pinned ? connected.find((provider) => provider.providerId === pinned) : undefined;

  if (overriddenProvider) {
    selected = overriddenProvider;
    overridden = true;
    why.unshift(`You chose ${selected.capabilities.displayName} instead of the recommendation.`);
  } else if (pinnedProvider) {
    selected = pinnedProvider;
    if (selected.providerId !== recommended.providerId) {
      why.unshift(`Your pin selects ${selected.capabilities.displayName}.`);
    }
  } else if (pool.length === 1) {
    why.push(`${selected.capabilities.displayName} is the only connected coding agent.`);
  } else {
    why.push(
      `${selected.capabilities.displayName} fits the capabilities this task needs. Ties use the provider you connected first.`,
    );
  }

  const intensity = override?.intensity ?? classification.intensity;
  if (override?.intensity && override.intensity !== classification.intensity) {
    overridden = true;
    why.unshift(`You set the execution profile to ${labelIntensity(intensity)}.`);
  }

  const profile = resolveProfile(selected.capabilities, intensity, override?.useProviderMax === true);
  if (profile.delegated) {
    why.push(profile.summary);
  } else {
    why.push(`Execution profile: ${labelIntensity(intensity)}. ${profile.summary}`);
  }

  if (!selected.capabilities.effortControl && intensity !== "fast" && selected.capabilities.effortMapping !== "model-params") {
    why.push(`${selected.capabilities.displayName} does not expose effort. Prentice did not pretend to set it.`);
  }

  return {
    providerId: selected.providerId,
    complexity: classification.complexity,
    intensity,
    profile,
    why,
    ambiguous: classification.ambiguous,
    signals: classification.signals,
    recommendedProviderId: recommended.providerId,
    overridden,
    telemetry: {
      recordedSamples: input.telemetry?.samples ?? 0,
      applied: false,
      reason: TELEMETRY_NOTE,
    },
  };
}

function recommend(pool: ConnectedProvider[], classification: TaskClassification): ConnectedProvider {
  const ranked = [...pool].sort((a, b) => {
    const delta = score(b, classification) - score(a, classification);
    if (delta !== 0) return delta;
    return a.connectionOrder - b.connectionOrder;
  });
  return ranked[0]!;
}

function score(provider: ConnectedProvider, classification: TaskClassification): number {
  const capabilities = provider.capabilities;
  let value = 0;
  if (capabilities.streaming) value += 1;
  if (capabilities.interruption) value += 1;
  const wantsEffort =
    classification.intensity === "deep" ||
    classification.intensity === "maximum" ||
    classification.signals.touchesArchitecture ||
    classification.complexity === "high";
  if (wantsEffort && capabilities.effortControl) value += 3;
  if (wantsEffort && capabilities.effortMapping === "model-params") value += 1;
  if (classification.signals.touchesTesting && capabilities.commandEvents) value += 1;
  if (
    capabilities.sessionContinuation &&
    (classification.signals.likelyFileScope === "many" || classification.complexity === "high")
  ) {
    value += 1;
  }
  return value;
}

export function labelIntensity(intensity: RoutingDecision["intensity"]): string {
  switch (intensity) {
    case "fast":
      return "Fast";
    case "balanced":
      return "Balanced";
    case "deep":
      return "Deep";
    case "maximum":
      return "Maximum";
  }
}

export function labelComplexity(complexity: RoutingDecision["complexity"]): string {
  switch (complexity) {
    case "low":
      return "Low";
    case "moderate":
      return "Moderate";
    case "high":
      return "High";
  }
}

export function providerDisplayName(id: ProviderId): string {
  switch (id) {
    case "claude-code":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
    case "fixture":
      return "Fixture";
  }
}

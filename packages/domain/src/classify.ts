import type {
  Complexity,
  Intensity,
  ProjectContext,
  TaskCategory,
  TaskClassification,
  TaskIntent,
  TaskSignals,
} from "./types.js";

const TECHNOLOGY_TERMS = [
  "react",
  "next.js",
  "nextjs",
  "vue",
  "postgres",
  "postgresql",
  "sqlite",
  "prisma",
  "drizzle",
  "redis",
  "oauth",
  "graphql",
  "docker",
  "kubernetes",
  "grpc",
  "tailwind",
  "supabase",
] as const;

const EMPTY_PROJECT: ProjectContext = {
  name: "project",
  topLevelDirs: [],
  dependencyNames: [],
  languages: [],
  hasTests: false,
  hasDatabase: false,
  hasAuth: false,
  filePaths: [],
};

export function classifyTask(prompt: string, project: ProjectContext = EMPTY_PROJECT): TaskClassification {
  const text = prompt.trim();
  const lower = text.toLowerCase();
  const namedPaths = namedPathsInPrompt(text, project.filePaths);
  const technologies = technologiesInPrompt(lower, project.dependencyNames);
  const categories = categoriesInPrompt(lower, namedPaths, project);
  const intent = intentInPrompt(lower);
  const touchesAuth = categories.includes("authentication");
  const touchesDatabase = categories.includes("database");
  const touchesArchitecture = categories.includes("architecture");
  const touchesTesting = categories.includes("testing");
  const likelyFileScope = fileScope(namedPaths, touchesArchitecture, touchesAuth, touchesDatabase);

  const signals: TaskSignals = {
    intent,
    categories: categories.length > 0 ? categories : ["general"],
    technologies,
    namedPaths,
    touchesArchitecture,
    touchesDatabase,
    touchesAuth,
    touchesTesting,
    likelyFileScope,
    promptWords: text.length === 0 ? 0 : text.split(/\s+/).length,
  };

  const reasons: string[] = [];
  let complexity = complexityFromSignals(signals);
  const ambiguous =
    categories.length === 0 &&
    namedPaths.length === 0 &&
    technologies.length === 0 &&
    (intent === "unknown" || intent === "modify");

  if (ambiguous) {
    reasons.push(
      "The prompt does not name a file, technology, or task category. Prentice kept this on a small profile. Override it if the work is larger.",
    );
  }

  if (touchesAuth && touchesDatabase) {
    reasons.push("The task mentions both authentication and database work.");
  } else if (touchesAuth) {
    reasons.push("The task mentions authentication.");
  } else if (touchesDatabase) {
    reasons.push("The task mentions database or schema work.");
  }
  if (touchesArchitecture) reasons.push("The task touches architecture or a migration of structure.");
  if (touchesTesting) reasons.push("The task includes tests.");
  if (namedPaths.length > 0) {
    reasons.push(
      namedPaths.length === 1
        ? `It names ${namedPaths[0]}.`
        : `It names ${namedPaths.length} files.`,
    );
  }
  if (technologies.length > 0) {
    reasons.push(`Technologies mentioned: ${technologies.join(", ")}.`);
  }
  if (project.hasAuth && namedPaths.some((path) => /auth|session|login/i.test(path))) {
    reasons.push("A named file sits in an existing auth area of this repo.");
  }
  if (signals.promptWords > 160 && complexity === "low") {
    reasons.push("The prompt is long. Length was not treated as complexity.");
  }
  if (reasons.length === 0) {
    reasons.push("No architecture, data, or auth signals. Treated as a small change.");
  }

  complexity = applyLengthAsMinorSignal(signals, complexity, reasons);

  return {
    complexity,
    intensity: intensityFor(complexity, lower),
    signals,
    ambiguous,
    reasons,
  };
}

function applyLengthAsMinorSignal(
  signals: TaskSignals,
  complexity: Complexity,
  reasons: string[],
): Complexity {
  const supported =
    signals.namedPaths.length > 0 && signals.technologies.length >= 2 && signals.promptWords > 180;
  if (complexity === "low" && supported) {
    reasons.push("Length contributed only because the prompt also names files and several technologies.");
    return "moderate";
  }
  return complexity;
}

function complexityFromSignals(signals: TaskSignals): Complexity {
  const structural = signals.touchesAuth || signals.touchesDatabase || signals.touchesArchitecture;
  const broad = signals.likelyFileScope === "many";
  if (
    (signals.touchesAuth && signals.touchesDatabase) ||
    (signals.touchesArchitecture && (signals.touchesAuth || signals.touchesDatabase || broad)) ||
    (signals.touchesAuth && signals.touchesTesting) ||
    (signals.touchesDatabase && broad)
  ) {
    return "high";
  }
  if (
    structural ||
    signals.touchesTesting ||
    signals.intent === "refactor" ||
    signals.likelyFileScope === "few"
  ) {
    return "moderate";
  }
  return "low";
}

function intensityFor(complexity: Complexity, lowerPrompt: string): Intensity {
  const asksForMaximum = /\b(maximum effort|as thorough as possible|deep review)\b/.test(lowerPrompt);
  if (asksForMaximum && complexity !== "low") return "maximum";
  if (complexity === "high") return "deep";
  if (complexity === "moderate") return "balanced";
  return "fast";
}

function categoriesInPrompt(lower: string, namedPaths: string[], project: ProjectContext): TaskCategory[] {
  const categories = new Set<TaskCategory>();
  if (/\b(auth|oauth|login|sign-in|signin|session|jwt|password|sso)\b/.test(lower)) {
    categories.add("authentication");
  }
  if (
    /\b(database|schema|migration|sql|postgres|postgresql|prisma|drizzle|table)\b/.test(lower) ||
    (project.hasDatabase && /\b(column|query|model)\b/.test(lower))
  ) {
    categories.add("database");
  }
  if (/\b(architecture|boundary|abstraction|redesign|event-driven|migrate the|migration)\b/.test(lower)) {
    categories.add("architecture");
  }
  if (/\b(test|spec|assert|coverage|playwright|vitest|jest)\b/.test(lower)) {
    categories.add("testing");
  }
  if (/\b(css|style|button|layout|tailwind|color|margin|padding)\b/.test(lower)) {
    categories.add("ui");
  }
  if (/\b(api|webhook|integration|third-party|sdk)\b/.test(lower)) {
    categories.add("integration");
  }
  if (namedPaths.some((path) => /auth|session|login/i.test(path))) categories.add("authentication");
  if (namedPaths.some((path) => /migrat|schema|prisma|drizzle/i.test(path))) categories.add("database");
  return [...categories];
}

function intentInPrompt(lower: string): TaskIntent {
  if (/\b(fix|bug|broken|failing|error)\b/.test(lower)) return "fix";
  if (/\brefactor\b/.test(lower)) return "refactor";
  if (/\b(test|spec)\b/.test(lower)) return "test";
  if (/\b(explain|why does|how does)\b/.test(lower)) return "explain";
  if (/\b(add|implement|create|build|introduce)\b/.test(lower)) return "create";
  if (/\b(update|change|edit|tweak|rename)\b/.test(lower)) return "modify";
  return "unknown";
}

function technologiesInPrompt(lower: string, dependencyNames: string[]): string[] {
  const found = new Set<string>();
  for (const term of TECHNOLOGY_TERMS) {
    if (lower.includes(term)) found.add(term);
  }
  for (const dependency of dependencyNames) {
    const name = dependency.toLowerCase();
    if (name.length >= 3 && lower.includes(name)) found.add(dependency);
  }
  return [...found];
}

function namedPathsInPrompt(prompt: string, filePaths: string[]): string[] {
  const found = new Set<string>();
  const inline = prompt.match(/`([^`]+\.[A-Za-z0-9]+)`/g) ?? [];
  for (const match of inline) {
    found.add(match.slice(1, -1).replace(/^\.\//, ""));
  }
  const bare = prompt.match(/(?:^|[\s"'`(])([A-Za-z0-9_@./-]+\.[A-Za-z0-9]+)(?=$|[\s"'`),])/g) ?? [];
  for (const match of bare) {
    const path = match.trim().replace(/^['"`(]/, "").replace(/^\.\//, "");
    if (!path.includes(" ")) found.add(path);
  }
  if (filePaths.length > 0) {
    const lower = prompt.toLowerCase();
    for (const path of filePaths) {
      const base = path.split("/").pop()?.toLowerCase();
      if (!base || base.length < 5) continue;
      if (lower.includes(path.toLowerCase()) || lower.includes(base)) found.add(path);
    }
  }
  return [...found];
}

function fileScope(
  namedPaths: string[],
  architecture: boolean,
  auth: boolean,
  database: boolean,
): TaskSignals["likelyFileScope"] {
  if (namedPaths.length >= 5) return "many";
  if (namedPaths.length >= 2) return "few";
  if (namedPaths.length === 1) return "one";
  if (architecture && (auth || database)) return "many";
  if (architecture || auth || database) return "unknown";
  return "one";
}

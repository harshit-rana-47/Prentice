import type { CommandOutput } from "./types.js";

/** Hard cap on stored failure output. The tail of a failed run is where the failure is reported. */
export const FAILURE_OUTPUT_MAX_CHARS = 4_000;
export const FAILURE_OUTPUT_MAX_LINES = 80;

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const SECRETS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*\S+/gi,
];

/**
 * Keeps only the tail of a failed command's output, inside a fixed size.
 * Returns undefined when there is nothing to keep. Never used for a command that succeeded.
 */
export function boundFailureOutput(raw: unknown): CommandOutput | undefined {
  if (typeof raw !== "string") return undefined;
  let text = raw.replace(ANSI, "").replace(/\r\n?/g, "\n");
  for (const pattern of SECRETS) text = text.replace(pattern, "[redacted]");
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return undefined;
  let truncated = false;
  const lines = text.split("\n");
  if (lines.length > FAILURE_OUTPUT_MAX_LINES) {
    text = lines.slice(-FAILURE_OUTPUT_MAX_LINES).join("\n");
    truncated = true;
  }
  if (text.length > FAILURE_OUTPUT_MAX_CHARS) {
    text = text.slice(-FAILURE_OUTPUT_MAX_CHARS);
    const firstBreak = text.indexOf("\n");
    if (firstBreak > 0 && firstBreak < 200) text = text.slice(firstBreak + 1);
    truncated = true;
  }
  return { source: "command-output", text, truncated };
}

/**
 * Reads a test runner's own summary line from recorded command output.
 * Returns null unless a known runner printed explicit pass and fail counts.
 */
export function parseTestSummary(output: string): { passed: number; failed: number } | null {
  const text = output.replace(ANSI, "");
  const nodeTest = { pass: /^#\s*pass\s+(\d+)\s*$/m.exec(text), fail: /^#\s*fail\s+(\d+)\s*$/m.exec(text) };
  if (nodeTest.pass && nodeTest.fail) return { passed: Number(nodeTest.pass[1]), failed: Number(nodeTest.fail[1]) };
  const vitest = /^\s*Tests\s+(?:(\d+)\s+failed)?\s*\|?\s*(?:(\d+)\s+passed)?/m.exec(text);
  if (vitest && (vitest[1] || vitest[2])) return { passed: Number(vitest[2] ?? 0), failed: Number(vitest[1] ?? 0) };
  const jest = /^Tests:\s+(?:(\d+)\s+failed,\s*)?(?:\d+\s+skipped,\s*)?(?:(\d+)\s+passed,\s*)?\d+\s+total/m.exec(text);
  if (jest && (jest[1] || jest[2])) return { passed: Number(jest[2] ?? 0), failed: Number(jest[1] ?? 0) };
  const pytest = /=+\s+(?:(\d+)\s+failed)?(?:,\s*)?(?:(\d+)\s+passed)?[^=\n]*\s+in\s+[\d.]+s\s*=+/m.exec(text);
  if (pytest && (pytest[1] || pytest[2])) return { passed: Number(pytest[2] ?? 0), failed: Number(pytest[1] ?? 0) };
  return null;
}

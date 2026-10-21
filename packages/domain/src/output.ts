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

/** Shared by persistence and outbound evidence. Scrub before truncation so a cut token cannot evade it. */
export function redactCredentials(raw: string): string {
  let text = raw.replace(ANSI, "");
  // Headers, including line folding and quoted bearer values.
  text = text.replace(/\b(?:authorization|proxy-authorization)\s*[=:]\s*(?:bearer|basic)\s+["']?[^\s"'\r\n]+["']?/gi, "Authorization: [redacted]");
  // Credential-bearing URLs (database, HTTP, Redis, etc.). Keep the host/protocol useful for diagnosis.
  text = text.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[redacted]@");
  // JSON, shell/env and diagnostic assignments. Quoted values may span whitespace/newlines.
  // Codex OAuth uses this boolean option; it is not an ID token or a credential.
  text = text.replace(/(?:["']?\b(?!id_token_add_organizations=(?:true|false)(?=[&#\s]|$))[\w.-]*(?:api[_-]?key|access[_-]?key|token|secret|password|passwd|credential)[\w.-]*["']?)\s*(?:=|:)\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;}&]+)/gi, "[redacted]");
  text = text.replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, "[redacted private key]");
  for (const pattern of SECRETS) text = text.replace(pattern, "[redacted]");
  return text;
}

/** Evidence contains JSON values only. This also protects old stored records when read back. */
export function scrubEvidence<T>(value: T): T {
  if (typeof value === "string") return redactCredentials(value) as T;
  if (Array.isArray(value)) return value.map((item) => scrubEvidence(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === "string" && /api[_-]?key|access[_-]?key|token|secret|password|passwd|credential|authorization/i.test(key) ? "[redacted]" : scrubEvidence(item)])) as T;
  }
  return value;
}

/**
 * Keeps only the tail of a failed command's output, inside a fixed size.
 * Returns undefined when there is nothing to keep. Never used for a command that succeeded.
 */
export function boundFailureOutput(raw: unknown): CommandOutput | undefined {
  if (typeof raw !== "string") return undefined;
  let text = redactCredentials(raw).replace(/\r\n?/g, "\n");
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

export function log(level: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ at: new Date().toISOString(), level, message, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

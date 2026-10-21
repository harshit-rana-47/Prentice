import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { migrate, openDatabase } from "./db.js";
import { Store } from "./store.js";
import { summaryForSync } from "./sync.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it("synchronizes bounded confirmed counts without prompt, path, command output or answer text", () => {
  const directory = mkdtempSync(join(tmpdir(), "prentice-sync-")); directories.push(directory);
  const db = openDatabase(join(directory, "record.db")); migrate(db);
  const store = new Store(db);
  const project = store.upsertProject("/Users/private/repository", "My project");
  const task = store.insertTask(project.id, "SECRET_PROMPT original request");
  store.updateTask(task.id, { status: "completed", finished_at: new Date().toISOString(), provider_id: "claude-code" });
  store.savePacket(task.id, { taskId: task.id, prompt: "SECRET_PROMPT", projectName: "My project", attribution: "available",
    files: [{ evidenceId: "f1", path: "src/SECRET_FILE.ts", change: "modified", additions: 2, deletions: 1 }],
    symbols: [], activity: [], tests: { evidenceId: "t1", passed: 2, failed: 0 }, unparsedFiles: [], unparsedLanguages: [] });
  const payload = summaryForSync(store);
  expect(payload.projects).toHaveLength(1);
  expect(payload.activity[0]).toMatchObject({ filesModified: 1, testsPassed: 2, testsFailed: 0, status: "completed" });
  const serialized = JSON.stringify(payload);
  for (const privateText of ["SECRET_PROMPT", "SECRET_FILE", "/Users/private", "prompt", "path", "answer", "output"]) expect(serialized).not.toContain(privateText);
});

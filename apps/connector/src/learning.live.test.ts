import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleUnderstand, type EvidencePacket, type RoutingDecision } from "@prentice/domain";
import { describe, expect, it } from "vitest";
import { migrate, openDatabase } from "./db.js";
import { loadConnectorEnv } from "./env.js";
import { explainEvidence } from "./learning.js";
import { answerExplain, beginExplain, discussTask } from "./session.js";
import { Store } from "./store.js";

loadConnectorEnv();
const live = process.env.PRENTICE_GROQ_LIVE === "1" && Boolean(process.env.GROQ_API_KEY?.trim());

describe.skipIf(!live)("Learning AI live", () => {
  it(
    "teaches from recorded evidence and remembers a demonstrated concept",
    async () => {
      const home = mkdtempSync(join(tmpdir(), "prentice-learn-"));
      const db = openDatabase(join(home, "prentice.db"));
      migrate(db);
      const store = new Store(db);
      const project = store.upsertProject("/tmp/prentice-learn-repo", "learn");
      const packet = evidence();
      const task = store.insertTask(project.id, "Add attachSessionNote");
      store.updateTask(task.id, { status: "completed", provider_id: "codex" });
      store.saveDecision(task.id, { complexity: "moderate" } as RoutingDecision);
      store.savePacket(task.id, packet);
      const artifact = await explainEvidence(packet, assembleUnderstand(packet));
      store.saveUnderstand(task.id, artifact);
      expect(artifact.learning?.available).toBe(true);
      expect(artifact.learning?.explanation ?? "").not.toMatch(/secrets\/other\.ts/);
      expect(artifact.observed.some((claim) => claim.text.includes("attachSessionNote"))).toBe(true);

      const started = await beginExplain(store, task.id);
      expect(started?.phase).toBe("asking");
      expect(started?.current?.prompt.toLowerCase()).not.toContain("attachsessionnote");

      const miss = await answerExplain(store, task.id, "I am not sure what changed.");
      expect(miss?.phase).toBe("asking");
      expect(miss?.hint?.toLowerCase() ?? "").not.toContain("attachsessionnote");
      expect(miss?.teaching).toBeNull();

      const taught = await answerExplain(store, task.id, "I still do not know.");
      expect(taught?.phase).toBe("taught");
      expect(taught?.teaching).toMatch(/attachSessionNote/);

      const general = await discussTask(store, task.id, "What is a function, in general?");
      expect(general?.discussion.at(-1)?.kind).toBe("general");

      const unknown = await discussTask(store, task.id, "Why did the agent change secrets/other.ts?");
      expect(unknown?.discussion.at(-1)?.kind).toBe("unrecorded");

      const remembered = store.insertTask(project.id, "Add another helper");
      store.updateTask(remembered.id, { status: "completed", provider_id: "codex" });
      store.saveDecision(remembered.id, { complexity: "moderate" } as RoutingDecision);
      store.savePacket(remembered.id, secondEvidence());
      store.demonstrate(project.id, "attachSessionNote");
      const second = await beginExplain(store, remembered.id);
      expect(second?.current?.prompt.toLowerCase()).toContain("format-note.ts");
      expect(second?.current?.prompt.toLowerCase()).not.toContain("attachsessionnote");
      expect(second?.current?.prompt.toLowerCase()).not.toContain("session-note");
    },
    120_000,
  );
});

function evidence(): EvidencePacket {
  return {
    taskId: "task",
    prompt: "Add a session note helper",
    projectName: "learn",
    files: [{ evidenceId: "file-1", path: "src/session-note.ts", change: "added", additions: 4, deletions: 0 }],
    symbols: [
      { evidenceId: "sym-1", path: "src/session-note.ts", name: "attachSessionNote", kind: "function", change: "added" },
    ],
    activity: [
      {
        evidenceId: "cmd-1",
        kind: "command.finished",
        title: "Command finished",
        command: "npm test",
        exitCode: 1,
        detail: "1 failed",
        source: "agent",
      },
    ],
    tests: null,
    unparsedLanguages: [],
    unparsedFiles: [],
  };
}

function secondEvidence(): EvidencePacket {
  return {
    ...evidence(),
    taskId: "task-2",
    symbols: [
      ...evidence().symbols,
      { evidenceId: "sym-2", path: "src/format-note.ts", name: "formatNote", kind: "function", change: "added" },
    ],
    files: [
      ...evidence().files,
      { evidenceId: "file-2", path: "src/format-note.ts", change: "added", additions: 2, deletions: 0 },
    ],
  };
}

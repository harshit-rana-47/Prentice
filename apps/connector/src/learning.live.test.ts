import { assembleUnderstand, type EvidencePacket, type RoutingDecision } from "@prentice/domain";
import { describe, expect, it } from "vitest";
import { migrate, openDatabase } from "./db.js";
import { loadConnectorEnv } from "./env.js";
import { explainEvidence, setLearningEndpoint } from "./learning.js";
import { answerExplain, beginExplain } from "./session.js";
import { Store } from "./store.js";
loadConnectorEnv();
const cloudUrl = process.env.PRENTICE_CLOUD_URL?.trim() ?? "";
const deviceToken = process.env.PRENTICE_DEVICE_TOKEN?.trim() ?? "";
const live = process.env.PRENTICE_GROQ_LIVE === "1" && Boolean(cloudUrl && deviceToken);

describe.skipIf(!live)("Learning AI live", () => {
  it("teaches a concept, rejects naming trivia, and avoids a repeated mastered check", async () => {
    setLearningEndpoint({cloudUrl,token:deviceToken});
    try {
      const db=openDatabase(":memory:");migrate(db);const store=new Store(db);
      const project=store.upsertProject("/tmp/prentice-learning-fixture","Synthetic learning fixture");
      const task=store.insertTask(project.id,"Add a small validation helper");
      store.updateTask(task.id,{status:"completed",provider_id:"codex"});
      store.saveDecision(task.id,{complexity:"low"} as RoutingDecision);
      const packet: EvidencePacket={taskId:task.id,prompt:task.prompt,projectName:"synthetic",files:[{evidenceId:"file",path:"validation.js",change:"added",additions:6,deletions:0}],symbols:[{evidenceId:"symbol",path:"validation.js",name:"validateName",kind:"function",change:"added"}],implementation:[{evidenceId:"throw",path:"validation.js",operation:"throw statement",change:"added"}],activity:[{evidenceId:"agent",title:"Agent",kind:"assistant",source:"agent",detail:"I added validation before saving a name. It rejects non-string or blank values and leaves the existing state unchanged when validation fails."}],tests:null,unparsedLanguages:[],unparsedFiles:[]};
      store.savePacket(task.id,packet);
      const artifact=await explainEvidence(packet,assembleUnderstand(packet));
      store.saveUnderstand(task.id,artifact);
      expect(artifact.learning?.concepts).toHaveLength(1);
      const start=await beginExplain(store,task.id);
      expect(start?.current?.grounding).toBe("inference");
      expect(start?.current?.prompt).not.toMatch(/which.*function|name.*file/i);
      const miss=await answerExplain(store,task.id,"validateName was added in validation.js");
      expect(miss?.feedback.understood).toEqual([]);
      expect(miss?.phase).toBe("asking");
      const taught=await answerExplain(store,task.id,"Validation should save the value before any checks happen.");
      expect(taught?.phase).toBe("taught");
      expect(taught?.teaching?.length).toBeGreaterThan(100);
      const concept=artifact.learning!.concepts![0]!;
      store.demonstrate(project.id,concept.title);
      const next=store.insertTask(project.id,task.prompt);
      store.updateTask(next.id,{status:"completed",provider_id:"codex"});
      store.saveDecision(next.id,{complexity:"low"} as RoutingDecision);
      store.savePacket(next.id,{...packet,taskId:next.id});
      store.saveUnderstand(next.id,artifact);
      expect((await beginExplain(store,next.id))?.current).toBeNull();
    } finally {setLearningEndpoint(null);}
  },120_000);
});

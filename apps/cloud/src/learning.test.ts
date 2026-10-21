// Legacy-path regressions; semantic-tutor tests exercise the default independent-review path.
process.env.GROQ_REVIEW_MODEL="disabled";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudStore } from "./store.js";
import { createHttpApp, LEARNING_RATE } from "./http.js";

const originalKey = process.env.GROQ_API_KEY;
const originalFetch = globalThis.fetch;
// These tests isolate generation/structural checks; approval is a fixture,
// not evidence of actual model technical correctness.
const approved = { checks: { technical: true, evidence: true, consistency: true, assessment: true }, issues: [] };
function reviewedMock(generate: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body ?? "{}"));
    if (request.messages?.[0]?.content.startsWith("You are Prentice's technical teaching reviewer.")) {
      return Response.json({ choices: [{ message: { content: JSON.stringify(approved) } }] });
    }
    return generate(url, init);
  });
}

afterEach(() => {
  if (originalKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalKey;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Learning AI on the cloud", () => {
  it("calls Groq for a paired computer and does not return the key", async () => {
    process.env.GROQ_API_KEY = "cloud-key";
    globalThis.fetch = reviewedMock(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.groq.com/openai/v1/chat/completions");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer cloud-key");
      const sent = JSON.parse(String(init?.body));
      expect(sent.messages[1].content).toContain("src/note.ts");
      return Response.json({ choices: [{ message: { content: JSON.stringify({ explanation: "Git added src/note.ts." }) } }] });
    }) as typeof fetch;
    const app = createHttpApp(storeFor("device-token"));
    const response = await app.request("/v1/learning", {
      method: "POST",
      headers: { authorization: "Bearer device-token", "content-type": "application/json" },
      body: JSON.stringify({ action: "explain", evidence: { files: [{ path: "src/note.ts" }] } }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { explanation: string } };
    expect(body.result.explanation).toContain("src/note.ts");
    expect(JSON.stringify(body)).not.toContain("cloud-key");
  });

  it("refuses a caller that is not a paired computer", async () => {
    process.env.GROQ_API_KEY = "cloud-key";
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
    const app = createHttpApp(storeFor("device-token"));
    const response = await app.request("/v1/learning", {
      method: "POST",
      headers: { authorization: "Bearer someone-else", "content-type": "application/json" },
      body: JSON.stringify({ action: "explain", evidence: { files: [] } }),
    });
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call Groq when Prentice has no key", async () => {
    delete process.env.GROQ_API_KEY;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
    const app = createHttpApp(storeFor("device-token"));
    const response = await app.request("/v1/learning", {
      method: "POST",
      headers: { authorization: "Bearer device-token", "content-type": "application/json" },
      body: JSON.stringify({ action: "explain", evidence: { files: [] } }),
    });
    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toMatch(/GROQ_API_KEY/);
  });
});

describe("Learning AI access", () => {
  it("accepts the per-run development token only when the server was given one", async () => {
    process.env.GROQ_API_KEY = "cloud-key";
    globalThis.fetch = reviewedMock(async () => Response.json({ choices: [{ message: { content: "{\"observed\":[]}" } }] })) as typeof fetch;
    const body = JSON.stringify({ action: "explain", evidence: { observed: {}, agentStated: [] } });
    const headers = { authorization: "Bearer dev-run-token", "content-type": "application/json" };
    expect((await createHttpApp(storeFor("device-token")).request("/v1/learning", { method: "POST", headers, body })).status).toBe(401);
    const dev = createHttpApp(storeFor("device-token"), { devLearningToken: "dev-run-token" });
    expect((await dev.request("/v1/learning", { method: "POST", headers, body })).status).toBe(200);
  });

  it("answers 503, not 401, when the device lookup itself fails", async () => {
    const failing = { deviceForToken: async () => Promise.reject(new Error("db down")) } as unknown as CloudStore;
    const response = await createHttpApp(failing).request("/v1/learning", {
      method: "POST",
      headers: { authorization: "Bearer device-token", "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(503);
  });

  it("rate-limits one computer without calling Groq past the limit", async () => {
    process.env.GROQ_API_KEY = "cloud-key";
    const fetchMock = reviewedMock(async () => Response.json({ choices: [{ message: { content: "{\"observed\":[]}" } }] }));
    globalThis.fetch = fetchMock as typeof fetch;
    const app = createHttpApp(storeFor("device-token"));
    const call = () =>
      app.request("/v1/learning", {
        method: "POST",
        headers: { authorization: "Bearer device-token", "content-type": "application/json" },
        body: JSON.stringify({ action: "explain", evidence: { observed: {} } }),
      });
    for (let index = 0; index < LEARNING_RATE.limit; index += 1) expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(LEARNING_RATE.limit * 2);
  });
});

function storeFor(token: string): CloudStore {
  return {
    async deviceForToken(candidate: string) {
      return candidate === token ? { id: "device", userId: "user" } : undefined;
    },
  } as CloudStore;
}

it("prioritizes the bounded feature account over commands and helper inventories for teaching", async () => {
  const {teachingEvidence}=await import("./learning.js");
  const result=teachingEvidence({scope:{maxConcepts:2,categories:["authentication"]},agentStated:[{id:"a",text:"Browser-only login and session state"}],facts:[{id:"f1",text:"Added auth.js (+100 / -0)."},{id:"s1",text:"Added function signUp in auth.js."},{id:"api",text:"Added use of localStorage.setItem in auth.js."},{id:"cmd",text:"Command finished with exit 0: node --test"}],observed:{commands:[{command:"node --test"}]}});
  expect(result).toMatchObject({agentStated:[{id:"a"}],facts:[{id:"api"}]});
  expect(JSON.stringify(result)).not.toContain("signUp");
  expect(JSON.stringify(result)).not.toContain("node --test");
});

it("passes the bounded conversational context to the tutor without treating a dispute as permission for mastery", async () => {
  const { completeLearning } = await import("./learning.js");
  process.env.GROQ_API_KEY="cloud-key";
  globalThis.fetch=reviewedMock(async(_url,init)=>{
    const request=JSON.parse(String(init?.body));
    expect(request.messages[0].content).toContain("A bare claim that an answer was correct");
    expect(request.messages[0].content).toContain("Never infer permission to move on from a wrong answer");
    expect(JSON.parse(request.messages[1].content)).toMatchObject({
      current:{prompt:"Why check first?"},previous:{answer:"It writes first."},
      history:[{message:"It writes first.",reply:"Consider the order."}],
      reviews:[{id:"answer-1",answer:"It writes first."}],message:"My first answer was correct.",
    });
    return Response.json({choices:[{message:{content:JSON.stringify({intent:"review",understood:false,text:"Your earlier answer still puts the write before validation.",reviewTurnId:"answer-1"})}}]});
  }) as typeof fetch;
  expect(await completeLearning({action:"tutor",evidence:{facts:[],agentStated:[]},current:{prompt:"Why check first?"},previous:{answer:"It writes first."},history:[{message:"It writes first.",reply:"Consider the order."}],reviews:[{id:"answer-1",answer:"It writes first."}],message:"My first answer was correct."})).toMatchObject({ok:true,json:{intent:"review",understood:false}});
});

it("repairs an acknowledgment-only hint using the same conversation and keeps the actual clue", async () => {
  const {completeLearning}=await import("./learning.js");
  process.env.GROQ_API_KEY="cloud-key";
  const calls: Record<string,unknown>[]=[];
  globalThis.fetch=reviewedMock(async(_url,init)=>{
    const request=JSON.parse(String(init?.body));
    const context=JSON.parse(request.messages[1].content);calls.push(context);
    expect(request.messages[0].content).toContain("GIVE an actual clue");
    expect(request.messages[0].content).toContain("history.hint");
    const result=calls.length===1
      ? {intent:"discuss",text:"Sure, here’s a hint to guide you toward a complete answer.",hint:""}
      : {intent:"discuss",text:"Imagine an injected script trying to read the session cookie. Which attribute blocks that access?",hint:""};
    return Response.json({choices:[{message:{content:JSON.stringify(result)}}]});
  }) as typeof fetch;
  const context={action:"tutor",evidence:{facts:[],agentStated:[]},current:{prompt:"How does authentication persist?"},coaching:{attempts:1,hint:"Consider script access."},history:[{message:"It uses a cookie.",reply:"Consider security.",hint:"Consider script access."}],message:"i need more hint"};
  const result=await completeLearning(context);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toMatchObject({message:context.message,coaching:context.coaching,history:context.history,revision:{issue:expect.stringContaining("conceptual help")}});
  expect(result).toMatchObject({ok:true,json:{text:expect.stringContaining("injected script")}});
});

it("accepts a concrete clue in the separate hint field and short substantive replies without a repair", async () => {
  const {completeLearning}=await import("./learning.js");
  process.env.GROQ_API_KEY="cloud-key";
  for(const reply of [
    {intent:"discuss",text:"Sure, here's a hint.",hint:"Which cookie attribute stops a script from reading the cookie?"},
    {intent:"discuss",text:"HttpOnly blocks JavaScript from reading the cookie.",hint:""},
    {intent:"discuss",text:"ब्राउज़र कुकी को अनुरोध के साथ भेजता है।",hint:""},
  ]) {
    const call=reviewedMock(async()=>Response.json({choices:[{message:{content:JSON.stringify(reply)}}]}));globalThis.fetch=call as typeof fetch;
    expect(await completeLearning({action:"tutor",evidence:{facts:[],agentStated:[]},message:"another hint"})).toMatchObject({ok:true,json:{...reply,text:expect.stringContaining(reply.text),support:{kind:"provisional"}}});
    expect(call).toHaveBeenCalledTimes(2);
  }
});

it("repairs verbatim repetition and does not accept a second non-answer", async () => {
  const {completeLearning}=await import("./learning.js");process.env.GROQ_API_KEY="cloud-key";
  const reply={intent:"discuss",text:"Which operation runs first?",hint:""};
  const call=reviewedMock(async()=>Response.json({choices:[{message:{content:JSON.stringify(reply)}}]}));globalThis.fetch=call as typeof fetch;
  const result=await completeLearning({action:"tutor",evidence:{facts:[],agentStated:[]},history:[{reply:reply.text}],message:"I still don't understand. Show an example."});
  expect(result.ok).toBe(false);expect(call).toHaveBeenCalledTimes(2);
});

it("does not start a repair after the overall tutor deadline is exhausted", async () => {
  const {completeLearning}=await import("./learning.js");process.env.GROQ_API_KEY="cloud-key";
  const call=reviewedMock(async()=>Response.json({choices:[{message:{content:JSON.stringify({intent:"discuss",text:"Sure, here's a hint.",hint:""})}}]}));globalThis.fetch=call as typeof fetch;
  vi.spyOn(Date,"now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValueOnce(29_999);
  expect(await completeLearning({action:"tutor",evidence:{facts:[],agentStated:[]},message:"a hint please"})).toMatchObject({ok:false});
  expect(call).toHaveBeenCalledTimes(1);
});

it("repairs accidental advancement on a help request instead of returning a canned question repeat", async () => {
  const {completeLearning}=await import("./learning.js");process.env.GROQ_API_KEY="cloud-key";
  let count=0;
  globalThis.fetch=reviewedMock(async()=>Response.json({choices:[{message:{content:JSON.stringify(++count===1
    ? {intent:"continue",text:"Let's move on."}
    : {intent:"discuss",text:"Imagine an invalid value entering the check. Does the failure branch reach the write?",hint:""})}}]})) as typeof fetch;
  expect(await completeLearning({action:"tutor",evidence:{facts:[],agentStated:[]},message:"I am not ready to move on. Another hint please."})).toMatchObject({ok:true,json:{intent:"discuss",text:expect.stringContaining("failure branch")}});
  expect(count).toBe(2);
});

it("allows the learner to ask for an earlier explanation to be repeated", async () => {
  const {completeLearning}=await import("./learning.js");process.env.GROQ_API_KEY="cloud-key";
  const reply={intent:"discuss",text:"HttpOnly blocks JavaScript from reading the cookie.",hint:""};
  const call=reviewedMock(async()=>Response.json({choices:[{message:{content:JSON.stringify(reply)}}]}));globalThis.fetch=call as typeof fetch;
  expect(await completeLearning({action:"tutor",evidence:{facts:[],agentStated:[]},history:[{reply:reply.text}],message:"Please repeat that explanation."})).toMatchObject({ok:true});
  expect(call).toHaveBeenCalledTimes(2);
});

it('repairs help being misclassified as an answer and teaching that demands the original question again',async()=>{
 const {completeLearning}=await import('./learning.js');process.env.GROQ_API_KEY='cloud-key';
 for(const defective of [
   {intent:'answer',understood:false,text:'You have not explained the causal relationship.'},
   {intent:'teach',text:'Validation protects state. Why validate before writing?'},
 ]){
   let calls=0;globalThis.fetch=reviewedMock(async()=>Response.json({choices:[{message:{content:JSON.stringify(++calls===1?defective:{intent:'teach',text:'A rejected value stops before the write. The old value survives because the write cannot run. We can explore an example or you can choose to practise.'})}}]})) as typeof fetch;
   expect(await completeLearning({action:'tutor',evidence:{facts:[],agentStated:[]},current:{prompt:'Why validate before writing?'},message:'Please explain it directly.'})).toMatchObject({ok:true,json:{intent:'teach'}});
   expect(calls).toBe(2);
 }
});

it('returns a typed recoverable consistency failure through HTTP without releasing the rejected draft',async()=>{
 process.env.GROQ_API_KEY='cloud-key';
 globalThis.fetch=vi.fn(async(_url,init)=>{
  const request=JSON.parse(String(init?.body));
  const review=request.messages[0].content.startsWith("You are Prentice's technical teaching reviewer.");
  const result=review?{checks:{technical:false,evidence:false,consistency:false,assessment:true},issues:[{claim:'OUTBOX FALSE GUARANTEE',basis:'general',reason:'A local transaction cannot encompass an external charge.'}]}:{intent:'teach',text:'OUTBOX FALSE GUARANTEE',hint:''};
  return Response.json({choices:[{message:{content:JSON.stringify(result)}}]});
 }) as typeof fetch;
 const response=await createHttpApp(storeFor('device-token')).request('/v1/learning',{method:'POST',headers:{authorization:'Bearer device-token','content-type':'application/json'},body:JSON.stringify({action:'tutor',evidence:{facts:[],agentStated:[]},message:'Explain a linked list.'})});
 expect(response.status).toBe(503);const body=await response.json();expect(body).toMatchObject({error:{code:'TEACHING_UNRELIABLE',retryable:true}});
 expect(JSON.stringify(body)).not.toContain('OUTBOX FALSE GUARANTEE');
});


it("repairs a draft whose provisional notice would push its displayed ending past the limit", async()=>{
 const {completeLearning}=await import("./learning.js");process.env.GROQ_API_KEY="synthetic";
 let calls=0;globalThis.fetch=reviewedMock(async()=>Response.json({choices:[{message:{content:JSON.stringify(++calls===1?{intent:"teach",text:"x".repeat(5990),hint:""}:{intent:"teach",text:"Here is the bounded explanation with its assumption intact.",hint:""})}}]})) as typeof fetch;
 const result=await completeLearning({action:"tutor",evidence:{facts:[],agentStated:[]},message:"Explain virtual nodes."});
 expect(result).toMatchObject({ok:true,json:{support:{kind:"provisional"},text:expect.stringContaining("assumption intact")}});
 expect((result as any).json.text.length).toBeLessThanOrEqual(6000);expect(calls).toBe(2);
});

import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { RELAY_CLOSE, type Frame } from "@prentice/protocol";
import { afterEach, expect, it } from "vitest";
import { FrameRelay } from "./relay.js";
const cleanups: Array<()=>Promise<void>>=[];
afterEach(async()=>{ for(const close of cleanups.splice(0).reverse()) await close(); });
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function harness(requestTimeoutMs = 50) {
  const state={ authorized:true, temporary:false, device:true, authDelayMs:0 };
  const relay=new FrameRelay({
    deviceForToken:async()=>state.device?{id:"d",userId:"u"}:undefined,
    userForSession:async()=>{await pause(state.authDelayMs);if(state.temporary)throw new Error("auth offline");return state.authorized?{id:"u",email:"u@example.test"}:undefined;},
    deviceForUser:async()=>state.device?{id:"d",userId:"u",name:"Computer",pairedAt:"",revokedAt:null}:undefined,
  },requestTimeoutMs);
  const server=createServer();const wss=new WebSocketServer({server});
  wss.on("connection",(socket,request)=>relay.attach(socket,request.url==="/connector"?"connector":"browser"));
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const port=(server.address() as {port:number}).port;
  cleanups.push(async()=>{ for(const socket of wss.clients)socket.terminate();await new Promise<void>(resolve=>wss.close(()=>resolve()));await new Promise<void>(resolve=>server.close(()=>resolve())); });
  async function connect(role:"connector"|"browser") {
    const socket=new WebSocket(`ws://127.0.0.1:${port}/${role}`);
    await new Promise<void>(resolve=>socket.once("open",()=>resolve()));
    socket.send(JSON.stringify(role==="connector"?{kind:"auth",role,token:"device"}:{kind:"auth",role,token:"session",deviceId:"d"}));
    if(role==="browser")await frame(socket);else await pause(20);
    return socket;
  }
  return {state,relay,connect,wss};
}
function frame(socket:WebSocket):Promise<Frame>{return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("frame timeout")),2000);socket.once("message",data=>{clearTimeout(timer);resolve(JSON.parse(String(data)));});});}
function closed(socket:WebSocket){return new Promise<number>(resolve=>socket.once("close",code=>resolve(code)));}
it("revalidates revoked/expired browser sessions and distinguishes temporary auth failure",async()=>{
  for(const temporary of [false,true]) {
    const h=await harness();await h.connect("connector");const browser=await h.connect("browser");
    const done=closed(browser);h.state.authorized=false;h.state.temporary=temporary;
    browser.send(JSON.stringify({kind:"request",id:"r",method:"workspace.get"}));
    expect(await done).toBe(temporary?RELAY_CLOSE.TEMPORARY:RELAY_CLOSE.SESSION_EXPIRED);
  }
});
it("supersedes the old connector, rejects it, and revokes the active connector",async()=>{
  const h=await harness();const old=await h.connect("connector");const done=closed(old);
  const current=await h.connect("connector");expect(await done).toBe(RELAY_CLOSE.SUPERSEDED);
  const revoked=closed(current);h.relay.disconnect("d");expect(await revoked).toBe(RELAY_CLOSE.REVOKED);
});
it("routes colliding browser request IDs individually and times out unanswered requests",async()=>{
  // Allow ordinary scheduling under parallel build/typecheck load. The timeout
  // assertion below still uses a real unanswered request; routing awaits frames.
  const h=await harness(500);const connector=await h.connect("connector");const a=await h.connect("browser");const b=await h.connect("browser");
  const incoming:Frame[]=[];
  const routed=new Promise<void>(resolve=>connector.on("message",data=>{incoming.push(JSON.parse(String(data)));if(incoming.length===2)resolve();}));
  const first=frame(a),second=frame(b);
  a.send(JSON.stringify({kind:"request",id:"same",method:"workspace.get"}));b.send(JSON.stringify({kind:"request",id:"same",method:"workspace.get"}));
  await routed;expect(incoming).toHaveLength(2);expect((incoming[0] as {id:string}).id).not.toBe((incoming[1] as {id:string}).id);
  connector.send(JSON.stringify({kind:"response",id:(incoming[0] as {id:string}).id,ok:true,status:200,body:{only:"a"}}));
  connector.send(JSON.stringify({kind:"response",id:(incoming[1] as {id:string}).id,ok:true,status:200,body:{only:"b"}}));
  expect(await first).toMatchObject({id:"same",body:{only:"a"}});expect(await second).toMatchObject({id:"same",body:{only:"b"}});
  const timeout=frame(a);a.send(JSON.stringify({kind:"request",id:"timeout",method:"workspace.get"}));
  expect(await timeout).toMatchObject({id:"timeout",ok:false,status:504});
});
it("keeps a shared task subscription after one tab unwatches and signs out browsers without revoking the connector",async()=>{
  const h=await harness();const connector=await h.connect("connector");const a=await h.connect("browser");const b=await h.connect("browser");
  const requests:Frame[]=[];connector.on("message",data=>{
    const request=JSON.parse(String(data)) as Frame;requests.push(request);
    if(request.kind==="request"&&request.method==="tasks.events")connector.send(JSON.stringify({kind:"response",id:request.id,ok:true,status:200,body:{subscribed:true}}));
  });
  for(const browser of [a,b]){
    const subscribed=frame(browser);
    browser.send(JSON.stringify({kind:"request",id:"watch",method:"tasks.events",params:{taskId:"t"}}));
    expect(await subscribed).toMatchObject({kind:"response",id:"watch",ok:true});
  }
  const unwatch=frame(a);a.send(JSON.stringify({kind:"request",id:"unwatch",method:"tasks.unwatch",params:{taskId:"t"}}));await unwatch;
  expect(requests.filter(f=>f.kind==="request"&&f.method==="tasks.unwatch")).toHaveLength(0);
  const update=frame(b);connector.send(JSON.stringify({kind:"event",method:"tasks.events",taskId:"t",event:"task",data:{status:"running"}}));
  expect(await update).toMatchObject({kind:"event",taskId:"t"});
  const signedOut=closed(b);h.relay.signOut("u");expect(await signedOut).toBe(RELAY_CLOSE.SESSION_EXPIRED);expect(h.relay.isOnline("d")).toBe(true);
});

it("delivers a response before its deadline despite a streamed-event authorization backlog", async () => {
  const h = await harness(400);
  const connector = await h.connect("connector");
  const browser = await h.connect("browser");
  const received: Frame[] = [];
  browser.on("message", data => received.push(JSON.parse(String(data))));
  connector.on("message", data => {
    const request = JSON.parse(String(data)) as Frame;
    if (request.kind !== "request") return;
    if (request.method === "workspace.get") {
      for (let i = 0; i < 40; i++) connector.send(JSON.stringify({ kind: "event", method: "tasks.events", taskId: "t", event: "task", data: { seq: i } }));
    }
    connector.send(JSON.stringify({ kind: "response", id: request.id, ok: true, status: 200, body: {} }));
  });
  browser.send(JSON.stringify({ kind: "request", id: "watch", method: "tasks.events", params: { taskId: "t" } }));
  await pause(40);
  h.state.authDelayMs = 25;
  browser.send(JSON.stringify({ kind: "request", id: "work", method: "workspace.get" }));
  await pause(650);
  expect(received.find(f => f.kind === "response" && f.id === "work")).toMatchObject({ ok: true, status: 200 });
  expect(received.filter(f => f.kind === "event").map(f => (f as Extract<Frame, { kind: "event" }>).data)).toEqual(Array.from({ length: 40 }, (_, seq) => ({ seq })));
});

it("does not forward frames whose authorization is pending when Prentice signs out", async () => {
  const h = await harness();
  const connector = await h.connect("connector");
  const browser = await h.connect("browser");
  const forwarded: Frame[] = [];
  connector.on("message", data => forwarded.push(JSON.parse(String(data))));
  h.state.authDelayMs = 40;
  browser.send(JSON.stringify({ kind: "request", id: "pending", method: "workspace.get" }));
  await pause(10);
  h.relay.signOut("u");
  await pause(80);
  expect(forwarded).toEqual([]);
  expect(h.relay.isOnline("d")).toBe(true);
});

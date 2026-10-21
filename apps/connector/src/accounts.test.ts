import { mkdtemp, mkdir, writeFile, chmod, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AccountService } from "./accounts.js";
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
describe.skipIf(process.platform==="win32")("Prentice provider connection",()=>{
  it("preserves a long official OAuth URL emitted across chunks",async()=>{
    const home=await mkdtemp(join(tmpdir(),"prentice-login-url-"));roots.push(home);
    const bin=join(home,".local","bin");await mkdir(bin,{recursive:true});
    const url=`https://auth.openai.com/oauth/authorize?code_challenge=${"a".repeat(600)}&scope=openid&state=complete`;
    const program=join(bin,"codex");
    await writeFile(program,`#!/bin/sh\nif [ "$2" = status ]; then echo 'Not logged in'; exit 1; fi\nprintf '%s' '${url.slice(0,350)}'\nsleep 0.05\nprintf '%s\\n' '${url.slice(350)}'\nsleep 0.5\n`);await chmod(program,0o755);
    const settings=new Map<string,string>();
    const accounts=new AccountService({getSetting:key=>settings.get(key),setSetting:(key,value)=>{settings.set(key,value);}},{discovery:{home,env:{PATH:'/usr/bin:/bin'}},cacheMs:0});
    await accounts.connect("codex");
    let message="";
    for(let attempt=0;attempt<30;attempt++){
      message=(await accounts.list()).jobs.codex?.message??"";
      if(message.includes("Continue sign-in:"))break;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    expect(message).toBe(`Continue sign-in: ${url}`);
    // Let the disposable login close before its files are removed.
    await new Promise(resolve=>setTimeout(resolve,600));
  });
  it("persists Disconnect independently of vendor status and reconnects without logout/login",async()=>{
    const home=await mkdtemp(join(tmpdir(),"prentice-account-"));roots.push(home);
    const bin=join(home,".local","bin");await mkdir(bin,{recursive:true});const calls=join(home,"calls");
    for(const [name,text] of [["claude",'{"loggedIn":true}'],["codex","Logged in using ChatGPT"],["cursor-agent",'{"isAuthenticated":true}']]) {
      const path=join(bin,name!);await writeFile(path,`#!/bin/sh\necho "$*" >> '${calls}'\nprintf '%s\\n' '${text}'\n`);await chmod(path,0o755);
    }
    const settings=new Map<string,string>();const store={getSetting:(key:string)=>settings.get(key),setSetting:(key:string,value:string)=>{settings.set(key,value);}};
    const options={discovery:{home,env:{PATH:bin}},cacheMs:0};const accounts=new AccountService(store,options);
    for(const id of ["codex","cursor","claude-code"] as const) {
      expect((await accounts.list()).accounts[id].connected).toBe(true);await accounts.disconnect(id);
      const reloaded=new AccountService(store,options);
      expect((await reloaded.list()).accounts[id]).toMatchObject({connected:false,state:"ready"});
      await reloaded.connect(id);expect((await reloaded.list()).accounts[id].connected).toBe(true);
    }
    const recorded=await readFile(calls,"utf8");expect(recorded).not.toMatch(/^logout$/m);expect(recorded).not.toMatch(/^login$/m);
  });
});

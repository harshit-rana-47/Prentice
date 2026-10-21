import { afterEach, expect, it, vi } from "vitest";
import { hostname } from "node:os";
import { pairWithCloud } from "./pair.js";
afterEach(()=>vi.unstubAllGlobals());
it("pairs with a bounded computer name without filesystem details",async()=>{
  const fetch=vi.fn(async(_url:unknown,init:RequestInit)=>{
    const body=JSON.parse(String(init.body));
    expect(body.name).toBe(hostname().replace(/[\x00-\x1f\x7f/\\]/g,"").trim().slice(0,80)||"This computer");
    expect(body.name.length).toBeLessThanOrEqual(80);expect(body.name).not.toContain("/Users/");
    return Response.json({deviceToken:"paired",userId:"00000000-0000-4000-8000-000000000001"});
  });vi.stubGlobal("fetch",fetch);
  await pairWithCloud({cloudUrl:"http://127.0.0.1:4740",code:"PAIRCODE",identity:{id:"device",publicKey:"public",privateKey:"private"} as never});
  expect(fetch).toHaveBeenCalledOnce();
});

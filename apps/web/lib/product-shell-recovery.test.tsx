// @vitest-environment happy-dom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProductShell } from "../components/product-shell";
import { prenticeAuth } from "./supabase-browser";
import { connectComputer } from "./relay-browser";
vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.mock("next/dynamic", () => ({ default: () => ({ account }: {account: {email: string}}) => <p>Workspace for {account.email}</p> }));
vi.mock("@/components/landing", () => ({ Landing: () => <p>Public landing</p> }));
vi.mock("@/lib/supabase-browser", () => ({ prenticeAuth: vi.fn() }));
vi.mock("@/lib/relay-browser", () => ({ cloudConfig: () => ({url:"https://cloud.test"}), connectComputer: vi.fn(), SIGNED_OUT: "signed out", COMPUTER_DISCONNECTED: "removed" }));
let host: HTMLDivElement;
let root: Root;
let session: {access_token: string; user: {id: string; email: string}} | null;
let online: (message: string | null) => void;
beforeEach(() => {
  window.history.replaceState(null, "", "/?view=workspace");
  session = {access_token:"test-only",user:{id:"account-a",email:"a@example.test"}};
  vi.mocked(prenticeAuth).mockImplementation(() => ({auth:{
    onAuthStateChange: () => ({data:{subscription:{unsubscribe:vi.fn()}}}),
    getSession: async () => ({data:{session}}),
  }} as unknown as ReturnType<typeof prenticeAuth>));
  vi.mocked(connectComputer).mockImplementation(() => ({session:{} as never, close:vi.fn(), updateAccessToken:vi.fn(), onStatus: listener => { online=listener; return () => {}; }}));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => Response.json(url.endsWith("/v1/session") ? {devices:[{id:"mac",name:"Test Mac",pairedAt:"2026-10-26",revokedAt:null}]} : {projects:[],activity:[],concepts:[]})));
  host=document.createElement("div");document.body.append(host);root=createRoot(host);
});
afterEach(async () => {await act(async () => root.unmount());host.remove();vi.unstubAllGlobals();vi.stubGlobal("React",React);vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);});
async function mount() {await act(async () => {root.render(<ProductShell />);});}
it("restores the requested workspace after its account and computer are verified online", async () => {
  await mount();
  expect(host.textContent).not.toContain("Workspace for");
  await act(async () => online(null));
  expect(host.textContent).toContain("Workspace for a@example.test");
});
it("does not open a workspace without an authenticated account", async () => {
  session=null; await mount();
  expect(host.textContent).toContain("Public landing");
  expect(host.textContent).not.toContain("Workspace for");
});
it("keeps the account overview on a normal account URL", async () => {
  window.history.replaceState(null,"","/"); await mount(); await act(async () => online(null));
  expect(host.textContent).toContain("Your account across computers");
  expect(host.textContent).not.toContain("Workspace for");
});

import { describe, expect, it } from "vitest";
import { credentialProgram, windowsCredentialManager } from "./windows-credential.js";

describe("Windows credential store", () => {
  it("keeps the secret off the command and round-trips it through the store", async () => {
    const saved = new Map<string, string>();
    const store = windowsCredentialManager(async (action, account, secret) => {
      expect(credentialProgram()).toContain("CredWrite");
      expect(credentialProgram()).toContain("CredRead");
      if (action === "write") saved.set(account, secret ?? "");
      if (action === "delete") saved.delete(account);
      return action === "read" ? (saved.get(account) ?? "") : "";
    });
    await store.writePrivateKey("device-1", "c2VjcmV0");
    expect(await store.readPrivateKey("device-1")).toBe("c2VjcmV0");
    await store.deletePrivateKey("device-1");
    expect(await store.readPrivateKey("device-1")).toBeNull();
  });
});

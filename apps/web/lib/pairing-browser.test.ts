import { afterEach, expect, it, vi } from "vitest";
import { issuePairingCode } from "./pairing-browser";
import { SIGNED_OUT } from "./relay-browser";

afterEach(() => vi.unstubAllGlobals());

it("snapshots every existing pairing before issuing a code, so another old computer is not mistaken for a new pairing", async () => {
  const older = { id: "other-mac", name: "Other Mac", pairedAt: "2026-10-01", revokedAt: null };
  const removed = { id: "this-mac", name: "This Mac", pairedAt: "2026-10-02", revokedAt: "2026-10-24" };
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ devices: [older, removed] }))
    .mockResolvedValueOnce(Response.json({ code: "TESTCODE", expiresAt: "2026-10-24T12:10:00Z" }));
  vi.stubGlobal("fetch", fetcher);
  const issued = await issuePairingCode("https://cloud.example", "session-token");
  expect(issued.devices).toEqual([older]);
  expect(issued.code).toBe("TESTCODE");
  expect(fetcher.mock.calls.map(call => call[0])).toEqual([
    "https://cloud.example/v1/session", "https://cloud.example/v1/pairing-codes",
  ]);
  expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: "no-store", headers: { authorization: "Bearer session-token" } });
});

it("does not create a code if the account's existing pairings cannot be verified", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({}, { status: 401 }));
  vi.stubGlobal("fetch", fetcher);
  await expect(issuePairingCode("https://cloud.example", "expired-token")).rejects.toThrow(SIGNED_OUT);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

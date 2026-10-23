import { afterEach, expect, it, vi } from "vitest";
import { resumeSavedConnection } from "./resume.js";

afterEach(() => vi.useRealTimers());

it("retries a network failure and activates only after verification succeeds", async () => {
  vi.useFakeTimers();
  const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ userId: "verified-account" });
  const activate = vi.fn().mockResolvedValue(undefined);
  const unavailable = vi.fn();
  const cancel = resumeSavedConnection({ load, activate, unavailable, isCurrent: () => true });
  await vi.advanceTimersByTimeAsync(0);
  expect(activate).not.toHaveBeenCalled();
  expect(unavailable).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(activate).toHaveBeenCalledExactlyOnceWith({ userId: "verified-account" });
  cancel();
});

it("does not retry a rejected or missing credential", async () => {
  vi.useFakeTimers();
  const load = vi.fn().mockResolvedValue(null);
  const activate = vi.fn();
  const cancel = resumeSavedConnection({ load, activate, unavailable: vi.fn(), isCurrent: () => true });
  await vi.advanceTimersByTimeAsync(90_000);
  expect(load).toHaveBeenCalledOnce();
  expect(activate).not.toHaveBeenCalled();
  cancel();
});

it("never restores an old account after an explicit account-selection intent", async () => {
  let current = true;
  let complete!: (value: { userId: string }) => void;
  const pending = new Promise<{ userId: string }>(resolve => { complete = resolve; });
  const activate = vi.fn();
  const cancel = resumeSavedConnection({ load: () => pending, activate, unavailable: vi.fn(), isCurrent: () => current });
  current = false;
  complete({ userId: "old-account" });
  await pending;
  await Promise.resolve();
  expect(activate).not.toHaveBeenCalled();
  cancel();
});

it("cancels pending retries when manual pairing or revocation takes over", async () => {
  vi.useFakeTimers();
  const load = vi.fn().mockRejectedValue(new Error("offline"));
  const cancel = resumeSavedConnection({ load, activate: vi.fn(), unavailable: vi.fn(), isCurrent: () => true });
  await vi.advanceTimersByTimeAsync(0);
  cancel();
  await vi.advanceTimersByTimeAsync(90_000);
  expect(load).toHaveBeenCalledOnce();
});

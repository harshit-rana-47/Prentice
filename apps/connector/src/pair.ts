import { hostname } from "node:os";
import type { DeviceIdentity } from "./device.js";

export async function pairWithCloud(options: {
  cloudUrl: string;
  code: string;
  identity: DeviceIdentity;
}): Promise<{ deviceToken: string; relayUrl: string; userId: string }> {
  const response = await fetch(new URL("/v1/devices/pair", options.cloudUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: options.code,
      name: hostname().replace(/[\x00-\x1f\x7f/\\]/g, "").trim().slice(0, 80) || "This computer",
      deviceId: options.identity.id,
      publicKey: options.identity.publicKey,
    }),
  });
  const body = (await response.json()) as { deviceToken?: string; userId?: string; error?: { message: string } };
  if (!response.ok || !body.deviceToken || !body.userId) {
    throw new Error(body.error?.message ?? "Pairing failed.");
  }
  const relayUrl = relayUrlFor(options.cloudUrl);
  assertSecureRelayUrl(relayUrl);
  return { deviceToken: body.deviceToken, relayUrl, userId: body.userId };
}

export async function pairingOwner(cloudUrl: string, code: string): Promise<{ userId: string; email: string }> {
  const response = await fetch(new URL("/v1/pairing-codes/owner", cloudUrl), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }),
  });
  const body = await response.json() as { userId?: string; email?: string; error?: { message: string } };
  if (!response.ok || !body.userId || !body.email) throw new Error(body.error?.message ?? "Pairing code could not be checked.");
  return { userId: body.userId, email: body.email };
}

/** Local development may use ws on localhost. Any other host must be wss. */
export function assertSecureRelayUrl(url: string): void {
  const parsed = new URL(url);
  const local = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if (!local && parsed.protocol !== "wss:" && parsed.protocol !== "https:") {
    throw new Error("A remote Prentice relay must use https. The connector will not open an unencrypted connection.");
  }
}

export function relayUrlFor(cloudUrl: string): string {
  const url = new URL(cloudUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/relay/connector";
  url.search = "";
  url.hash = "";
  return url.toString();
}

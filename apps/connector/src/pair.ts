import type { DeviceIdentity } from "./device.js";

export async function pairWithCloud(options: {
  cloudUrl: string;
  code: string;
  identity: DeviceIdentity;
}): Promise<{ deviceToken: string; relayUrl: string }> {
  const response = await fetch(new URL("/v1/devices/pair", options.cloudUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: options.code,
      deviceId: options.identity.id,
      publicKey: options.identity.publicKey,
    }),
  });
  const body = (await response.json()) as { deviceToken?: string; error?: { message: string } };
  if (!response.ok || !body.deviceToken) {
    throw new Error(body.error?.message ?? "Pairing failed.");
  }
  const relayUrl = relayUrlFor(options.cloudUrl);
  assertSecureRelayUrl(relayUrl);
  return { deviceToken: body.deviceToken, relayUrl };
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

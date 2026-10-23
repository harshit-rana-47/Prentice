import { SIGNED_OUT } from "./relay-browser";

export interface ActiveDevice {
  id: string;
  name: string;
  pairedAt: string;
  revokedAt: string | null;
}

export async function issuePairingCode(cloudUrl: string, token: string): Promise<{ code: string; expiresAt: string; devices: ActiveDevice[] }> {
  // Snapshot all existing pairings, not just the selected computer. Another saved
  // device may be selected while we wait for this Mac to be paired again.
  const session = await fetch(`${cloudUrl}/v1/session`, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!session.ok) throw new Error(session.status === 401 ? SIGNED_OUT : "Could not check your computers. Try again.");
  const { devices } = await session.json() as { devices: ActiveDevice[] };
  const response = await fetch(`${cloudUrl}/v1/pairing-codes`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const body = (await response.json()) as { code?: string; expiresAt?: string; error?: { message: string } };
  if (!response.ok || !body.code) throw new Error(body.error?.message ?? "Could not create a pairing code.");
  return { code: body.code, expiresAt: body.expiresAt ?? "", devices: devices.filter(item => !item.revokedAt) };
}

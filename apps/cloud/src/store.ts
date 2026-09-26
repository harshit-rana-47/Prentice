import { createHash, randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./db.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export interface CloudUser {
  id: string;
  email: string;
}

export interface CloudDevice {
  id: string;
  userId: string;
  name: string;
  pairedAt: string;
  revokedAt: string | null;
}

export class CloudStore {
  private readonly auth: SupabaseClient;

  constructor(
    private readonly sql: Database,
    supabaseUrl: string,
    secretKey: string,
  ) {
    this.auth = createClient(supabaseUrl, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async userForSession(token: string): Promise<CloudUser | undefined> {
    const { data, error } = await this.auth.auth.getUser(token);
    if (error || !data.user?.id || !data.user.email) return undefined;
    return { id: data.user.id, email: data.user.email };
  }

  async createPairingCode(userId: string): Promise<{ code: string; expiresAt: string }> {
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = pairingCode();
      try {
        await this.sql`
          insert into prentice_private.pairing_codes (code, user_id, expires_at)
          values (${code}, ${userId}, ${expiresAt})
        `;
        return { code, expiresAt: expiresAt.toISOString() };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw new Error("Could not allocate a pairing code.");
  }

  async pairDevice(input: {
    code: string;
    deviceId: string;
    publicKey: string;
    name?: string;
  }): Promise<{ deviceToken: string } | { error: string }> {
    const code = input.code.trim().toUpperCase();
    const deviceToken = randomBytes(32).toString("hex");
    const name = input.name?.trim() || "This computer";
    try {
      await this.sql.begin(async (tx) => {
        const [row] = await tx<{ user_id: string; expires_at: Date; consumed_at: Date | null }[]>`
          select user_id, expires_at, consumed_at
          from prentice_private.pairing_codes
          where code = ${code}
          for update
        `;
        if (!row || row.consumed_at || new Date(row.expires_at).getTime() <= Date.now()) {
          throw new PairingError("That pairing code is not valid.");
        }
        const [existing] = await tx<{ user_id: string }[]>`
          select user_id from public.devices where id = ${input.deviceId} for update
        `;
        if (existing && existing.user_id !== row.user_id) {
          throw new PairingError("This device is already paired to another account.");
        }
        if (existing) {
          await tx`
            update public.devices
            set public_key = ${input.publicKey}, name = ${name}, paired_at = now()
            where id = ${input.deviceId}
          `;
          await tx`
            update prentice_private.device_credentials
            set token_hash = ${hashToken(deviceToken)}
            where device_id = ${input.deviceId}
          `;
        } else {
          await tx`
            insert into public.devices (id, user_id, public_key, name)
            values (${input.deviceId}, ${row.user_id}, ${input.publicKey}, ${name})
          `;
          await tx`
            insert into prentice_private.device_credentials (device_id, token_hash)
            values (${input.deviceId}, ${hashToken(deviceToken)})
          `;
        }
        await tx`
          update prentice_private.pairing_codes
          set consumed_at = now()
          where code = ${code}
        `;
      });
    } catch (error) {
      if (error instanceof PairingError) return { error: error.message };
      throw error;
    }
    return { deviceToken };
  }

  async deviceForToken(token: string): Promise<{ id: string; userId: string } | undefined> {
    const [row] = await this.sql<{ id: string; user_id: string }[]>`
      select devices.id, devices.user_id
      from public.devices
      join prentice_private.device_credentials on device_credentials.device_id = devices.id
      where device_credentials.token_hash = ${hashToken(token)}
    `;
    return row ? { id: row.id, userId: row.user_id } : undefined;
  }

  async deviceForUser(deviceId: string, userId: string): Promise<CloudDevice | undefined> {
    const [row] = await this.sql<{ id: string; user_id: string; name: string; paired_at: Date }[]>`
      select id, user_id, name, paired_at
      from public.devices
      where id = ${deviceId} and user_id = ${userId} and revoked_at is null
    `;
    return row ? toDevice({ ...row, revoked_at: null }) : undefined;
  }

  async listDevices(userId: string): Promise<CloudDevice[]> {
    const rows = await this.sql<{ id: string; user_id: string; name: string; paired_at: Date; revoked_at: Date | null }[]>`
      select id, user_id, name, paired_at, revoked_at
      from public.devices
      where user_id = ${userId}
      order by paired_at
    `;
    return rows.map(toDevice);
  }

  async revokeDevice(userId: string, deviceId: string): Promise<{ revoked: true } | { error: string }> {
    try {
      await this.sql.begin(async (tx) => {
        const [row] = await tx<{ id: string }[]>`
          update public.devices
          set revoked_at = now()
          where id = ${deviceId} and user_id = ${userId} and revoked_at is null
          returning id
        `;
        if (!row) throw new RevokeError("That device is not an active device on this account.");
        await tx`delete from prentice_private.device_credentials where device_id = ${deviceId}`;
      });
    } catch (error) {
      if (error instanceof RevokeError) return { error: error.message };
      throw error;
    }
    return { revoked: true };
  }

  async saveProject(input: { userId: string; deviceId: string; displayName: string }): Promise<{ id: string } | { error: string }> {
    const device = await this.deviceForUser(input.deviceId, input.userId);
    if (!device) return { error: "That device is not paired to this account." };
    const [row] = await this.sql<{ id: string }[]>`
      insert into public.project_metadata (user_id, device_id, display_name)
      values (${input.userId}, ${input.deviceId}, ${input.displayName.trim()})
      returning id
    `;
    if (!row) return { error: "That device is not paired to this account." };
    return { id: row.id };
  }

  async storedText(): Promise<string> {
    const rows = await this.sql<{ value: string }[]>`
      select name as value from public.devices
      union all
      select display_name from public.project_metadata
      union all
      select code from prentice_private.pairing_codes
    `;
    return JSON.stringify(rows);
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

class PairingError extends Error {}

class RevokeError extends Error {}

function toDevice(row: {
  id: string;
  user_id: string;
  name: string;
  paired_at: Date;
  revoked_at: Date | null;
}): CloudDevice {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    pairedAt: new Date(row.paired_at).toISOString(),
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  };
}

function pairingCode(): string {
  const bytes = randomBytes(8);
  return [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

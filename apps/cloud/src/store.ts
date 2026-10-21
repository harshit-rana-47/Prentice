import { createHash, randomBytes } from "node:crypto";
import { createClient, isAuthSessionMissingError, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./db.js";
import type { SyncPayload } from "@prentice/protocol";

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
    if (error) {
      if (isAuthSessionMissingError(error) || error.status === 401 || error.status === 403 || ["bad_jwt", "session_not_found", "user_not_found", "refresh_token_not_found"].includes(error.code ?? "")) return undefined;
      throw new Error("Authentication service temporarily unavailable.");
    }
    if (!data.user?.id || !data.user.email) return undefined;
    let claims: { session_id?: string; exp?: number };
    try { claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()); } catch { return undefined; }
    if (!claims.session_id || !/^[0-9a-f-]{36}$/i.test(claims.session_id) || !claims.exp || claims.exp * 1000 <= Date.now()) return undefined;
    const [session] = await this.sql<{ id: string }[]>`select id from auth.sessions where id = ${claims.session_id} and user_id = ${data.user.id} and (not_after is null or not_after > now())`;
    if (!session) return undefined;
    return { id: data.user.id, email: data.user.email };
  }

  async signOut(token: string): Promise<void> {
    const { error } = await this.auth.auth.admin.signOut(token, "global");
    if (error) throw new Error("Prentice could not end your sessions. Try again.");
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

  async pairingOwner(code: string): Promise<{ userId: string; email: string } | undefined> {
    const [row] = await this.sql<{ user_id: string; email: string }[]>`
      select pairing_codes.user_id, users.email from prentice_private.pairing_codes
      join auth.users on users.id = pairing_codes.user_id
      where code = ${code.trim().toUpperCase()} and consumed_at is null and expires_at > now()
    `;
    return row?.email ? { userId: row.user_id, email: row.email } : undefined;
  }

  async pairDevice(input: {
    code: string;
    deviceId: string;
    publicKey: string;
    name?: string;
  }): Promise<{ deviceToken: string; userId: string } | { error: string }> {
    const code = input.code.trim().toUpperCase();
    const deviceToken = randomBytes(32).toString("hex");
    const name = input.name?.replace(/[\x00-\x1f\x7f/\\]/g, "").trim().slice(0, 80) || "This computer";
    let userId = "";
    try {
      await this.sql.begin(async (tx) => {
        const [row] = await tx<{ user_id: string; expires_at: Date; consumed_at: Date | null }[]>`
          select user_id, expires_at, consumed_at
          from prentice_private.pairing_codes
          where code = ${code}
          for update
        `;
        if (!row) throw new PairingError("That pairing code is not valid. Check it against the code on the Prentice website.");
        userId = row.user_id;
        if (row.consumed_at) throw new PairingError("That pairing code was already used. Get a new code on the Prentice website.");
        if (new Date(row.expires_at).getTime() <= Date.now()) {
          throw new PairingError("That pairing code expired. Get a new code on the Prentice website.");
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
            set public_key = ${input.publicKey}, name = ${name}, paired_at = now(), revoked_at = null
            where id = ${input.deviceId}
          `;
          // Revoking deletes the credential row, so a legitimate re-pair must insert it again.
          await tx`
            insert into prentice_private.device_credentials (device_id, token_hash)
            values (${input.deviceId}, ${hashToken(deviceToken)})
            on conflict (device_id) do update set token_hash = excluded.token_hash
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
    return { deviceToken, userId };
  }

  async saveSync(userId: string, deviceId: string, payload: SyncPayload): Promise<void> {
    await this.sql.begin(async (tx) => {
      for (const item of payload.projects) {
        await tx`
          insert into prentice_private.sync_projects as current_project (user_id, id, origin_device_id, display_name, created_at, last_active_at)
          values (${userId}, ${item.id}, ${deviceId}, ${item.displayName}, ${item.createdAt}, ${item.lastActiveAt})
          on conflict (user_id, id) do update set
            display_name = excluded.display_name,
            last_active_at = greatest(current_project.last_active_at, excluded.last_active_at)
          where current_project.origin_device_id = excluded.origin_device_id
        `;
      }
      for (const item of payload.activity) {
        await tx`
          insert into prentice_private.sync_activity as current_activity
            (user_id, id, project_id, origin_device_id, created_at, finished_at, status, provider_id,
             files_added, files_modified, files_deleted, tests_passed, tests_failed)
          values (${userId}, ${item.id}, ${item.projectId}, ${deviceId}, ${item.createdAt}, ${item.finishedAt},
                  ${item.status}, ${item.providerId}, ${item.filesAdded}, ${item.filesModified}, ${item.filesDeleted},
                  ${item.testsPassed}, ${item.testsFailed})
          on conflict (user_id, id) do update set
            finished_at = excluded.finished_at, status = excluded.status,
            files_added = excluded.files_added, files_modified = excluded.files_modified,
            files_deleted = excluded.files_deleted, tests_passed = excluded.tests_passed, tests_failed = excluded.tests_failed
          where current_activity.origin_device_id = excluded.origin_device_id
        `;
      }
      for (const item of payload.concepts) {
        await tx`
          insert into prentice_private.sync_concepts as current_concept (user_id, project_id, concept, state, recorded_at)
          values (${userId}, ${item.projectId}, ${item.concept}, ${item.state}, ${item.recordedAt})
          on conflict (user_id, project_id, concept) do update set
            state = case when current_concept.state = 'understood' or excluded.state = 'understood'
                         then 'understood' else 'explored' end,
            recorded_at = greatest(current_concept.recorded_at, excluded.recorded_at)
        `;
      }
      await tx`
        delete from prentice_private.sync_activity
        where user_id = ${userId} and id not in (
          select id from prentice_private.sync_activity
          where user_id = ${userId}
          order by created_at desc, id desc limit 50
        )
      `;
    });
  }

  async syncOverview(userId: string): Promise<SyncPayload> {
    const [projects, activity, concepts] = await Promise.all([
      this.sql<SyncPayload["projects"]>`
        select id, display_name as "displayName", created_at as "createdAt", last_active_at as "lastActiveAt"
        from prentice_private.sync_projects where user_id = ${userId} order by last_active_at desc limit 500
      `,
      this.sql<SyncPayload["activity"]>`
        select id, project_id as "projectId", created_at as "createdAt", finished_at as "finishedAt",
          status, provider_id as "providerId", files_added as "filesAdded", files_modified as "filesModified",
          files_deleted as "filesDeleted", tests_passed as "testsPassed", tests_failed as "testsFailed"
        from prentice_private.sync_activity where user_id = ${userId} order by created_at desc limit 50
      `,
      this.sql<SyncPayload["concepts"]>`
        select project_id as "projectId", concept, state, recorded_at as "recordedAt"
        from prentice_private.sync_concepts where user_id = ${userId} order by recorded_at desc limit 1000
      `,
    ]);
    return { projects: projects.map(row => ({ ...row, createdAt: new Date(row.createdAt).toISOString(), lastActiveAt: new Date(row.lastActiveAt).toISOString() })),
      activity: activity.map(row => ({ ...row, createdAt: new Date(row.createdAt).toISOString(), finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null })),
      concepts: concepts.map(row => ({ ...row, recordedAt: new Date(row.recordedAt).toISOString() })) };
  }

  async deviceForToken(token: string): Promise<{ id: string; userId: string } | undefined> {
    const [row] = await this.sql<{ id: string; user_id: string }[]>`
      select devices.id, devices.user_id
      from public.devices
      join prentice_private.device_credentials on device_credentials.device_id = devices.id
      where device_credentials.token_hash = ${hashToken(token)}
        and devices.revoked_at is null
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

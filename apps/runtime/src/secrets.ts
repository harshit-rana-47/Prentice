import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderId } from "@prentice/domain";

export type SecretFile = Partial<Record<ProviderId, string>>;

export class SecretStore {
  constructor(private readonly filePath: string) {}

  read(): SecretFile {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as SecretFile;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  async write(next: SecretFile): Promise<void> {
    mkdirSync(join(this.filePath, ".."), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(next), { mode: 0o600 });
    await chmod(this.filePath, 0o600);
  }

  async set(providerId: ProviderId, apiKey: string): Promise<void> {
    const current = this.read();
    current[providerId] = apiKey.trim();
    await this.write(current);
  }

  async clear(providerId: ProviderId): Promise<void> {
    const current = this.read();
    delete current[providerId];
    await this.write(current);
  }
}

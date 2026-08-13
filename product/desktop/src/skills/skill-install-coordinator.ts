import type { SkillConfirmation, SkillDetail, SkillOperation } from "@uclaw/shared";

import type { PreparedSkillImport, SkillImportSelection, SkillImportService } from "./skill-import-service.js";
import type { SkillService } from "./skill-service.js";

const SKILLHUB_DISCOVERY_URL = "https://skillhub.cloud.tencent.com/skills";

export interface SkillInstallCoordinator {
  selectImport(): Promise<SkillImportSelection | null>;
  prepareImport(token: string): Promise<SkillDetail>;
  installImport(token: string, confirmation: SkillConfirmation): Promise<SkillOperation>;
  disposeImport(token: string): Promise<void>;
  resolveInstall(identity: string): Promise<SkillDetail>;
  openHub(): Promise<void>;
}

export function createSkillInstallCoordinator({
  imports,
  skills,
  openExternal,
}: {
  imports: SkillImportService;
  skills: SkillService;
  openExternal(url: string): Promise<unknown>;
}): SkillInstallCoordinator {
  const prepared = new Map<string, PreparedSkillImport>();
  return {
    selectImport: () => imports.select(),
    async prepareImport(token) {
      const candidate = await imports.prepare(token);
      prepared.set(token, candidate);
      return candidate.detail;
    },
    async installImport(token, confirmation) {
      const candidate = prepared.get(token);
      prepared.delete(token);
      if (!candidate) throw new Error("Skill import selection expired or was already used.");
      return skills.startInstallBundle({ ...candidate, confirmation });
    },
    async disposeImport(token) {
      prepared.delete(token);
      await imports.dispose(token);
    },
    async resolveInstall(identity) {
      const separator = identity.indexOf("/");
      if (!identity.startsWith("@") || separator < 2) throw new Error("Invalid SkillHub identity.");
      const detail = await skills.detail(identity.slice(separator + 1));
      return { ...detail, risk: "high" };
    },
    async openHub() {
      await openExternal(SKILLHUB_DISCOVERY_URL);
    },
  };
}

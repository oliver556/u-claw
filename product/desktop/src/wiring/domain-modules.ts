import type { UClawClient } from "@uclaw/shared";

import type { DesktopDomainRegistry, RegisteredDesktopDomain } from "../main.js";

export interface DesktopDomainModuleContext {
  client: UClawClient;
}

export interface DesktopDomainModule {
  name: string;
  register(context: DesktopDomainModuleContext): RegisteredDesktopDomain | Promise<RegisteredDesktopDomain>;
}

export async function composeDesktopDomainModules(
  registry: DesktopDomainRegistry,
  context: DesktopDomainModuleContext,
  modules: readonly DesktopDomainModule[],
): Promise<void> {
  for (const module of modules) {
    registry.register(module.name, await module.register(context));
  }
}

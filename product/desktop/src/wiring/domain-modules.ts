import type { UClawClient } from "@uclaw/shared";

import type { DesktopDomainRegistry, RegisteredDesktopDomain } from "../main.js";
import {
  createProductionProductDomainModule,
  type CreateProductionProductDomainModuleOptions,
} from "../product-services/production-product-services.js";

export interface DesktopDomainModuleContext {
  client: UClawClient;
  productServices?: CreateProductionProductDomainModuleOptions | false;
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
  const productOptions = context.productServices === false ? undefined : context.productServices;
  if (productOptions !== undefined && registry.resolve("product-services") === undefined) {
    const module = createProductionProductDomainModule(productOptions);
    registry.register(module.name, await module.register(context));
  }
}

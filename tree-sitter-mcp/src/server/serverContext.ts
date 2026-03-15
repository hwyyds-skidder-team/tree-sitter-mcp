import type { RuntimeConfig } from "../config/runtimeConfig.js";
import { createLanguageRegistry, type LanguageRegistry } from "../languages/languageRegistry.js";
import { registerBuiltinGrammars } from "../languages/registerBuiltinGrammars.js";
import { listSupportedQueryTypes } from "../queries/queryCatalog.js";
import { createWorkspaceState, type WorkspaceState } from "../workspace/workspaceState.js";

export interface ServerContext {
  config: RuntimeConfig;
  workspace: WorkspaceState;
  languageRegistry: LanguageRegistry;
  parserMode: "on_demand";
  queryTypes: string[];
}

export function createServerContext(config: RuntimeConfig): ServerContext {
  const languageRegistry = createLanguageRegistry();
  registerBuiltinGrammars(languageRegistry);

  return {
    config,
    workspace: createWorkspaceState(config.defaultExclusions),
    languageRegistry,
    parserMode: "on_demand",
    queryTypes: listSupportedQueryTypes(),
  };
}

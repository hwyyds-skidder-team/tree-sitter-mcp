import type { RuntimeConfig } from "../config/runtimeConfig.js";
import { createSemanticIndexCoordinator, type SemanticIndexCoordinator } from "../indexing/semanticIndexCoordinator.js";
import { createLanguageRegistry, type LanguageRegistry } from "../languages/languageRegistry.js";
import { registerBuiltinGrammars } from "../languages/registerBuiltinGrammars.js";
import { listSupportedQueryTypes } from "../queries/queryCatalog.js";
import {
  applyWorkspaceIndexSummary,
  createWorkspaceState,
  type WorkspaceState,
} from "../workspace/workspaceState.js";

export interface ServerContext {
  config: RuntimeConfig;
  workspace: WorkspaceState;
  semanticIndex: SemanticIndexCoordinator;
  languageRegistry: LanguageRegistry;
  parserMode: "on_demand";
  queryTypes: string[];
}

export function createServerContext(config: RuntimeConfig): ServerContext {
  const languageRegistry = createLanguageRegistry();
  const workspace = createWorkspaceState(config.defaultExclusions);
  const semanticIndex = createSemanticIndexCoordinator(config, {
    onSummaryChange(summary) {
      applyWorkspaceIndexSummary(workspace, summary);
    },
  });

  registerBuiltinGrammars(languageRegistry);
  applyWorkspaceIndexSummary(workspace, semanticIndex.getSummary());

  return {
    config,
    workspace,
    semanticIndex,
    languageRegistry,
    parserMode: "on_demand",
    queryTypes: listSupportedQueryTypes(),
  };
}

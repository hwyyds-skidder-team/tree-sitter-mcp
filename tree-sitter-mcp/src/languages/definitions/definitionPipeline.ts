import type { Diagnostic } from "../../diagnostics/diagnosticFactory.js";
import type { SymbolMatch } from "../../queries/queryCatalog.js";
import { extractDefinitionMatches } from "../../queries/definitionQueryCatalog.js";
import type { ServerContext } from "../../server/serverContext.js";
import { parseWithDiagnostics } from "../../parsing/parseWithDiagnostics.js";
import type { SearchableFileRecord } from "../../workspace/workspaceState.js";

export interface FileDefinitionsResult {
  file: SearchableFileRecord;
  definitions: SymbolMatch[];
  diagnostics: Diagnostic[];
}

export async function collectFileDefinitions(
  context: ServerContext,
  file: SearchableFileRecord,
): Promise<FileDefinitionsResult> {
  const language = context.languageRegistry.getById(file.languageId);
  if (!language) {
    return {
      file,
      definitions: [],
      diagnostics: [],
    };
  }

  const parseResult = await parseWithDiagnostics({
    absolutePath: file.path,
    relativePath: file.relativePath,
    language,
  });

  if (!parseResult.ok) {
    return {
      file,
      definitions: [],
      diagnostics: [parseResult.diagnostic],
    };
  }

  return {
    file,
    definitions: extractDefinitionMatches({
      language,
      workspaceRoot: file.workspaceRoot ?? context.workspace.root ?? file.path,
      absolutePath: file.path,
      relativePath: file.relativePath,
      source: parseResult.source,
      tree: parseResult.tree,
    }),
    diagnostics: [],
  };
}

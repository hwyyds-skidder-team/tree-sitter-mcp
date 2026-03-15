import type { Diagnostic } from "../diagnostics/diagnosticFactory.js";
import { createSourceRange } from "../diagnostics/diagnosticFactory.js";
import { captureReferenceNodes } from "../queries/referenceQueryCatalog.js";
import { createSnippet } from "../queries/queryCatalog.js";
import type { ServerContext } from "../server/serverContext.js";
import { parseWithDiagnostics } from "../parsing/parseWithDiagnostics.js";
import type { SearchableFileRecord } from "../workspace/workspaceState.js";
import { ReferenceMatchSchema, type ReferenceMatch } from "./referenceTypes.js";

export interface CollectFileReferencesRequest {
  targetName: string;
  symbolKind?: ReferenceMatch["symbolKind"];
}

export interface FileReferencesResult {
  file: SearchableFileRecord;
  references: ReferenceMatch[];
  diagnostics: Diagnostic[];
}

export async function collectFileReferences(
  context: ServerContext,
  file: SearchableFileRecord,
  request: CollectFileReferencesRequest,
): Promise<FileReferencesResult> {
  const language = context.languageRegistry.getById(file.languageId);
  if (!language) {
    return {
      file,
      references: [],
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
      references: [],
      diagnostics: [parseResult.diagnostic],
    };
  }

  const references = captureReferenceNodes({
    language,
    tree: parseResult.tree,
    targetName: request.targetName,
  }).map((capture) => ReferenceMatchSchema.parse({
    name: capture.nameNode.text,
    referenceKind: capture.referenceKind,
    symbolKind: request.symbolKind ?? null,
    languageId: language.id,
    filePath: file.path,
    relativePath: file.relativePath,
    range: createSourceRange(
      capture.rangeNode.startPosition,
      capture.rangeNode.endPosition,
      capture.rangeNode.startIndex,
      capture.rangeNode.endIndex,
    ),
    selectionRange: createSourceRange(
      capture.nameNode.startPosition,
      capture.nameNode.endPosition,
      capture.nameNode.startIndex,
      capture.nameNode.endIndex,
    ),
    containerName: findReferenceContainerName(capture.nameNode),
    snippet: createSnippet(parseResult.source, capture.rangeNode),
  })).sort((left, right) => {
    if (left.relativePath !== right.relativePath) {
      return left.relativePath.localeCompare(right.relativePath);
    }

    return left.range.start.offset - right.range.start.offset;
  });

  return {
    file,
    references,
    diagnostics: [],
  };
}

function findReferenceContainerName(node: { parent: import("tree-sitter").SyntaxNode | null }): string | null {
  let current = node.parent;
  while (current) {
    switch (current.type) {
      case "class_declaration":
      case "class_definition":
      case "function_declaration":
      case "function_definition":
      case "interface_declaration":
      case "method_definition":
        return current.childForFieldName("name")?.text ?? current.firstNamedChild?.text ?? null;
      default:
        current = current.parent;
    }
  }

  return null;
}

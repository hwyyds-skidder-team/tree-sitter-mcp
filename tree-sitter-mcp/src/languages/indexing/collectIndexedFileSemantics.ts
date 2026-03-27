import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createContextSnippet } from "../context/contextSnippet.js";
import { extractEnclosingContext } from "../context/extractEnclosingContext.js";
import {
  createDiagnostic,
  createSourceRange,
  type Diagnostic,
} from "../../diagnostics/diagnosticFactory.js";
import type { DefinitionMatch } from "../definitions/definitionTypes.js";
import {
  IndexedFileSemanticRecordSchema,
  type IndexedFileSemanticRecord,
} from "./indexTypes.js";
import { parseWithDiagnostics } from "../../parsing/parseWithDiagnostics.js";
import { extractDefinitionMatches } from "../../queries/definitionQueryCatalog.js";
import {
  createSnippet,
  extractSymbols,
  type SymbolMatch,
} from "../../queries/queryCatalog.js";
import { captureReferenceNodes } from "../../queries/referenceQueryCatalog.js";
import { ReferenceMatchSchema, type ReferenceMatch } from "../../references/referenceTypes.js";
import type { ServerContext } from "../../server/serverContext.js";
import type { SearchableFileRecord } from "../../workspace/workspaceState.js";

export const PersistedIndexedFileRecordSchema = IndexedFileSemanticRecordSchema;

export const PersistedIndexedFileRecordsSchema = IndexedFileSemanticRecordSchema.array();

export type PersistedIndexedFileRecord = IndexedFileSemanticRecord;
export interface IndexedFileSnapshot {
  contentHash: string;
  mtimeMs: number;
  sizeBytes: number;
  updatedAt: string;
}

export interface WorkspaceOwnedPath {
  path: string;
  relativePath: string;
  workspaceRoot?: string;
}

export async function collectIndexedFileSemantics(
  context: ServerContext,
  file: SearchableFileRecord,
  snapshotInput?: IndexedFileSnapshot,
): Promise<PersistedIndexedFileRecord> {
  const fileSnapshot = snapshotInput ?? await readIndexedFileSnapshot(file);
  const workspaceRoot = resolveIndexedRecordWorkspaceRoot(file);
  const language = context.languageRegistry.getById(file.languageId);

  if (!language) {
    return createIndexedRecord(file, fileSnapshot, {
      diagnostics: [createDiagnostic({
        code: "unsupported_language",
        message: `Registered file ${file.relativePath} references missing language ${file.languageId}.`,
        reason: "Workspace discovery found a file whose grammar registration is no longer present.",
        nextStep: "Reset the workspace with set_workspace or restart the server.",
        filePath: file.path,
        relativePath: file.relativePath,
        languageId: file.languageId,
      })],
    });
  }

  const parseResult = await parseWithDiagnostics({
    absolutePath: file.path,
    relativePath: file.relativePath,
    language,
  });

  if (!parseResult.ok) {
    return createIndexedRecord(file, fileSnapshot, {
      diagnostics: [parseResult.diagnostic],
    });
  }

  const symbols = extractSymbols({
    language,
    workspaceRoot,
    absolutePath: file.path,
    relativePath: file.relativePath,
    source: parseResult.source,
    tree: parseResult.tree,
  });
  const definitions = extractDefinitionMatches({
    language,
    workspaceRoot,
    absolutePath: file.path,
    relativePath: file.relativePath,
    source: parseResult.source,
    tree: parseResult.tree,
  });
  const references = captureReferenceNodes({
    language,
    tree: parseResult.tree,
  }).map((capture) => ReferenceMatchSchema.parse({
    name: capture.nameNode.text,
    referenceKind: capture.referenceKind,
    symbolKind: null,
    languageId: language.id,
    workspaceRoot,
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
    enclosingContext: extractEnclosingContext({
      tree: parseResult.tree,
      startOffset: capture.nameNode.startIndex,
      endOffset: capture.nameNode.endIndex,
    }),
    contextSnippet: createContextSnippet({
      source: parseResult.source,
      startOffset: capture.nameNode.startIndex,
      endOffset: capture.nameNode.endIndex,
    }),
  })).sort((left, right) => {
    if (left.relativePath !== right.relativePath) {
      return left.relativePath.localeCompare(right.relativePath);
    }

    if (left.referenceKind !== right.referenceKind) {
      return left.referenceKind === "call" ? -1 : 1;
    }

    return left.range.start.offset - right.range.start.offset;
  });

  return createIndexedRecord(file, fileSnapshot, {
    symbols,
    definitions,
    references,
    diagnostics: [],
  });
}

interface CreateIndexedRecordOptions {
  symbols?: SymbolMatch[];
  definitions?: DefinitionMatch[];
  references?: ReferenceMatch[];
  diagnostics?: Diagnostic[];
}

export async function readIndexedFileSnapshot(file: SearchableFileRecord): Promise<IndexedFileSnapshot> {
  try {
    const [source, stats] = await Promise.all([
      fs.readFile(file.path, "utf8"),
      fs.stat(file.path),
    ]);

    return {
      contentHash: crypto.createHash("sha1").update(source).digest("hex"),
      mtimeMs: stats.mtimeMs,
      sizeBytes: stats.size,
      updatedAt: stats.mtime.toISOString(),
    };
  } catch {
    return {
      contentHash: crypto.createHash("sha1").update("").digest("hex"),
      mtimeMs: 0,
      sizeBytes: 0,
      updatedAt: new Date(0).toISOString(),
    };
  }
}

export function resolveIndexedRecordWorkspaceRoot(file: WorkspaceOwnedPath): string {
  if (file.workspaceRoot && file.workspaceRoot.trim().length > 0) {
    return file.workspaceRoot;
  }

  const segments = file.relativePath
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0);
  const upwardSegments = Math.max(segments.length - 1, 0);

  return path.resolve(path.dirname(file.path), ...Array(upwardSegments).fill(".."));
}

export function createWorkspaceRecordKey(file: WorkspaceOwnedPath): string {
  return JSON.stringify([resolveIndexedRecordWorkspaceRoot(file), file.relativePath]);
}

export function parseWorkspaceRecordKey(key: string): {
  workspaceRoot: string;
  relativePath: string;
} {
  const parsed = JSON.parse(key) as unknown;

  if (
    Array.isArray(parsed)
    && parsed.length === 2
    && typeof parsed[0] === "string"
    && typeof parsed[1] === "string"
  ) {
    return {
      workspaceRoot: parsed[0],
      relativePath: parsed[1],
    };
  }

  throw new Error(`Invalid workspace record key: ${key}`);
}

function createIndexedRecord(
  file: SearchableFileRecord,
  snapshot: IndexedFileSnapshot,
  options: CreateIndexedRecordOptions,
): PersistedIndexedFileRecord {
  const symbols = options.symbols ?? [];
  const workspaceRoot = resolveIndexedRecordWorkspaceRoot(file);
  return PersistedIndexedFileRecordSchema.parse({
    workspaceRoot,
    path: file.path,
    relativePath: file.relativePath,
    languageId: file.languageId,
    grammarName: file.grammarName,
    contentHash: snapshot.contentHash,
    symbolCount: symbols.length,
    updatedAt: snapshot.updatedAt,
    mtimeMs: snapshot.mtimeMs,
    sizeBytes: snapshot.sizeBytes,
    symbols,
    definitions: options.definitions ?? [],
    references: options.references ?? [],
    diagnostics: options.diagnostics ?? [],
  });
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

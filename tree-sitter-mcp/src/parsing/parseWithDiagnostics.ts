import fs from "node:fs/promises";
import Parser from "tree-sitter";
import {
  createDiagnostic,
  createSourceRange,
  type Diagnostic,
} from "../diagnostics/diagnosticFactory.js";
import type { RegisteredLanguage } from "../languages/languageRegistry.js";

export interface ParseRequest {
  absolutePath: string;
  relativePath: string;
  language: RegisteredLanguage;
}

export type ParseResult =
  | {
      ok: true;
      absolutePath: string;
      relativePath: string;
      language: RegisteredLanguage;
      source: string;
      tree: Parser.Tree;
    }
  | {
      ok: false;
      absolutePath: string;
      relativePath: string;
      languageId: string;
      diagnostic: Diagnostic;
    };

export async function parseWithDiagnostics(request: ParseRequest): Promise<ParseResult> {
  let source: string;
  try {
    source = await fs.readFile(request.absolutePath, "utf8");
  } catch {
    return {
      ok: false,
      absolutePath: request.absolutePath,
      relativePath: request.relativePath,
      languageId: request.language.id,
      diagnostic: createDiagnostic({
        code: "file_not_found",
        message: `Unable to read file: ${request.relativePath}`,
        reason: "The requested file no longer exists or is not readable.",
        nextStep: "Refresh the workspace with set_workspace and retry the query.",
        filePath: request.absolutePath,
        relativePath: request.relativePath,
        languageId: request.language.id,
      }),
    };
  }

  const parser = new Parser();
  try {
    parser.setLanguage(request.language.parserLanguage);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      absolutePath: request.absolutePath,
      relativePath: request.relativePath,
      languageId: request.language.id,
      diagnostic: createDiagnostic({
        code: "unsupported_language",
        message: `Language grammar failed to initialize for ${request.language.displayName}.`,
        reason: message,
        nextStep: "Restart the server or reinstall the grammar package for this language.",
        filePath: request.absolutePath,
        relativePath: request.relativePath,
        languageId: request.language.id,
      }),
    };
  }

  try {
    const tree = parser.parse(source);
    const errorNode = findFirstErrorNode(tree.rootNode);
    if (tree.rootNode.hasError && errorNode) {
      return {
        ok: false,
        absolutePath: request.absolutePath,
        relativePath: request.relativePath,
        languageId: request.language.id,
        diagnostic: createDiagnostic({
          code: "parse_failed",
          message: `Tree-sitter could not parse ${request.relativePath} cleanly.`,
          reason: `Encountered syntax errors near node type ${errorNode.type}.`,
          nextStep: "Fix the file syntax or retry against a supported file that parses successfully.",
          filePath: request.absolutePath,
          relativePath: request.relativePath,
          languageId: request.language.id,
          range: createSourceRange(
            errorNode.startPosition,
            errorNode.endPosition,
            errorNode.startIndex,
            errorNode.endIndex,
          ),
        }),
      };
    }

    return {
      ok: true,
      absolutePath: request.absolutePath,
      relativePath: request.relativePath,
      language: request.language,
      source,
      tree,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      absolutePath: request.absolutePath,
      relativePath: request.relativePath,
      languageId: request.language.id,
      diagnostic: createDiagnostic({
        code: "parse_failed",
        message: `Tree-sitter parse failed for ${request.relativePath}.`,
        reason: message,
        nextStep: "Inspect the file contents and retry after correcting the syntax.",
        filePath: request.absolutePath,
        relativePath: request.relativePath,
        languageId: request.language.id,
      }),
    };
  }
}

function findFirstErrorNode(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  if (node.isError || node.isMissing) {
    return node;
  }

  for (const child of node.children) {
    const errorNode = findFirstErrorNode(child);
    if (errorNode) {
      return errorNode;
    }
  }

  return null;
}

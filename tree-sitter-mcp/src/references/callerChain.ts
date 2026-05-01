import fs from "node:fs/promises";
import Parser from "tree-sitter";
import type { RegisteredLanguage } from "../languages/languageRegistry.js";
import { parseWithDiagnostics } from "../parsing/parseWithDiagnostics.js";

export interface CallChainEntry {
  filePath: string;
  functionName: string;
  location: {
    start: { row: number; column: number };
    end: { row: number; column: number };
    startIndex: number;
    endIndex: number;
  };
}

export interface CallerResult {
  filePath: string;
  functionName: string;
  callLocation: {
    start: { row: number; column: number };
    end: { row: number; column: number };
    startIndex: number;
    endIndex: number;
  };
  callChain: CallChainEntry[];
  snippet: string;
}

const CALL_NODE_TYPES = new Set([
  "call_expression",
  "call",
  "new_expression",
  "method_invocation",
  "method_call",
  "function_call",
  "invocation_expression",
]);

const FUNCTION_NODE_TYPES = new Set([
  "function_declaration",
  "function_definition",
  "method_declaration",
  "method_definition",
  "arrow_function",
  "function_expression",
  "function_item",
  "constructor_declaration",
  "lambda_expression",
]);

export async function findCallersForSymbol(
  absolutePath: string,
  relativePath: string,
  language: RegisteredLanguage,
  symbolName: string,
): Promise<CallerResult[]> {
  const parseResult = await parseWithDiagnostics({
    absolutePath,
    relativePath,
    language,
  });

  if (!parseResult.ok) {
    return [];
  }

  const callers: CallerResult[] = [];
  const source = parseResult.source;

  function findContainingFunction(node: Parser.SyntaxNode): string | null {
    let current: Parser.SyntaxNode | null = node.parent;
    while (current) {
      if (FUNCTION_NODE_TYPES.has(current.type)) {
        const nameField = current.childForFieldName("name");
        if (nameField) {
          return nameField.text;
        }
        const declaratorField = current.childForFieldName("declarator");
        if (declaratorField?.type === "function_declarator") {
          const fnName = declaratorField.childForFieldName("declarator");
          if (fnName && fnName.type === "identifier") {
            return fnName.text;
          }
        }
      }
      current = current.parent;
    }
    return null;
  }

  function extractCallChain(node: Parser.SyntaxNode): CallChainEntry[] {
    const chain: CallChainEntry[] = [];
    let current: Parser.SyntaxNode | null = node.parent;

    while (current) {
      if (FUNCTION_NODE_TYPES.has(current.type)) {
        const nameField = current.childForFieldName("name");
        const fnName = nameField?.text ?? "(anonymous)";
        chain.unshift({
          filePath: absolutePath,
          functionName: fnName,
          location: {
            start: { row: current.startPosition.row, column: current.startPosition.column },
            end: { row: current.endPosition.row, column: current.endPosition.column },
            startIndex: current.startIndex,
            endIndex: current.endIndex,
          },
        });
      }
      current = current.parent;
    }

    return chain;
  }

  function visit(node: Parser.SyntaxNode): void {
    if (CALL_NODE_TYPES.has(node.type)) {
      const functionField = node.childForFieldName("function");
      if (functionField && functionField.text === symbolName) {
        const callerFunction = findContainingFunction(node);
        const callChain = extractCallChain(node);

        callers.push({
          filePath: absolutePath,
          functionName: callerFunction ?? "(module level)",
          callLocation: {
            start: { row: node.startPosition.row, column: node.startPosition.column },
            end: { row: node.endPosition.row, column: node.endPosition.column },
            startIndex: node.startIndex,
            endIndex: node.endIndex,
          },
          callChain,
          snippet: source.slice(node.startIndex, Math.min(node.endIndex, node.startIndex + 120)).trim(),
        });
      }
    }

    for (const child of node.children) {
      visit(child);
    }
  }

  visit(parseResult.tree.rootNode);

  return callers;
}

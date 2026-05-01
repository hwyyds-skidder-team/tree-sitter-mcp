import Parser from "tree-sitter";
import { z } from "zod";
import { createSourceRange, SourceRangeSchema } from "../diagnostics/diagnosticFactory.js";
import type { RegisteredLanguage } from "../languages/languageRegistry.js";

export const SymbolKindSchema = z.enum(["class", "function", "method", "variable", "interface"]);

export const SymbolMatchSchema = z.object({
  name: z.string(),
  kind: SymbolKindSchema,
  languageId: z.string(),
  workspaceRoot: z.string().min(1),
  filePath: z.string(),
  relativePath: z.string(),
  range: SourceRangeSchema,
  selectionRange: SourceRangeSchema,
  containerName: z.string().nullable(),
  snippet: z.string(),
});

export type SymbolKind = z.infer<typeof SymbolKindSchema>;
export type SymbolMatch = z.infer<typeof SymbolMatchSchema>;

export interface QueryDefinition {
  source: string;
  classify(definitionNode: Parser.SyntaxNode, nameNode: Parser.SyntaxNode): SymbolKind;
}

export interface CompilableQueryDefinition {
  source: string;
}

interface ExtractSymbolsInput {
  language: RegisteredLanguage;
  workspaceRoot: string;
  absolutePath: string;
  relativePath: string;
  source: string;
  tree: Parser.Tree;
}

const SUPPORTED_QUERY_TYPES = ["file_symbols", "workspace_symbols"] as const;

const QUERY_DEFINITIONS: Record<string, QueryDefinition> = {
  javascript: {
    source: `[
      (function_declaration name: (identifier) @symbol.name) @symbol.definition
      (class_declaration name: (identifier) @symbol.name) @symbol.definition
      (method_definition name: (property_identifier) @symbol.name) @symbol.definition
      (variable_declarator name: (identifier) @symbol.name value: [(arrow_function) (function_expression)]) @symbol.definition
    ]`,
    classify(definitionNode, nameNode) {
      return classifySymbolKind(definitionNode, nameNode);
    },
  },
  typescript: {
    source: `[
      (interface_declaration name: (type_identifier) @symbol.name) @symbol.definition
      (function_declaration name: (identifier) @symbol.name) @symbol.definition
      (class_declaration name: (type_identifier) @symbol.name) @symbol.definition
      (method_definition name: (property_identifier) @symbol.name) @symbol.definition
      (variable_declarator name: (identifier) @symbol.name value: [(arrow_function) (function_expression)]) @symbol.definition
    ]`,
    classify(definitionNode, nameNode) {
      return classifySymbolKind(definitionNode, nameNode);
    },
  },
  tsx: {
    source: `[
      (interface_declaration name: (type_identifier) @symbol.name) @symbol.definition
      (function_declaration name: (identifier) @symbol.name) @symbol.definition
      (class_declaration name: (type_identifier) @symbol.name) @symbol.definition
      (method_definition name: (property_identifier) @symbol.name) @symbol.definition
      (variable_declarator name: (identifier) @symbol.name value: [(arrow_function) (function_expression)]) @symbol.definition
    ]`,
    classify(definitionNode, nameNode) {
      return classifySymbolKind(definitionNode, nameNode);
    },
  },
  python: {
    source: `[
      (class_definition name: (identifier) @symbol.name) @symbol.definition
      (function_definition name: (identifier) @symbol.name) @symbol.definition
    ]`,
    classify(definitionNode, nameNode) {
      return classifySymbolKind(definitionNode, nameNode);
    },
  },
  rust: {
    source: `[
      (function_item name: (identifier) @symbol.name) @symbol.definition
      (struct_item name: (type_identifier) @symbol.name) @symbol.definition
      (enum_item name: (type_identifier) @symbol.name) @symbol.definition
      (trait_item name: (type_identifier) @symbol.name) @symbol.definition
      (impl_item type: (type_identifier) @symbol.name) @symbol.definition
      (mod_item name: (identifier) @symbol.name) @symbol.definition
      (type_item name: (type_identifier) @symbol.name) @symbol.definition
    ]`,
    classify(definitionNode, nameNode) {
      switch (definitionNode.type) {
        case "struct_item":
        case "enum_item":
          return "class";
        case "trait_item":
          return "interface";
        case "impl_item":
          return "class";
        case "mod_item":
          return "variable";
        case "type_item":
          return "variable";
        case "function_item":
          return hasAncestor(definitionNode, ["impl_item"]) ? "method" : "function";
        default:
          return "function";
      }
    },
  },
};

const queryCache = new Map<string, Parser.Query>();

export function listSupportedQueryTypes(): string[] {
  return [...SUPPORTED_QUERY_TYPES];
}

export function extractSymbols(input: ExtractSymbolsInput): SymbolMatch[] {
  const queryDefinition = QUERY_DEFINITIONS[input.language.id];
  if (!queryDefinition) {
    return [];
  }

  const query = getCompiledQuery(input.language, queryDefinition);
  const matches = query.matches(input.tree.rootNode);
  const symbols: SymbolMatch[] = [];

  for (const match of matches) {
    const definitionCapture = match.captures.find((capture) => capture.name === "symbol.definition");
    const nameCapture = match.captures.find((capture) => capture.name === "symbol.name");

    if (!definitionCapture || !nameCapture) {
      continue;
    }

    const definitionNode = definitionCapture.node;
    const nameNode = nameCapture.node;
    symbols.push({
      name: nameNode.text,
      kind: queryDefinition.classify(definitionNode, nameNode),
      languageId: input.language.id,
      workspaceRoot: input.workspaceRoot,
      filePath: input.absolutePath,
      relativePath: input.relativePath,
      range: createSourceRange(
        definitionNode.startPosition,
        definitionNode.endPosition,
        definitionNode.startIndex,
        definitionNode.endIndex,
      ),
      selectionRange: createSourceRange(
        nameNode.startPosition,
        nameNode.endPosition,
        nameNode.startIndex,
        nameNode.endIndex,
      ),
      containerName: findContainerName(definitionNode),
      snippet: createSnippet(input.source, definitionNode),
    });
  }

  return symbols.sort((left, right) => {
    if (left.relativePath !== right.relativePath) {
      return left.relativePath.localeCompare(right.relativePath);
    }

    return left.range.start.offset - right.range.start.offset;
  });
}

export function getCompiledQuery(language: RegisteredLanguage, definition: CompilableQueryDefinition): Parser.Query {
  const cacheKey = `${language.id}:${definition.source}`;
  const cachedQuery = queryCache.get(cacheKey);
  if (cachedQuery) {
    return cachedQuery;
  }

  const compiledQuery = new Parser.Query(language.parserLanguage, definition.source);
  queryCache.set(cacheKey, compiledQuery);
  return compiledQuery;
}

export function classifySymbolKind(
  definitionNode: Parser.SyntaxNode,
  nameNode: Parser.SyntaxNode,
): SymbolKind {
  switch (definitionNode.type) {
    case "class_declaration":
    case "class_definition":
      return "class";
    case "method_definition":
      return "method";
    case "function_declaration":
    case "function_definition":
      return hasAncestor(definitionNode, ["class_definition", "class_declaration"]) ? "method" : "function";
    case "interface_declaration":
      return "interface";
    case "variable_declarator":
      return "variable";
    default:
      return hasAncestor(nameNode, ["class_definition", "class_declaration"]) ? "method" : "function";
  }
}

export function hasAncestor(node: Parser.SyntaxNode, types: string[]): boolean {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (types.includes(current.type)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

export function findContainerName(node: Parser.SyntaxNode): string | null {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    switch (current.type) {
      case "class_declaration":
      case "interface_declaration":
        return current.childForFieldName("name")?.text ?? current.firstNamedChild?.text ?? null;
      case "class_definition":
        return current.childForFieldName("name")?.text ?? current.firstNamedChild?.text ?? null;
      default:
        current = current.parent;
    }
  }
  return null;
}

export function createSnippet(source: string, node: Parser.SyntaxNode): string {
  const rawSnippet = source.slice(node.startIndex, node.endIndex).trim().replace(/\s+/g, " ");
  return rawSnippet.length > 180 ? `${rawSnippet.slice(0, 177)}...` : rawSnippet;
}

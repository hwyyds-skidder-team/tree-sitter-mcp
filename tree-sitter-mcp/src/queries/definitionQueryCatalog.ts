import Parser from "tree-sitter";
import { createSourceRange } from "../diagnostics/diagnosticFactory.js";
import type { RegisteredLanguage } from "../languages/languageRegistry.js";
import {
  classifySymbolKind,
  createSnippet,
  findContainerName,
  getCompiledQuery,
  hasAncestor,
  type QueryDefinition,
  type SymbolKind,
  type SymbolMatch,
} from "./queryCatalog.js";

export interface RawDefinitionCapture {
  definitionNode: Parser.SyntaxNode;
  nameNode: Parser.SyntaxNode;
  kind: SymbolKind;
}

interface DefinitionCatalogEntry extends QueryDefinition {}

const DEFINITION_QUERY_TYPES = ["definition_search", "definition_resolve"] as const;

const DEFINITION_QUERY_DEFINITIONS: Record<string, DefinitionCatalogEntry> = {
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

interface CaptureDefinitionsInput {
  language: RegisteredLanguage;
  tree: Parser.Tree;
}

interface ExtractDefinitionMatchesInput {
  language: RegisteredLanguage;
  workspaceRoot: string;
  absolutePath: string;
  relativePath: string;
  source: string;
  tree: Parser.Tree;
}

export function listDefinitionQueryTypes(): string[] {
  return [...DEFINITION_QUERY_TYPES];
}

export function captureDefinitionNodes(input: CaptureDefinitionsInput): RawDefinitionCapture[] {
  const definition = DEFINITION_QUERY_DEFINITIONS[input.language.id];
  if (!definition) {
    return [];
  }

  const query = getCompiledQuery(input.language, definition);
  const matches = query.matches(input.tree.rootNode);

  return matches.flatMap((match) => {
    const definitionCapture = match.captures.find((capture) => capture.name === "symbol.definition");
    const nameCapture = match.captures.find((capture) => capture.name === "symbol.name");

    if (!definitionCapture || !nameCapture) {
      return [];
    }

    return [{
      definitionNode: definitionCapture.node,
      nameNode: nameCapture.node,
      kind: definition.classify(definitionCapture.node, nameCapture.node),
    }];
  });
}

export function extractDefinitionMatches(input: ExtractDefinitionMatchesInput): SymbolMatch[] {
  return captureDefinitionNodes({
    language: input.language,
    tree: input.tree,
  }).map((capture) => ({
    name: capture.nameNode.text,
    kind: capture.kind,
    languageId: input.language.id,
    workspaceRoot: input.workspaceRoot,
    filePath: input.absolutePath,
    relativePath: input.relativePath,
    range: createSourceRange(
      capture.definitionNode.startPosition,
      capture.definitionNode.endPosition,
      capture.definitionNode.startIndex,
      capture.definitionNode.endIndex,
    ),
    selectionRange: createSourceRange(
      capture.nameNode.startPosition,
      capture.nameNode.endPosition,
      capture.nameNode.startIndex,
      capture.nameNode.endIndex,
    ),
    containerName: findContainerName(capture.definitionNode),
    snippet: createSnippet(input.source, capture.definitionNode),
  })).sort((left, right) => {
    if (left.relativePath !== right.relativePath) {
      return left.relativePath.localeCompare(right.relativePath);
    }

    return left.range.start.offset - right.range.start.offset;
  });
}

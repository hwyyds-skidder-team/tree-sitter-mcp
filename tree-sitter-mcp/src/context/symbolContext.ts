import type { RegisteredLanguage } from "../languages/languageRegistry.js";
import { parseWithDiagnostics } from "../parsing/parseWithDiagnostics.js";

export interface SymbolSignature {
  name: string;
  kind: string;
  signature: string;
  location: {
    filePath: string;
    start: { row: number; column: number };
    end: { row: number; column: number };
  };
}

export interface SymbolRelation {
  name: string;
  filePath: string;
  location: {
    start: { row: number; column: number };
    end: { row: number; column: number };
  };
}

export interface SymbolHierarchy {
  extends: string | null;
  implements: string[];
  extendedBy: string[];
}

export interface SymbolContext {
  signature: SymbolSignature;
  callers: SymbolRelation[];
  callees: SymbolRelation[];
  hierarchy: SymbolHierarchy;
}

const FUNCTION_NODE_TYPES = new Set([
  "function_declaration",
  "function_definition",
  "method_declaration",
  "method_definition",
  "arrow_function",
  "function_expression",
  "function_item",
  "constructor_declaration",
]);

const CLASS_NODE_TYPES = new Set([
  "class_declaration",
  "class_definition",
  "class_specifier",
  "struct_item",
  "struct_specifier",
  "interface_declaration",
  "trait_item",
]);

const CALL_NODE_TYPES = new Set([
  "call_expression",
  "call",
  "new_expression",
  "method_invocation",
  "method_call",
  "function_call",
]);

export async function getSymbolContext(
  absolutePath: string,
  relativePath: string,
  language: RegisteredLanguage,
  symbolName: string,
): Promise<SymbolContext | null> {
  const parseResult = await parseWithDiagnostics({
    absolutePath,
    relativePath,
    language,
  });

  if (!parseResult.ok) {
    return null;
  }

  const source = parseResult.source;
  const tree = parseResult.tree;

  let foundSymbol: {
    node: import("tree-sitter").SyntaxNode;
    kind: string;
    name: string;
  } | null = null;

  function findSymbol(node: import("tree-sitter").SyntaxNode): void {
    if (foundSymbol) return;

    const nameField = node.childForFieldName("name");
    if (nameField && nameField.text === symbolName) {
      if (FUNCTION_NODE_TYPES.has(node.type)) {
        foundSymbol = { node, kind: "function", name: nameField.text };
      } else if (CLASS_NODE_TYPES.has(node.type)) {
        foundSymbol = { node, kind: "class", name: nameField.text };
      }
    }

    for (const child of node.children) {
      findSymbol(child);
    }
  }

  findSymbol(tree.rootNode);

  if (!foundSymbol) {
    return null;
  }

  const symbol = foundSymbol as {
    node: import("tree-sitter").SyntaxNode;
    kind: string;
    name: string;
  };
  const signature = extractSignature(symbol.node, source, symbol.kind, symbol.name);
  const callees = extractCallees(symbol.node, source);
  const hierarchy = extractHierarchy(symbol.node, source);

  return {
    signature: {
      name: symbol.name,
      kind: symbol.kind,
      signature,
      location: {
        filePath: absolutePath,
        start: { row: symbol.node.startPosition.row, column: symbol.node.startPosition.column },
        end: { row: symbol.node.endPosition.row, column: symbol.node.endPosition.column },
      },
    },
    callers: [],
    callees,
    hierarchy,
  };
}

function extractSignature(
  node: import("tree-sitter").SyntaxNode,
  source: string,
  kind: string,
  name: string,
): string {
  if (kind === "function") {
    const paramsField = node.childForFieldName("parameters");
    const returnTypeField = node.childForFieldName("return_type");

    let signature = `${name}`;
    if (paramsField) {
      signature += paramsField.text;
    } else {
      signature += "()";
    }
    if (returnTypeField) {
      signature += ` -> ${returnTypeField.text}`;
    }
    return signature;
  }

  if (kind === "class") {
    const parentField = node.childForFieldName("superclass");
    if (parentField) {
      return `class ${name} extends ${parentField.text}`;
    }
    return `class ${name}`;
  }

  return name;
}

function extractCallees(
  node: import("tree-sitter").SyntaxNode,
  source: string,
): SymbolRelation[] {
  const callees: SymbolRelation[] = [];
  const seen = new Set<string>();

  function visit(current: import("tree-sitter").SyntaxNode): void {
    if (CALL_NODE_TYPES.has(current.type)) {
      const functionField = current.childForFieldName("function");
      if (functionField && !seen.has(functionField.text)) {
        seen.add(functionField.text);
        callees.push({
          name: functionField.text,
          filePath: "",
          location: {
            start: { row: current.startPosition.row, column: current.startPosition.column },
            end: { row: current.endPosition.row, column: current.endPosition.column },
          },
        });
      }
    }

    for (const child of current.children) {
      visit(child);
    }
  }

  visit(node);
  return callees;
}

function extractHierarchy(
  node: import("tree-sitter").SyntaxNode,
  source: string,
): SymbolHierarchy {
  const hierarchy: SymbolHierarchy = {
    extends: null,
    implements: [],
    extendedBy: [],
  };

  const superclassField = node.childForFieldName("superclass");
  if (superclassField) {
    hierarchy.extends = superclassField.text;
  }

  const interfacesField = node.childForFieldName("interfaces");
  if (interfacesField) {
    for (const child of interfacesField.children) {
      if (child.type === "type_identifier" || child.type === "identifier") {
        hierarchy.implements.push(child.text);
      }
    }
  }

  return hierarchy;
}

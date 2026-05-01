import Parser from "tree-sitter";
import type { RegisteredLanguage } from "../languages/languageRegistry.js";
import { getCompiledQuery } from "./queryCatalog.js";

export type ReferenceKind = "reference" | "call";

export interface RawReferenceCapture {
  nameNode: Parser.SyntaxNode;
  rangeNode: Parser.SyntaxNode;
  referenceKind: ReferenceKind;
}

interface ReferenceQueryDefinition {
  source: string;
}

interface CaptureReferenceNodesInput {
  language: RegisteredLanguage;
  tree: Parser.Tree;
  targetName?: string;
}

const REFERENCE_QUERY_TYPES = ["reference_search", "call_site_search"] as const;

const REFERENCE_QUERY_DEFINITIONS: Record<string, ReferenceQueryDefinition> = {
  javascript: {
    source: `[
      (identifier)
      (property_identifier)
    ] @reference.name`,
  },
  typescript: {
    source: `[
      (identifier)
      (property_identifier)
      (type_identifier)
    ] @reference.name`,
  },
  tsx: {
    source: `[
      (identifier)
      (property_identifier)
      (type_identifier)
    ] @reference.name`,
  },
  python: {
    source: `(identifier) @reference.name`,
  },
  rust: {
    source: `[
      (identifier)
      (type_identifier)
    ] @reference.name`,
  },
};

export function listReferenceQueryTypes(): string[] {
  return [...REFERENCE_QUERY_TYPES];
}

export function captureReferenceNodes(input: CaptureReferenceNodesInput): RawReferenceCapture[] {
  const definition = REFERENCE_QUERY_DEFINITIONS[input.language.id];
  if (!definition) {
    return [];
  }

  const normalizedTargetName = input.targetName?.trim().toLowerCase() ?? null;
  const query = getCompiledQuery(input.language, definition);
  const matches = query.matches(input.tree.rootNode);
  const captures: RawReferenceCapture[] = [];

  for (const match of matches) {
    const nameCapture = match.captures.find((capture) => capture.name === "reference.name");
    if (!nameCapture) {
      continue;
    }

    const nameNode = nameCapture.node;
    if (normalizedTargetName && nameNode.text.toLowerCase() !== normalizedTargetName) {
      continue;
    }

    if (isDefinitionNameNode(nameNode)) {
      continue;
    }

    const rangeNode = findReferenceRangeNode(nameNode);
    captures.push({
      nameNode,
      rangeNode,
      referenceKind: rangeNode === nameNode ? "reference" : "call",
    });
  }

  return dedupeReferenceCaptures(captures).sort((left, right) => {
    if (left.nameNode.startIndex !== right.nameNode.startIndex) {
      return left.nameNode.startIndex - right.nameNode.startIndex;
    }

    if (left.referenceKind !== right.referenceKind) {
      return left.referenceKind === "call" ? -1 : 1;
    }

    return left.rangeNode.startIndex - right.rangeNode.startIndex;
  });
}

function dedupeReferenceCaptures(captures: RawReferenceCapture[]): RawReferenceCapture[] {
  const uniqueCaptures = new Map<string, RawReferenceCapture>();

  for (const capture of captures) {
    const key = `${capture.nameNode.startIndex}:${capture.nameNode.endIndex}`;
    const existingCapture = uniqueCaptures.get(key);
    if (!existingCapture || existingCapture.referenceKind === "reference" && capture.referenceKind === "call") {
      uniqueCaptures.set(key, capture);
    }
  }

  return [...uniqueCaptures.values()];
}

function findReferenceRangeNode(nameNode: Parser.SyntaxNode): Parser.SyntaxNode {
  let current: Parser.SyntaxNode | null = nameNode.parent;
  while (current) {
    if (isCallLikeNode(current) && isWithinInvokedExpression(current, nameNode)) {
      return current;
    }
    current = current.parent;
  }

  return nameNode;
}

function isWithinInvokedExpression(node: Parser.SyntaxNode, candidate: Parser.SyntaxNode): boolean {
  const invokedExpression = node.childForFieldName("function") ?? node.childForFieldName("constructor");
  if (!invokedExpression) {
    return false;
  }

  return invokedExpression.startIndex <= candidate.startIndex
    && invokedExpression.endIndex >= candidate.endIndex;
}

function isCallLikeNode(node: Parser.SyntaxNode): boolean {
  return node.type === "call_expression"
    || node.type === "new_expression"
    || node.type === "call";
}

function isDefinitionNameNode(node: Parser.SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent || !isDefinitionNodeType(parent.type)) {
    return false;
  }

  const nameField = parent.childForFieldName("name");
  return Boolean(nameField && sameNode(nameField, node));
}

function isDefinitionNodeType(type: string): boolean {
  return type === "class_declaration"
    || type === "class_definition"
    || type === "function_declaration"
    || type === "function_definition"
    || type === "interface_declaration"
    || type === "method_definition"
    || type === "variable_declarator";
}

function sameNode(left: Parser.SyntaxNode, right: Parser.SyntaxNode): boolean {
  return left.type === right.type
    && left.startIndex === right.startIndex
    && left.endIndex === right.endIndex;
}

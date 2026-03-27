import Parser from "tree-sitter";
import { createSourceRange } from "../../diagnostics/diagnosticFactory.js";
import { EnclosingContextSchema, type EnclosingContext } from "./contextTypes.js";

interface ExtractEnclosingContextInput {
  tree: Parser.Tree;
  startOffset: number;
  endOffset: number;
}

export function extractEnclosingContext(input: ExtractEnclosingContextInput): EnclosingContext | null {
  let current: Parser.SyntaxNode | null = input.tree.rootNode.descendantForIndex(input.startOffset, input.endOffset);

  while (current) {
    const contextKind = getEnclosingContextKind(current);
    if (contextKind) {
      return EnclosingContextSchema.parse({
        name: current.childForFieldName("name")?.text ?? null,
        kind: contextKind,
        range: createSourceRange(
          current.startPosition,
          current.endPosition,
          current.startIndex,
          current.endIndex,
        ),
      });
    }

    current = current.parent;
  }

  return null;
}

function getEnclosingContextKind(node: Parser.SyntaxNode): EnclosingContext["kind"] | null {
  switch (node.type) {
    case "class_declaration":
    case "class_definition":
      return "class";
    case "function_declaration":
    case "function_definition":
    case "variable_declarator":
      return "function";
    case "interface_declaration":
      return "interface";
    case "method_definition":
      return "method";
    default:
      return null;
  }
}

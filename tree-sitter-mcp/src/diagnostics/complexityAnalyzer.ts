import Parser from "tree-sitter";

export interface FunctionMetrics {
  name: string;
  location: {
    start: { row: number; column: number };
    end: { row: number; column: number };
    startIndex: number;
    endIndex: number;
  };
  metrics: {
    cyclomaticComplexity: number;
    linesOfCode: number;
    statementCount: number;
    maxNestingDepth: number;
  };
}

export interface ComplexityResult {
  functions: FunctionMetrics[];
  summary: {
    totalFunctions: number;
    averageComplexity: number;
    maxComplexity: number;
  };
}

const BRANCH_NODE_TYPES = new Set([
  "if_statement",
  "if_expression",
  "else_clause",
  "while_statement",
  "while_expression",
  "for_statement",
  "for_expression",
  "switch_statement",
  "switch_expression",
  "case_statement",
  "case_default_statement",
  "catch_clause",
  "conditional_expression",
  "ternary_expression",
  "binary_expression",
  "match_expression",
  "match_arm",
  "try_statement",
  "try_expression",
  "except_clause",
  "finally_clause",
  "break_statement",
  "continue_statement",
  "return_statement",
  "throw_statement",
  "yield_statement",
  "and_expression",
  "or_expression",
  "logical_and",
  "logical_or",
  "short_circuit_expression",
]);

const STATEMENT_NODE_TYPES = new Set([
  "expression_statement",
  "variable_declaration",
  "let_declaration",
  "const_declaration",
  "var_declaration",
  "assignment_expression",
  "call_expression",
  "return_statement",
  "break_statement",
  "continue_statement",
  "throw_statement",
  "if_statement",
  "while_statement",
  "for_statement",
  "switch_statement",
  "try_statement",
  "declaration",
  "local_variable_declaration",
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
  "procedure_declaration",
  "subroutine_declaration",
]);

export function analyzeComplexity(source: string, tree: Parser.Tree, symbolName?: string): ComplexityResult {
  const functions: FunctionMetrics[] = [];

  function visit(node: Parser.SyntaxNode, depth: number = 0): void {
    if (FUNCTION_NODE_TYPES.has(node.type)) {
      const name = extractFunctionName(node);
      if (name) {
        if (symbolName && name !== symbolName) {
          // Skip if filtering by symbol name and this doesn't match
        } else {
          const metrics = calculateMetrics(node, source);
          functions.push({
            name,
            location: {
              start: { row: node.startPosition.row, column: node.startPosition.column },
              end: { row: node.endPosition.row, column: node.endPosition.column },
              startIndex: node.startIndex,
              endIndex: node.endIndex,
            },
            metrics,
          });
        }
      }
    }

    for (const child of node.children) {
      visit(child, depth + 1);
    }
  }

  visit(tree.rootNode);

  const complexities = functions.map((f) => f.metrics.cyclomaticComplexity);
  const totalFunctions = functions.length;
  const averageComplexity = totalFunctions > 0
    ? Math.round((complexities.reduce((a, b) => a + b, 0) / totalFunctions) * 100) / 100
    : 0;
  const maxComplexity = totalFunctions > 0 ? Math.max(...complexities) : 0;

  return {
    functions,
    summary: {
      totalFunctions,
      averageComplexity,
      maxComplexity,
    },
  };
}

function extractFunctionName(node: Parser.SyntaxNode): string | null {
  const nameField = node.childForFieldName("name");
  if (nameField) {
    return nameField.text;
  }

  const declaratorField = node.childForFieldName("declarator");
  if (declaratorField) {
    const innerName = declaratorField.childForFieldName("name") ?? declaratorField.childForFieldName("declarator");
    if (innerName && innerName.type === "identifier") {
      return innerName.text;
    }
    if (innerName?.type === "function_declarator") {
      const fnName = innerName.childForFieldName("declarator");
      if (fnName && fnName.type === "identifier") {
        return fnName.text;
      }
    }
  }

  for (const child of node.children) {
    if (child.type === "identifier" || child.type === "property_identifier") {
      return child.text;
    }
  }

  return "(anonymous)";
}

function calculateMetrics(node: Parser.SyntaxNode, source: string): FunctionMetrics["metrics"] {
  let cyclomaticComplexity = 1;
  let statementCount = 0;
  let maxNestingDepth = 0;

  function countNodes(current: Parser.SyntaxNode, depth: number): void {
    if (BRANCH_NODE_TYPES.has(current.type)) {
      cyclomaticComplexity++;
    }

    if (STATEMENT_NODE_TYPES.has(current.type)) {
      statementCount++;
    }

    if (depth > maxNestingDepth) {
      maxNestingDepth = depth;
    }

    const isBranch = BRANCH_NODE_TYPES.has(current.type) && current.type !== node.type;
    const nextDepth = isBranch ? depth + 1 : depth;

    for (const child of current.children) {
      countNodes(child, nextDepth);
    }
  }

  countNodes(node, 0);

  const linesOfCode = node.endPosition.row - node.startPosition.row + 1;

  return {
    cyclomaticComplexity,
    linesOfCode,
    statementCount,
    maxNestingDepth,
  };
}

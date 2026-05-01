import JavaScript from "tree-sitter-javascript";
import Python from "tree-sitter-python";
import Rust from "tree-sitter-rust";
import TypeScript from "tree-sitter-typescript";
import { listDefinitionQueryTypes } from "../queries/definitionQueryCatalog.js";
import { listSupportedQueryTypes } from "../queries/queryCatalog.js";
import { listReferenceQueryTypes } from "../queries/referenceQueryCatalog.js";
import type { LanguageRegistry } from "./languageRegistry.js";

export function registerBuiltinGrammars(registry: LanguageRegistry): void {
  const queryTypes = [...new Set([
    ...listSupportedQueryTypes(),
    ...listDefinitionQueryTypes(),
    ...listReferenceQueryTypes(),
  ])];

  registry.register({
    id: "javascript",
    displayName: "JavaScript",
    grammarName: JavaScript.name,
    extensions: [".cjs", ".js", ".jsx", ".mjs"],
    parserLanguage: JavaScript,
    queryTypes,
  });

  registry.register({
    id: "python",
    displayName: "Python",
    grammarName: Python.name,
    extensions: [".py"],
    parserLanguage: Python,
    queryTypes,
  });

  registry.register({
    id: "rust",
    displayName: "Rust",
    grammarName: Rust.name,
    extensions: [".rs"],
    parserLanguage: Rust,
    queryTypes,
  });

  registry.register({
    id: "tsx",
    displayName: "TSX",
    grammarName: TypeScript.tsx.name,
    extensions: [".tsx"],
    parserLanguage: TypeScript.tsx,
    queryTypes,
  });

  registry.register({
    id: "typescript",
    displayName: "TypeScript",
    grammarName: TypeScript.typescript.name,
    extensions: [".cts", ".mts", ".ts"],
    parserLanguage: TypeScript.typescript,
    queryTypes,
  });
}

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLanguageRegistry } from "../src/languages/languageRegistry.js";
import { registerBuiltinGrammars } from "../src/languages/registerBuiltinGrammars.js";
import { parseWithDiagnostics } from "../src/parsing/parseWithDiagnostics.js";

test("parseWithDiagnostics parses source files larger than node-tree-sitter's default input buffer", async () => {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tree-sitter-mcp-large-parse-"));
  const sourcePath = path.join(workspaceRoot, "large.rs");
  const source = [
    "pub fn sentinel() -> i32 { 1 }",
    ...Array.from({ length: 2400 }, (_, index) => `pub fn generated_${index}() -> i32 { ${index} }`),
    "",
  ].join("\n");

  assert.ok(source.length > 32768);
  await fs.writeFile(sourcePath, source);

  const registry = createLanguageRegistry();
  registerBuiltinGrammars(registry);
  const language = registry.getByFilePath(sourcePath);
  assert.ok(language);

  const result = await parseWithDiagnostics({
    absolutePath: sourcePath,
    relativePath: "large.rs",
    language,
  });

  assert.equal(result.ok, true);
  if (!result.ok) {
    assert.fail(result.diagnostic.reason);
  }

  const firstFunction = result.tree.rootNode.descendantsOfType("function_item")[0];
  assert.equal(firstFunction?.childForFieldName("name")?.text, "sentinel");
});

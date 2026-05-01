import assert from "node:assert/strict";
import test from "node:test";
import { createLanguageRegistry } from "../src/languages/languageRegistry.js";
import { registerBuiltinGrammars } from "../src/languages/registerBuiltinGrammars.js";

test("builtin grammar registration is deterministic and extension-aware", () => {
  const registry = createLanguageRegistry();
  registerBuiltinGrammars(registry);

  assert.deepEqual(registry.list().map((language) => language.id), [
    "c",
    "cpp",
    "csharp",
    "go",
    "java",
    "javascript",
    "python",
    "rust",
    "tsx",
    "typescript",
  ]);

  assert.equal(registry.getByFilePath("example.c")?.id, "c");
  assert.equal(registry.getByFilePath("example.h")?.id, "c");
  assert.equal(registry.getByFilePath("example.cpp")?.id, "cpp");
  assert.equal(registry.getByFilePath("example.hpp")?.id, "cpp");
  assert.equal(registry.getByFilePath("example.cs")?.id, "csharp");
  assert.equal(registry.getByFilePath("example.go")?.id, "go");
  assert.equal(registry.getByFilePath("example.java")?.id, "java");
  assert.equal(registry.getByFilePath("example.ts")?.id, "typescript");
  assert.equal(registry.getByFilePath("example.tsx")?.id, "tsx");
  assert.equal(registry.getByFilePath("example.py")?.id, "python");
  assert.equal(registry.getByFilePath("example.js")?.id, "javascript");
  assert.equal(registry.getByFilePath("example.rs")?.id, "rust");
  assert.equal(registry.getByFilePath("README.md"), undefined);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createLanguageRegistry } from "../src/languages/languageRegistry.js";
import { registerBuiltinGrammars } from "../src/languages/registerBuiltinGrammars.js";

test("builtin grammar registration is deterministic and extension-aware", () => {
  const registry = createLanguageRegistry();
  registerBuiltinGrammars(registry);

  assert.deepEqual(registry.list().map((language) => language.id), [
    "javascript",
    "python",
    "tsx",
    "typescript",
  ]);

  assert.equal(registry.getByFilePath("example.ts")?.id, "typescript");
  assert.equal(registry.getByFilePath("example.tsx")?.id, "tsx");
  assert.equal(registry.getByFilePath("example.py")?.id, "python");
  assert.equal(registry.getByFilePath("example.js")?.id, "javascript");
  assert.equal(registry.getByFilePath("README.md"), undefined);
});

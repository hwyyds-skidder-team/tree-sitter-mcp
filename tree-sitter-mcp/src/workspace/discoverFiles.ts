import fs from "node:fs/promises";
import path from "node:path";
import type { LanguageRegistry } from "../languages/languageRegistry.js";
import { createExclusionPolicy } from "./exclusionPolicy.js";
import { normalizeAbsolutePath, relativeToWorkspace } from "./resolveWorkspace.js";
import type { SearchableFileRecord, UnsupportedFileRecord } from "./workspaceState.js";

export interface DiscoveryResult {
  searchableFiles: SearchableFileRecord[];
  unsupportedFiles: UnsupportedFileRecord[];
}

export async function discoverWorkspaceFiles(
  root: string,
  exclusions: string[],
  languageRegistry: LanguageRegistry,
): Promise<DiscoveryResult> {
  const normalizedRoot = normalizeAbsolutePath(root);
  const exclusionPolicy = createExclusionPolicy(normalizedRoot, exclusions);
  const searchableFiles: SearchableFileRecord[] = [];
  const unsupportedFiles: UnsupportedFileRecord[] = [];

  async function walkDirectory(currentDirectory: string): Promise<void> {
    const entries = await fs.readdir(currentDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of entries) {
      const absolutePath = path.join(currentDirectory, entry.name);
      if (exclusionPolicy.shouldExclude(absolutePath)) {
        continue;
      }

      if (entry.isDirectory()) {
        await walkDirectory(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const relativePath = relativeToWorkspace(normalizedRoot, absolutePath);
      const registeredLanguage = languageRegistry.getByFilePath(absolutePath);

      if (registeredLanguage) {
        searchableFiles.push({
          path: absolutePath,
          relativePath,
          languageId: registeredLanguage.id,
          grammarName: registeredLanguage.grammarName,
        });
        continue;
      }

      unsupportedFiles.push({
        path: absolutePath,
        relativePath,
        reason: describeUnsupportedFile(absolutePath),
        extension: path.extname(absolutePath).toLowerCase() || null,
      });
    }
  }

  await walkDirectory(normalizedRoot);

  searchableFiles.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  unsupportedFiles.sort((left, right) => left.relativePath.localeCompare(right.relativePath));

  return {
    searchableFiles,
    unsupportedFiles,
  };
}

function describeUnsupportedFile(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension.length === 0) {
    return "File has no extension and no registered Tree-sitter grammar.";
  }

  return `No registered Tree-sitter grammar is configured for ${extension} files.`;
}

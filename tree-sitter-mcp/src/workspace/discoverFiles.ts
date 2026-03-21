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

export interface WorkspaceDiscoveryEntry extends DiscoveryResult {
  root: string;
}

export interface ConfiguredWorkspaceDiscoveryResult extends DiscoveryResult {
  workspaces: WorkspaceDiscoveryEntry[];
}

export async function discoverWorkspaceFiles(
  root: string,
  exclusions: string[],
  languageRegistry: LanguageRegistry,
): Promise<DiscoveryResult> {
  const discovery = await discoverConfiguredWorkspaces([root], exclusions, languageRegistry);

  return {
    searchableFiles: discovery.searchableFiles,
    unsupportedFiles: discovery.unsupportedFiles,
  };
}

export async function discoverConfiguredWorkspaces(
  roots: readonly string[],
  exclusions: string[],
  languageRegistry: LanguageRegistry,
): Promise<ConfiguredWorkspaceDiscoveryResult> {
  const workspaces: WorkspaceDiscoveryEntry[] = [];
  const searchableFiles: SearchableFileRecord[] = [];
  const unsupportedFiles: UnsupportedFileRecord[] = [];

  for (const root of roots) {
    const workspace = await discoverSingleWorkspace(root, exclusions, languageRegistry);
    workspaces.push(workspace);
    searchableFiles.push(...workspace.searchableFiles);
    unsupportedFiles.push(...workspace.unsupportedFiles);
  }

  return {
    searchableFiles,
    unsupportedFiles,
    workspaces,
  };
}

async function discoverSingleWorkspace(
  root: string,
  exclusions: string[],
  languageRegistry: LanguageRegistry,
): Promise<WorkspaceDiscoveryEntry> {
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
          workspaceRoot: normalizedRoot,
          path: absolutePath,
          relativePath,
          languageId: registeredLanguage.id,
          grammarName: registeredLanguage.grammarName,
        });
        continue;
      }

      unsupportedFiles.push({
        workspaceRoot: normalizedRoot,
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
    root: normalizedRoot,
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

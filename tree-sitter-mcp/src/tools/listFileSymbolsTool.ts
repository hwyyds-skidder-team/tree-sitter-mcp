import fs from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDiagnostic, DiagnosticSchema } from "../diagnostics/diagnosticFactory.js";
import { parseWithDiagnostics } from "../parsing/parseWithDiagnostics.js";
import { extractSymbols, SymbolMatchSchema } from "../queries/queryCatalog.js";
import type { ServerContext } from "../server/serverContext.js";
import { createExclusionPolicy } from "../workspace/exclusionPolicy.js";
import {
  findContainingWorkspaceRoot,
  normalizeAbsolutePath,
  relativeToWorkspace,
  resolveConfiguredWorkspacePath,
  resolveWorkspacePath,
} from "../workspace/resolveWorkspace.js";

const ListFileSymbolsInputSchema = z.object({
  path: z.string().min(1),
  workspaceRoot: z.string().min(1).optional(),
});

const ListFileSymbolsOutputSchema = z.object({
  workspaceRoot: z.string().nullable(),
  filePath: z.string(),
  relativePath: z.string().nullable(),
  languageId: z.string().nullable(),
  symbols: z.array(SymbolMatchSchema),
  diagnostics: z.array(DiagnosticSchema),
});

export function registerListFileSymbolsTool(server: McpServer, context: ServerContext): void {
  server.registerTool(
    "list_file_symbols",
    {
      title: "List File Symbols",
      description: "Parse one supported source file on demand and return extracted symbols plus actionable diagnostics.",
      inputSchema: ListFileSymbolsInputSchema,
      outputSchema: ListFileSymbolsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const configuredRoots = context.workspace.roots.length > 0
        ? context.workspace.roots
        : context.workspace.root
          ? [context.workspace.root]
          : [];

      if (configuredRoots.length === 0) {
        const diagnostic = createDiagnostic({
          code: "workspace_not_set",
          message: "No workspace is configured.",
          reason: "The server does not know which repository root to trust yet.",
          nextStep: "Call set_workspace before listing file symbols.",
        });

        return {
          isError: true,
          content: [{ type: "text" as const, text: diagnostic.message }],
          structuredContent: {
            workspaceRoot: null,
            filePath: input.path,
            relativePath: null,
            languageId: null,
            symbols: [],
            diagnostics: [diagnostic],
          },
        };
      }

      let requestedWorkspaceRoot: string | null = null;
      if (input.workspaceRoot) {
        requestedWorkspaceRoot = normalizeAbsolutePath(input.workspaceRoot);
        if (!configuredRoots.includes(requestedWorkspaceRoot)) {
          const diagnostic = createDiagnostic({
            code: "workspace_root_invalid",
            message: "Requested workspace root is not configured.",
            reason: `Workspace root ${requestedWorkspaceRoot} is not part of the active workspace set.`,
            nextStep: "Use a configured workspaceRoot from prior results or call set_workspace with that root.",
            filePath: input.workspaceRoot,
          });

          return {
            isError: true,
            content: [{ type: "text" as const, text: diagnostic.message }],
            structuredContent: {
              workspaceRoot: null,
              filePath: input.path,
              relativePath: null,
              languageId: null,
              symbols: [],
              diagnostics: [diagnostic],
            },
          };
        }
      }

      const targetRoots = requestedWorkspaceRoot ? [requestedWorkspaceRoot] : configuredRoots;

      let absolutePath: string;
      let workspaceRoot: string;
      try {
        ({ absolutePath, workspaceRoot } = await resolveRequestedFileTarget(targetRoots, input.path));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const diagnostic = createDiagnostic({
          code: "workspace_path_out_of_scope",
          message: message === AMBIGUOUS_WORKSPACE_FILE_MESSAGE
            ? AMBIGUOUS_WORKSPACE_FILE_MESSAGE
            : "Requested file is outside the configured workspace root.",
          reason: message,
          nextStep: message === AMBIGUOUS_WORKSPACE_FILE_MESSAGE
            ? "Provide workspaceRoot to disambiguate the requested relative path."
            : "Use a path inside the active workspace or reset the workspace root.",
          filePath: input.path,
        });

        return {
          isError: true,
          content: [{ type: "text" as const, text: diagnostic.message }],
          structuredContent: {
            workspaceRoot: requestedWorkspaceRoot ?? context.workspace.root,
            filePath: input.path,
            relativePath: null,
            languageId: null,
            symbols: [],
            diagnostics: [diagnostic],
          },
        };
      }

      const exclusionPolicy = createExclusionPolicy(workspaceRoot, context.workspace.exclusions);
      if (exclusionPolicy.shouldExclude(absolutePath)) {
        const match = exclusionPolicy.explain(absolutePath);
        const diagnostic = createDiagnostic({
          code: "file_excluded",
          message: "Requested file is excluded by the active workspace policy.",
          reason: match ? `Matched exclusion pattern ${match.pattern}.` : "Matched an active exclusion rule.",
          nextStep: "Adjust additionalExclusions in set_workspace or target a non-excluded file.",
          filePath: absolutePath,
          relativePath: relativeToWorkspace(workspaceRoot, absolutePath),
        });

        return {
          isError: true,
          content: [{ type: "text" as const, text: diagnostic.message }],
          structuredContent: {
            workspaceRoot,
            filePath: absolutePath,
            relativePath: diagnostic.relativePath ?? null,
            languageId: null,
            symbols: [],
            diagnostics: [diagnostic],
          },
        };
      }

      const relativePath = relativeToWorkspace(workspaceRoot, absolutePath);
      const language = context.languageRegistry.getByFilePath(absolutePath);
      if (!language) {
        const diagnostic = createDiagnostic({
          code: "unsupported_file",
          message: `No registered Tree-sitter grammar supports ${path.extname(absolutePath) || "this file"}.`,
          reason: "Only files mapped to a registered language can be parsed semantically.",
          nextStep: "Inspect get_capabilities for supported languages or choose a supported source file.",
          filePath: absolutePath,
          relativePath,
        });

        return {
          isError: true,
          content: [{ type: "text" as const, text: diagnostic.message }],
          structuredContent: {
            workspaceRoot,
            filePath: absolutePath,
            relativePath,
            languageId: null,
            symbols: [],
            diagnostics: [diagnostic],
          },
        };
      }

      const parseResult = await parseWithDiagnostics({
        absolutePath,
        relativePath,
        language,
      });

      if (!parseResult.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: parseResult.diagnostic.message }],
          structuredContent: {
            workspaceRoot,
            filePath: absolutePath,
            relativePath,
            languageId: language.id,
            symbols: [],
            diagnostics: [parseResult.diagnostic],
          },
        };
      }

      const symbols = extractSymbols({
        language,
        workspaceRoot,
        absolutePath,
        relativePath,
        source: parseResult.source,
        tree: parseResult.tree,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${symbols.length} symbols in ${relativePath}.`,
          },
        ],
        structuredContent: {
          workspaceRoot,
          filePath: absolutePath,
          relativePath,
          languageId: language.id,
          symbols,
          diagnostics: [],
        },
      };
    },
  );
}

const AMBIGUOUS_WORKSPACE_FILE_MESSAGE = "Requested file is ambiguous across configured workspaces.";

async function resolveRequestedFileTarget(
  targetRoots: readonly string[],
  requestedPath: string,
): Promise<{ absolutePath: string; workspaceRoot: string }> {
  const trimmedPath = requestedPath.trim();
  if (trimmedPath.length === 0) {
    throw new Error("Path is required.");
  }

  if (isAbsoluteWorkspacePath(trimmedPath)) {
    const absolutePath = resolveConfiguredWorkspacePath(targetRoots, trimmedPath);
    const workspaceRoot = findContainingWorkspaceRoot(targetRoots, absolutePath);
    if (!workspaceRoot) {
      throw new Error(`Path escapes the configured workspace roots: ${requestedPath}`);
    }

    return {
      absolutePath,
      workspaceRoot,
    };
  }

  const existingCandidates = (
    await Promise.all(targetRoots.map(async (root) => {
      const absolutePath = resolveWorkspacePath(root, trimmedPath);
      try {
        const stats = await fs.stat(absolutePath);
        if (!stats.isFile()) {
          return null;
        }

        return {
          absolutePath,
          workspaceRoot: root,
        };
      } catch {
        return null;
      }
    }))
  ).filter((candidate): candidate is { absolutePath: string; workspaceRoot: string } => candidate !== null);

  if (existingCandidates.length > 1) {
    throw new Error(AMBIGUOUS_WORKSPACE_FILE_MESSAGE);
  }

  if (existingCandidates.length === 1) {
    return existingCandidates[0];
  }

  const workspaceRoot = targetRoots[0];
  return {
    absolutePath: resolveWorkspacePath(workspaceRoot, trimmedPath),
    workspaceRoot,
  };
}

function isAbsoluteWorkspacePath(targetPath: string): boolean {
  return path.isAbsolute(targetPath)
    || path.win32.isAbsolute(targetPath)
    || path.posix.isAbsolute(targetPath);
}

import fs from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDiagnostic, DiagnosticSchema } from "../diagnostics/diagnosticFactory.js";
import { parseWithDiagnostics } from "../parsing/parseWithDiagnostics.js";
import type { ServerContext } from "../server/serverContext.js";
import { createExclusionPolicy } from "../workspace/exclusionPolicy.js";
import {
  findContainingWorkspaceRoot,
  normalizeAbsolutePath,
  relativeToWorkspace,
  resolveConfiguredWorkspacePath,
  resolveWorkspacePath,
} from "../workspace/resolveWorkspace.js";
import { analyzeComplexity } from "../diagnostics/complexityAnalyzer.js";
import type { ComplexityResult } from "../diagnostics/complexityAnalyzer.js";

const AnalyzeComplexityInputSchema = z.object({
  path: z.string().min(1),
  workspaceRoot: z.string().min(1).optional(),
  symbolName: z.string().min(1).optional(),
});

const LocationSchema = z.object({
  start: z.object({ row: z.number(), column: z.number() }),
  end: z.object({ row: z.number(), column: z.number() }),
  startIndex: z.number(),
  endIndex: z.number(),
});

const FunctionMetricsSchema = z.object({
  name: z.string(),
  location: LocationSchema,
  metrics: z.object({
    cyclomaticComplexity: z.number(),
    linesOfCode: z.number(),
    statementCount: z.number(),
    maxNestingDepth: z.number(),
  }),
});

const AnalyzeComplexityOutputSchema = z.object({
  workspaceRoot: z.string().nullable(),
  filePath: z.string(),
  relativePath: z.string().nullable(),
  languageId: z.string().nullable(),
  functions: z.array(FunctionMetricsSchema),
  summary: z.object({
    totalFunctions: z.number(),
    averageComplexity: z.number(),
    maxComplexity: z.number(),
  }),
  diagnostics: z.array(DiagnosticSchema),
});

export function registerAnalyzeComplexityTool(server: McpServer, context: ServerContext): void {
  server.registerTool(
    "analyze_complexity",
    {
      title: "Analyze Code Complexity",
      description: "Analyze cyclomatic complexity, lines of code, statement count, and nesting depth for functions in a source file.",
      inputSchema: AnalyzeComplexityInputSchema,
      outputSchema: AnalyzeComplexityOutputSchema,
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
          nextStep: "Call set_workspace before analyzing complexity.",
        });

        return {
          isError: true,
          content: [{ type: "text" as const, text: diagnostic.message }],
          structuredContent: {
            workspaceRoot: null,
            filePath: input.path,
            relativePath: null,
            languageId: null,
            functions: [],
            summary: { totalFunctions: 0, averageComplexity: 0, maxComplexity: 0 },
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
              functions: [],
              summary: { totalFunctions: 0, averageComplexity: 0, maxComplexity: 0 },
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
            functions: [],
            summary: { totalFunctions: 0, averageComplexity: 0, maxComplexity: 0 },
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
            functions: [],
            summary: { totalFunctions: 0, averageComplexity: 0, maxComplexity: 0 },
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
            functions: [],
            summary: { totalFunctions: 0, averageComplexity: 0, maxComplexity: 0 },
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
            functions: [],
            summary: { totalFunctions: 0, averageComplexity: 0, maxComplexity: 0 },
            diagnostics: [parseResult.diagnostic],
          },
        };
      }

      const result = analyzeComplexity(parseResult.source, parseResult.tree, input.symbolName);

      const highComplexity = result.functions.filter((f) => f.metrics.cyclomaticComplexity > 10);
      const summaryText = highComplexity.length > 0
        ? `Analyzed ${result.summary.totalFunctions} functions. ${highComplexity.length} functions have high complexity (>10). Max complexity: ${result.summary.maxComplexity}.`
        : `Analyzed ${result.summary.totalFunctions} functions. Average complexity: ${result.summary.averageComplexity}. Max complexity: ${result.summary.maxComplexity}.`;

      return {
        content: [
          {
            type: "text" as const,
            text: summaryText,
          },
        ],
        structuredContent: {
          workspaceRoot,
          filePath: absolutePath,
          relativePath,
          languageId: language.id,
          functions: result.functions,
          summary: result.summary,
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

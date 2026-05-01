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
import { getSymbolContext as getSymbolContextData, type SymbolContext } from "../context/symbolContext.js";
import { searchDefinitions } from "../definitions/searchDefinitions.js";
import { searchReferences } from "../references/searchReferences.js";

const GetSymbolContextInputSchema = z.object({
  symbolName: z.string().min(1),
  filePath: z.string().min(1).optional(),
  workspaceRoot: z.string().min(1).optional(),
});

const SymbolRelationSchema = z.object({
  name: z.string(),
  filePath: z.string(),
  location: z.object({
    start: z.object({ row: z.number(), column: z.number() }),
    end: z.object({ row: z.number(), column: z.number() }),
  }),
});

const SymbolHierarchySchema = z.object({
  extends: z.string().nullable(),
  implements: z.array(z.string()),
  extendedBy: z.array(z.string()),
});

const SymbolSignatureSchema = z.object({
  name: z.string(),
  kind: z.string(),
  signature: z.string(),
  location: z.object({
    filePath: z.string(),
    start: z.object({ row: z.number(), column: z.number() }),
    end: z.object({ row: z.number(), column: z.number() }),
  }),
});

const GetSymbolContextOutputSchema = z.object({
  symbolName: z.string(),
  signature: SymbolSignatureSchema.nullable(),
  callers: z.array(SymbolRelationSchema),
  callees: z.array(SymbolRelationSchema),
  hierarchy: SymbolHierarchySchema,
  definitions: z.array(z.object({
    name: z.string(),
    filePath: z.string(),
    relativePath: z.string(),
    kind: z.string(),
    snippet: z.string(),
  })),
  references: z.array(z.object({
    name: z.string(),
    filePath: z.string(),
    relativePath: z.string(),
    kind: z.string(),
    snippet: z.string(),
  })),
  diagnostics: z.array(DiagnosticSchema),
});

export function registerGetSymbolContextTool(server: McpServer, context: ServerContext): void {
  server.registerTool(
    "get_symbol_context",
    {
      title: "Get Symbol Context",
      description: "Get the complete context for a symbol: signature, callers, callees, hierarchy, definitions, and references.",
      inputSchema: GetSymbolContextInputSchema,
      outputSchema: GetSymbolContextOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      if (!context.workspace.root) {
        const diagnostic = createDiagnostic({
          code: "workspace_not_set",
          message: "No workspace is configured.",
          reason: "The server does not know which repository root to trust yet.",
          nextStep: "Call set_workspace before getting symbol context.",
        });

        return {
          isError: true,
          content: [{ type: "text" as const, text: diagnostic.message }],
          structuredContent: {
            symbolName: input.symbolName,
            signature: null,
            callers: [],
            callees: [],
            hierarchy: { extends: null, implements: [], extendedBy: [] },
            definitions: [],
            references: [],
            diagnostics: [diagnostic],
          },
        };
      }

      let signature: SymbolContext["signature"] | null = null;
      let callees: SymbolContext["callees"] = [];
      let hierarchy: SymbolContext["hierarchy"] = { extends: null, implements: [], extendedBy: [] };
      const diagnostics: z.infer<typeof DiagnosticSchema>[] = [];

      if (input.filePath) {
        const configuredRoots = context.workspace.roots.length > 0
          ? context.workspace.roots
          : [context.workspace.root];

        let absolutePath: string;
        let workspaceRoot: string;
        try {
          ({ absolutePath, workspaceRoot } = await resolveRequestedFileTarget(configuredRoots, input.filePath));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const diagnostic = createDiagnostic({
            code: "workspace_path_out_of_scope",
            message: "Requested file is outside the configured workspace root.",
            reason: message,
            nextStep: "Use a path inside the active workspace or reset the workspace root.",
            filePath: input.filePath,
          });

          return {
            isError: true,
            content: [{ type: "text" as const, text: diagnostic.message }],
            structuredContent: {
              symbolName: input.symbolName,
              signature: null,
              callers: [],
              callees: [],
              hierarchy: { extends: null, implements: [], extendedBy: [] },
              definitions: [],
              references: [],
              diagnostics: [diagnostic],
            },
          };
        }

        const relativePath = relativeToWorkspace(workspaceRoot, absolutePath);
        const language = context.languageRegistry.getByFilePath(absolutePath);

        if (language) {
          const symbolContext = await getSymbolContextData(
            absolutePath,
            relativePath,
            language,
            input.symbolName,
          );

          if (symbolContext) {
            signature = symbolContext.signature;
            callees = symbolContext.callees;
            hierarchy = symbolContext.hierarchy;
          }
        }
      }

      const defResult = await searchDefinitions(context, {
        query: input.symbolName,
        limit: 20,
      });

      const refResult = await searchReferences(context, {
        lookup: { name: input.symbolName },
        limit: 50,
      });

      const definitions = defResult.results.map((def) => ({
        name: def.name,
        filePath: def.filePath,
        relativePath: def.relativePath,
        kind: def.kind,
        snippet: def.snippet,
      }));

      const references = refResult.results.map((ref) => ({
        name: ref.name,
        filePath: ref.filePath,
        relativePath: ref.relativePath,
        kind: ref.referenceKind,
        snippet: ref.snippet,
      }));

      const text = signature
        ? `Found context for ${input.symbolName}: ${definitions.length} definition(s), ${references.length} reference(s), ${callees.length} callee(s).`
        : `Found ${definitions.length} definition(s) and ${references.length} reference(s) for ${input.symbolName}.`;

      return {
        content: [{ type: "text" as const, text }],
        structuredContent: {
          symbolName: input.symbolName,
          signature,
          callers: [],
          callees,
          hierarchy,
          definitions,
          references,
          diagnostics: [...diagnostics, ...defResult.diagnostics, ...refResult.diagnostics],
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

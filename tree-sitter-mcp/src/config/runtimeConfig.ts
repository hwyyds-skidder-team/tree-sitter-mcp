import os from "node:os";
import path from "node:path";

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface RuntimeConfig {
  name: string;
  version: string;
  logLevel: LogLevel;
  defaultExclusions: string[];
  indexRootDir: string;
  indexSchemaVersion: string;
}

const DEFAULT_EXCLUSIONS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "out",
  "vendor",
  "vendors",
  "generated",
  "__generated__",
  "__pycache__",
  ".venv",
  "venv",
];

const DEFAULT_INDEX_SCHEMA_VERSION = "1";
const DEFAULT_INDEX_ROOT_DIR = path.join(os.homedir(), ".tree-sitter-mcp", "indexes");

function parseLogLevel(value: string | undefined): LogLevel {
  switch (value) {
    case "error":
    case "warn":
    case "info":
    case "debug":
      return value;
    default:
      return "info";
  }
}

function resolveIndexRootDir(value: string | undefined): string {
  if (value === undefined) {
    return DEFAULT_INDEX_ROOT_DIR;
  }

  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    return DEFAULT_INDEX_ROOT_DIR;
  }

  return path.resolve(trimmedValue);
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return {
    name: env.TREE_SITTER_MCP_NAME ?? "tree-sitter-mcp",
    version: env.TREE_SITTER_MCP_VERSION ?? "0.1.0",
    logLevel: parseLogLevel(env.TREE_SITTER_MCP_LOG_LEVEL),
    defaultExclusions: [...DEFAULT_EXCLUSIONS],
    indexRootDir: resolveIndexRootDir(env.TREE_SITTER_MCP_INDEX_DIR),
    indexSchemaVersion: DEFAULT_INDEX_SCHEMA_VERSION,
  };
}

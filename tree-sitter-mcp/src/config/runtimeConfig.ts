export type LogLevel = "error" | "warn" | "info" | "debug";

export interface RuntimeConfig {
  name: string;
  version: string;
  logLevel: LogLevel;
  defaultExclusions: string[];
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

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return {
    name: env.TREE_SITTER_MCP_NAME ?? "tree-sitter-mcp",
    version: env.TREE_SITTER_MCP_VERSION ?? "0.1.0",
    logLevel: parseLogLevel(env.TREE_SITTER_MCP_LOG_LEVEL),
    defaultExclusions: [...DEFAULT_EXCLUSIONS],
  };
}

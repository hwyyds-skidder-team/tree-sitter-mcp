import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ZodType } from "zod";

export function validateToolInput<TInput>(
  toolName: string,
  schema: ZodType<TInput>,
  input: unknown,
): TInput {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return parsed.data;
  }

  throw new McpError(
    ErrorCode.InvalidParams,
    `Input validation error: Invalid arguments for tool ${toolName}: ${parsed.error.message}`,
  );
}

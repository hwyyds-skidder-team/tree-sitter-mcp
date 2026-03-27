import { ContextSnippetSchema, type ContextSnippet } from "./contextTypes.js";

interface CreateContextSnippetInput {
  source: string;
  startOffset: number;
  endOffset: number;
  maxLength?: number;
}

export function createContextSnippet(input: CreateContextSnippetInput): ContextSnippet {
  const maxLength = input.maxLength ?? 160;
  const padding = Math.max(24, Math.floor(maxLength / 2));
  const rawStart = Math.max(0, input.startOffset - padding);
  const rawEnd = Math.min(input.source.length, input.endOffset + padding);
  const rawSnippet = input.source.slice(rawStart, rawEnd).trim().replace(/\s+/g, " ");

  if (rawSnippet.length <= maxLength) {
    return ContextSnippetSchema.parse({
      text: rawSnippet,
      truncated: false,
    });
  }

  const centeredStart = Math.max(0, Math.floor((rawSnippet.length - maxLength) / 2));
  const truncatedText = `${rawSnippet.slice(centeredStart, centeredStart + maxLength - 3).trim()}...`;

  return ContextSnippetSchema.parse({
    text: truncatedText,
    truncated: true,
  });
}

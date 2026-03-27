import assert from "node:assert/strict";
import test from "node:test";
import {
  collectDirectRelationshipEdges,
  createRelationshipEdgeKey,
  sortRelationshipEdges,
} from "../src/relationships/relationshipTraversal.js";

test("relationshipTraversal exports reusable helpers for direct edge collection and ordering", () => {
  assert.equal(typeof collectDirectRelationshipEdges, "function");
  assert.equal(typeof createRelationshipEdgeKey, "function");
  assert.equal(typeof sortRelationshipEdges, "function");
});

test("sortRelationshipEdges keeps canonical hop, kind, workspace, and offset ordering", () => {
  const outgoingReference = {
    relationshipKind: "outgoing_reference",
    hopCount: 1,
    relatedSymbol: {
      name: "formatName",
      kind: "function",
      languageId: "typescript",
      workspaceRoot: "/workspace-a",
      filePath: "/workspace-a/src/core.ts",
      relativePath: "src/core.ts",
      range: {
        start: { line: 1, column: 1, offset: 0 },
        end: { line: 1, column: 10, offset: 9 },
      },
      selectionRange: {
        start: { line: 1, column: 1, offset: 5 },
        end: { line: 1, column: 10, offset: 14 },
      },
      containerName: null,
      snippet: "formatName",
    },
    evidence: {
      name: "formatName",
      referenceKind: "reference",
      symbolKind: "function",
      languageId: "typescript",
      workspaceRoot: "/workspace-a",
      filePath: "/workspace-a/src/core.ts",
      relativePath: "src/core.ts",
      range: {
        start: { line: 5, column: 1, offset: 40 },
        end: { line: 5, column: 10, offset: 49 },
      },
      selectionRange: {
        start: { line: 5, column: 1, offset: 41 },
        end: { line: 5, column: 10, offset: 50 },
      },
      containerName: "helper",
      snippet: "formatName",
    },
  } as const;
  const incomingCall = {
    ...outgoingReference,
    relationshipKind: "incoming_call",
    relatedSymbol: {
      ...outgoingReference.relatedSymbol,
      name: "sayHello",
      selectionRange: {
        start: { line: 2, column: 1, offset: 15 },
        end: { line: 2, column: 8, offset: 22 },
      },
    },
  } as const;
  const secondHop = {
    ...outgoingReference,
    hopCount: 2,
  } as const;

  const sorted = sortRelationshipEdges(
    [outgoingReference, secondHop, incomingCall],
    ["/workspace-a", "/workspace-b"],
  );

  assert.deepEqual(sorted.map((edge) => [edge.hopCount, edge.relationshipKind]), [
    [1, "incoming_call"],
    [1, "outgoing_reference"],
    [2, "outgoing_reference"],
  ]);
  assert.equal(createRelationshipEdgeKey(sorted[0]).length > 0, true);
});

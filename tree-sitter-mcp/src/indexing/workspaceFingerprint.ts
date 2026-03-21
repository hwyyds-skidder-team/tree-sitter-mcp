import { createHash } from "node:crypto";
import { normalizeAbsolutePath } from "../workspace/resolveWorkspace.js";

export interface WorkspaceFingerprintInput {
  root: string;
  exclusions: string[];
  indexSchemaVersion: string;
}

function normalizeExclusions(exclusions: string[]): string[] {
  return [...new Set(
    exclusions
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )].sort();
}

export function createWorkspaceFingerprint({
  root,
  exclusions,
  indexSchemaVersion,
}: WorkspaceFingerprintInput): string {
  const payload = {
    root: normalizeAbsolutePath(root),
    exclusions: normalizeExclusions(exclusions),
    indexSchemaVersion,
  };

  return createHash("sha1").update(JSON.stringify(payload)).digest("hex");
}

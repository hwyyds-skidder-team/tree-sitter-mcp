import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { RuntimeConfig } from "../../config/runtimeConfig.js";
import {
  IndexedFileSemanticRecordSchema,
  type IndexedFileSemanticRecord,
  WorkspaceIndexManifestSchema,
  type WorkspaceIndexManifest,
} from "./indexTypes.js";

const MANIFEST_FILE_NAME = "manifest.json";
const RECORDS_FILE_NAME = "records.json";

const IndexedFileSemanticRecordsSchema = z.array(IndexedFileSemanticRecordSchema);

export interface WorkspaceIndexStorageLocation {
  directory: string;
  manifestPath: string;
  recordsPath: string;
}

export interface WorkspaceIndexSnapshot {
  manifest: WorkspaceIndexManifest;
  records: IndexedFileSemanticRecord[];
}

export type LoadWorkspaceIndexResult =
  | ({
      status: "loaded";
      manifest: WorkspaceIndexManifest;
      records: IndexedFileSemanticRecord[];
    } & WorkspaceIndexStorageLocation)
  | ({
      status: "missing";
    } & WorkspaceIndexStorageLocation)
  | ({
      status: "schema_mismatch";
      expectedSchemaVersion: string;
      actualSchemaVersion: string;
    } & WorkspaceIndexStorageLocation)
  | ({
      status: "invalid";
      reason: string;
    } & WorkspaceIndexStorageLocation);

function resolveWorkspaceIndexStorageLocation(
  indexRootDir: string,
  workspaceFingerprint: string,
): WorkspaceIndexStorageLocation {
  const directory = path.join(indexRootDir, workspaceFingerprint);

  return {
    directory,
    manifestPath: path.join(directory, MANIFEST_FILE_NAME),
    recordsPath: path.join(directory, RECORDS_FILE_NAME),
  };
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const contents = await fs.readFile(filePath, "utf8");
  return JSON.parse(contents) as unknown;
}

function ensureIndexedFileCountMatches(
  manifest: WorkspaceIndexManifest,
  records: IndexedFileSemanticRecord[],
): void {
  if (manifest.indexedFileCount !== records.length) {
    throw new Error(
      `Manifest indexedFileCount ${manifest.indexedFileCount} does not match records length ${records.length}.`,
    );
  }
}

export async function loadWorkspaceIndex(
  config: Pick<RuntimeConfig, "indexRootDir" | "indexSchemaVersion">,
  workspaceFingerprint: string,
): Promise<LoadWorkspaceIndexResult> {
  const location = resolveWorkspaceIndexStorageLocation(config.indexRootDir, workspaceFingerprint);

  try {
    await fs.access(location.manifestPath);
    await fs.access(location.recordsPath);
  } catch {
    return {
      status: "missing",
      ...location,
    };
  }

  try {
    const manifestInput = await readJsonFile(location.manifestPath);

    if (
      typeof manifestInput === "object"
      && manifestInput !== null
      && "schemaVersion" in manifestInput
      && typeof manifestInput.schemaVersion === "string"
      && manifestInput.schemaVersion !== config.indexSchemaVersion
    ) {
      await fs.rm(location.directory, { recursive: true, force: true });

      return {
        status: "schema_mismatch",
        expectedSchemaVersion: config.indexSchemaVersion,
        actualSchemaVersion: manifestInput.schemaVersion,
        ...location,
      };
    }

    const manifest = WorkspaceIndexManifestSchema.parse(manifestInput);
    const records = IndexedFileSemanticRecordsSchema.parse(await readJsonFile(location.recordsPath));
    ensureIndexedFileCountMatches(manifest, records);

    return {
      status: "loaded",
      manifest,
      records,
      ...location,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    return {
      status: "invalid",
      reason,
      ...location,
    };
  }
}

export async function saveWorkspaceIndex(
  config: Pick<RuntimeConfig, "indexRootDir">,
  snapshot: WorkspaceIndexSnapshot,
): Promise<WorkspaceIndexStorageLocation> {
  const manifest = WorkspaceIndexManifestSchema.parse(snapshot.manifest);
  const records = IndexedFileSemanticRecordsSchema.parse(snapshot.records);
  ensureIndexedFileCountMatches(manifest, records);

  const location = resolveWorkspaceIndexStorageLocation(
    config.indexRootDir,
    manifest.workspaceFingerprint,
  );

  await fs.mkdir(location.directory, { recursive: true });
  await fs.writeFile(location.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fs.writeFile(location.recordsPath, `${JSON.stringify(records, null, 2)}\n`, "utf8");

  return location;
}

import type { DefinitionMatch } from "../definitions/definitionTypes.js";
import type { DependencyPathStep, DependencyResult } from "../dependencies/dependencyTypes.js";
import { getDependencyAnalysis, type GetDependencyAnalysisResult } from "../dependencies/getDependencyAnalysis.js";
import type { Diagnostic } from "../diagnostics/diagnosticFactory.js";
import type { Pagination } from "../results/paginateResults.js";
import { paginateResults } from "../results/paginateResults.js";
import { createWorkspaceBreakdown, type WorkspaceBreakdown } from "../results/workspaceBreakdown.js";
import type { SearchFreshness } from "../indexing/indexTypes.js";
import type { RelationshipKind } from "../relationships/relationshipTypes.js";
import type { ServerContext } from "../server/serverContext.js";
import type {
  ConfidenceLevel,
  ImpactAreaSummary,
  ImpactAnalysisRequest,
  ImpactBlastRadius,
  ImpactSeverity,
  ImpactTarget,
} from "./impactTypes.js";

export interface AnalyzeImpactResult {
  seed: DefinitionMatch | null;
  targets: ImpactTarget[];
  blastRadius: ImpactBlastRadius;
  pagination: Pagination;
  freshness: SearchFreshness;
  diagnostic: Diagnostic | null;
  diagnostics: Diagnostic[];
  searchedFiles: number;
  matchedFiles: number;
  workspaceRoots: string[];
  workspaceBreakdown: WorkspaceBreakdown[];
  dependencyResult: GetDependencyAnalysisResult | null;
}

export async function analyzeImpact(
  context: ServerContext,
  request: ImpactAnalysisRequest,
): Promise<AnalyzeImpactResult> {
  const depResult = await getDependencyAnalysis(context, {
    symbol: request.symbol,
    lookup: request.lookup,
    workspaceRoots: request.workspaceRoots,
    language: request.language,
    relationshipKinds: request.relationshipKinds,
    maxDepth: request.maxDepth,
    limit: 200, // fetch all for full scoring, paginate afterward
    offset: 0,
  });

  const diagnostics = [...depResult.diagnostics];

  if (!depResult.target) {
    return emptyImpactResult(depResult, diagnostics);
  }

  const scoredTargets = scoreImpactTargets(depResult.results, depResult.target);

  const sortedTargets = sortByImpactPriority(scoredTargets);

  const limit = request.limit ?? 50;
  const offset = request.offset ?? 0;
  const pagedTargets = paginateResults(sortedTargets, { limit, offset });

  const blastRadius = buildBlastRadius(pagedTargets.items);

  const selectedWorkspaceRoots = depResult.filters.workspaceRoots ?? context.workspace.roots;
  const workspaceBreakdown = createWorkspaceBreakdown(
    selectedWorkspaceRoots,
    depResult.searchableFiles,
    pagedTargets.items.map((target) => ({
      workspaceRoot: target.symbol.workspaceRoot,
      relativePath: target.symbol.relativePath,
    })),
  );

  return {
    seed: depResult.target,
    targets: pagedTargets.items,
    blastRadius,
    pagination: pagedTargets.pagination,
    freshness: depResult.freshness,
    diagnostic: depResult.diagnostic,
    diagnostics,
    searchedFiles: depResult.searchedFiles,
    matchedFiles: depResult.matchedFiles,
    workspaceRoots: selectedWorkspaceRoots,
    workspaceBreakdown,
    dependencyResult: depResult,
  };
}

function scoreImpactTargets(
  results: readonly DependencyResult[],
  seed: DefinitionMatch,
): ImpactTarget[] {
  return results.map((result) => {
    const confidence = assignConfidence(result);
    const severity = assignSeverity(result);
    const reason = buildReason(result, seed);

    return {
      symbol: result.symbol,
      direction: result.direction,
      depth: result.depth,
      relationshipKind: result.path[0]?.relationshipKind ?? (result.direction === "incoming" ? "incoming_call" : "outgoing_call"),
      confidence,
      severity,
      reason,
      path: result.path,
    };
  });
}

function assignConfidence(result: DependencyResult): ConfidenceLevel {
  const isCall = result.path.every((step) =>
    step.relationshipKind === "incoming_call" || step.relationshipKind === "outgoing_call");

  if (result.depth === 1) {
    return isCall ? "high" : "medium";
  }

  if (result.depth === 2) {
    return isCall ? "medium" : "low";
  }

  return "low";
}

function assignSeverity(result: DependencyResult): ImpactSeverity {
  if (result.direction === "outgoing" && result.depth === 1) {
    return result.path.every((step) =>
      step.relationshipKind === "outgoing_call") ? "critical" : "medium";
  }

  if (result.direction === "incoming" && result.depth === 1) {
    return result.path.every((step) =>
      step.relationshipKind === "incoming_call") ? "high" : "medium";
  }

  if (result.depth === 2) {
    return result.path.every((step) =>
      step.relationshipKind === "incoming_call" || step.relationshipKind === "outgoing_call")
      ? (result.direction === "outgoing" ? "high" : "medium")
      : "low";
  }

  // depth 3+
  return result.path.every((step) =>
    step.relationshipKind === "incoming_call" || step.relationshipKind === "outgoing_call")
    ? "medium"
    : "low";
}

function buildReason(result: DependencyResult, seed: DefinitionMatch): string {
  const intermediate = result.path.length >= 2 ? result.path[result.path.length - 2]?.toSymbol.name : null;
  const lastStep = result.path[result.path.length - 1];
  const relatedName = result.symbol.name;

  if (result.depth === 1) {
    if (result.direction === "outgoing") {
      const kindText = lastStep?.relationshipKind === "outgoing_call" ? "Direct callee" : "Direct dependency";
      return `${kindText} — ${seed.name} references ${relatedName}. Changes to ${seed.name} may propagate to ${relatedName}.`;
    }

    const kindText = lastStep?.relationshipKind === "incoming_call" ? "Direct caller" : "Direct dependent";
    return `${kindText} — ${relatedName} calls ${seed.name} and may break if ${seed.name}'s signature or behavior changes.`;
  }

  if (result.depth === 2) {
    const via = intermediate ? ` via ${intermediate}` : "";
    if (result.direction === "outgoing") {
      const kindText = lastStep?.relationshipKind === "outgoing_call" ? "Indirect callee" : "Indirect dependency";
      return `${kindText} (2 hops${via}) — ${seed.name} is connected to ${relatedName} through a transitive dependency chain.`;
    }

    const kindText = lastStep?.relationshipKind === "incoming_call" ? "Indirect caller" : "Indirect dependent";
    return `${kindText} (2 hops${via}) — ${relatedName} depends on ${seed.name} through a transitive call chain.`;
  }

  const via = intermediate ? ` via ${intermediate}` : "";
  const kindText = result.direction === "outgoing" ? "Transitive callee" : "Transitive caller";
  return `${kindText} (${result.depth} hops${via}) — ${relatedName} is weakly connected to ${seed.name} through a multi-hop chain.`;
}

function sortByImpactPriority(targets: ImpactTarget[]): ImpactTarget[] {
  const severityOrder: Record<ImpactSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const confidenceOrder: Record<ConfidenceLevel, number> = { high: 0, medium: 1, low: 2 };

  return [...targets].sort((left, right) => {
    // 1. Severity (most important first)
    const severityDiff = (severityOrder[left.severity] ?? 99) - (severityOrder[right.severity] ?? 99);
    if (severityDiff !== 0) return severityDiff;

    // 2. Confidence (most certain first)
    const confidenceDiff = (confidenceOrder[left.confidence] ?? 99) - (confidenceOrder[right.confidence] ?? 99);
    if (confidenceDiff !== 0) return confidenceDiff;

    // 3. Direction (outgoing first — things seed depends on)
    if (left.direction !== right.direction) {
      return left.direction === "outgoing" ? -1 : 1;
    }

    // 4. Depth (closer first)
    if (left.depth !== right.depth) {
      return left.depth - right.depth;
    }

    // 5. By file path then position
    if (left.symbol.relativePath !== right.symbol.relativePath) {
      return left.symbol.relativePath.localeCompare(right.symbol.relativePath);
    }

    return left.symbol.selectionRange.start.offset - right.symbol.selectionRange.start.offset;
  });
}

function buildBlastRadius(targets: ImpactTarget[]): ImpactBlastRadius {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  const byDirection = { incoming: 0, outgoing: 0 };
  const fileMap = new Map<string, ImpactAreaSummary>();

  for (const target of targets) {
    bySeverity[target.severity]++;
    byDirection[target.direction]++;

    const fileKey = JSON.stringify([target.symbol.workspaceRoot, target.symbol.relativePath]);
    let area = fileMap.get(fileKey);
    if (!area) {
      area = {
        relativePath: target.symbol.relativePath,
        workspaceRoot: target.symbol.workspaceRoot,
        targetCount: 0,
        criticalCount: 0,
        highCount: 0,
        severity: "low",
      };
      fileMap.set(fileKey, area);
    }

    area.targetCount++;
    if (target.severity === "critical") area.criticalCount++;
    if (target.severity === "high") area.highCount++;

    const areaSeverityOrder: Record<ImpactSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    if ((areaSeverityOrder[target.severity] ?? 99) < (areaSeverityOrder[area.severity] ?? 99)) {
      area.severity = target.severity;
    }
  }

  const affectedFiles = [...fileMap.values()].sort((left, right) => {
    if (left.severity !== right.severity) {
      const order: Record<ImpactSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      return (order[left.severity] ?? 99) - (order[right.severity] ?? 99);
    }

    if (left.targetCount !== right.targetCount) {
      return right.targetCount - left.targetCount;
    }

    return left.relativePath.localeCompare(right.relativePath);
  });

  const summary = buildSummaryText(targets, affectedFiles);

  return {
    totalTargets: targets.length,
    criticalCount: bySeverity.critical,
    highCount: bySeverity.high,
    mediumCount: bySeverity.medium,
    lowCount: bySeverity.low,
    incomingCount: byDirection.incoming,
    outgoingCount: byDirection.outgoing,
    affectedFiles,
    summary,
  };
}

function buildSummaryText(
  targets: ImpactTarget[],
  affectedFiles: ImpactAreaSummary[],
): string {
  if (targets.length === 0) {
    return "No impact targets were identified. The symbol appears to be isolated within the analyzed scope.";
  }

  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  const byDirection = { incoming: 0, outgoing: 0 };

  for (const target of targets) {
    bySeverity[target.severity]++;
    byDirection[target.direction]++;
  }

  const topFiles = affectedFiles.slice(0, 3).map((f) => f.relativePath).join(", ");
  const topTargets = targets.slice(0, 3).map((t) => t.symbol.name).join(", ");

  let summary = `Impact analysis identified ${targets.length} potentially affected symbol(s) across ${affectedFiles.length} file(s).`;

  if (bySeverity.critical > 0) {
    summary += ` ${bySeverity.critical} critical direct callee(s) would be immediately affected by changes.`;
  }

  if (bySeverity.high > 0) {
    summary += ` ${bySeverity.high} high-severity caller(s) may break if the interface changes.`;
  }

  if (bySeverity.medium > 0) {
    summary += ` ${bySeverity.medium} medium-priority target(s) are indirectly connected.`;
  }

  if (bySeverity.low > 0) {
    summary += ` ${bySeverity.low} low-priority target(s) have weak transitive connections.`;
  }

  if (byDirection.outgoing > 0 && byDirection.incoming > 0) {
    summary += ` The blast radius spans ${byDirection.outgoing} outgoing (dependencies) and ${byDirection.incoming} incoming (dependents) relationships.`;
  } else if (byDirection.outgoing > 0) {
    summary += ` All targets are outgoing dependencies.`;
  } else {
    summary += ` All targets are incoming dependents.`;
  }

  if (topFiles) {
    summary += ` Most affected files: ${topFiles}.`;
  }

  if (topTargets) {
    summary += ` Key targets: ${topTargets}.`;
  }

  return summary;
}

function emptyImpactResult(
  depResult: GetDependencyAnalysisResult,
  diagnostics: Diagnostic[],
): AnalyzeImpactResult {
  const emptyBlastRadius: ImpactBlastRadius = {
    totalTargets: 0,
    criticalCount: 0,
    highCount: 0,
    mediumCount: 0,
    lowCount: 0,
    incomingCount: 0,
    outgoingCount: 0,
    affectedFiles: [],
    summary: depResult.target
      ? `Impact analysis for ${depResult.target.name} found no connected symbols within the requested scope.`
      : "Impact analysis could not resolve the requested seed symbol.",
  };

  return {
    seed: depResult.target,
    targets: [],
    blastRadius: emptyBlastRadius,
    pagination: depResult.pagination,
    freshness: depResult.freshness,
    diagnostic: depResult.diagnostic,
    diagnostics,
    searchedFiles: depResult.searchedFiles,
    matchedFiles: depResult.matchedFiles,
    workspaceRoots: [],
    workspaceBreakdown: [],
    dependencyResult: depResult,
  };
}

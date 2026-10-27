import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const IMPACT_TYPES = new Set([
  "imports",
  "calls",
  "depends_on",
  "tested_by",
  "configures",
  "middleware",
  "triggers",
  "reads_from",
  "writes_to",
  "subscribes",
  "publishes",
]);

export type ImpactRole = "changed" | "affected";

export type ImpactNode = {
  id: string;
  type: string;
  name: string;
  filePath: string | null;
  summary: string;
  role: ImpactRole;
};

export type ImpactEdge = {
  source: string;
  target: string;
  type: string;
};

export type ImpactChain = {
  available: boolean;
  nodes: ImpactNode[];
  edges: ImpactEdge[];
};

type GraphNode = {
  id?: unknown;
  type?: unknown;
  name?: unknown;
  filePath?: unknown;
  summary?: unknown;
};

type GraphEdge = {
  source?: unknown;
  target?: unknown;
  type?: unknown;
};

const empty: ImpactChain = { available: false, nodes: [], edges: [] };

export function loadImpactChain(repoPath: string, changedPaths: string[]): ImpactChain {
  const legacy = join(repoPath, ".understand-anything", "knowledge-graph.json");
  const current = join(repoPath, ".ua", "knowledge-graph.json");
  const file = existsSync(legacy) ? legacy : existsSync(current) ? current : "";
  if (!file) return empty;
  try {
    const chain = extractImpactChain(JSON.parse(readFileSync(file, "utf8")), changedPaths);
    return { ...chain, available: true };
  } catch {
    return empty;
  }
}

export function extractImpactChain(graph: unknown, changedPaths: string[]): ImpactChain {
  const changed = new Set(changedPaths.map(normalizePath).filter(Boolean));
  const rawNodes = Array.isArray((graph as { nodes?: unknown })?.nodes)
    ? ((graph as { nodes: GraphNode[] }).nodes)
    : [];
  const rawEdges = Array.isArray((graph as { edges?: unknown })?.edges)
    ? ((graph as { edges: GraphEdge[] }).edges)
    : [];
  const nodes = new Map<string, ImpactNode>();
  for (const raw of rawNodes) {
    if (typeof raw?.id !== "string" || !raw.id || nodes.has(raw.id)) continue;
    const filePath = nodePath(raw);
    nodes.set(raw.id, {
      id: raw.id,
      type: typeof raw.type === "string" && raw.type ? raw.type : "file",
      name: typeof raw.name === "string" && raw.name ? raw.name : raw.id,
      filePath,
      summary: typeof raw.summary === "string" ? raw.summary : "",
      role: filePath && changed.has(filePath) ? "changed" : "affected",
    });
  }
  const changedIds = new Set([...nodes.values()].filter((node) => node.role === "changed").map((node) => node.id));
  const edges = new Map<string, ImpactEdge>();
  const kept = new Set(changedIds);
  for (const raw of rawEdges) {
    if (typeof raw?.source !== "string" || typeof raw?.target !== "string" || typeof raw?.type !== "string") continue;
    if (!IMPACT_TYPES.has(raw.type) || !nodes.has(raw.source) || !nodes.has(raw.target)) continue;
    const touchesChange = changedIds.has(raw.source) || changedIds.has(raw.target);
    if (!touchesChange) continue;
    const key = `${raw.type}\0${raw.source}\0${raw.target}`;
    if (edges.has(key)) continue;
    edges.set(key, { source: raw.source, target: raw.target, type: raw.type });
    kept.add(raw.source);
    kept.add(raw.target);
  }
  return {
    available: true,
    nodes: [...kept].map((id) => nodes.get(id)!).sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort((a, b) => `${a.type}:${a.source}:${a.target}`.localeCompare(`${b.type}:${b.source}:${b.target}`)),
  };
}

function nodePath(node: GraphNode): string | null {
  if (typeof node.filePath === "string" && node.filePath.trim()) return normalizePath(node.filePath);
  if (typeof node.id === "string" && node.id.startsWith("file:")) return normalizePath(node.id.slice("file:".length));
  return null;
}

function normalizePath(input: string): string {
  return input.replaceAll("\\", "/").replace(/^\.\//, "");
}

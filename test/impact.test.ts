import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { extractImpactChain, loadImpactChain } from "../apps/daemon/src/impact.ts";

const graph = {
  nodes: [
    { id: "file:src/a.ts", type: "file", name: "a.ts", filePath: "src/a.ts", summary: "改动文件" },
    { id: "function:src/a.ts:run", type: "function", name: "run", filePath: "src/a.ts", summary: "改动函数" },
    { id: "file:src/b.ts", type: "file", name: "b.ts", filePath: "src/b.ts", summary: "调用方" },
    { id: "function:src/b.ts:use", type: "function", name: "use", filePath: "src/b.ts", summary: "调用改动函数" },
    { id: "file:src/d.ts", type: "file", name: "d.ts", filePath: "src/d.ts", summary: "被改动文件导入" },
    { id: "file:src/e.ts", type: "file", name: "e.ts", filePath: "src/e.ts", summary: "第二跳" },
    { id: "file:src/c.ts", type: "file", name: "c.ts", filePath: "src/c.ts", summary: "无关文件" },
  ],
  edges: [
    { source: "file:src/a.ts", target: "function:src/a.ts:run", type: "contains" },
    { source: "file:src/b.ts", target: "file:src/a.ts", type: "imports" },
    { source: "function:src/b.ts:use", target: "function:src/a.ts:run", type: "calls" },
    { source: "file:src/a.ts", target: "file:src/d.ts", type: "imports" },
    { source: "file:src/d.ts", target: "file:src/e.ts", type: "imports" },
    { source: "file:src/c.ts", target: "file:src/e.ts", type: "imports" },
  ],
};

test("只保留改动节点和直接碰到它们的影响边", () => {
  const chain = extractImpactChain(graph, ["src/a.ts"]);
  assert.deepEqual(chain.nodes.map((node) => [node.id, node.role]), [
    ["file:src/a.ts", "changed"],
    ["file:src/b.ts", "affected"],
    ["file:src/d.ts", "affected"],
    ["function:src/a.ts:run", "changed"],
    ["function:src/b.ts:use", "affected"],
  ]);
  assert.deepEqual(chain.edges, [
    { source: "function:src/b.ts:use", target: "function:src/a.ts:run", type: "calls" },
    { source: "file:src/a.ts", target: "file:src/d.ts", type: "imports" },
    { source: "file:src/b.ts", target: "file:src/a.ts", type: "imports" },
  ]);
});

test("落在类行范围内的方法挂到该类下面", () => {
  const chain = extractImpactChain({
    nodes: [
      { id: "file:src/A.java", type: "file", name: "A.java", filePath: "src/A.java", summary: "", lineRange: [1, 80] },
      { id: "class:src/A.java:A", type: "class", name: "A", filePath: "src/A.java", summary: "类", lineRange: [1, 40] },
      { id: "function:src/A.java:run", type: "function", name: "run", filePath: "src/A.java", summary: "方法", lineRange: [10, 20] },
      { id: "function:src/A.java:helper", type: "function", name: "helper", filePath: "src/A.java", summary: "类外面的函数", lineRange: [50, 60] },
      { id: "function:src/B.java:call", type: "function", name: "call", filePath: "src/B.java", summary: "调用方", lineRange: [1, 8] },
    ],
    edges: [
      { source: "function:src/B.java:call", target: "function:src/A.java:run", type: "calls" },
    ],
  }, ["src/B.java"]);
  assert.equal(chain.nodes.find((node) => node.id === "function:src/A.java:run")?.parentId, "class:src/A.java:A");
  assert.equal(chain.nodes.find((node) => node.id === "function:src/B.java:call")?.parentId, null);
  assert.equal(chain.nodes.find((node) => node.id === "class:src/A.java:A")?.role, "affected");
  assert.equal(chain.nodes.some((node) => node.id === "function:src/A.java:helper"), false);
});

test("旧路径也能对上改动节点", () => {
  const chain = extractImpactChain(graph, ["./src/a.ts"]);
  assert.equal(chain.nodes.find((node) => node.id === "file:src/a.ts")?.role, "changed");
});

test("仓库没有知识图谱时不返回子图", () => {
  const root = mkdtempSync(join(tmpdir(), "impact-"));
  try {
    assert.deepEqual(loadImpactChain(root, ["src/a.ts"]), { available: false, nodes: [], edges: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

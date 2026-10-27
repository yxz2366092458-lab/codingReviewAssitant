import assert from "node:assert/strict";
import test from "node:test";
import { layoutImpact } from "../apps/web/impact-layout.js";

const LANE = 14;

function node(id, filePath, role, extra = {}) {
  return {
    id,
    type: extra.type ?? "function",
    name: extra.name ?? id,
    filePath,
    summary: "",
    role,
    parentId: extra.parentId ?? null,
  };
}

test("同一起点分到不同类的边，竖线至少隔开一个间距", () => {
  const layout = layoutImpact(
    [
      node("start", "server.ts", "changed", { name: "startServer" }),
      node("checkout", "branches.ts", "affected", { name: "checkoutBranch" }),
      node("proxy", "cursor-proxy.ts", "affected", { name: "startCursorProxy" }),
    ],
    [
      { source: "start", target: "checkout", type: "calls" },
      { source: "start", target: "proxy", type: "calls" },
    ],
  );
  assert.equal(layout.routes.length, 2);
  const lanes = layout.routes.map((route) => route.laneX).sort((a, b) => a - b);
  assert.ok(lanes[1] - lanes[0] >= LANE);
  assert.equal(layout.labels.filter((label) => label.type === "calls").length, 1);
});

test("同一个类里的多个方法并成一条边，再在类内分开", () => {
  const layout = layoutImpact(
    [
      node("call", "B.java", "affected", { name: "call" }),
      node("file", "A.java", "changed", { type: "file", name: "A.java" }),
      node("class", "A.java", "changed", { type: "class", name: "A" }),
      node("run", "A.java", "changed", { name: "run", parentId: "class" }),
      node("stop", "A.java", "changed", { name: "stop", parentId: "class" }),
    ],
    [
      { source: "call", target: "run", type: "calls" },
      { source: "call", target: "stop", type: "calls" },
    ],
  );
  const frame = layout.frames.find((item) => item.path === "A.java");
  const block = frame.blocks.find((item) => item.kind === "class");
  assert.deepEqual(block.methods.map((method) => method.node.name), ["run", "stop"]);
  for (const method of block.methods) {
    assert.ok(method.x >= block.x);
    assert.ok(method.y >= block.y);
    assert.ok(method.x + method.w <= block.x + block.w);
    assert.ok(method.y + method.h <= block.y + block.h);
  }
  assert.equal(layout.routes.length, 1);
  assert.equal(layout.routes[0].branches.length, 2);
  assert.ok(layout.routes[0].branches.every((path) => path.startsWith(`M ${layout.routes[0].laneX} `)));
});

test("跨过中间列时从上方绕开，路径里不出现空坐标", () => {
  const layout = layoutImpact(
    [
      node("a", "a.ts", "affected", { name: "a" }),
      node("b", "b.ts", "changed", { name: "b" }),
      node("c", "c.ts", "affected", { name: "c" }),
    ],
    [
      { source: "a", target: "b", type: "calls" },
      { source: "a", target: "c", type: "calls" },
    ],
  );
  const skip = layout.routes.find((route) => route.dir === "skip-forward");
  assert.ok(skip);
  assert.equal(skip.trunk.includes("undefined") || skip.trunk.includes("NaN"), false);
  const lanes = layout.routes.map((route) => route.laneX).sort((left, right) => left - right);
  assert.ok(lanes[1] - lanes[0] >= LANE);
});

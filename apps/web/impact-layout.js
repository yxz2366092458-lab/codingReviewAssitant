const NODE_W = 200;
const NODE_H = 32;
const GAP_Y = 8;
const PAD = 24;
const FRAME_PAD = 12;
const HEAD_H = 48;
const CLASS_HEAD = 28;
const FRAME_GAP = 16;
const LANE = 14;
const MIN_GAP = 56;
const FRAME_W = NODE_W + FRAME_PAD * 2;

export function layoutImpact(nodes, edges) {
  const list = Array.isArray(nodes) ? nodes : [];
  const links = Array.isArray(edges) ? edges : [];
  const changedIds = new Set(list.filter((node) => node.role === "changed").map((node) => node.id));
  const columns = { upstream: [], changed: [], downstream: [] };
  const meta = new Map();
  for (const members of groupByFile(list).values()) {
    const ids = new Set(members.map((node) => node.id));
    const changed = members.some((node) => node.role === "changed");
    const toward = links.some((edge) => ids.has(edge.source) && changedIds.has(edge.target));
    const side = changed ? "changed" : toward ? "upstream" : "downstream";
    columns[side].push(modelFrame(members));
  }
  const used = ["upstream", "changed", "downstream"].filter((key) => columns[key].length);
  const frames = [];
  used.forEach((key, column) => {
    const ordered = columns[key].sort((a, b) => a.head.localeCompare(b.head, "zh"));
    for (const frame of ordered) {
      frame.column = column;
      stamp(meta, frame, column);
      frames.push(frame);
    }
  });
  const bundled = collectBundles(links, meta);
  const gapWidth = bundled.gaps.map((bucket) => Math.max(MIN_GAP, (bucket.size + 1) * LANE));
  const gutter = bundled.same.map((bucket) => (bucket.size ? (bucket.size + 1) * LANE : 0));
  const topPad = PAD + (bundled.skips.size ? (bundled.skips.size + 1) * LANE : 0);
  const gapStarts = [];
  const gutterStarts = [];
  let cursor = PAD;
  let width = PAD;
  let height = topPad;
  used.forEach((_key, column) => {
    gutterStarts[column] = cursor;
    cursor += gutter[column] ?? 0;
    const x = cursor;
    let y = topPad;
    for (const frame of frames.filter((item) => item.column === column)) {
      frame.x = x;
      frame.y = y;
      placeFrame(frame);
      y += frame.h + FRAME_GAP;
      height = Math.max(height, frame.y + frame.h + PAD);
    }
    cursor += FRAME_W;
    if (column < used.length - 1) {
      gapStarts[column] = cursor;
      cursor += gapWidth[column] ?? MIN_GAP;
    }
    width = cursor + PAD;
  });
  if (!frames.length) {
    width = PAD * 2;
    height = PAD * 2;
  }
  const boxes = new Map();
  for (const frame of frames) {
    if (frame.file) boxes.set(frame.file.id, boxOf(frame));
    for (const block of frame.blocks) {
      if (block.kind === "class") boxes.set(block.node.id, boxOf(block));
      const symbols = block.kind === "class" ? block.methods : [block];
      for (const symbol of symbols) boxes.set(symbol.node.id, boxOf(symbol));
    }
  }
  const lanes = assignLanes(bundled, boxes, gapStarts, gutterStarts);
  const routes = [];
  for (const bundle of allBundles(bundled)) {
    const route = routeBundle(bundle, boxes, lanes);
    if (route) routes.push(route);
  }
  return { width, height, frames, routes, labels: buildLabels(routes) };
}

function groupByFile(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    const key = node.filePath || node.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  return groups;
}

function modelFrame(members) {
  const file = members.find((node) => node.type === "file" || node.type === "config" || node.type === "document") ?? null;
  const symbols = members.filter((node) => node !== file);
  const classIds = new Set(symbols.filter((node) => node.type === "class").map((node) => node.id));
  const methods = new Map([...classIds].map((id) => [id, []]));
  const loose = [];
  for (const node of symbols) {
    if (node.type === "class") continue;
    if (node.parentId && methods.has(node.parentId)) methods.get(node.parentId).push(node);
    else loose.push(node);
  }
  const blocks = [];
  for (const node of symbols.filter((item) => item.type === "class").sort(byName)) {
    const kids = methods.get(node.id).sort(byName);
    blocks.push({
      kind: "class",
      node,
      h: classHeight(kids.length),
      changed: node.role === "changed" || kids.some((kid) => kid.role === "changed"),
      methods: kids.map((kid) => ({ node: kid, x: 0, y: 0, w: NODE_W - 16, h: NODE_H })),
    });
  }
  for (const node of loose.sort(byName)) {
    blocks.push({ kind: "symbol", node, x: 0, y: 0, w: NODE_W, h: NODE_H });
  }
  const head = file?.name || members.find((node) => node.filePath)?.filePath.split("/").pop() || members[0].name;
  const path = file?.filePath || members.find((node) => node.filePath)?.filePath || "";
  return {
    head,
    path,
    changed: members.some((node) => node.role === "changed"),
    file,
    fileKey: file?.filePath || members.find((node) => node.filePath)?.filePath || members[0].id,
    blocks,
    x: 0,
    y: 0,
    w: FRAME_W,
    h: frameHeight(blocks),
  };
}

function classHeight(count) {
  if (!count) return CLASS_HEAD + 8;
  return CLASS_HEAD + count * NODE_H + (count - 1) * GAP_Y + 8;
}

function frameHeight(blocks) {
  if (!blocks.length) return HEAD_H + 8;
  const stack = blocks.reduce((sum, block) => sum + block.h, 0) + (blocks.length - 1) * GAP_Y;
  return HEAD_H + stack + 8;
}

function stamp(meta, frame, column) {
  const frameBundle = `frame:${frame.fileKey}`;
  if (frame.file) meta.set(frame.file.id, { column, bundleId: frameBundle });
  for (const block of frame.blocks) {
    if (block.kind === "class") {
      const bundleId = `class:${block.node.id}`;
      meta.set(block.node.id, { column, bundleId });
      for (const method of block.methods) meta.set(method.node.id, { column, bundleId });
    } else {
      meta.set(block.node.id, { column, bundleId: frameBundle });
    }
  }
}

function placeFrame(frame) {
  let cursor = frame.y + HEAD_H;
  frame.blocks.forEach((block, index) => {
    if (index) cursor += GAP_Y;
    block.x = frame.x + FRAME_PAD;
    block.y = cursor;
    block.w = NODE_W;
    if (block.kind === "class") {
      block.methods.forEach((method, methodIndex) => {
        method.x = block.x + 8;
        method.y = block.y + CLASS_HEAD + methodIndex * (NODE_H + GAP_Y);
      });
    }
    cursor += block.h;
  });
}

function boxOf(item) {
  return { x: item.x, y: item.y, w: item.w, h: item.h };
}

function collectBundles(edges, meta) {
  const gaps = [];
  const same = [];
  const skips = new Map();
  const bundles = new Map();
  for (const edge of edges) {
    if (!edge?.source || !edge?.target || edge.source === edge.target) continue;
    const from = meta.get(edge.source);
    const to = meta.get(edge.target);
    if (!from || !to) continue;
    const span = to.column - from.column;
    const dir = span === 0 ? "same" : span === 1 ? "forward" : span === -1 ? "back" : span > 1 ? "skip-forward" : "skip-back";
    const key = `${edge.source}|${to.bundleId}|${edge.type}|${dir}`;
    if (!bundles.has(key)) {
      bundles.set(key, { key, dir, fromCol: from.column, toCol: to.column, source: edge.source, type: edge.type, targets: [] });
    }
    const bundle = bundles.get(key);
    if (!bundle.targets.includes(edge.target)) bundle.targets.push(edge.target);
  }
  const columnCount = Math.max(0, ...[...meta.values()].map((item) => item.column)) + (meta.size ? 1 : 0);
  for (let index = 0; index < Math.max(columnCount - 1, 0); index += 1) gaps.push(new Map());
  for (let index = 0; index < columnCount; index += 1) same.push(new Map());
  for (const bundle of bundles.values()) {
    if (bundle.dir === "same") {
      same[bundle.fromCol]?.set(bundle.key, bundle);
      continue;
    }
    if (bundle.dir === "forward" || bundle.dir === "back") {
      gaps[Math.min(bundle.fromCol, bundle.toCol)]?.set(bundle.key, bundle);
      continue;
    }
    skips.set(bundle.key, bundle);
    if (bundle.dir === "skip-forward") {
      gaps[bundle.fromCol]?.set(bundle.key, bundle);
      gaps[bundle.toCol - 1]?.set(bundle.key, bundle);
    } else {
      gaps[bundle.fromCol - 1]?.set(bundle.key, bundle);
      gaps[bundle.toCol]?.set(bundle.key, bundle);
    }
  }
  return { gaps, same, skips };
}

function allBundles(bundled) {
  const seen = new Map();
  for (const bucket of [...bundled.gaps, ...bundled.same]) {
    for (const bundle of bucket.values()) seen.set(bundle.key, bundle);
  }
  for (const bundle of bundled.skips.values()) seen.set(bundle.key, bundle);
  return [...seen.values()];
}

function assignLanes(bundled, boxes, gapStarts, gutterStarts) {
  const laneX = new Map();
  const topY = new Map();
  bundled.gaps.forEach((bucket, gap) => {
    sortBundles(bucket, boxes).forEach((bundle, index) => {
      laneX.set(`${bundle.key}|${gap}`, gapStarts[gap] + LANE * (index + 1));
    });
  });
  bundled.same.forEach((bucket, column) => {
    sortBundles(bucket, boxes).forEach((bundle, index) => {
      laneX.set(`${bundle.key}|same|${column}`, gutterStarts[column] + LANE * (index + 1));
    });
  });
  sortBundles(bundled.skips, boxes).forEach((bundle, index) => {
    topY.set(bundle.key, PAD + LANE * (index + 1));
  });
  return { laneX, topY };
}

function sortBundles(bucket, boxes) {
  return [...bucket.values()].sort((a, b) => bundleRank(a, boxes) - bundleRank(b, boxes) || a.key.localeCompare(b.key));
}

function bundleRank(bundle, boxes) {
  const from = boxes.get(bundle.source);
  const sy = from ? from.y + from.h / 2 : 0;
  const targets = bundle.targets.map((id) => boxes.get(id)).filter(Boolean);
  const ty = targets.length ? targets.reduce((sum, box) => sum + box.y + box.h / 2, 0) / targets.length : 0;
  return sy * 100000 + ty;
}

function routeBundle(bundle, boxes, lanes) {
  const from = boxes.get(bundle.source);
  const targets = bundle.targets.map((id) => boxes.get(id)).filter(Boolean).sort((a, b) => a.y - b.y || a.x - b.x);
  if (!from || !targets.length) return null;
  const sy = from.y + from.h / 2;
  const targetYs = targets.map((target) => target.y + target.h / 2);
  const y1 = Math.min(sy, ...targetYs);
  const y2 = Math.max(sy, ...targetYs);
  const enterLeft = bundle.dir === "forward" || bundle.dir === "same" || bundle.dir === "skip-forward";
  let laneX = 0;
  let sx = from.x;
  let trunk = "";
  if (bundle.dir === "forward") {
    sx = from.x + from.w;
    laneX = lanes.laneX.get(`${bundle.key}|${bundle.fromCol}`);
    trunk = trunkTo(sx, sy, laneX, y1, y2);
  } else if (bundle.dir === "back") {
    sx = from.x;
    laneX = lanes.laneX.get(`${bundle.key}|${bundle.toCol}`);
    trunk = trunkTo(sx, sy, laneX, y1, y2);
  } else if (bundle.dir === "same") {
    sx = from.x;
    laneX = lanes.laneX.get(`${bundle.key}|same|${bundle.fromCol}`);
    trunk = trunkTo(sx, sy, laneX, y1, y2);
  } else if (bundle.dir === "skip-forward") {
    sx = from.x + from.w;
    const depart = lanes.laneX.get(`${bundle.key}|${bundle.fromCol}`);
    laneX = lanes.laneX.get(`${bundle.key}|${bundle.toCol - 1}`);
    trunk = skipTrunk(sx, sy, depart, laneX, lanes.topY.get(bundle.key), y1, y2);
  } else {
    sx = from.x;
    const depart = lanes.laneX.get(`${bundle.key}|${bundle.fromCol - 1}`);
    laneX = lanes.laneX.get(`${bundle.key}|${bundle.toCol}`);
    trunk = skipTrunk(sx, sy, depart, laneX, lanes.topY.get(bundle.key), y1, y2);
  }
  if (laneX === undefined || Number.isNaN(laneX)) return null;
  return {
    trunk,
    branches: targets.map((target) => `M ${laneX} ${target.y + target.h / 2} H ${enterLeft ? target.x : target.x + target.w}`),
    type: bundle.type,
    source: bundle.source,
    dir: bundle.dir,
    laneX,
    sx,
    sy,
    targetYs,
  };
}

function trunkTo(sx, sy, laneX, y1, y2) {
  const head = `M ${sx} ${sy} H ${laneX}`;
  return y1 === y2 ? head : `${head} M ${laneX} ${y1} V ${y2}`;
}

function skipTrunk(sx, sy, depart, arrive, topY, y1, y2) {
  const low = Math.min(topY, y1);
  const high = Math.max(topY, y2);
  const head = `M ${sx} ${sy} H ${depart} V ${topY} H ${arrive}`;
  return low === high ? head : `${head} M ${arrive} ${low} V ${high}`;
}

function buildLabels(routes) {
  const groups = new Map();
  for (const route of routes) {
    const key = `${route.source}\0${route.type}\0${route.sy}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(route);
  }
  const labels = [];
  for (const group of groups.values()) {
    const route = group[0];
    const many = group.length > 1 || route.targetYs.length > 1;
    const forward = route.dir === "forward" || route.dir === "skip-forward";
    if (many && forward) labels.push({ x: route.sx + 8, y: route.sy - 6, type: route.type });
    else labels.push({ x: route.laneX + 6, y: (route.sy + route.targetYs[0]) / 2, type: route.type });
  }
  return labels;
}

function byName(a, b) {
  return a.name.localeCompare(b.name, "zh");
}

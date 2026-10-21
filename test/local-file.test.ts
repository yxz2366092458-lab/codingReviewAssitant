import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readLocalLines } from "../apps/daemon/src/local-file.ts";

test("按行读取本地文件，并拒绝仓库外路径", () => {
  const root = mkdtempSync(join(tmpdir(), "local-file-"));
  try {
    writeFileSync(join(root, "Demo.java"), "class Demo {\r\n  void run() {}\n}\n");
    const slice = readLocalLines(root, "Demo.java", 2, 2);
    assert.equal(slice.total, 3);
    assert.deepEqual(slice.lines, ["  void run() {}"]);
    assert.equal(slice.missing, false);
    const all = readLocalLines(root, "Demo.java");
    assert.deepEqual(all.lines, ["class Demo {", "  void run() {}", "}"]);
    writeFileSync(join(root, "blob.bin"), Buffer.from([0, 1, 2]));
    assert.equal(readLocalLines(root, "blob.bin").binary, true);
    assert.equal(readLocalLines(root, "missing.java").missing, true);
    assert.throws(() => readLocalLines(root, "../secret"), /路径超出仓库/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

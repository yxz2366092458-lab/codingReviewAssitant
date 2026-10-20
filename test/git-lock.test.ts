import assert from "node:assert/strict";
import test from "node:test";
import { enqueueGit, retryOnIndexLock } from "../apps/daemon/src/git/lock.ts";

test("git 命令排队执行，后一次等前一次结束", async () => {
  const order: string[] = [];
  const first = enqueueGit(async () => {
    order.push("first-start");
    await new Promise((resolve) => setTimeout(resolve, 30));
    order.push("first-end");
  });
  const second = enqueueGit(async () => {
    order.push("second");
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
});

test("撞上 index.lock 时重试，其他错误直接抛出", async () => {
  let locks = 0;
  const value = await retryOnIndexLock(async () => {
    locks += 1;
    if (locks < 3) throw new Error("fatal: Unable to create index.lock");
    return "ok";
  }, 5, 1);
  assert.equal(value, "ok");
  assert.equal(locks, 3);
  await assert.rejects(() => retryOnIndexLock(async () => {
    throw new Error("分支名无效");
  }, 3, 1), /分支名无效/);
});

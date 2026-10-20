let chain: Promise<unknown> = Promise.resolve();

export function enqueueGit<T>(task: () => Promise<T>): Promise<T> {
  const result = chain.then(task, task);
  chain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export async function retryOnIndexLock<T>(task: () => Promise<T>, attempts = 8, delayMs = 200): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      last = error;
      const message = error instanceof Error ? error.message : "";
      if (!message.includes("index.lock") || attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw last;
}

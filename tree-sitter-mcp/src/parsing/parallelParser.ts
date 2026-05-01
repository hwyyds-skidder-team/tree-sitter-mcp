export interface ParallelTask<T> {
  execute(): Promise<T>;
}

export interface ParallelResult<T> {
  successes: T[];
  failures: { error: Error; index: number }[];
}

export async function runInParallel<T>(
  tasks: ParallelTask<T>[],
  concurrency: number = 4,
): Promise<ParallelResult<T>> {
  const successes: T[] = [];
  const failures: { error: Error; index: number }[] = [];

  const queue = tasks.map((task, index) => ({ task, index }));
  const executing: Promise<void>[] = [];

  async function processNext(): Promise<void> {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;

      try {
        const result = await item.task.execute();
        successes.push(result);
      } catch (error) {
        failures.push({
          error: error instanceof Error ? error : new Error(String(error)),
          index: item.index,
        });
      }
    }
  }

  for (let i = 0; i < Math.min(concurrency, tasks.length); i++) {
    executing.push(processNext());
  }

  await Promise.all(executing);

  return { successes, failures };
}

export async function processBatch<T, R>(
  items: T[],
  processor: (item: T, index: number) => Promise<R>,
  concurrency: number = 4,
): Promise<{ results: R[]; errors: { error: Error; item: T; index: number }[] }> {
  const results: R[] = [];
  const errors: { error: Error; item: T; index: number }[] = [];

  const queue = items.map((item, index) => ({ item, index }));
  const executing: Promise<void>[] = [];

  async function processNext(): Promise<void> {
    while (queue.length > 0) {
      const { item, index } = queue.shift()!;
      try {
        const result = await processor(item, index);
        results.push(result);
      } catch (error) {
        errors.push({
          error: error instanceof Error ? error : new Error(String(error)),
          item,
          index,
        });
      }
    }
  }

  for (let i = 0; i < Math.min(concurrency, items.length); i++) {
    executing.push(processNext());
  }

  await Promise.all(executing);

  return { results, errors };
}

export function createSerialQueue() {
  const queues = new Map();
  const pending = new Map();

  async function enqueue(key, task) {
    const queueKey = key || "default";
    const previous = queues.get(queueKey) ?? Promise.resolve();
    pending.set(queueKey, (pending.get(queueKey) ?? 0) + 1);

    const next = previous
      .catch(() => {})
      .then(async () => {
        try {
          return await task();
        } finally {
          const count = (pending.get(queueKey) ?? 1) - 1;
          if (count <= 0) pending.delete(queueKey);
          else pending.set(queueKey, count);
        }
      });

    queues.set(queueKey, next.finally(() => {
      if (queues.get(queueKey) === next) queues.delete(queueKey);
    }));

    return next;
  }

  function snapshot() {
    return Array.from(pending.entries()).map(([key, count]) => ({ key, pending: count }));
  }

  return { enqueue, snapshot };
}

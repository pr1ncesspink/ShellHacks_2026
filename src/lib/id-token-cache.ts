type CachedToken = { key: string; token: string; refreshAt: number };

export type IdTokenCache = {
  get(key: string, now: number, mint: () => Promise<string>): Promise<string>;
  invalidate(): void;
};

/**
 * Single-flight token cache. invalidate() bumps a generation counter so a mint
 * that was already in flight cannot repopulate the cache afterwards.
 */
export function createIdTokenCache(
  refreshAt: (token: string) => number,
): IdTokenCache {
  let cached: CachedToken | null = null;
  let pending: { key: string; promise: Promise<string> } | null = null;
  let generation = 0;

  return {
    invalidate() {
      generation += 1;
      cached = null;
      pending = null;
    },
    async get(key, now, mint) {
      if (cached?.key === key && cached.refreshAt > now) return cached.token;
      if (pending?.key === key) return pending.promise;

      const started = generation;
      const promise = mint().then((token) => {
        if (started === generation) {
          cached = { key, token, refreshAt: refreshAt(token) };
        }
        return token;
      });
      pending = { key, promise };
      try {
        return await promise;
      } finally {
        if (pending?.promise === promise) pending = null;
      }
    },
  };
}

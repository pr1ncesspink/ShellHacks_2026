import assert from "node:assert/strict";
import test from "node:test";
import { createIdTokenCache } from "./id-token-cache.ts";

test("concurrent requests share one mint and reuse the cached token", async () => {
  const cache = createIdTokenCache(() => 1_000);
  let mints = 0;
  const mint = async () => `token-${++mints}`;
  const [first, second] = await Promise.all([
    cache.get("k", 0, mint),
    cache.get("k", 0, mint),
  ]);
  assert.equal(first, "token-1");
  assert.equal(second, "token-1");
  assert.equal(await cache.get("k", 10, mint), "token-1");
  assert.equal(mints, 1);
  assert.equal(await cache.get("k", 1_000, mint), "token-2");
});

test("an in-flight mint after invalidate does not repopulate the cache", async () => {
  const cache = createIdTokenCache(() => 1_000);
  let release: (token: string) => void = () => undefined;
  const stale = cache.get(
    "k",
    0,
    () => new Promise<string>((resolve) => (release = resolve)),
  );
  cache.invalidate();
  release("stale-token");
  assert.equal(await stale, "stale-token");

  let mints = 0;
  const fresh = await cache.get("k", 0, async () => `fresh-${++mints}`);
  assert.equal(fresh, "fresh-1");
  assert.equal(await cache.get("k", 0, async () => `fresh-${++mints}`), "fresh-1");
  assert.equal(mints, 1);
});

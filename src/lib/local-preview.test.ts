import assert from "node:assert/strict";
import test from "node:test";
import { allowLocalPreview } from "./local-preview.ts";

test("design preview requires explicit development opt-in on loopback", () => {
  const env = { NODE_ENV: "development", GRIDLENS_LOCAL_PREVIEW: "1" };
  for (const host of ["localhost:5176", "127.0.0.1:5176", "[::1]:5176"]) {
    assert.equal(allowLocalPreview(env, host, null), true);
    assert.equal(allowLocalPreview(env, host, host), true);
  }
  assert.equal(allowLocalPreview(env, null, null), false);
  assert.equal(allowLocalPreview(env, "public.example.com", null), false);
  assert.equal(allowLocalPreview(env, "localhost.evil.com", null), false);
  assert.equal(allowLocalPreview(env, "localhost:5176", "public.example.com"), false);
  assert.equal(allowLocalPreview({ NODE_ENV: "development" }, "localhost", null), false);
  assert.equal(allowLocalPreview({ ...env, NODE_ENV: "production" }, "localhost", null), false);
});

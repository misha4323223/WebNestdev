import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createOAuthState, consumeOAuthState, consumeOAuthStateWithVerifier, originFromOAuthState } from "./github-oauth-state.js";

test("the OAuth state carries the browser origin back to the callback", async () => {
  const userId = "oauth-state-" + randomUUID();
  const state = await createOAuthState(userId, "https://preview.example.dev");
  assert.equal(originFromOAuthState(state), "https://preview.example.dev");
  assert.equal(await consumeOAuthState(state), userId);
});

test("PKCE verifier is consumed together with the state", async () => {
  const userId = "oauth-state-" + randomUUID();
  const state = await createOAuthState(userId, "https://app.example.dev", "verifier-123");
  assert.deepEqual(await consumeOAuthStateWithVerifier(state), { userId, verifier: "verifier-123" });
  assert.equal(await consumeOAuthStateWithVerifier(state), null);
});

test("the OAuth state is single use", async () => {
  const userId = "oauth-state-" + randomUUID();
  const state = await createOAuthState(userId, "http://localhost:5173");
  assert.equal(await consumeOAuthState(state), userId);
  assert.equal(await consumeOAuthState(state), null);
});

test("states without an encoded origin and malformed ones are ignored", async () => {
  const plain = await createOAuthState("oauth-state-" + randomUUID());
  assert.equal(originFromOAuthState(plain), null);
  assert.equal(originFromOAuthState("some-uuid.not-a-valid-url"), null);
  assert.equal(originFromOAuthState(""), null);
});

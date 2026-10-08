import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

test("provider and GitHub tokens are encrypted at rest and legacy tokens migrate without losing access", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "webnestdev-secrets-"));
  process.env.WEBNESTDEV_DATA_DIR = root;
  process.env.WEBNESTDEV_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
  process.env.NODE_ENV = "test";
  try {
    const store = await import("../project-store.js");
    const github = await import("../github/github-connection-store.js");
    const project = await store.createProject("security-test", undefined, "user-1");
    const providerToken = "provider-test-credential-123";
    await store.saveProjectProvider(project.id, { provider: "test", baseUrl: "https://provider.example", model: "test-model", token: providerToken });
    const providerFile = path.join(root, "providers", project.id + ".json");
    const providerRaw = await readFile(providerFile, "utf8");
    assert.ok(!providerRaw.includes(providerToken), "provider token must not be stored as plaintext");
    assert.equal((await store.getProjectProvider(project.id))?.token, providerToken, "provider token must decrypt on read");

    const legacyProvider = { provider: "legacy", baseUrl: "https://provider.example", model: "legacy", token: "legacy-provider-credential" };
    await writeFile(providerFile, JSON.stringify(legacyProvider));
    assert.equal((await store.getProjectProvider(project.id))?.token, legacyProvider.token, "legacy provider token remains usable");
    assert.ok(!(await readFile(providerFile, "utf8")).includes(legacyProvider.token), "legacy provider token must be migrated to ciphertext");

    const githubToken = "github-test-credential";
    await github.saveGitHubConnection("user-1", githubToken, "test-user");
    const githubFile = path.join(root, "github", "user-1.json");
    assert.ok(!(await readFile(githubFile, "utf8")).includes(githubToken), "GitHub token must not be stored as plaintext");
    assert.equal((await github.getGitHubConnection("user-1"))?.accessToken, githubToken, "GitHub token must decrypt on read");

    await writeFile(githubFile, JSON.stringify({ id: "legacy-id", userId: "user-1", accessToken: "legacy-github-credential", githubLogin: "legacy-user", createdAt: "2026-01-01T00:00:00.000Z" }));
    assert.equal((await github.getGitHubConnection("user-1"))?.accessToken, "legacy-github-credential", "legacy GitHub connection remains usable");
    assert.ok(!(await readFile(githubFile, "utf8")).includes("legacy-github-credential"), "legacy GitHub token must be migrated to ciphertext");
  } finally {
    await rm(root, { recursive: true, force: true });
    delete process.env.WEBNESTDEV_DATA_DIR;
  }
});

test("authenticated encryption rejects tampering and invalid key configuration", async () => {
  process.env.WEBNESTDEV_ENCRYPTION_KEY = "0123456789abcdef".repeat(4);
  const crypto = await import("./secret-crypto.js");
  const encrypted = crypto.encryptSecret("test-only-plaintext");
  assert.notEqual(encrypted, "test-only-plaintext");
  assert.equal(crypto.decryptSecret(encrypted), "test-only-plaintext");
  assert.throws(() => crypto.decryptSecret(encrypted.slice(0, -1) + "x"));
  process.env.WEBNESTDEV_ENCRYPTION_KEY = "too-short";
  assert.throws(() => crypto.encryptSecret("token"), /32 bytes/);
});

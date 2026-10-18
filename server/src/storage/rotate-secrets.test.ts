import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { decryptSecretWith, encryptSecretWith } from "./secret-crypto.js";
import { rotateJsonStore } from "./rotate-secrets.js";

const OLD = "a".repeat(64);
const NEW = "b".repeat(64);

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "rotate-secrets-"));
  const seal = (value: string) => encryptSecretWith(value, OLD);
  await mkdir(path.join(root, "providers"), { recursive: true });
  await mkdir(path.join(root, "github"), { recursive: true });
  await mkdir(path.join(root, "yandex"), { recursive: true });
  await mkdir(path.join(root, "database"), { recursive: true });
  await mkdir(path.join(root, "project-secrets"), { recursive: true });
  await mkdir(path.join(root, "platform"), { recursive: true });
  await writeFile(path.join(root, "providers", "p1.json"), JSON.stringify({ provider: "openai", token: seal("provider-secret") }));
  await writeFile(path.join(root, "github", "u1.json"), JSON.stringify({ id: "g1", userId: "u1", accessToken: seal("github-secret") }));
  await writeFile(path.join(root, "yandex", "u1.json"), JSON.stringify({ userId: "u1", id: "y1", kind: "key", secret: seal("yandex-secret") }));
  await writeFile(path.join(root, "database", "u1.json"), JSON.stringify({ userId: "u1", id: "d1", password: seal("db-password"), url: seal("postgres://u:p@h/db") }));
  await writeFile(path.join(root, "project-secrets", "p1.json"), JSON.stringify({ version: 1, payload: seal('{".env.local":{"TOKEN":"project-secret"}}') }));
  // Старая установка: ключ платформы лежал открытым текстом.
  await writeFile(path.join(root, "platform", "env.json"), JSON.stringify({ version: 1, values: { GITHUB_CLIENT_SECRET: { value: "legacy-panel-plain", preview: "", updatedAt: "2026-01-01" } } }));
  return root;
}

test("ротация перешифровывает все файловые хранилища и ключи платформы", async () => {
  const root = await fixture();
  try {
    const result = await rotateJsonStore(root, OLD, NEW);
    assert.deepEqual(result.files.sort(), ["database/u1.json", "github/u1.json", "platform/env.json", "project-secrets/p1.json", "providers/p1.json", "yandex/u1.json"]);
    assert.equal(result.fields, 7);

    const read = async (file: string) => JSON.parse(await readFile(path.join(root, file), "utf8"));
    const provider = await read("providers/p1.json");
    assert.equal(decryptSecretWith(provider.token, NEW), "provider-secret");
    assert.throws(() => decryptSecretWith(provider.token, OLD));
    const github = await read("github/u1.json");
    assert.equal(decryptSecretWith(github.accessToken, NEW), "github-secret");
    const yandex = await read("yandex/u1.json");
    assert.equal(decryptSecretWith(yandex.secret, NEW), "yandex-secret");
    const database = await read("database/u1.json");
    assert.equal(decryptSecretWith(database.password, NEW), "db-password");
    assert.equal(decryptSecretWith(database.url, NEW), "postgres://u:p@h/db");
    const projectSecrets = await read("project-secrets/p1.json");
    assert.equal(decryptSecretWith(projectSecrets.payload, NEW), '{".env.local":{"TOKEN":"project-secret"}}');
    assert.throws(() => decryptSecretWith(projectSecrets.payload, OLD));
    const platform = await read("platform/env.json");
    assert.equal(decryptSecretWith(platform.values.GITHUB_CLIENT_SECRET.value, NEW), "legacy-panel-plain");
    assert.throws(() => decryptSecretWith(platform.values.GITHUB_CLIENT_SECRET.value, OLD));

    const raw = await readFile(path.join(root, "platform", "env.json"), "utf8");
    assert.equal(raw.includes("legacy-panel-plain"), false, "плейнтекст не остаётся на диске");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("повреждённый секрет отменяет ротацию, не оставляя половину файлов на новом ключе", async () => {
  const root = await fixture();
  try {
    const broken = path.join(root, "yandex", "u1.json");
    await writeFile(broken, JSON.stringify({ userId: "u1", id: "y1", kind: "key", secret: "enc:v1:AAAA:BBBB:CCCC" }));
    const before = await readFile(path.join(root, "providers", "p1.json"), "utf8");

    await assert.rejects(rotateJsonStore(root, OLD, NEW));

    assert.equal(await readFile(path.join(root, "providers", "p1.json"), "utf8"), before, "другие файлы не перезаписаны");
    const stillOld = JSON.parse(before);
    assert.equal(decryptSecretWith(stillOld.token, OLD), "provider-secret", "старый ключ всё ещё работает");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

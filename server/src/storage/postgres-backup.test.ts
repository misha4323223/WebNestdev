import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { objectStoreConfigFromEnv, s3ObjectStore, type ObjectStore } from "./object-store.js";
import {
  backupDatabaseSegment,
  backupObjectKey,
  backupStamp,
  checkBackup,
  manifestObjectKey,
  putBackup,
  readBackup,
  readManifest,
  validateBackupKey,
} from "./postgres-backup.js";

type FakeStore = ObjectStore & { objects: Map<string, Buffer> };

function fakeStore(prefix = "webnestdev"): FakeStore {
  const objects = new Map<string, Buffer>();
  return {
    prefix,
    objects,
    async putFile(key, file) {
      const bytes = await readFile(file);
      objects.set(key, bytes);
      return bytes.length;
    },
    async getToFile(key, file) {
      const bytes = objects.get(key);
      if (!bytes) return false;
      await writeFile(file, bytes);
      return true;
    },
    async head(key) {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.length } : null;
    },
    async remove(key) {
      objects.delete(key);
    },
  };
}

function collector() {
  const chunks: Buffer[] = [];
  const output = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(Buffer.from(chunk));
      done();
    },
  });
  return { output, text: () => Buffer.concat(chunks).toString("utf8") };
}

const NOW = new Date("2026-10-29T02:30:00.000Z");
const SHA = (text: string) => createHash("sha256").update(text).digest("hex");

test("ключ бэкапа: дата, база и имя файла без сюрпризов", () => {
  assert.equal(backupStamp(NOW), "20261029T023000Z");
  assert.equal(backupDatabaseSegment("My-DB"), "my-db");
  assert.equal(
    backupObjectKey("webnestdev/", "webnestdev", NOW),
    "webnestdev/backups/postgres/webnestdev/2026/10/29/webnestdev-20261029T023000Z.dump",
  );
  assert.equal(
    backupObjectKey("team", "webnestdev", NOW, "manual.dump"),
    "team/backups/postgres/webnestdev/2026/10/29/manual.dump",
  );
  assert.throws(() => backupObjectKey("p", "bad/name"), /Некорректное имя базы/);
  assert.throws(() => backupObjectKey("p", "webnestdev", NOW, "../escape"), /Некорректное имя файла/);
  assert.equal(manifestObjectKey("p", "webnestdev"), "p/backups/postgres/webnestdev/latest.json");
});

test("чужой ключ не читается: манифест из бакета не доверенный", () => {
  assert.equal(validateBackupKey("p", "p/backups/postgres/webnestdev/2026/10/29/d.dump"), "p/backups/postgres/webnestdev/2026/10/29/d.dump");
  assert.throws(() => validateBackupKey("p", "p/projects/u/p/workspace.tar.gz"), /вне каталога/);
  assert.throws(() => validateBackupKey("p", "p/backups/postgres/../projects"), /Некорректный ключ/);
  assert.throws(() => validateBackupKey("p", "p/backups/postgres/a//b"), /Некорректный ключ/);
});

test("putBackup: дамп, sha256, манифест и подтверждение размера", async () => {
  const store = fakeStore();
  const root = await mkdtemp(path.join(tmpdir(), "pg-backup-test-"));
  const body = "custom-format-dump";
  try {
    const manifest = await putBackup({
      store,
      database: "webnestdev",
      input: Readable.from([Buffer.from(body)]),
      now: NOW,
      tempRoot: root,
    });
    assert.equal(manifest.key, "webnestdev/backups/postgres/webnestdev/2026/10/29/webnestdev-20261029T023000Z.dump");
    assert.equal(manifest.bytes, Buffer.byteLength(body));
    assert.equal(manifest.sha256, SHA(body));
    assert.equal(manifest.createdAt, NOW.toISOString());
    assert.equal(store.objects.get(manifest.key)?.toString(), body);

    const saved = JSON.parse(store.objects.get(manifestObjectKey("webnestdev", "webnestdev"))!.toString("utf8"));
    assert.deepEqual(saved, manifest);
    assert.deepEqual(await readdir(root), [], "временный каталог убран");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("putBackup: пустой и слишком большой поток отклоняются, временные файлы убираются", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pg-backup-test-"));
  try {
    await assert.rejects(
      () => putBackup({ store: fakeStore(), database: "webnestdev", input: Readable.from([]), now: NOW, tempRoot: root }),
      /Пустой дамп/,
    );
    await assert.rejects(
      () => putBackup({
        store: fakeStore(),
        database: "webnestdev",
        input: Readable.from([Buffer.from("12345")]),
        now: NOW,
        tempRoot: root,
        maxBytes: 4,
      }),
      /предела 4 байт/,
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("манифест читается и проверяется; битый или чужой — отклоняется", async () => {
  const store = fakeStore();
  const manifest = await putBackup({
    store,
    database: "webnestdev",
    input: Readable.from([Buffer.from("dump")]),
    now: NOW,
  });
  assert.deepEqual(await readManifest(store, "webnestdev"), manifest);

  store.objects.set(manifestObjectKey("webnestdev", "webnestdev"), Buffer.from("не json"));
  await assert.rejects(() => readManifest(store, "webnestdev"), /не JSON/);

  store.objects.set(
    manifestObjectKey("webnestdev", "webnestdev"),
    Buffer.from(JSON.stringify({ ...manifest, key: "webnestdev/projects/u/p/workspace.tar.gz" })),
  );
  await assert.rejects(() => readManifest(store, "webnestdev"), /вне каталога/);

  store.objects.set(manifestObjectKey("webnestdev", "webnestdev"), Buffer.from(JSON.stringify({ ...manifest, version: 2 })));
  await assert.rejects(() => readManifest(store, "webnestdev"), /версия/);
});

test("checkBackup: свежий проходит, старый и с расхождением размера — нет", async () => {
  const store = fakeStore();
  const manifest = await putBackup({
    store,
    database: "webnestdev",
    input: Readable.from([Buffer.from("dump")]),
    now: NOW,
  });

  const fresh = await checkBackup({ store, database: "webnestdev", maxAgeHours: 36, now: new Date(NOW.getTime() + 3_600_000) });
  assert.equal(fresh.manifest.key, manifest.key);
  assert.ok(Math.abs(fresh.ageHours - 1) < 0.001);

  await assert.rejects(
    () => checkBackup({ store, database: "webnestdev", maxAgeHours: 36, now: new Date(NOW.getTime() + 37 * 3_600_000) }),
    /старше 36 ч/,
  );

  store.objects.set(manifest.key, Buffer.from("short"));
  await assert.rejects(
    () => checkBackup({ store, database: "webnestdev", maxAgeHours: 36, now: NOW }),
    /не совпадает/,
  );

  await assert.rejects(
    () => checkBackup({ store: fakeStore(), database: "webnestdev", maxAgeHours: 36, now: NOW }),
    /нет ни одного бэкапа/,
  );
});

test("putBackup и readBackup проходят через настоящий S3-клиент", async () => {
  const objects = new Map<string, Buffer>();
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const key = decodeURIComponent(new URL(String(url)).pathname).replace(/^\/[^/]+\//, "");
    const method = String(init?.method ?? "GET").toUpperCase();
    if (method === "PUT") {
      const chunks: Buffer[] = [];
      const body = init?.body as AsyncIterable<Buffer> | null | undefined;
      if (body) for await (const chunk of body) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
      return new Response(null, { status: 200 });
    }
    if (method === "HEAD") {
      const value = objects.get(key);
      return value
        ? new Response(null, { status: 200, headers: { "content-length": String(value.length) } })
        : new Response(null, { status: 404 });
    }
    const value = objects.get(key);
    return value ? new Response(value as unknown as BodyInit, { status: 200 }) : new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  const config = objectStoreConfigFromEnv({
    PLATFORM_S3_ENDPOINT: "https://s3.example.test",
    PLATFORM_S3_BUCKET: "bucket",
    PLATFORM_S3_ACCESS_KEY_ID: "access",
    PLATFORM_S3_SECRET_ACCESS_KEY: "secret",
  });
  assert.ok(config);
  const store = s3ObjectStore(config, { fetch: fakeFetch });
  const body = "dump-through-real-client";
  const manifest = await putBackup({
    store,
    database: "webnestdev",
    input: Readable.from([Buffer.from(body)]),
    now: NOW,
  });
  assert.equal(objects.get(manifest.key)?.toString(), body);

  const sink = collector();
  await readBackup({ store, key: manifest.key, sha256: manifest.sha256, output: sink.output });
  assert.equal(sink.text(), body);
  const fresh = await checkBackup({ store, database: "webnestdev", maxAgeHours: 36, now: NOW });
  assert.equal(fresh.manifest.key, manifest.key);
});

test("readBackup: сумма проверяется до восстановления, поток отдаётся целиком", async () => {
  const store = fakeStore();
  const body = "custom-format-dump";
  const manifest = await putBackup({
    store,
    database: "webnestdev",
    input: Readable.from([Buffer.from(body)]),
    now: NOW,
  });

  const sink = collector();
  const bytes = await readBackup({ store, key: manifest.key, sha256: manifest.sha256, output: sink.output });
  assert.equal(bytes, Buffer.byteLength(body));
  assert.equal(sink.text(), body);

  await assert.rejects(
    () => readBackup({ store, key: manifest.key, sha256: SHA("другое"), output: collector().output }),
    /не совпала/,
  );
  await assert.rejects(
    () => readBackup({ store, key: "webnestdev/projects/u/p/workspace.tar.gz", sha256: manifest.sha256, output: collector().output }),
    /вне каталога/,
  );
  await assert.rejects(
    () => readBackup({ store, key: "webnestdev/backups/postgres/webnestdev/2026/10/29/missing.dump", sha256: manifest.sha256, output: collector().output }),
    /не найден/,
  );
});

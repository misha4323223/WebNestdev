import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  describeObjectStore,
  objectPathFor,
  objectStoreConfigFromEnv,
  projectArchiveKey,
  s3ObjectStore,
  summarizeBucket,
} from "./object-store.js";

const FULL_ENV = {
  PLATFORM_S3_ENDPOINT: "https://s3.twcstorage.ru",
  PLATFORM_S3_BUCKET: "webnestdev-projects",
  PLATFORM_S3_ACCESS_KEY_ID: "AKIADEMO",
  PLATFORM_S3_SECRET_ACCESS_KEY: "demo-secret",
};

test("хранилище выключено, пока не заданы ключи, и падает на половине настроек", () => {
  assert.equal(objectStoreConfigFromEnv({}), null);
  assert.match(describeObjectStore({}), /не настроено/);
  assert.throws(
    () => objectStoreConfigFromEnv({ ...FULL_ENV, PLATFORM_S3_SECRET_ACCESS_KEY: "" }),
    /настроено не полностью/,
  );
});

test("конфигурация: регион и префикс по умолчанию, адрес — только хост", () => {
  const config = objectStoreConfigFromEnv(FULL_ENV);
  assert.equal(config?.region, "ru-1");
  assert.equal(config?.prefix, "webnestdev");
  assert.equal(objectStoreConfigFromEnv({ ...FULL_ENV, PLATFORM_S3_PREFIX: "/team/" })?.prefix, "team");
  assert.match(describeObjectStore(FULL_ENV), /бакет webnestdev-projects в s3\.twcstorage\.ru/);
  assert.throws(() => objectStoreConfigFromEnv({ ...FULL_ENV, PLATFORM_S3_ENDPOINT: "http://minio:9000" }), /https/);
  assert.throws(() => objectStoreConfigFromEnv({ ...FULL_ENV, PLATFORM_S3_ENDPOINT: "https://s3.twcstorage.ru/bucket" }), /только адрес сервиса/);
});

test("ключ архива и путь запроса кодируются по сегментам", () => {
  const store = { bucket: "b" };
  assert.equal(projectArchiveKey("webnestdev", "user-1", "project-1"), "webnestdev/projects/user-1/project-1/workspace.tar.gz");
  assert.equal(objectPathFor(store, "webnestdev/projects/u/p/workspace.tar.gz"), "/b/webnestdev/projects/u/p/workspace.tar.gz");
  assert.throws(() => objectPathFor(store, "webnestdev/../../etc/passwd"), /Некорректный ключ/);
});

test("загрузка файла подписывает хеш, тип и длину тела", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "object-store-"));
  const file = path.join(dir, "workspace.tar.gz");
  await writeFile(file, "архив");
  const store = { calls: [] as Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }> };
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    store.calls.push({
      method: String(init?.method),
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body,
    });
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;

  try {
    const client = s3ObjectStore(objectStoreConfigFromEnv(FULL_ENV), { fetch: fakeFetch });
    const bytes = await client.putFile("webnestdev/projects/u/p/workspace.tar.gz", file, "application/gzip");
    assert.equal(bytes, Buffer.byteLength("архив"));
    const call = store.calls[0];
    assert.equal(call.method, "PUT");
    assert.equal(call.url, "https://s3.twcstorage.ru/webnestdev-projects/webnestdev/projects/u/p/workspace.tar.gz");
    assert.equal(call.headers["content-type"], "application/gzip");
    assert.equal(call.headers["content-length"], String(bytes));
    assert.match(call.headers["x-amz-content-sha256"], /^[0-9a-f]{64}$/);
    assert.match(call.headers.Authorization, /SignedHeaders=content-length;content-type;host;x-amz-content-sha256;x-amz-date/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("скачивание пишет файл, а отсутствующий объект — это false", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "object-store-"));
  try {
    const config = objectStoreConfigFromEnv(FULL_ENV);
    const client = s3ObjectStore(config, {
      fetch: (async () => new Response("содержимое", { status: 200 })) as unknown as typeof fetch,
    });
    const target = path.join(dir, "restored.tar.gz");
    assert.equal(await client.getToFile("k", target), true);
    assert.equal(await readFile(target, "utf8"), "содержимое");

    const missing = s3ObjectStore(config, {
      fetch: (async () => new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 })) as unknown as typeof fetch,
    });
    assert.equal(await missing.getToFile("k", path.join(dir, "none")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("сводка бакета складывает объекты и честно помечает предел страниц", async () => {
  const config = objectStoreConfigFromEnv(FULL_ENV);
  const pages = [
    "<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken>" +
      "<Contents><Key>a</Key><Size>10</Size></Contents><Contents><Key>b</Key><Size>20</Size></Contents></ListBucketResult>",
    "<ListBucketResult><IsTruncated>false</IsTruncated>" +
      "<Contents><Key>c</Key><Size>30</Size></Contents></ListBucketResult>",
  ];
  const urls: string[] = [];
  const fakeFetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(pages[urls.length - 1] ?? pages[0], { status: 200 });
  }) as unknown as typeof fetch;

  assert.deepEqual(await summarizeBucket(config, { fetch: fakeFetch }, { maxPages: 1 }), {
    objects: 2,
    bytes: 30,
    truncated: true,
  });
  assert.match(urls[0], /list-type=2/);
  assert.match(urls[0], /prefix=webnestdev/);

  urls.length = 0;
  assert.deepEqual(await summarizeBucket(config, { fetch: fakeFetch }, { maxPages: 10 }), {
    objects: 3,
    bytes: 60,
    truncated: false,
  });
  assert.equal(urls.length, 2, "вторая страница запрошена по continuation-token");
  assert.match(urls[1], /continuation-token=next/);

  // Провайдер сказал «есть ещё», но токен не прислал: это всё равно неполный список.
  const noToken = (async () =>
    new Response(
      "<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>a</Key><Size>10</Size></Contents></ListBucketResult>",
      { status: 200 },
    )) as unknown as typeof fetch;
  assert.deepEqual(await summarizeBucket(config, { fetch: noToken }, { maxPages: 10 }), {
    objects: 1,
    bytes: 10,
    truncated: true,
  });
});

test("head отдаёт размер, отказ хранилища объясняется кодом", async () => {
  const config = objectStoreConfigFromEnv(FULL_ENV);
  const head = s3ObjectStore(config, {
    fetch: (async () => new Response(null, { status: 200, headers: { "content-length": "123" } })) as unknown as typeof fetch,
  });
  assert.deepEqual(await head.head("k"), { size: 123 });

  const denied = s3ObjectStore(config, {
    fetch: (async () => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 })) as unknown as typeof fetch,
  });
  await assert.rejects(() => denied.remove("k"), /не дало удалить объект: AccessDenied/);
});

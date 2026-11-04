import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteProjectMedia,
  listMediaObjects,
  mediaConfigFromEnv,
  mediaKey,
  mediaKeyBelongsTo,
  mediaPublicUrl,
  renameMediaObject,
  safeMediaName,
  uploadMultipartPart,
} from "./media-store.js";
import { presignAwsV4 } from "../services/s3.js";

const env = {
  MEDIA_S3_ENDPOINT: "https://storage.mwsapis.ru",
  MEDIA_S3_BUCKET: "nestdev-media",
  MEDIA_S3_REGION: "ru-1",
  MEDIA_PUBLIC_BASE_URL: "https://storage.mwsapis.ru/nestdev-media",
  MEDIA_S3_PREFIX: "media",
  MWS_SA_KEY: "test-key",
} as NodeJS.ProcessEnv;

test("media config reads the bucket and enforces the 10 GiB default", () => {
  const config = mediaConfigFromEnv(env);
  assert.ok(config);
  assert.equal(config.bucket, "nestdev-media");
  assert.equal(config.maxFileBytes, 10 * 1024 * 1024 * 1024);
  assert.equal(config.partSizeBytes, 64 * 1024 * 1024);
});

test("media config refuses a partial bucket instead of silently disabling uploads", () => {
  assert.throws(
    () => mediaConfigFromEnv({ MEDIA_S3_ENDPOINT: "https://storage.mwsapis.ru", MWS_SA_KEY: "test-key" } as NodeJS.ProcessEnv),
    /MEDIA_S3_BUCKET/,
  );
});

test("media names are reduced to a safe path segment", () => {
  assert.equal(safeMediaName("../../Мой клип (final).mp4"), "final-.mp4");
  assert.equal(safeMediaName("..."), "file");
});

test("media keys stay inside the user's project and foreign keys are rejected", () => {
  const config = mediaConfigFromEnv(env);
  assert.ok(config);
  const key = mediaKey(config, "user-1", "project-1", "video.mp4");
  assert.match(key, /^media\/user-1\/project-1\/\d{4}\/\d{2}\/[0-9a-f-]+-video\.mp4$/);
  assert.equal(mediaKeyBelongsTo(config, key, "user-1", "project-1"), true);
  assert.equal(mediaKeyBelongsTo(config, key, "user-2", "project-1"), false);
  assert.equal(mediaKeyBelongsTo(config, key.replace("project-1", "project-2"), "user-1", "project-1"), false);
  assert.equal(mediaPublicUrl(config, "media/a b.png"), "https://storage.mwsapis.ru/nestdev-media/media/a%20b.png");
});

test("project cleanup lists the project prefix and deletes every object", async () => {
  const config = mediaConfigFromEnv(env);
  assert.ok(config);
  const previousToken = process.env.MWS_IAM_TOKEN;
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  process.env.MWS_IAM_TOKEN = "test-token";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });
    if (url.includes("issueServiceAccountToken")) {
      return new Response(JSON.stringify({
        accessToken: "iam-token",
        expirationTs: new Date(Date.now() + 10 * 60_000).toISOString(),
      }), { status: 200 });
    }
    if (url.includes("issueSessionToken")) {
      return new Response(JSON.stringify({
        AccessKeyId: "access",
        SecretAccessKey: "secret",
        SessionToken: "session",
        Expiration: new Date(Date.now() + 10 * 60_000).toISOString(),
      }), { status: 200 });
    }
    if (method === "GET") {
      return new Response(
        "<ListBucketResult><IsTruncated>false</IsTruncated>" +
        "<Contents><Key>media/user-1/project-1/2026/11/a&amp;b.png</Key><Size>10</Size></Contents>" +
        "<Contents><Key>media/user-1/project-1/2026/11/c.png</Key><Size>20</Size></Contents>" +
        "</ListBucketResult>",
        { status: 200 },
      );
    }
    if (method === "DELETE") return new Response(null, { status: 204 });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  try {
    const result = await deleteProjectMedia(config, "user-1", "project-1");
    assert.deepEqual(result, { deleted: 2, failed: 0 });
    const list = calls.find(call => call.url.includes("list-type=2"));
    assert.ok(list?.url.includes("prefix=media%2Fuser-1%2Fproject-1%2F"));
    assert.equal(calls.filter(call => call.method === "DELETE").length, 2);
    assert.ok(calls.some(call => call.url.includes("a%26b.png")));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.MWS_IAM_TOKEN;
    else process.env.MWS_IAM_TOKEN = previousToken;
  }
});

test("media list shows object metadata and rename copies then removes the old key", async () => {
  const config = mediaConfigFromEnv(env);
  assert.ok(config);
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; headers: Headers }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    calls.push({ url, method, headers });
    if (url.includes("issueServiceAccountToken")) {
      return new Response(JSON.stringify({ accessToken: "iam-token", expirationTs: new Date(Date.now() + 10 * 60_000).toISOString() }), { status: 200 });
    }
    if (url.includes("issueSessionToken")) {
      return new Response(JSON.stringify({
        AccessKeyId: "access", SecretAccessKey: "secret", SessionToken: "session",
        Expiration: new Date(Date.now() + 10 * 60_000).toISOString(),
      }), { status: 200 });
    }
    if (method === "GET" && url.includes("list-type=2")) {
      return new Response(
        "<ListBucketResult><IsTruncated>false</IsTruncated>" +
        "<Contents><Key>media/user-1/project-1/2026/11/11111111-1111-1111-1111-111111111111-photo.jpg</Key><Size>1000</Size><LastModified>2026-11-04T10:00:00.000Z</LastModified></Contents>" +
        "</ListBucketResult>",
        { status: 200 },
      );
    }
    if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": "1000" } });
    if (method === "PUT") return new Response("<CopyObjectResult/>", { status: 200 });
    if (method === "DELETE") return new Response(null, { status: 204 });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  try {
    const listed = await listMediaObjects(config, "user-1", "project-1");
    assert.deepEqual(listed.objects.map(object => object.name), ["photo.jpg"]);
    assert.equal(listed.objects[0].bytes, 1000);
    assert.equal(listed.objects[0].url, "https://storage.mwsapis.ru/nestdev-media/media/user-1/project-1/2026/11/11111111-1111-1111-1111-111111111111-photo.jpg");

    const renamed = await renameMediaObject(config, {
      userId: "user-1", projectId: "project-1",
      key: listed.objects[0].key,
      name: "cover",
    });
    assert.notEqual(renamed.key, listed.objects[0].key);
    assert.match(renamed.key, /^media\/user-1\/project-1\/2026\/11\/[0-9a-f-]+-cover\.jpg$/);
    const copy = calls.find(call => call.method === "PUT");
    assert.ok(copy?.headers.get("x-amz-copy-source")?.includes("11111111-1111-1111-1111-111111111111-photo.jpg"));
    assert.ok(calls.some(call => call.method === "DELETE" && call.url.includes("11111111-1111-1111-1111-111111111111-photo.jpg")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a part sent through the API keeps the multipart key, number and bytes", async () => {
  const config = mediaConfigFromEnv(env);
  assert.ok(config);
  const previousToken = process.env.MWS_IAM_TOKEN;
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method: string; headers: Headers; body: unknown }> = [];
  process.env.MWS_IAM_TOKEN = "test-token";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, headers: new Headers(init?.headers), body: init?.body });
    if (url.includes("issueServiceAccountToken")) {
      return new Response(JSON.stringify({ accessToken: "iam-token", expirationTs: new Date(Date.now() + 10 * 60_000).toISOString() }), { status: 200 });
    }
    if (url.includes("issueSessionToken")) {
      return new Response(JSON.stringify({
        AccessKeyId: "access", SecretAccessKey: "secret", SessionToken: "session",
        Expiration: new Date(Date.now() + 10 * 60_000).toISOString(),
      }), { status: 200 });
    }
    if (method === "PUT") return new Response(null, { status: 200, headers: { etag: "\"0f343b0931126a20f133d67c2b018a3b\"" } });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  try {
    const key = mediaKey(config, "user-1", "project-1", "photo.webp");
    const bytes = Buffer.from("part-bytes");
    const etag = await uploadMultipartPart(config, { key, uploadId: "00065F75B1B0B26B", partNumber: 1, body: bytes });
    assert.equal(etag, "\"0f343b0931126a20f133d67c2b018a3b\"");
    const put = calls.find(call => call.method === "PUT");
    assert.ok(put?.url.includes("partNumber=1"));
    assert.ok(put?.url.includes("uploadId=00065F75B1B0B26B"));
    assert.ok(put?.url.includes("/nestdev-media/" + key));
    assert.deepEqual(put?.body, new Uint8Array(bytes));
    // Подпись считается по телу части: иначе хранилище отклонит загрузку.
    assert.ok(put?.headers.get("authorization")?.includes("Signature="));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousToken === undefined) delete process.env.MWS_IAM_TOKEN;
    else process.env.MWS_IAM_TOKEN = previousToken;
  }
});

test("presigned query keeps AWS byte order when a part number is present", () => {
  const url = presignAwsV4({
    method: "PUT",
    host: "storage.mwsapis.ru",
    path: "/nestdev-media/media/user-1/project-1/video.mp4",
    query: { partNumber: "1", uploadId: "00065F75B1B0B26B" },
    expiresSeconds: 3600,
    amzDate: "20261104T120000Z",
    region: "ru-1",
    accessKey: "access",
    secretKey: "secret",
  });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("partNumber"), "1");
  assert.equal(parsed.searchParams.get("uploadId"), "00065F75B1B0B26B");
  assert.equal(parsed.searchParams.get("X-Amz-Signature")?.length, 64);
  assert.ok(url.indexOf("X-Amz-Algorithm") < url.indexOf("partNumber"), "X-Amz-* must sort before lowercase query keys");
});

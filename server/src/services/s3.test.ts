import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { amzDate, awsEncode, listS3Buckets, parseBucketList, parseS3Endpoint, parseS3ErrorCode, signAwsV4 } from "./s3.js";

/** Хеш пустого тела — то, что подписывает ListBuckets. */
const EMPTY = createHash("sha256").update("").digest("hex");

test("подпись совпадает с независимой реализацией (curl --aws-sigv4)", () => {
  // Значения сняты с трассировки curl при запросе к реальному хранилищу Selectel
  // (curl -s --trace-ascii ... --aws-sigv4 aws:amz:ru-1:s3 --user AKIADEMO:demo-secret https://s3.storage.selcloud.ru/).
  const signed = signAwsV4({
    method: "GET",
    path: "/",
    headers: { host: "s3.storage.selcloud.ru", "x-amz-date": "20261018T203055Z" },
    payloadHash: EMPTY,
    amzDate: "20261018T203055Z",
    region: "ru-1",
    accessKey: "AKIADEMO",
    secretKey: "demo-secret",
  });
  assert.equal(signed.signedHeaders, "host;x-amz-date");
  assert.equal(signed.signature, "8252bca6ef39d8fb8e01f5a17b1e45db4c92b225de35864e89ec4bbd27f36023");
  assert.match(signed.authorization, /^AWS4-HMAC-SHA256 Credential=AKIADEMO\/20261018\/ru-1\/s3\/aws4_request, SignedHeaders=host;x-amz-date, Signature=/);
});

test("запрос проверки подписывает хост, дату и хеш тела", async () => {
  let sent: { url: string; headers: Record<string, string> } | null = null;
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string> };
    return new Response("<ListAllMyBucketsResult><Buckets><Bucket><Name>files</Name></Bucket></Buckets></ListAllMyBucketsResult>", { status: 200 });
  }) as unknown as typeof fetch;

  const result = await listS3Buckets(
    { endpoint: "https://s3.twcstorage.ru", region: "ru-1", accessKey: "AKIADEMO", secretKey: "demo-secret" },
    { fetch: fakeFetch },
  );

  assert.deepEqual(result.buckets, ["files"]);
  assert.equal(result.host, "s3.twcstorage.ru");
  assert.equal(sent!.url, "https://s3.twcstorage.ru/");
  assert.match(sent!.headers["x-amz-content-sha256"], /^[0-9a-f]{64}$/);
  assert.match(sent!.headers["x-amz-date"], /^\d{8}T\d{6}Z$/);
  assert.match(sent!.headers.Authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
});

test("неизвестный ключ и отсутствие прав говорят разное", async () => {
  const respond = (body: string, status = 403) => (async () => new Response(body, { status })) as unknown as typeof fetch;
  const credentials = { endpoint: "https://s3.cloud.ru", region: "ru-central-1", accessKey: "AKIADEMO", secretKey: "demo-secret" };

  await assert.rejects(
    () => listS3Buckets(credentials, { fetch: respond("<Error><Code>InvalidAccessKeyId</Code></Error>") }),
    /отклонило ключ \(InvalidAccessKeyId\)/,
  );
  await assert.rejects(
    () => listS3Buckets(credentials, { fetch: respond("<Error><Code>AccessDenied</Code></Error>") }),
    /доступ запрещён.*ключа нет роли/s,
  );
});

test("адрес хранилища принимается только как https-хост", () => {
  assert.deepEqual(parseS3Endpoint("https://s3.timeweb.cloud"), { host: "s3.timeweb.cloud", origin: "https://s3.timeweb.cloud" });
  assert.throws(() => parseS3Endpoint("http://s3.timeweb.cloud"), /https/);
  assert.throws(() => parseS3Endpoint("https://s3.timeweb.cloud/bucket"), /только хост/);
  assert.throws(() => parseS3Endpoint("не адрес"), /Некорректный адрес/);
});

test("кодирование и разбор ответов", () => {
  assert.equal(awsEncode("Москва и (тест)"), "%D0%9C%D0%BE%D1%81%D0%BA%D0%B2%D0%B0%20%D0%B8%20%28%D1%82%D0%B5%D1%81%D1%82%29");
  assert.equal(amzDate(new Date("2026-10-18T10:00:00.000Z")), "20261018T100000Z");
  assert.deepEqual(parseBucketList("<Bucket><Name>a</Name></Bucket><Bucket><Name>b</Name><CreationDate>x</CreationDate></Bucket>"), ["a", "b"]);
  assert.equal(parseBucketList("<ListAllMyBucketsResult></ListAllMyBucketsResult>").length, 0);
  assert.equal(parseS3ErrorCode("<Error><Code>SignatureDoesNotMatch</Code></Error>"), "SignatureDoesNotMatch");
  assert.equal(parseS3ErrorCode("<html>403</html>"), null);
});

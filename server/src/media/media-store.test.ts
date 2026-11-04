import assert from "node:assert/strict";
import test from "node:test";
import {
  mediaConfigFromEnv,
  mediaKey,
  mediaKeyBelongsTo,
  mediaPublicUrl,
  safeMediaName,
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

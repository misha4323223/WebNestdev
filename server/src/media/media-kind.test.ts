import test from "node:test";
import assert from "node:assert/strict";
import { mediaContentType, mediaKind, mediaKindFromName } from "./media-kind.js";

test("размер не влияет на решение: даже маленькая картинка — медиа", () => {
  assert.equal(mediaKindFromName("public/images/icon.png"), "image");
  assert.equal(mediaKindFromName("1kb.jpg"), "image");
  assert.equal(mediaKindFromName("public/hero.webp?v=2"), "image");
  assert.equal(mediaKindFromName("README.md"), null);
});

test("видео распознаётся по расширению и content-type", () => {
  assert.equal(mediaKindFromName("media/intro.mp4"), "video");
  assert.equal(mediaKind({ name: "clip", contentType: "video/webm" }), "video");
  assert.equal(mediaKind({ name: "clip.webm", contentType: "application/octet-stream" }), "video");
});

test("content-type важнее имени, когда сервер отдаёт файл без расширения", () => {
  assert.equal(mediaKind({ name: "photo.php", contentType: "image/jpeg; charset=binary" }), "image");
  assert.equal(mediaKind({ name: "download", contentType: "image/avif" }), "image");
  assert.equal(mediaKind({ name: "download", contentType: "text/plain" }), null);
  assert.equal(mediaKind({ name: "missing.png", contentType: "text/html" }), null, "страница ошибки не становится картинкой");
});

test("тип в бакете восстанавливается по расширению, если сервер отдал octet-stream", () => {
  assert.equal(mediaContentType({ name: "hero.webp", contentType: "application/octet-stream", kind: "image" }), "image/webp");
  assert.equal(mediaContentType({ name: "intro.mov", contentType: "binary/octet-stream", kind: "video" }), "video/quicktime");
  assert.equal(mediaContentType({ name: "photo", contentType: "image/avif; charset=binary", kind: "image" }), "image/avif");
});

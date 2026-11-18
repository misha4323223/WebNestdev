import test from "node:test";
import assert from "node:assert/strict";
import { hostingProjectView, type HostingProjectInspection } from "./project-mode.js";

function functions(count: number): HostingProjectInspection {
  return { kind: "static-functions", functions: count, jobs: 0, reason: "" };
}

test("на «Плюсе» можно опубликовать до пяти функций на сайт", () => {
  assert.equal(hostingProjectView(functions(5), "pro").canPublish, true);
});

test("шестая функция на «Плюсе» блокирует публикацию с понятной причиной", () => {
  const view = hostingProjectView(functions(6), "pro");
  assert.equal(view.canPublish, false);
  assert.match(view.reason, /до 5 функций.*6/);
});

test("на бесплатном тарифе функции закрыты целиком, а не только сверх лимита", () => {
  const view = hostingProjectView(functions(1), "free");
  assert.equal(view.canPublish, false);
  assert.match(view.reason, /serverless-функции/);
});

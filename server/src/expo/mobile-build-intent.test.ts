import assert from "node:assert/strict";
import test from "node:test";
import { mobileBuildIntent } from "./mobile-build-intent.js";

/**
 * Просьба о сборке отличается от правки и от вопроса о статусе: expo.build запускает EAS и
 * тратит кредиты, поэтому наугад его не зовут.
 */
test("явная просьба о мобильной сборке", () => {
  assert.equal(mobileBuildIntent("собери приложение для android"), "explicit");
  assert.equal(mobileBuildIntent("сделай apk"), "explicit");
  assert.equal(mobileBuildIntent("запусти сборку на eas"), "explicit");
  assert.equal(mobileBuildIntent("собери ios приложение"), "explicit");
  assert.equal(mobileBuildIntent("build the android app on expo"), "explicit");
});

test("«собери приложение» без признака платформы — сначала уточнить", () => {
  assert.equal(mobileBuildIntent("собери приложение"), "ambiguous");
  assert.equal(mobileBuildIntent("сделай сборку приложения"), "ambiguous");
});

test("обычная работа, вопрос о статусе и веб-сборка не запускают EAS", () => {
  assert.equal(mobileBuildIntent("поправь кнопку в андроид-приложении"), "none");
  assert.equal(mobileBuildIntent("покажи статус сборки android"), "none");
  assert.equal(mobileBuildIntent("проверь сборку на eas"), "none");
  assert.equal(mobileBuildIntent("собери проект"), "none");
  assert.equal(mobileBuildIntent("npm run build"), "none");
  assert.equal(mobileBuildIntent(""), "none");
});

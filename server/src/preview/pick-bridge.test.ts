import test from "node:test";
import assert from "node:assert/strict";
import { PICK_COMMAND, PICK_BRIDGE_PATH, PICK_BRIDGE_SCRIPT, PICK_BRIDGE_TAG, PICK_RESULT, canInjectPickBridge, injectPickBridge, pickBridgeResponse } from "./pick-bridge.js";

/**
 * Мост выбора элемента — единственный код платформы, который выполняется внутри документа
 * пользовательского приложения. Поэтому проверяется не «вставилось ли что-то», а три вещи:
 * вставка не портит документ, повторная вставка ничего не добавляет, а сам скрипт слушает только
 * родительское окно и не несёт незаменённых заглушек.
 */

test("мост вставляется перед закрытием body и не дублируется", () => {
  const html = '<!doctype html><html><body><h1>приложение</h1></body></html>';
  const injected = injectPickBridge(html);
  assert.ok(injected.includes(PICK_BRIDGE_TAG), "тег моста должен попасть в документ");
  assert.ok(injected.indexOf(PICK_BRIDGE_TAG) < injected.indexOf("</body>"), "тег ставится до закрытия body");
  assert.match(injected, /<h1>приложение<\/h1>/, "разметка приложения не меняется");
  assert.equal(injectPickBridge(injected), injected, "повторная вставка ничего не добавляет");
});

test("документ без body получает мост в конец, а не теряется", () => {
  const fragment = "<div>фрагмент без body</div>";
  const injected = injectPickBridge(fragment);
  assert.ok(injected.startsWith(fragment));
  assert.ok(injected.endsWith(PICK_BRIDGE_TAG));
});

test("вставка не выполняется для не-HTML и сжатых ответов", () => {
  assert.equal(canInjectPickBridge("text/html; charset=utf-8", null), true);
  assert.equal(canInjectPickBridge("text/html", "identity"), true);
  assert.equal(canInjectPickBridge("text/html", "gzip"), false, "сжатый ответ не перепаковывается");
  assert.equal(canInjectPickBridge("application/json", null), false);
  assert.equal(canInjectPickBridge("text/css", null), false);
  assert.equal(canInjectPickBridge(null, null), false);
});

test("скрипт моста готов к работе и никого, кроме родителя, не слушает", () => {
  assert.ok(!PICK_BRIDGE_SCRIPT.includes("__NEST_"), "в скрипте не должно остаться заглушек");
  assert.ok(PICK_BRIDGE_SCRIPT.includes(JSON.stringify(PICK_COMMAND)), "команда панели названа один раз");
  assert.ok(PICK_BRIDGE_SCRIPT.includes(JSON.stringify(PICK_RESULT)), "ответ панели назван один раз");
  assert.match(PICK_BRIDGE_SCRIPT, /event\.source !== window\.parent/);
  assert.match(PICK_BRIDGE_SCRIPT, /postMessage\(message, parentOrigin\)/);
  assert.match(PICK_BRIDGE_SCRIPT, /preventDefault\(\)/, "клик в режиме выбора не уходит в приложение");
});

test("ответ на сам скрипт — JavaScript без кэша и с точной длиной", () => {
  const response = pickBridgeResponse();
  assert.match(response.headers["content-type"], /application\/javascript/);
  assert.match(response.headers["cache-control"], /no-store/);
  assert.equal(Number(response.headers["content-length"]), response.body.length);
  assert.ok(PICK_BRIDGE_PATH.startsWith("/"), "путь отдаётся от корня адреса предпросмотра");
});

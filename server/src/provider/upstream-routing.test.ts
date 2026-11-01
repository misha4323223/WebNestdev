import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultUpstreamRouting,
  isUpstreamRouted,
  normalizeUpstreamRouting,
  parseUpstreamRouting,
  upstreamRoutingProblem,
} from "./upstream-routing.js";

test("auto — поведение по умолчанию: список пуст, шлюз выбирает сам", () => {
  assert.deepEqual(defaultUpstreamRouting(), {
    mode: "auto",
    providers: [],
    allowFallback: true,
    fallbackToAuto: false,
    assumedInputPerOutput: 10,
  });
  assert.equal(isUpstreamRouted(defaultUpstreamRouting()), false);
  assert.equal(isUpstreamRouted(normalizeUpstreamRouting({ mode: "fixed", providers: ["morph/fp8"] })), true);
});

test("fixed сохраняет порядок провайдеров, убирает повторы и заполняет умолчания", () => {
  const routing = normalizeUpstreamRouting({
    mode: "fixed",
    providers: ["morph/fp8", "open-inference/fp4", "morph/fp8"],
    maxPrice: { prompt: 10, completion: 40 },
  });
  assert.deepEqual(routing, {
    mode: "fixed",
    providers: ["morph/fp8", "open-inference/fp4"],
    allowFallback: true,
    fallbackToAuto: false,
    assumedInputPerOutput: 10,
    maxPrice: { prompt: 10, completion: 40 },
  });
  assert.equal(upstreamRoutingProblem(routing!), null);
});

test("cheapest принимает пустой белый список: рассматриваются все провайдеры", () => {
  const routing = normalizeUpstreamRouting({ mode: "cheapest", assumedInputPerOutput: 30 });
  assert.deepEqual(routing, {
    mode: "cheapest",
    providers: [],
    allowFallback: true,
    fallbackToAuto: false,
    assumedInputPerOutput: 30,
  });
  assert.equal(upstreamRoutingProblem(routing!), null);
});

test("fixed без провайдера и лишние провайдеры при allowFallback:false — ошибка настройки", () => {
  const empty = normalizeUpstreamRouting({ mode: "fixed" });
  assert.ok(empty);
  assert.match(upstreamRoutingProblem(empty!) ?? "", /хотя бы одного/);

  const two = normalizeUpstreamRouting({ mode: "fixed", providers: ["morph/fp8", "open-inference/fp4"], allowFallback: false });
  assert.ok(two);
  assert.match(upstreamRoutingProblem(two!) ?? "", /должен остаться один/);
});

test("неизвестный режим и кривой JSON не ломают конфигурацию", () => {
  assert.equal(normalizeUpstreamRouting({ mode: "smart" }), null);
  assert.equal(normalizeUpstreamRouting({ mode: "fixed", providers: "morph/fp8" }), null);
  assert.equal(normalizeUpstreamRouting({ mode: "fixed", providers: [""] }), null);
  assert.equal(normalizeUpstreamRouting(null), null);
  assert.equal(parseUpstreamRouting("{not json"), null);
  assert.equal(parseUpstreamRouting(""), null);
  assert.deepEqual(parseUpstreamRouting('{"mode":"cheapest"}')?.mode, "cheapest");
});

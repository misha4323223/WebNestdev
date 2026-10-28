import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { PreviewAddressDeps } from "./preview-address.js";
import { previewAddressAnswers, settlePreviewAddress, unreachablePreviewDiagnosis } from "./preview-address.js";
import type { PreviewState } from "./types.js";

function state(overrides: Partial<PreviewState> = {}): PreviewState {
  return { mode: "container", containerId: "c1", projectId: "p1", host: "172.19.0.4", port: 3000, startedAt: 0, lastUsedAt: 0, ...overrides };
}

/**
 * Приложение в тесте отвечает ровно по тем адресам, которые перечислены: так проверяется и «свой
 * порт», и «только петля контейнера», и «не поднялось вовсе».
 */
function deps(options: { answers: (candidate: { host: string; port: number }) => boolean; ports?: number[]; appUp?: boolean; appUpAt?: (port: number) => boolean; relay?: boolean; attach?: { host: string; connected: string[] } }) {
  const calls = { address: 0, ports: 0, attach: 0, relay: [] as Array<{ containerId: string; targetPort: number; listenPort: number }> };
  const value: PreviewAddressDeps = {
    addressAnswers: async candidate => { calls.address++; return options.answers(candidate); },
    appAnswers: async candidate => { calls.ports++; return options.appUpAt ? options.appUpAt(candidate.port) : (options.appUp ?? true); },
    usedPorts: async () => options.ports ?? [],
    startRelay: async input => { calls.relay.push(input); return options.relay ?? true; },
    attachToServerNetworks: async () => { calls.attach++; return options.attach ?? { host: "", connected: [] }; },
  };
  return { value, calls };
}

/** Ждать в тестах незачем: ожидание проверяется отдельно, здесь важны решения. */
const noWait = { attempts: 1, delayMs: 0 };

test("a reachable preview is confirmed once and never inspected again", async () => {
  const { value, calls } = deps({ answers: () => true });
  const settled = await settlePreviewAddress(state(), { deps: value });
  assert.equal(settled.port, 3000);
  assert.equal(settled.settled, true);
  // Подтверждённый адрес больше не проверяется: статус читается на каждый запрос прокси.
  assert.equal(await settlePreviewAddress(settled, { deps: value }), settled);
  assert.equal(calls.address, 1);
  assert.deepEqual(calls.relay, []);
});

test("the app's real port is adopted when the launch flags were ignored", async () => {
  // dev-скрипт не принял `--port 3000` и слушает 5173 по адресу контейнера.
  const { value, calls } = deps({ answers: candidate => candidate.port === 5173, ports: [5173] });
  const settled = await settlePreviewAddress(state(), { deps: value, appAnswers: true });
  assert.equal(settled.port, 5173);
  assert.equal(settled.settled, true);
  assert.deepEqual(calls.relay, []);
  // Таблицы ядра ответили — значит приложение не опрашивается лишний раз.
  assert.equal(calls.ports, 0);
});

/**
 * `/proc/net/tcp` читается одним `docker exec` с коротким пределом, и на занятом хосте он может
 * не уложиться. Раньше это оставляло предпросмотр на каноническом 3000, где ничего не слушает:
 * контейнер жив, приложение работает, панель белая. Порт спрашивается у приложения напрямую.
 *
 * Ровно так выглядел живой предпросмотр этого репозитория: Vite на 5173, платформа стучится в 3000.
 */
test("when the kernel tables cannot be read, the port is asked from the app itself", async () => {
  const { value } = deps({ answers: candidate => candidate.port === 5173, ports: [], appUpAt: port => port === 5173 });
  const settled = await settlePreviewAddress(state(), { deps: value, appAnswers: false });
  assert.equal(settled.port, 5173, "порт найден опросом, а не оставлен каноническим");
  assert.equal(settled.settled, true);
});

test("an app bound to localhost is relayed onto the platform port", async () => {
  // Приложение слушает только петлю: по адресу контейнера молчит, но внутри отвечает.
  const { value, calls } = deps({ answers: candidate => candidate.port === 3001, ports: [3000], appUp: true });
  const settled = await settlePreviewAddress(state(), { deps: value });
  assert.equal(settled.port, 3001);
  assert.equal(settled.settled, true);
  // Проброс целится в порт, где приложение действительно слушает.
  assert.deepEqual(calls.relay, [{ containerId: "c1", targetPort: 3000, listenPort: 3001 }]);
});

test("the relay takes the free canonical port when the app sits on another loopback port", async () => {
  // Приложение слушает 5173 на петле и молчит на 5173 по адресу контейнера; порт 3000 свободен,
  // поэтому проброс поднимается на нём — платформа остаётся на своём каноническом адресе.
  let relayStarted = false;
  const relay: Array<{ containerId: string; targetPort: number; listenPort: number }> = [];
  const value: PreviewAddressDeps = {
    addressAnswers: async candidate => relayStarted && candidate.port === 3000,
    appAnswers: async () => true,
    usedPorts: async () => [5173],
    startRelay: async input => { relay.push(input); relayStarted = true; return true; },
    attachToServerNetworks: async () => ({ host: "", connected: [] }),
  };
  const settled = await settlePreviewAddress(state(), { deps: value, appAnswers: true, wait: noWait });
  assert.deepEqual(relay, [{ containerId: "c1", targetPort: 5173, listenPort: 3000 }]);
  assert.equal(settled.port, 3000);
  assert.equal(settled.settled, true);
});

/**
 * Контейнер, оставшийся в сети, которой сервер не видит: приложение живо внутри, но адрес молчит.
 * Починка — подключить контейнер к сети сервера и подтвердить новый адрес, а не искать петлю.
 */
test("a preview container in a foreign network is attached to the server's network and confirmed there", async () => {
  const { value, calls } = deps({
    answers: candidate => candidate.host === "172.18.0.5" && candidate.port === 3000,
    ports: [3000],
    appUp: true,
    attach: { host: "172.18.0.5", connected: ["src_webnestdev"] },
  });
  const settled = await settlePreviewAddress(state(), { deps: value, appAnswers: true, wait: noWait });
  assert.equal(settled.host, "172.18.0.5", "адрес берётся на сети сервера");
  assert.equal(settled.settled, true);
  assert.equal(calls.attach, 1);
  assert.deepEqual(calls.relay, [], "проброс для этого не нужен");
});

/**
 * Порт не изменился — но адрес всё равно проверяется: между двумя чтениями статуса мог встать
 * проброс или подключиться нужная сеть. Без этой проверки состояние оставалось без подтверждённого
 * адреса, а панель — с белым экраном при живом приложении.
 */
test("an unchanged port is still re-checked, so a repair made between two status reads is confirmed", async () => {
  let calls = 0;
  const { value } = deps({ answers: () => { calls++; return calls > 1; }, ports: [3000], appUp: true });
  // Первая проверка (до чтения портов) молчит, вторая — отвечает по тому же адресу.
  const settled = await settlePreviewAddress(state(), { deps: value, appAnswers: true, wait: noWait });
  assert.equal(settled.settled, true);
  assert.equal(settled.port, 3000);
});

/**
 * Проброс поднимается через `docker exec -d` и слушает не сразу: одиночная проверка сразу после
 * запуска объявляла починку неудачной, состояние оставалось неподтверждённым, и панель получала
 * «Прокси предпросмотра не сработал: fetch failed». Теперь адрес перепроверяется с паузой.
 */
test("a relay that needs a moment to start listening is still confirmed", async () => {
  let afterRelay = 0;
  const relay: Array<{ containerId: string; targetPort: number; listenPort: number }> = [];
  const value: PreviewAddressDeps = {
    addressAnswers: async candidate => {
      if (candidate.port !== 3001) return false;
      afterRelay++;
      return afterRelay > 2;
    },
    appAnswers: async () => true,
    usedPorts: async () => [3000],
    startRelay: async input => { relay.push(input); return true; },
    attachToServerNetworks: async () => ({ host: "", connected: [] }),
  };
  const settled = await settlePreviewAddress(state(), { deps: value, appAnswers: true, wait: { attempts: 5, delayMs: 10 } });
  assert.deepEqual(relay, [{ containerId: "c1", targetPort: 3000, listenPort: 3001 }]);
  assert.equal(settled.port, 3001);
  assert.equal(settled.settled, true);
});

/**
 * Деградировавший предпросмотр держится на `docker exec` только пока адрес контейнера не отвечает.
 * Подтверждённый заново адрес снимает пометку, и панель возвращается на прямой, потоковый путь.
 */
test("a confirmed address clears the exec-only mark, so the direct path takes over again", async () => {
  const { value } = deps({ answers: () => true });
  // preview-manager снимает «подтверждён» перед проверкой — иначе она бы не выполнялась вообще.
  const settled = await settlePreviewAddress(state({ execOnly: true, execOnlyCheckedAt: 1, settled: false }), { deps: value });
  assert.equal(settled.settled, true);
  assert.equal(settled.execOnly, false);
});

test("nothing is repaired while the app is not up, and a failed repair stays unconfirmed", async () => {
  const down = deps({ answers: () => false, ports: [], appUp: false });
  const untouched = await settlePreviewAddress(state(), { deps: down.value });
  assert.equal(untouched.port, 3000);
  assert.equal(untouched.settled, undefined, "адрес не подтверждён — следующая проверка попробует снова");
  assert.deepEqual(down.calls.relay, []);

  const failing = deps({ answers: () => false, ports: [3000], appUp: true, relay: false });
  const unrepaired = await settlePreviewAddress(state(), { deps: failing.value, wait: noWait });
  assert.equal(unrepaired.port, 3000);
  assert.equal(unrepaired.settled, undefined);
  assert.equal(failing.calls.relay.length, 1);

  // Проброс поднялся, но адрес всё равно молчит (например, сеть контейнеров не пересекается с сервером).
  const silent = deps({ answers: () => false, ports: [3000], appUp: true });
  const stillBroken = await settlePreviewAddress(state(), { deps: silent.value, wait: noWait });
  assert.equal(stillBroken.port, 3000);
  assert.equal(stillBroken.settled, undefined);
});

test("a static preview has no address to settle and the diagnosis names the cause", async () => {
  const { value, calls } = deps({ answers: () => false });
  const staticState = state({ mode: "static" });
  assert.equal(await settlePreviewAddress(staticState, { deps: value }), staticState);
  assert.equal(calls.address, 0);

  const inside = unreachablePreviewDiagnosis({ message: "fetch failed", port: 3000, appAnswersInside: true });
  assert.match(inside.reason, /port 3000: fetch failed/);
  assert.match(inside.hint, /localhost/);
  assert.match(inside.hint, /перезапустите/i);

  const down = unreachablePreviewDiagnosis({ message: "fetch failed", port: 3000, appAnswersInside: false });
  assert.match(down.hint, /не поднялся/);
  assert.match(down.hint, /preview\.logs/);
});

test("the address check really asks the address that the panel and the agent use", async () => {
  const server = createServer((request, response) => { response.writeHead(200); response.end("ok"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    assert.equal(await previewAddressAnswers({ host: "127.0.0.1", port }), true);
    // Свободный порт на том же адресе: приложение по нему не отвечает.
    assert.equal(await previewAddressAnswers({ host: "127.0.0.1", port: port + 1 }, 500), false);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

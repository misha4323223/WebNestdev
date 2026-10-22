/**
 * Проверка того пути, которым пользуются панель, агент и Chromium: сервер → контейнер предпросмотра.
 *
 * Запускается внутри серверного контейнера на ВМ, потому что именно этот шаг нельзя проверить
 * заранее: контейнер предпросмотра стоит в сети Docker, и если сервер эту сеть не видит, приложение
 * остаётся живым внутри контейнера при пустом экране в панели («Прокси предпросмотра не сработал:
 * fetch failed»). Скрипт поднимает одноразовый контейнер на той же сети и том же порту, что и
 * предпросмотр, и отвечает на вопрос фактом:
 *
 *   PREVIEW-NETWORK=ok               — сервер доходит до контейнера по сетевому адресу;
 *   PREVIEW-NETWORK=ok-after-connect — доходил только после подключения к сети сервера (та самая
 *                                      починка, которую платформа делает сама в preview-address.ts);
 *   PREVIEW-NETWORK=unreachable      — не доходит и после подключения: сеть предпросмотра указывают
 *                                      вручную (PREVIEW_NETWORK) или хост блокирует трафик между сетями;
 *   PREVIEW-NETWORK=no-docker|image  — Docker недоступен изнутри контейнера / образа нет на ВМ.
 *
 * На ВМ из каталога развёртывания:
 *   docker compose exec -T webnestdev-server node server/dist/scripts/preview-selfcheck.js
 *
 * Код возврата: 0 — путь работает, 1 — не работает. Последняя строка `PREVIEW-NETWORK=…` —
 * машинный вердикт для deploy-скрипта.
 *
 * Уборка — часть контракта: проба живёт в контейнере, и `process.exit()` внутри проверки
 * пропускает `finally` (Node не разворачивает стек), поэтому раньше контейнер оставался
 * запущенным после каждой выкатки. Здесь проверка только возвращает код, а удаление и выход
 * идут в одном месте — после него.
 */
import { dockerExec } from "../preview/docker-exec.js";
import { sandboxImage } from "../sandbox/config.js";
import { addressOnNetworks, attachToServerNetworks, firstContainerAddress, previewNetwork, serverNetworks } from "../preview/preview-network.js";
import { PREVIEW_APP_PORT, PREVIEW_LABEL } from "../preview/types.js";

const IMAGE = sandboxImage();
/** Ответ, который отдаёт проба: он же подтверждает, что отвечает именно она. */
const PROBE_MARKER = "webnestdev-preview-probe";
/** Тот же порт, что у настоящего предпросмотра (PREVIEW_APP_PORT). */
const PROBE_SCRIPT =
  'const http=require("node:http");' +
  'http.createServer((request,response)=>{response.writeHead(200,{"content-type":"text/plain"});response.end("' + PROBE_MARKER + '")})' +
  ".listen(" + PREVIEW_APP_PORT + ',"0.0.0.0");';
/** Проверка изнутри контейнера: отличает «проба не поднялась» от «сервер её не видит». */
const INSIDE_SCRIPT =
  'fetch("http://127.0.0.1:' + PREVIEW_APP_PORT + '/").then(response=>{process.stdout.write(String(response.status));process.exit(0)}).catch(()=>process.exit(1));';

function verdict(value: string) {
  console.log("PREVIEW-NETWORK=" + value);
}

async function main() {
  const version = await dockerExec(["version", "--format", "{{.Server.Version}}"], 10_000).catch(error => ({
    code: 1,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  }));
  if (version.code !== 0) {
    console.log("[preview] Docker недоступен из контейнера сервера: " + version.stderr.trim());
    verdict("no-docker");
    process.exit(1);
  }
  const networks = await serverNetworks();
  const network = await previewNetwork();
  console.log("[preview] сеть предпросмотра: " + (network || "по умолчанию (сервер не в контейнере)") +
    (networks.length > 1 ? "; все сети сервера: " + networks.join(", ") : ""));

  const started = await dockerExec([
    "run", "-d", "--rm", "--init",
    "--memory", "256m",
    "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,size=16m",
    "--user", "1000:1000",
    ...(network ? ["--network", network] : []),
    "--label", PREVIEW_LABEL + "=selfcheck",
    IMAGE, "node", "-e", PROBE_SCRIPT,
  ], 60_000).catch(error => ({ code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
  if (started.code !== 0) {
    const detail = (started.stderr || "").trim().slice(-400);
    console.log("[preview] контейнер-проба не запустился: " + detail);
    // Отсутствующая сеть тоже отвечает «not found», и вердикт `image` отправлял искать причину
    // в образе, хотя запуск упал на сети (ровно так имя `webnestdev-preview` вместо
    // `src_webnestdev-preview` выглядело как проблема образа). Сеть проверяется первой.
    const missingNetwork = /network .*not found/i.test(detail);
    verdict(missingNetwork ? "unreachable" : /pull access denied|no such image|manifest unknown|not found|unauthorized/i.test(detail) ? "image" : "unreachable");
    process.exit(1);
  }

  const containerId = started.stdout.trim();
  let code = 1;
  try {
    code = await probeContainer(containerId, network);
  } finally {
    // Проба — контейнер на хосте: он должен исчезнуть при любом исходе, включая ошибку выше.
    const removed = await dockerExec(["rm", "-f", containerId], 20_000).catch(() => null);
    if (!removed || removed.code !== 0) console.log("[preview] контейнер-проба " + containerId + " не удалился — удалите его вручную (docker rm -f)");
  }
  process.exit(code);
}

/** Возвращает код выхода проверки; контейнер удаляет вызывающий, в одном месте. */
async function probeContainer(containerId: string, network: string | null): Promise<number> {
  // Проба поднимается внутри контейнера: это тот же вопрос, что задаёт платформа (`ready`).
  let inside = false;
  for (let attempt = 0; attempt < 15 && !inside; attempt++) {
    const response = await dockerExec(["exec", containerId, "node", "-e", INSIDE_SCRIPT], 10_000).catch(() => null);
    inside = Boolean(response && response.code === 0);
    if (!inside) await new Promise(resolve => setTimeout(resolve, 300));
  }
  if (!inside) {
    console.log("[preview] проба не отвечает и внутри контейнера: образ " + IMAGE + " не запускает node, либо " + PREVIEW_APP_PORT + " занят");
    verdict("unreachable");
    return 1;
  }

  const address = network ? await addressOnNetworks(containerId, [network]) : await firstContainerAddress(containerId);
  if (await reachable(address)) {
    console.log("[preview] сервер доходит до контейнера по адресу " + address + ":" + PREVIEW_APP_PORT);
    verdict("ok");
    return 0;
  }
  console.log("[preview] адрес " + (address || "(не назначен)") + ":" + PREVIEW_APP_PORT + " серверу не отвечает — подключаю контейнер к сети сервера");

  // Та же починка, что платформа делает при запуске предпросмотра: контейнер подключается к
  // сети сервера, и адрес берётся уже с неё.
  const attached = await attachToServerNetworks(containerId);
  const repaired = attached.host || address;
  if (await reachable(repaired)) {
    console.log("[preview] после подключения к " + attached.connected.join(", ") + " адрес " + repaired + " отвечает: платформа починит предпросмотр сама");
    verdict("ok-after-connect");
    return 0;
  }
  console.log("[preview] ПРЕДПРОСМОТР НЕДОСТУПЕН СЕРВЕРУ: сеть " + (network || "по умолчанию") +
    " сервер не видит. Панель покажет приложение и так (через docker exec), но медленнее и без\n" +
    "[preview] горячей перезагрузки. Чтобы вернуть прямой адрес, задайте PREVIEW_NETWORK в .env и\n" +
    "[preview] выкатите снова (docs/PRODUCTION_DEPLOYMENT.md)");
  verdict("unreachable");
  return 1;
}

/** Ответила ли проба по этому адресу; ошибка называется в логе, а не превращается в «нет». */
async function reachable(address: string) {
  if (!address) return false;
  try {
    const response = await fetch("http://" + address + ":" + PREVIEW_APP_PORT + "/", { redirect: "manual", signal: AbortSignal.timeout(4_000) });
    const body = await response.text();
    return response.ok && body.includes(PROBE_MARKER);
  } catch (error) {
    console.log("[preview] проверка адреса не удалась: " + (error instanceof Error ? error.message : String(error)));
    return false;
  }
}

await main();

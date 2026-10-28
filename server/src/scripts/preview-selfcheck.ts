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
 *   PREVIEW-NETWORK=start-failed     — контейнер-проба вообще не поднялся (Docker занят, отказ
 *                                      политики, предел времени): это не сеть, причину смотреть выше;
 *   PREVIEW-NETWORK=exec-broken      — `docker exec` внутрь контейнера не проходит: виноват брокер,
 *                                      а не сеть (см. журнал docker-broker, строки «upgrade»);
 *   PREVIEW-NETWORK=no-node          — exec работает, а node в образе из-под exec не запускается;
 *   PREVIEW-NETWORK=app-silent       — exec и node работают, а приложение не отвечает на петле:
 *                                      дев-сервер слушает не тот порт или не поднялся;
 *   PREVIEW-NETWORK=no-docker|image  — Docker недоступен изнутри контейнера / образа нет на ВМ.
 *
 * Перед вердиктом печатается матрица «что именно не работает внутри контейнера»: `exec`,
 * `proc-net`, `node`, `node-fetch`. Каждый шаг опирается на предыдущий, поэтому первый отказ
 * называет виновника без догадок.
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
/**
 * Бюджет проверки изнутри контейнера.
 *
 * Раньше это был цикл из 15 попыток по 10 с: когда `docker exec` через брокер не отвечал, проверка
 * съедала весь `timeout 120` выкатки и не печатала НИ ОДНОГО вердикта — в журнале оставалась
 * строка «проверка предпросмотра не ответила — пропускаю», и причину приходилось искать заново
 * по журналу брокера. Теперь у цикла есть предел, а отказ называется своим вердиктом.
 */
const INSIDE_BUDGET_MS = 20_000;
const INSIDE_ATTEMPT_MS = 4_000;
/**
 * Предел одной пробы матрицы (`exec`, `proc-net`, `node`, `node-fetch`).
 *
 * Матрица отвечает на вопрос, который иначе приходится разгадывать по журналу брокера: что именно
 * не работает внутри контейнера. Каждый шаг доказывает следующий: `exec` — что hijack дошёл и
 * команда вернула код; `proc-net` — что читаются таблицы ядра (по ним платформа ищет порт);
 * `node` — что в образе запускается node (им платформа спрашивает приложение); `node-fetch` — что
 * приложение отвечает на петле. Все четыре идут через тот же `docker exec`, что у платформы.
 */
const PROBE_TIMEOUT_MS = 4_000;

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
    "--cpus", "1",
    "--pids-limit", "64",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges:true",
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
    // Третий случай — контейнер вообще не поднялся (зависший Docker, отказ политики, предел
    // времени). Это не «сеть не видна»: такой вердикт отправлял оператора задавать PREVIEW_NETWORK,
    // когда причина была в запуске, и причину приходилось искать в логе заново.
    verdict(missingNetwork ? "unreachable" : /pull access denied|no such image|manifest unknown|not found|unauthorized/i.test(detail) ? "image" : "start-failed");
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

type ProbeResult = { ok: boolean; code: number; detail: string; ms: number };

/** Один `docker exec` с пределом времени: результат называется кодом, текстом и длительностью. */
async function execProbe(containerId: string, args: string[], timeoutMs: number): Promise<ProbeResult> {
  const started = Date.now();
  const result = await dockerExec(["exec", containerId, ...args], timeoutMs)
    .catch(error => ({ code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }));
  const ms = Date.now() - started;
  const detail = (result.stdout || result.stderr).trim().replace(/\s+/g, " ").slice(0, 160);
  return { ok: result.code === 0, code: result.code, detail, ms };
}

/**
 * Матрица «что именно не работает внутри контейнера».
 *
 * Порядок не случаен: каждый шаг опирается на предыдущий, и первый же отказ называет виновника.
 * `exec` не прошёл — виноват брокер (hijack); `exec` прошёл, `node` нет — образ не запускает
 * node из-под exec; `node` прошёл, `node-fetch` нет — приложение внутри контейнера не отвечает на
 * петле, и тогда платформа не может ни подтвердить готовность, ни узнать порт.
 */
const PROBE_MATRIX: { name: string; args: string[] }[] = [
  { name: "exec", args: ["sh", "-c", "echo ok"] },
  { name: "proc-net", args: ["sh", "-c", "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | wc -l"] },
  { name: "node", args: ["node", "-e", "process.stdout.write('ok')"] },
  { name: "node-fetch", args: ["node", "-e", INSIDE_SCRIPT] },
];

/** Возвращает код выхода проверки; контейнер удаляет вызывающий, в одном месте. */
async function probeContainer(containerId: string, network: string | null): Promise<number> {
  const probes = new Map<string, ProbeResult>();
  for (const probe of PROBE_MATRIX) {
    const result = await execProbe(containerId, probe.args, PROBE_TIMEOUT_MS);
    probes.set(probe.name, result);
    console.log("[preview] проба «" + probe.name + "»: " + (result.ok ? "ok" : "нет") +
      " (код " + result.code + ", " + result.ms + " мс)" + (result.detail ? " — " + result.detail : ""));
    // Дальше проверять нечего: без hijack не работают все остальные шаги.
    if (!result.ok && probe.name === "exec") break;
  }

  if (!probes.get("exec")?.ok) {
    // Контейнер-проба жив, а `docker exec` до него не доходит. Сеть предпросмотра здесь ни при
    // чём — платформа проверяет приложение тем же `docker exec`, поэтому белый кадр будет и при
    // идеальной сети.
    console.log("[preview] docker exec внутрь контейнера не проходит: контейнер жив, а проверки и дверь панели через docker exec не работают — смотрите журнал брокера (docker compose logs docker-broker) и строки «upgrade/hijack» в нём");
    verdict("exec-broken");
    return 1;
  }

  // Готовность приложения: тот же вопрос, что задаёт платформа (`ready`). Первый ответ пробы
  // может опоздать — сервер поднимается за миллисекунды, но контейнер бывает загружен.
  let inside = Boolean(probes.get("node-fetch")?.ok);
  let lastFailure = "";
  const deadline = Date.now() + INSIDE_BUDGET_MS;
  for (let attempt = 0; attempt < 5 && !inside && Date.now() < deadline; attempt++) {
    const result = await execProbe(containerId, ["node", "-e", INSIDE_SCRIPT], INSIDE_ATTEMPT_MS);
    inside = result.ok;
    if (!inside) {
      lastFailure = "код " + result.code + (result.detail ? ": " + result.detail : " без вывода") + ", " + result.ms + " мс";
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  if (!inside) {
    if (!probes.get("node")?.ok) {
      console.log("[preview] node не запускается внутри контейнера из-под exec (" + (lastFailure || "нет ответа") +
        "): образ " + IMAGE + " не даёт платформе спросить приложение");
      verdict("no-node");
      return 1;
    }
    console.log("[preview] приложение не отвечает внутри контейнера на петле " + PREVIEW_APP_PORT + " (" +
      (lastFailure || "нет ответа") + "): exec и node работают, значит виноват не брокер и не сеть — " +
      "дев-сервер слушает не тот порт или не поднялся");
    verdict("app-silent");
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

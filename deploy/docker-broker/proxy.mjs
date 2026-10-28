/**
 * HTTP-прокси между сервером и настоящим Docker Engine API.
 *
 * Зачем прокси, а не свой набор команд: сервер вызывает `docker` CLI, и тот уже говорит по Engine
 * API. Прокси позволяет не менять ни один вызов в сервере — меняется только DOCKER_HOST — и при
 * этом проверять каждый запрос до демона.
 *
 * Две тонкости, без которых ломался бы обычный путь платформы:
 *
 * 1. `docker exec` и `docker run` без `-d` открывают upgraded-соединение (hijack). Такие запросы
 *    Node отдаёт в событие `upgrade`, а не в обработчик запроса; здесь они проверяются и затем
 *    пересылаются байт-в-байт, иначе панель видела бы запущенный предпросмотр, к которому не
 *    подключиться.
 * 2. `containers/create` — единственное место, где сервер описывает, что именно запустить.
 *    Проверка тела живёт в policy.mjs, здесь только вызов и простановка метки `webnestdev.managed`.
 *
 * Ошибки отвечаются в формате Docker (`{"message":"…"}`), чтобы `docker` CLI показал их так же, как
 * ответ демона, а сервер продолжил различать «нет образа» и «Docker недоступен».
 */
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { classify, isAllowedName, isManagedContainer, validateCreate, MANAGED_LABEL } from "./policy.mjs";

const MAX_BODY = 2 * 1024 * 1024;
const MANAGED_TTL_MS = 60_000;
const EXEC_TTL_MS = 60 * 60_000;
const MAX_EXECS = 512;

export function dockerUnavailableMessage(upstreamPath) {
  return "Cannot connect to the Docker daemon at unix://" + upstreamPath + ". Is the docker daemon running?";
}

export function createBrokerServer({ socketPath, upstreamPath, policy, log = console }) {
  /** id/имя контейнера → когда истекает уверенность, что он наш. */
  const managed = new Map();
  /** id exec-сессии → время создания. Разрешает `POST /exec/{id}/start` только для своих сессий. */
  const execs = new Map();

  // Ошибка внутри обработчика не должна оставлять клиента ждать до таймаута: Docker CLI получает
  // понятный ответ, а стек уходит в лог брокера — иначе такая поломка выглядит как «Docker завис».
  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch(error => {
      log.error("[broker] внутренняя ошибка: " + (error?.stack ?? error));
      sendError(response, 500, "Внутренняя ошибка Docker-брокера");
    });
  });
  server.on("upgrade", (request, socket, head) => {
    handleUpgrade(request, socket, head).catch(error => {
      log.error("[broker] внутренняя ошибка upgrade: " + (error?.stack ?? error));
      writeRawError(socket, 500, "Внутренняя ошибка Docker-брокера");
      socket.destroy();
    });
  });
  // Сокеты нужны при остановке: `server.close()` ждёт соединений, а upgraded-сессии (exec и attach)
  // в него не входят — без явного закрытия контейнер брокера висел бы до SIGKILL.
  const sockets = new Set();
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.destroySockets = () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };
  return server;

  async function handleRequest(request, response) {
    // Диагностика зависаний: видно, до какого запроса Docker CLI дошёл и что брокер получил.
    // Включается BROKER_LOG_REQUESTS=1, по умолчанию выключена — журнал не растёт.
    if (process.env.BROKER_LOG_REQUESTS === "1") {
      log.log("[broker] " + request.method + " " + request.url);
    }
    let body;
    try {
      body = await readBody(request);
    } catch (error) {
      return sendError(response, 413, "Тело запроса больше " + MAX_BODY + " байт");
    }

    const decision = classify(request.method, request.url);
    if (decision.kind === "deny") {
      log.warn("[broker] отказ: " + request.method + " " + request.url + " — " + decision.message);
      return sendError(response, decision.status, decision.message);
    }
    if (decision.kind === "self") return handleSelf(response);
    if (decision.kind === "container-create") return handleCreate(request, response, body, decision);

    if (decision.kind === "container" || decision.kind === "network" || decision.kind === "exec-start") {
      const allowed = await allowScoped(decision, body);
      if (!allowed.ok) {
        log.warn("[broker] отказ: " + request.method + " " + request.url + " — " + allowed.message);
        return sendError(response, allowed.status, allowed.message);
      }
    }

    // Создание exec возвращает id сессии, и только её `start` будет разрешён. Ответ небольшой,
    // поэтому читается целиком, регистрируется и отдаётся клиенту без изменений.
    if (decision.kind === "container" && decision.action === "exec") {
      return proxyCapture(request, response, body, json => {
        if (json && typeof json.Id === "string") rememberExec(json.Id);
      });
    }

    return proxy(request, response, body);
  }

  /** Проверка «свой ли объект» для операций над контейнерами и сетями. */
  async function allowScoped(decision, body) {
    if (decision.kind === "exec-start") {
      const createdAt = execs.get(decision.id);
      if (!createdAt || Date.now() - createdAt > EXEC_TTL_MS) {
        return { ok: false, status: 403, message: "Сессия exec не создана через брокер" };
      }
      return { ok: true };
    }
    if (decision.kind === "network") {
      if (!policy.isPreviewNetwork(decision.id)) {
        return { ok: false, status: 403, message: "Подключать контейнеры можно только к сети предпросмотра" };
      }
      if (decision.action === "connect") {
        let parsed;
        try {
          parsed = JSON.parse(body.toString("utf8") || "{}");
        } catch {
          return { ok: false, status: 400, message: "Тело network connect — не JSON" };
        }
        const container = typeof parsed?.Container === "string" ? parsed.Container : "";
        if (!container) return { ok: false, status: 400, message: "network connect без имени контейнера" };
        const state = await managedState(container);
        if (state !== "managed" && state !== "missing") {
          return { ok: false, status: state === "unmanaged" ? 403 : 502, message: "Подключать можно только контейнеры платформы" };
        }
      }
      return { ok: true };
    }
    const state = await managedState(decision.id);
    // «missing» пропускается: демон сам ответит 404 так же, как отвечал до брокера. Ошибку
    // проверки нельзя считать разрешением — иначе сбой демона открывал бы чужие контейнеры.
    if (state === "unmanaged") {
      return { ok: false, status: 403, message: "Контейнер не управляется платформой: операция запрещена" };
    }
    if (state === "error") {
      return { ok: false, status: 502, message: "Не удалось проверить владельца контейнера" };
    }
    return { ok: true };
  }

  async function handleCreate(request, response, body, decision) {
    if (!isAllowedName(decision.name)) {
      log.warn("[broker] отказ: имя контейнера " + decision.name);
      return sendError(response, 403, "Имя контейнера должно начинаться с wnd-");
    }
    let parsed;
    try {
      parsed = JSON.parse(body.toString("utf8") || "{}");
    } catch {
      return sendError(response, 400, "Тело create — не JSON");
    }
    const verdict = validateCreate(parsed, policy);
    if (!verdict.ok) {
      log.warn("[broker] отказ create: " + verdict.message);
      return sendError(response, 403, verdict.message);
    }
    parsed.Labels = { ...(parsed.Labels ?? {}), [MANAGED_LABEL]: "1" };
    const forwarded = Buffer.from(JSON.stringify(parsed));
    return proxy(request, response, forwarded);
  }

  async function managedState(id) {
    const cached = managed.get(id);
    if (cached && cached > Date.now()) return "managed";
    const result = await upstreamJson("/containers/" + encodeURIComponent(id) + "/json");
    if (result.status === 404) return "missing";
    if (result.status < 200 || result.status >= 300) return "error";
    if (!isManagedContainer(result.json)) return "unmanaged";
    managed.set(id, Date.now() + MANAGED_TTL_MS);
    return "managed";
  }

  function rememberExec(id) {
    execs.set(id, Date.now());
    if (execs.size <= MAX_EXECS) return;
    const oldest = [...execs.entries()].sort((left, right) => left[1] - right[1]).slice(0, execs.size - MAX_EXECS);
    for (const [key] of oldest) execs.delete(key);
  }

  /** `GET /_webnestdev/self`: сети, в которых стоит брокер (он в тех же сетях, что сервер). */
  async function handleSelf(response) {
    const result = await upstreamJson("/containers/" + encodeURIComponent(os.hostname()) + "/json");
    if (result.status !== 200 || !result.json) {
      return sendError(response, 500, "Брокер не смог определить свои сети: " + (result.error ?? "ответ " + result.status));
    }
    const networks = Object.keys(result.json.NetworkSettings?.Networks ?? {});
    const payload = JSON.stringify({ networks });
    response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    response.end(payload);
  }

  /**
   * Заголовки для демона: тело create пересобирается (метка брокера), поэтому старый
   * Content-Length неверен — с ним демон прочитал бы обрезанный JSON. Chunked тоже убирается:
   * тело уже в памяти, и длину проще назвать честно.
   */
  function upstreamHeaders(request, body) {
    const headers = { ...request.headers, host: "docker" };
    delete headers["transfer-encoding"];
    if (body?.length) headers["content-length"] = String(body.length);
    else delete headers["content-length"];
    return headers;
  }

  /** Пересылка обычного запроса с потоковым ответом. */
  function proxy(request, response, body) {
    const upstream = http.request({
      socketPath: upstreamPath,
      method: request.method,
      path: request.url,
      headers: upstreamHeaders(request, body),
    });
    upstream.on("response", answer => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    });
    upstream.on("error", error => {
      log.error("[broker] Docker недоступен: " + error.message);
      sendError(response, 502, dockerUnavailableMessage(upstreamPath));
    });
    if (body?.length) upstream.write(body);
    upstream.end();
  }

  /** Пересылка с разбором JSON-ответа (создание exec). */
  function proxyCapture(request, response, body, onJson) {
    const upstream = http.request({
      socketPath: upstreamPath,
      method: request.method,
      path: request.url,
      headers: upstreamHeaders(request, body),
    });
    const chunks = [];
    upstream.on("response", answer => {
      answer.on("data", chunk => chunks.push(chunk));
      answer.on("end", () => {
        const payload = Buffer.concat(chunks);
        if (answer.statusCode && answer.statusCode >= 200 && answer.statusCode < 300) {
          try {
            onJson(JSON.parse(payload.toString("utf8")));
          } catch {
            // Не JSON — не наша сессия; клиенту всё равно уйдёт исходный ответ.
          }
        }
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        response.end(payload);
      });
    });
    upstream.on("error", () => sendError(response, 502, dockerUnavailableMessage(upstreamPath)));
    if (body?.length) upstream.write(body);
    upstream.end();
  }

  /** Один запрос к демону с разбором JSON: нужен для проверки владения и своих сетей. */
  function upstreamJson(path) {
    return new Promise(resolve => {
      const upstream = http.request({ socketPath: upstreamPath, method: "GET", path, headers: { host: "docker" } });
      const chunks = [];
      upstream.on("response", answer => {
        answer.on("data", chunk => chunks.push(chunk));
        answer.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: answer.statusCode ?? 502, json });
        });
      });
      upstream.on("error", error => resolve({ status: 502, json: null, error: error.message }));
      upstream.end();
    });
  }

  /**
   * Hijack: `attach` и `exec/start`. Проверка — до соединения с демоном, дальше поток байт идёт
   * без разбора: внутри уже нет HTTP, только вывод процесса.
   */
  async function handleUpgrade(request, clientSocket, head) {
    const decision = classify(request.method, request.url);
    let message = "";
    if (decision.kind === "container" && decision.action === "attach") {
      const state = await managedState(decision.id);
      if (state === "unmanaged") message = "Контейнер не управляется платформой: attach запрещён";
    } else if (decision.kind === "exec-start") {
      const createdAt = execs.get(decision.id);
      if (!createdAt || Date.now() - createdAt > EXEC_TTL_MS) message = "Сессия exec не создана через брокер";
    } else {
      message = "Upgraded-соединение для этого запроса запрещено";
    }
    if (message) {
      log.warn("[broker] отказ upgrade: " + request.url + " — " + message);
      writeRawError(clientSocket, 403, message);
      return;
    }

    const upstream = net.connect(upstreamPath);
    upstream.once("connect", () => {
      const lines = [request.method + " " + request.url + " HTTP/1.1"];
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        lines.push(request.rawHeaders[index] + ": " + request.rawHeaders[index + 1]);
      }
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head?.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.once("error", error => {
      log.error("[broker] Docker недоступен (upgrade): " + error.message);
      writeRawError(clientSocket, 502, dockerUnavailableMessage(upstreamPath));
      upstream.destroy();
    });
    clientSocket.once("error", () => upstream.destroy());
    clientSocket.once("close", () => upstream.destroy());
    // `end`, а не `destroy`: у вывода контейнера последний кусок может ещё лежать в буфере
    // клиентского сокета, и destroy() выбросил бы его вместе с хвостом лога.
    upstream.once("close", () => {
      if (!clientSocket.destroyed) clientSocket.end();
    });
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sendError(response, status, message) {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const payload = JSON.stringify({ message });
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}

function writeRawError(socket, status, message) {
  const text = status === 403 ? "Forbidden" : status === 502 ? "Bad Gateway" : "Error";
  const payload = JSON.stringify({ message });
  socket.write(
    "HTTP/1.1 " + status + " " + text + "\r\n" +
    "Content-Type: application/json\r\n" +
    "Content-Length: " + Buffer.byteLength(payload) + "\r\n" +
    "Connection: close\r\n\r\n" + payload,
  );
  socket.end();
}

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBrokerServer } from "./proxy.mjs";

/**
 * Прокси проверяется на подставном демоне: в среде сборки Docker нет, а поведение нужно ровно
 * такое, как у Engine API — включая hijack у attach/exec. Подставной демон отвечает на минимум
 * маршрутов, которые использует платформа, и записывает тела create.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wnd-broker-"));
const upstreamSocket = path.join(dir, "upstream.sock");
const brokerSocket = path.join(dir, "broker.sock");

const policy = {
  image: "node:22-bookworm",
  sandboxRoot: "/var/lib/webnestdev/sandboxes",
  isPreviewNetwork: name => name === "src_webnestdev-preview",
};

const log = { warn() {}, error() {}, log() {} };
const creates = [];

let upstream;
let broker;

function json(response, value, status = 200) {
  const payload = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}

function listen(server, socketPath) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

before(async () => {
  upstream = http.createServer((request, response) => {
    const url = new URL(request.url, "http://docker");
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (url.pathname === "/version") return json(response, { Version: "27.0.0" });
      if (url.pathname === "/containers/create") {
        creates.push(JSON.parse(body));
        return json(response, { Id: "abc", Warnings: [] }, 201);
      }
      if (url.pathname === "/containers/abc/json") {
        return json(response, { Name: "/wnd-cmd-1-abcd", Config: { Labels: { "webnestdev.managed": "1" } } });
      }
      if (url.pathname === "/containers/foreign/json") {
        return json(response, { Name: "/postgres", Config: { Labels: {} } });
      }
      if (url.pathname === "/containers/abc/logs") {
        response.writeHead(200, { "content-type": "text/plain" });
        return response.end("hello from container");
      }
      if (url.pathname === "/containers/abc/exec") return json(response, { Id: "exec1" }, 201);
      if (url.pathname === "/system/df") return json(response, { LayersSize: 1 });
      if (url.pathname === "/containers/" + encodeURIComponent(os.hostname()) + "/json") {
        return json(response, {
          NetworkSettings: { Networks: { src_webnestdev: {}, "src_webnestdev-preview": {} } },
        });
      }
      return json(response, { message: "No such container" }, 404);
    });
  });
  upstream.on("upgrade", (request, socket) => {
    socket.write(
      "HTTP/1.1 101 UPGRADED\r\n" +
      "Content-Type: application/vnd.docker.raw-stream\r\n" +
      "Connection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
    );
    socket.on("data", chunk => socket.write(chunk));
  });
  await listen(upstream, upstreamSocket);

  broker = createBrokerServer({ socketPath: brokerSocket, upstreamPath: upstreamSocket, policy, log });
  await listen(broker, brokerSocket);
});

after(async () => {
  // keep-alive и upgraded-соединения не дают `close` завершиться: закрываем их явно.
  broker.destroySockets?.();
  broker.closeAllConnections?.();
  upstream.closeAllConnections?.();
  const closed = server => new Promise(resolve => {
    const timer = setTimeout(resolve, 1000);
    timer.unref?.();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  await closed(broker);
  await closed(upstream);
  fs.rmSync(dir, { recursive: true, force: true });
});

function call(method, requestPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { socketPath: brokerSocket, method, path: requestPath, agent: false, headers: { host: "docker", "content-type": "application/json", ...extraHeaders } },
      response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    request.on("error", reject);
    if (body !== undefined) request.write(typeof body === "string" ? body : JSON.stringify(body));
    request.end();
  });
}

function upgrade(requestPath) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(brokerSocket);
    let received = "";
    let asked = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("hijack не ответил вовремя: " + received.slice(0, 200)));
    }, 3000);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        "POST " + requestPath + " HTTP/1.1\r\nHost: docker\r\n" +
        "Connection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
      );
    });
    socket.on("data", chunk => {
      received += chunk;
      if (!asked && received.includes("\r\n\r\n")) {
        asked = true;
        socket.write("ping");
      }
      if (asked && received.includes("ping")) {
        clearTimeout(timer);
        resolve({ received, socket });
      }
    });
    socket.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function baseCreate() {
  return {
    Hostname: "",
    Domainname: "",
    User: "1000:1000",
    AttachStdin: false,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    OpenStdin: false,
    StdinOnce: false,
    Env: ["HOME=/tmp"],
    Cmd: ["/bin/sh", "-lc", "npm test"],
    Image: "node:22-bookworm",
    Volumes: null,
    WorkingDir: "/workspace",
    Entrypoint: null,
    OnBuild: null,
    Labels: { "webnestdev.job": "1" },
    HostConfig: {
      Binds: ["/var/lib/webnestdev/sandboxes/proj-1:/workspace"],
      NetworkMode: "none",
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "rw,nosuid,size=256m" },
      Memory: 1073741824,
      NanoCpus: 1000000000,
      PidsLimit: 128,
      AutoRemove: true,
      Init: true,
      RestartPolicy: { Name: "", MaximumRetryCount: 0 },
      LogConfig: { Type: "", Config: {} },
    },
    NetworkingConfig: {},
  };
}

test("create вне политики не доходит до демона", async () => {
  const body = baseCreate();
  body.HostConfig.Binds = ["/:/host"];
  const answer = await call("POST", "/containers/create?name=wnd-cmd-1-abcd", body);
  assert.equal(answer.status, 403);
  assert.match(JSON.parse(answer.body).message, /монтировать/i);
  assert.equal(creates.length, 0);
});

test("create по политике проходит и получает метку брокера", async () => {
  const answer = await call("POST", "/containers/create?name=wnd-cmd-1-abcd", baseCreate());
  assert.equal(answer.status, 201);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].Labels["webnestdev.managed"], "1");
  assert.equal(creates[0].Labels["webnestdev.job"], "1");
});

test("content-length пересчитывается: тело create дополняется меткой", async () => {
  const payload = JSON.stringify(baseCreate());
  const answer = await call(
    "POST",
    "/containers/create?name=wnd-cmd-2-efgh",
    payload,
    // Именно так делает docker CLI: длина тела объявлена заранее. Если брокер оставит старую,
    // демон прочитает обрезанный JSON вместо тела с меткой.
    { "content-length": String(Buffer.byteLength(payload)) },
  );
  assert.equal(answer.status, 201);
  const sent = creates.at(-1);
  assert.equal(sent.Labels["webnestdev.managed"], "1");
  assert.ok(sent.HostConfig.Binds.length > 0);
});

test("операции над чужим контейнером запрещены", async () => {
  const answer = await call("GET", "/containers/foreign/json");
  assert.equal(answer.status, 403);

  const logs = await call("GET", "/containers/foreign/logs?tail=10");
  assert.equal(logs.status, 403);

  const remove = await call("DELETE", "/containers/foreign?force=1");
  assert.equal(remove.status, 403);
});

test("исчезнувший контейнер отдаёт ответ демона, а не отказ политики", async () => {
  const answer = await call("GET", "/containers/ghost/json");
  assert.equal(answer.status, 404);
  assert.match(JSON.parse(answer.body).message, /No such container/);
});

test("свой контейнер: inspect, logs, системная информация", async () => {
  const inspect = await call("GET", "/containers/abc/json");
  assert.equal(inspect.status, 200);
  const logs = await call("GET", "/containers/abc/logs?tail=10");
  assert.equal(logs.status, 200);
  assert.equal(logs.body, "hello from container");

  const df = await call("GET", "/system/df");
  assert.equal(df.status, 200);
});

test("запрещённые эндпоинты не пересылаются", async () => {
  for (const [method, requestPath] of [
    ["POST", "/images/create?fromImage=alpine"],
    ["POST", "/build"],
    ["POST", "/volumes/create"],
    ["POST", "/containers/abc/stop"],
  ]) {
    const answer = await call(method, requestPath, {});
    assert.equal(answer.status, 403, method + " " + requestPath);
  }
});

test("exec: своя сессия работает через hijack, чужая запрещена", async () => {
  const created = await call("POST", "/containers/abc/exec", { Cmd: ["node", "-e", "1"], AttachStdout: true });
  assert.equal(created.status, 201);
  assert.equal(JSON.parse(created.body).Id, "exec1");

  const own = await upgrade("/exec/exec1/start");
  assert.match(own.received, /101 UPGRADED/);
  own.socket.destroy();

  const foreign = await call("POST", "/exec/foreign/start", {});
  assert.equal(foreign.status, 403);
});

test("attach к своему контейнеру проксируется как поток", async () => {
  const attached = await upgrade("/containers/abc/attach?stream=1&stdout=1&stderr=1");
  assert.match(attached.received, /101 UPGRADED/);
  attached.socket.destroy();
});

test("network connect: только сеть предпросмотра и только свой контейнер", async () => {
  const preview = await call("POST", "/networks/src_webnestdev-preview/connect", { Container: "abc", EndpointConfig: {} });
  assert.notEqual(preview.status, 403);

  const database = await call("POST", "/networks/src_webnestdev/connect", { Container: "abc", EndpointConfig: {} });
  assert.equal(database.status, 403);

  const foreign = await call("POST", "/networks/src_webnestdev-preview/connect", { Container: "foreign", EndpointConfig: {} });
  assert.equal(foreign.status, 403);
});

test("self отдаёт сети брокера, не открывая inspect чужих контейнеров", async () => {
  const answer = await call("GET", "/_webnestdev/self");
  assert.equal(answer.status, 200);
  const payload = JSON.parse(answer.body);
  assert.deepEqual(payload.networks.sort(), ["src_webnestdev", "src_webnestdev-preview"]);
});

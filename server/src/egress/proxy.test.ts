import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import type { EgressDecision } from "./allowlist.js";
import { createEgressStats, parseConnectTarget, startEgressProxy, type EgressProxy, type EgressProxyOptions } from "./proxy.js";

/**
 * Прокси — единственное место, через которое код проекта видит интернет, поэтому проверяется на
 * живых сокетах, а не только на решениях фильтра: туннель CONNECT (весь HTTPS идёт им), обычный
 * HTTP, отказ с понятным заголовком, журнал отказов с проектом и счётчики.
 */

type Started = { proxy: EgressProxy; port: number; close: () => Promise<void> };

async function startProxy(options: Partial<EgressProxyOptions> & { check: (host: string, port: number, address: string) => EgressDecision }): Promise<Started> {
  const proxy = startEgressProxy({
    resolve: async () => "127.0.0.1",
    ...options,
  });
  await new Promise<void>((ready, fail) => {
    proxy.server.once("error", fail);
    proxy.server.listen(0, "127.0.0.1", () => ready());
  });
  const address = proxy.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { proxy, port, close: () => proxy.close() };
}

function plainRequest(proxyPort: number, target: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port: proxyPort, path: target, method: "GET" }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        body += String(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body, headers: response.headers }));
    });
    request.on("error", reject);
    request.end();
  });
}

/** CONNECT и первая строка ответа прокси. */
function connectTunnel(proxyPort: number, target: string): Promise<{ socket: net.Socket; head: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1");
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      socket.off("error", reject);
      resolve({ socket, head: buffer });
    };
    socket.on("data", onData);
    socket.on("error", reject);
    socket.on("connect", () => socket.write("CONNECT " + target + " HTTP/1.1\r\nHost: " + target + "\r\n\r\n"));
  });
}

test("обычный HTTP идёт через прокси, байты считаются", async () => {
  const upstream = http.createServer((_request, response) => response.end("hello"));
  await new Promise<void>(ready => upstream.listen(0, "127.0.0.1", () => ready()));
  const upstreamPort = (upstream.address() as net.AddressInfo).port;
  const started = await startProxy({
    check: (host, port, address) => (host === "allowed.test" && address === "127.0.0.1" ? { allowed: true } : { allowed: false, reason: "not-allowlisted" }),
    resolve: async () => "127.0.0.1",
    // Порт апстрима случаен, поэтому подменяем порт проверки: фильтр проверяем отдельно.
    onAllowed: () => undefined,
  });
  try {
    const response = await plainRequest(started.port, "http://allowed.test:" + String(upstreamPort) + "/path?x=1");
    assert.equal(response.status, 200);
    assert.equal(response.body, "hello");
    assert.equal(started.proxy.stats.requests, 1);
    assert.equal(started.proxy.stats.allowed, 1);
    assert.equal(started.proxy.stats.denied, 0);
    assert.ok(started.proxy.stats.bytesDown > 0);
  } finally {
    await started.close();
    await new Promise<void>(ready => upstream.close(() => ready()));
  }
});

test("посторонний домен получает 403 с причиной и попадает в журнал", async () => {
  const denies: string[] = [];
  const started = await startProxy({
    check: () => ({ allowed: false, reason: "not-allowlisted" }),
    identify: async address => (address === "127.0.0.1" ? "p-42" : null),
    onDeny: entry => {
      denies.push(entry.host + ":" + String(entry.port) + " " + entry.reason + " " + String(entry.projectId));
    },
  });
  try {
    const response = await plainRequest(started.port, "http://example.com/");
    assert.equal(response.status, 403);
    assert.equal(response.headers["x-egress-deny"], "not-allowlisted");
    assert.match(response.body, /не входит в список разрешённых/);
    assert.equal(started.proxy.stats.denied, 1);
    assert.equal(started.proxy.stats.deniedByHost["example.com"], 1);
    assert.equal(denies.length, 1);
    assert.match(denies[0] ?? "", /p-42/);
    assert.equal(started.proxy.stats.denies[0]?.projectId, "p-42");
  } finally {
    await started.close();
  }
});

test("CONNECT: разрешённый домен получает туннель и данные идут в обе стороны", async () => {
  const echo = net.createServer(socket => socket.pipe(socket));
  await new Promise<void>(ready => echo.listen(0, "127.0.0.1", () => ready()));
  const echoPort = (echo.address() as net.AddressInfo).port;
  const started = await startProxy({ check: () => ({ allowed: true }) });
  try {
    const { socket, head } = await connectTunnel(started.port, "echo.test:" + String(echoPort));
    assert.match(head.split("\r\n")[0] ?? "", /200/);
    const echoed = await new Promise<string>((resolve, reject) => {
      socket.on("error", reject);
      socket.once("data", chunk => resolve(chunk.toString("utf8")));
      socket.write("ping");
    });
    assert.equal(echoed, "ping");
    socket.destroy();
    assert.ok(started.proxy.stats.bytesUp >= 4);
  } finally {
    await started.close();
    await new Promise<void>(ready => echo.close(() => ready()));
  }
});

test("CONNECT: запрет отдаёт 403 в самом туннеле и не открывает сокет", async () => {
  const started = await startProxy({ check: () => ({ allowed: false, reason: "private" }) });
  try {
    const { socket, head } = await connectTunnel(started.port, "10.0.0.5:443");
    assert.match(head.split("\r\n")[0] ?? "", /403/);
    assert.equal(started.proxy.stats.denied, 1);
    assert.equal(started.proxy.stats.deniedByReason.private, 1);
    socket.destroy();
  } finally {
    await started.close();
  }
});

test("неразрешимое имя — 502 и отдельная причина в журнале, а не «домен запрещён»", async () => {
  const started = await startProxy({
    check: () => ({ allowed: true }),
    resolve: async () => {
      throw new Error("ENOTFOUND");
    },
  });
  try {
    const response = await plainRequest(started.port, "http://nowhere.test/");
    assert.equal(response.status, 502);
    assert.equal(started.proxy.stats.deniedByReason.unresolved, 1);
  } finally {
    await started.close();
  }
});

test("статистика начинается с нуля и хранит последние отказы", async () => {
  const stats = createEgressStats(1_000);
  assert.deepEqual(
    { requests: stats.requests, denied: stats.denied, denies: stats.denies.length, startedAt: stats.startedAt },
    { requests: 0, denied: 0, denies: 0, startedAt: 1_000 },
  );
  const started = await startProxy({ check: () => ({ allowed: false, reason: "bad-port" }), maxDenies: 2 });
  try {
    await plainRequest(started.port, "http://a.test/");
    await plainRequest(started.port, "http://b.test/");
    await plainRequest(started.port, "http://c.test/");
    assert.equal(started.proxy.stats.denied, 3);
    assert.equal(started.proxy.stats.denies.length, 2, "в health не копится бесконечный журнал");
    assert.equal(started.proxy.stats.denies[0]?.host, "c.test");
  } finally {
    await started.close();
  }
});

test("строка CONNECT разбирается и с IPv6, и без порта — отказ", () => {
  assert.deepEqual(parseConnectTarget("example.com:443"), { host: "example.com", port: 443 });
  assert.deepEqual(parseConnectTarget("[2606:4700::1111]:443"), { host: "2606:4700::1111", port: 443 });
  assert.equal(parseConnectTarget("example.com"), null);
  assert.equal(parseConnectTarget("example.com:0"), null);
  assert.equal(parseConnectTarget(""), null);
});

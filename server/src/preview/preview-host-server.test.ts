import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { createPreviewHostServer, describePreviewHostServer, previewAccess, requestCookies, forwardableHeaders, startPreviewHostServer, stopPreviewHostServer, type PreviewHostDeps } from "./preview-host-server.js";
import { previewHostTarget } from "./preview-host.js";
import { PICK_BRIDGE_PATH, PICK_BRIDGE_TAG, PICK_COMMAND } from "./pick-bridge.js";
import { mintPreviewTicket, previewTicketProject, PREVIEW_TICKET_COOKIE } from "./preview-ticket.js";
import type { PreviewStatus } from "./types.js";

/**
 * Публичный адрес предпросмотра — это то, что видит браузер пользователя, поэтому проверяется он
 * целиком: настоящий HTTP-запрос к слушателю, настоящее приложение (пусть и в этом же процессе) за
 * ним и настоящие заголовки в обе стороны. Docker и настоящий проект для этого не нужны: вторая
 * дверь (`docker exec`) подставлена и в этих тестах не отвечает.
 */

process.env.WEBNESTDEV_ENCRYPTION_KEY = "0".repeat(64);
const DOMAIN = "preview.nestdev.ru";
const PROJECT = "3f9c1b2a-1c2b-4d5e-8f90-abcdef012345";
process.env.PREVIEW_PUBLIC_DOMAIN = DOMAIN;

type Upstream = { server: Server; port: number; hits: string[]; cookies: string[]; close: () => Promise<void> };

/** Приложение проекта: отвечает страницей с корневыми ссылками и запоминает, что ему прислали. */
async function upstream(options: { status?: number; body?: string; cookie?: string } = {}): Promise<Upstream> {
  const hits: string[] = [];
  const cookies: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? "/");
    cookies.push(String(request.headers.cookie ?? ""));
    const body = Buffer.from(options.body ?? '<!doctype html><html><head><script src="/@vite/client"></script></head><body>приложение</body></html>');
    response.writeHead(options.status ?? 200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=600",
      etag: 'W/"stale"',
      ...(options.cookie ? { "set-cookie": options.cookie } : {}),
    });
    response.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    server,
    port: typeof address === "object" && address ? address.port : 0,
    hits,
    cookies,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

function depsFor(port: number, overrides: Partial<PreviewHostDeps> = {}): PreviewHostDeps {
  const status: PreviewStatus = { running: true, ready: true, host: "127.0.0.1", port, containerId: "container-1", startedAt: 0 };
  return {
    target: previewHostTarget,
    getProject: async projectId => (projectId === PROJECT ? { id: PROJECT, userId: "u1" } : null),
    previewStatus: async () => status,
    execPreview: async () => null,
    unsettle: () => undefined,
    setExecOnly: () => undefined,
    ticketProject: ticket => {
      // Настоящий разбор билета проверяется в preview-ticket.test.ts; здесь важно, что дверь его
      // спрашивает и отвергает всё остальное.
      const value = String(ticket ?? "");
      return value.startsWith("ticket:") ? value.slice("ticket:".length) : "";
    },
    secureCookie: () => false,
    ...overrides,
  };
}

async function doorWith(deps: PreviewHostDeps, limits?: { maxConnections: number; maxUpgrades: number; upgradeTimeoutMs: number }) {
  const door = createPreviewHostServer(deps, limits);
  await new Promise<void>(resolve => door.server.listen(0, "127.0.0.1", resolve));
  const address = door.server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { port, close: door.close };
}

/** Запрос к двери с нужным именем хоста — так её видит реверс-прокси. */
function ask(port: number, path: string, headers: Record<string, string> = {}, timeoutMs = 2000) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, method: "GET", timeout: timeoutMs, headers: { host: PROJECT + "." + DOMAIN, ...headers } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk as Buffer));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}

test("без билета адрес предпросмотра закрыт", async () => {
  const site = await upstream();
  const door = await doorWith(depsFor(site.port));
  try {
    const denied = await ask(door.port, "/", { accept: "application/json" });
    assert.equal(denied.status, 401);
    assert.match(denied.body, /панели проекта/);
    // Панель открывает адрес в кадре и в новой вкладке, поэтому страница отказа читаема и глазами.
    const page = await ask(door.port, "/");
    assert.equal(page.status, 401);
    assert.match(String(page.headers["content-type"]), /text\/html/);
    assert.equal(site.hits.length, 0, "приложение не должно отвечать тому, кто не предъявил билет");
  } finally {
    await door.close();
    await site.close();
  }
});

test("билет в строке запроса превращается в cookie и убирается из адреса", async () => {
  const site = await upstream();
  const door = await doorWith(depsFor(site.port));
  try {
    const response = await ask(door.port, "/?ticket=ticket:" + PROJECT + "&tab=1");
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, "/?tab=1");
    const cookie = String(response.headers["set-cookie"]);
    assert.match(cookie, new RegExp(PREVIEW_TICKET_COOKIE + "="));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.equal(site.hits.length, 0, "первый запрос только ставит cookie, приложение его не видит");
  } finally {
    await door.close();
    await site.close();
  }
});

test("cookie платформы в приложение не уходит, а приложение отдаётся как есть", async () => {
  const site = await upstream({ cookie: "app_session=1" });
  const door = await doorWith(depsFor(site.port));
  try {
    const response = await ask(door.port, "/deep?x=1", {
      cookie: PREVIEW_TICKET_COOKIE + "=ticket:" + PROJECT + "; app_session=1",
    });
    assert.equal(response.status, 200);
    assert.equal(site.hits.at(-1), "/deep?x=1");
    // Билет — доказательство права на доступ; приложению пользователя он не нужен.
    assert.equal(site.cookies.at(-1), "app_session=1");
    // Публичный адрес — корень приложения: его корневые ссылки не переписываются (в панели они
    // переписываются на префикс прокси, и именно из-за этого работает только там).
    assert.match(response.body, /src="\/@vite\/client"/);
    // Кадр — это всегда последняя версия проекта: кэш браузера или посредника показал бы старую.
    assert.equal(response.headers["cache-control"], "no-store, no-cache, must-revalidate, max-age=0");
    assert.equal(response.headers.etag, undefined);
    // Cookie самого приложения сохраняется: оно живёт на своём поддомене.
    assert.match(String(response.headers["set-cookie"]), /app_session=1/);
  } finally {
    await door.close();
    await site.close();
  }
});

test("страница приложения получает мост выбора элемента, а сам мост отдаёт платформа", async () => {
  const site = await upstream();
  const door = await doorWith(depsFor(site.port));
  try {
    const page = await ask(door.port, "/", { cookie: PREVIEW_TICKET_COOKIE + "=ticket:" + PROJECT });
    assert.equal(page.status, 200);
    // Мост — единственный способ дать панели выбор элемента на чужом origin.
    assert.ok(page.body.includes(PICK_BRIDGE_TAG), page.body);
    // Документ приложения при этом не переписан: ссылки остаются какими были.
    assert.match(page.body, /src="\/@vite\/client"/);
    assert.equal(page.headers["content-length"], undefined, "длина тела пересчитана после вставки");

    // Скрипт отдаётся самим слушателем: приложение о таком пути ничего не знает и не должно.
    const hitsBefore = site.hits.length;
    const script = await ask(door.port, PICK_BRIDGE_PATH, { cookie: PREVIEW_TICKET_COOKIE + "=ticket:" + PROJECT });
    assert.equal(script.status, 200);
    assert.match(String(script.headers["content-type"]), /application\/javascript/);
    assert.ok(script.body.includes(PICK_COMMAND), "скрипт отдаётся целиком");
    assert.equal(site.hits.length, hitsBefore, "запрос моста не доходит до приложения");
  } finally {
    await door.close();
    await site.close();
  }
});

test("не-HTML ответы не переписываются", async () => {
  const json: Upstream = await (async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, path: request.url }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    return { server, port: typeof address === "object" && address ? address.port : 0, hits: [], cookies: [], close: () => new Promise<void>(resolve => server.close(() => resolve())) };
  })();
  const door = await doorWith(depsFor(json.port));
  try {
    const response = await ask(door.port, "/api/client", { cookie: PREVIEW_TICKET_COOKIE + "=ticket:" + PROJECT });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { ok: true, path: "/api/client" });
  } finally {
    await door.close();
    await json.close();
  }
});

test("остановленный предпросмотр объясняет себя, а не отдаёт пустую страницу", async () => {
  const site = await upstream();
  const door = await doorWith(depsFor(site.port, { previewStatus: async () => ({ running: false }) }));
  try {
    const response = await ask(door.port, "/", { cookie: PREVIEW_TICKET_COOKIE + "=ticket:" + PROJECT, accept: "application/json" });
    assert.equal(response.status, 503);
    assert.match(response.body, /не запущен/);
  } finally {
    await door.close();
    await site.close();
  }
});

test("удалённый проект не отдаётся по старому адресу", async () => {
  const site = await upstream();
  const door = await doorWith(depsFor(site.port, { getProject: async () => null }));
  try {
    const response = await ask(door.port, "/", { cookie: PREVIEW_TICKET_COOKIE + "=ticket:" + PROJECT, accept: "application/json" });
    assert.equal(response.status, 404);
    assert.equal(site.hits.length, 0);
  } finally {
    await door.close();
    await site.close();
  }
});

test("чужое имя хоста дверь не обслуживает", async () => {
  const site = await upstream();
  const door = await doorWith(depsFor(site.port));
  try {
    const response = await ask(door.port, "/", { host: "preview.nestdev.ru" });
    assert.equal(response.status, 404);
  } finally {
    await door.close();
    await site.close();
  }
});

/**
 * Живая перезагрузка приходит обновлением соединения, и его нельзя разбирать: клиент (Vite HMR,
 * socket.io) договаривается с приложением сам. Дверь передаёт байты приложения в обе стороны, а
 * приложение в этом тесте — обычный сокет, который повторяет полученное.
 */
test("обновление соединения до WebSocket передаётся приложению как есть", async () => {
  const received: string[] = [];
  // Приложение для этого теста — обычный сокет: дверь не разбирает WebSocket, а передаёт байты,
  // поэтому проверять нужно именно переданные байты, а не протокол.
  const site = createTcpServer(socket => {
    socket.on("data", chunk => {
      received.push(chunk.toString("utf8"));
      if (received.length === 1) socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      else socket.write("echo:" + chunk.toString("utf8"));
    });
  });
  await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
  const address = site.address();
  const sitePort = typeof address === "object" && address ? address.port : 0;
  const door = await doorWith(depsFor(sitePort));
  const client = connect(door.port, "127.0.0.1");
  try {
    await new Promise<void>(resolve => client.on("connect", resolve));
    client.write(
      "GET /hmr HTTP/1.1\r\n" +
      "Host: " + PROJECT + "." + DOMAIN + "\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      "Sec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n" +
      "Cookie: " + PREVIEW_TICKET_COOKIE + "=ticket:" + PROJECT + "; app_session=1\r\n\r\n",
    );
    const handshake = await read(client);
    assert.match(handshake, /101 Switching Protocols/);
    assert.match(received[0] ?? "", /^GET \/hmr HTTP\/1\.1\r\n/);
    assert.match(received[0] ?? "", /app_session=1/);
    assert.doesNotMatch(received[0] ?? "", new RegExp(PREVIEW_TICKET_COOKIE), "билет не должен уходить в приложение");

    client.write("ping");
    const echo = await read(client);
    assert.equal(echo, "echo:ping");
  } finally {
    client.destroy();
    await door.close();
    await new Promise<void>(resolve => site.close(() => resolve()));
  }
});

test("билет не уходит в приложение в строке WebSocket-запроса", async () => {
  const received: string[] = [];
  const site = createTcpServer(socket => {
    socket.on("data", chunk => {
      received.push(chunk.toString("utf8"));
      if (received.length === 1) socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    });
  });
  await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
  const address = site.address();
  const sitePort = typeof address === "object" && address ? address.port : 0;
  const door = await doorWith(depsFor(sitePort));
  const client = connect(door.port, "127.0.0.1");
  try {
    await new Promise<void>(resolve => client.on("connect", resolve));
    client.write(
      "GET /hmr?ticket=ticket:" + PROJECT + "&tab=1 HTTP/1.1\r\n" +
      "Host: " + PROJECT + "." + DOMAIN + "\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      "Sec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n" +
      "Cookie: " + PREVIEW_TICKET_COOKIE + "=ticket:" + PROJECT + "\r\n\r\n",
    );
    const handshake = await read(client);
    assert.match(handshake, /101 Switching Protocols/);
    assert.match(received[0] ?? "", /^GET \/hmr\?tab=1 HTTP\/1\.1\r\n/, "билет вырезан, остальные параметры на месте");
    assert.doesNotMatch(received[0] ?? "", /ticket=/);
  } finally {
    client.destroy();
    await door.close();
    await new Promise<void>(resolve => site.close(() => resolve()));
  }
});

test("число одновременных WebSocket-соединений ограничено", async () => {
  const site = createTcpServer(socket => {
    socket.on("data", () => socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n"));
  });
  await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
  const address = site.address();
  const sitePort = typeof address === "object" && address ? address.port : 0;
  const door = await doorWith(depsFor(sitePort), { maxConnections: 16, maxUpgrades: 1, upgradeTimeoutMs: 2000 });
  const first = connect(door.port, "127.0.0.1");
  let second: ReturnType<typeof connect> | null = null;
  try {
    await new Promise<void>(resolve => first.on("connect", resolve));
    first.write("GET /hmr HTTP/1.1\r\nHost: " + PROJECT + "." + DOMAIN + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: " + PREVIEW_TICKET_COOKIE + "=ticket:" + PROJECT + "\r\n\r\n");
    assert.match(await read(first), /101 Switching Protocols/);

    second = connect(door.port, "127.0.0.1");
    await new Promise<void>(resolve => second?.once("connect", resolve));
    second.write("GET /hmr HTTP/1.1\r\nHost: " + PROJECT + "." + DOMAIN + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: " + PREVIEW_TICKET_COOKIE + "=ticket:" + PROJECT + "\r\n\r\n");
    assert.match(await read(second), /503 Service Unavailable/);
  } finally {
    first.destroy();
    second?.destroy();
    await door.close();
    await new Promise<void>(resolve => site.close(() => resolve()));
  }
});

test("без билета обновление соединения отвергается", async () => {
  const site = await upstream();
  const door = await doorWith(depsFor(site.port));
  const client = connect(door.port, "127.0.0.1");
  try {
    await new Promise<void>(resolve => client.on("connect", resolve));
    client.write("GET /hmr HTTP/1.1\r\nHost: " + PROJECT + "." + DOMAIN + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    const answer = await read(client);
    assert.match(answer, /401 Unauthorized/);
  } finally {
    client.destroy();
    await door.close();
    await site.close();
  }
});

/**
 * Читает ответ сокета до первой порции данных и короткой паузы после неё: у ответа апгрейда нет
 * длины, поэтому «конец ответа» здесь — это тишина после того, как что-то пришло.
 */
function read(socket: ReturnType<typeof connect>, timeoutMs = 2000) {
  return new Promise<string>((resolve, reject) => {
    let collected = "";
    const finish = () => {
      clearTimeout(timer);
      socket.removeListener("data", onData);
      if (collected) resolve(collected);
      else reject(new Error("сокет молчит"));
    };
    const timer = setTimeout(finish, timeoutMs);
    const onData = (chunk: Buffer) => {
      collected += chunk.toString("utf8");
      setTimeout(finish, 50);
    };
    socket.on("data", onData);
  });
}

test("разбор cookie запроса и фильтр заголовков — отдельно от основного сервера", () => {
  assert.deepEqual(requestCookies("a=1; b=2; broken; =3"), { a: "1", b: "2" });
  assert.deepEqual(
    forwardableHeaders({ cookie: "webnestdev_session=s; webnestdev_preview=t; app=1", host: "p1.preview.nestdev.ru" }),
    { cookie: "app=1", host: "p1.preview.nestdev.ru" },
  );
  // Единственные cookie — платформенные: заголовок исчезает целиком, а не остаётся пустым.
  assert.deepEqual(forwardableHeaders({ cookie: "webnestdev_preview=t" }), {});
});

/** Заголовок cookie приходит от клиента: мусор в одном значении не должен ломать весь запрос. */
test("битая последовательность в cookie не роняет дверь", async () => {
  const site = await upstream();
  const door = await doorWith(depsFor(site.port));
  try {
    const response = await ask(door.port, "/", { cookie: "broken=%zz; " + PREVIEW_TICKET_COOKIE + "=ticket:" + PROJECT });
    assert.equal(response.status, 200);
    assert.equal(site.hits.length, 1);
  } finally {
    await door.close();
    await site.close();
  }
});

test("доступ даётся только билету своего проекта", () => {
  const url = new URL("https://p1.preview.nestdev.ru/?ticket=good");
  assert.deepEqual(
    previewAccess({ url, cookies: {}, projectId: "p1", ticketProject: ticket => (ticket === "good" ? "p1" : "") }),
    { ok: true, ticket: "good", redirectTo: "/" },
  );
  // Билет другого проекта: чужой предпросмотр не открывается даже валидным билетом.
  assert.equal(previewAccess({ url, cookies: {}, projectId: "p2", ticketProject: () => "p1" }).ok, false);
  assert.equal(previewAccess({ url: new URL("https://p1.preview.nestdev.ru/"), cookies: { [PREVIEW_TICKET_COOKIE]: "bad" }, projectId: "p1", ticketProject: () => "" }).ok, false);
});

/**
 * Сама дверь — часть старта сервера (index.ts): она поднимается только при заданном домене и
 * освобождает порт при остановке. Без этой проверки ошибка в обвязке была бы видна только на ВМ,
 * где предпросмотр «настроен, но не отвечает».
 */
test("дверь поднимается при заданном домене и освобождает порт", async () => {
  const port = 18_900 + Math.floor(Math.random() * 100);
  process.env.PREVIEW_HOST_PORT = String(port);
  process.env.PREVIEW_HOST_BIND = "127.0.0.1";
  try {
    const started = await startPreviewHostServer();
    assert.deepEqual({ started: started.started, port: started.port }, { started: true, port });
    assert.match(describePreviewHostServer(), new RegExp(String(port)));
    // Слушает именно дверь предпросмотра: без билета она отвечает 401, а не отдаёт панель.
    const denied = await ask(port, "/", { accept: "application/json" });
    assert.equal(denied.status, 401);
    await stopPreviewHostServer();
    // Порт должен быть закрыт: отказ в соединении, а не разговор с уже остановленной дверью.
    await assert.rejects(
      () => ask(port, "/", {}, 500),
      (error: Error) => /ECONNREFUSED|ECONNRESET|hang up|closed/i.test(error.message),
    );
  } finally {
    delete process.env.PREVIEW_HOST_PORT;
    delete process.env.PREVIEW_HOST_BIND;
    await stopPreviewHostServer();
  }
});

test("без домена предпросмотра дверь не занимает порт", async () => {
  const domain = process.env.PREVIEW_PUBLIC_DOMAIN;
  delete process.env.PREVIEW_PUBLIC_DOMAIN;
  try {
    const started = await startPreviewHostServer();
    assert.equal(started.started, false);
    assert.match(String(started.reason), /PREVIEW_PUBLIC_DOMAIN/);
    assert.match(describePreviewHostServer(), /не поднимается/);
  } finally {
    process.env.PREVIEW_PUBLIC_DOMAIN = domain;
  }
});

/** Настоящий билет (шифрование тем же ключом, что и секреты) проходит дверь без подстановок. */
test("настоящий билет шифрования проходит через дверь", async () => {
  const site = await upstream();
  const ticket = mintPreviewTicket(PROJECT);
  const door = await doorWith(depsFor(site.port, { ticketProject: previewTicketProject }));
  try {
    const response = await ask(door.port, "/?q=1", { cookie: PREVIEW_TICKET_COOKIE + "=" + encodeURIComponent(ticket) });
    assert.equal(response.status, 200);
    assert.equal(site.hits.at(-1), "/?q=1");
    // Тот же билет на другой адрес проекта не открывает ничего.
    const other = await ask(door.port, "/", { cookie: PREVIEW_TICKET_COOKIE + "=" + encodeURIComponent(ticket), host: "another-project." + DOMAIN, accept: "application/json" });
    assert.equal(other.status, 401);
  } finally {
    await door.close();
    await site.close();
  }
});

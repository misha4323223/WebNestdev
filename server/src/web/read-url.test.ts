import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { assertPublicUrl, isPrivateAddress, pinnedLookup, readWebPage, requestPage } from "./read-url.js";

test("private, loopback, link-local and metadata addresses are recognised", () => {
  for (const address of [
    "127.0.0.1",
    "127.10.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.0.10",
    "169.254.169.254",
    "100.100.100.200",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
    "::",
    "fd00::1",
    "fe80::1",
    "fe80::1%eth0",
    "::ffff:127.0.0.1",
    // URL нормализует IPv4-mapped адрес в hex, поэтому проверка по точкам его не видела:
    // эти записи обязаны отвергаться так же, как точечные.
    "::ffff:7f00:1",
    "0:0:0:0:0:ffff:7f00:1",
    "::ffff:0:127.0.0.1",
    "::ffff:a9fe:a9fe",
    "::7f00:1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
    "2001:0:1234::1",
    "ff02::1",
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700:4700::1111", "2a00:1450:4001:81b::200e", "::ffff:8.8.8.8"]) {
    assert.equal(isPrivateAddress(address), false, address);
  }
  // Строка, похожая на IPv6, но не адрес, тоже не считается публичной.
  assert.equal(isPrivateAddress("1:2:3:4:5:6:7:8:9"), true);
});

test("only public http(s) addresses on ports 80 and 443 are accepted", async () => {
  await assert.rejects(() => assertPublicUrl("file:///etc/passwd"), /только http и https/);
  await assert.rejects(() => assertPublicUrl("http://localhost/"), /Внутренние адреса/);
  await assert.rejects(() => assertPublicUrl("http://169.254.169.254/latest/meta-data/"), /Частный адрес/);
  await assert.rejects(() => assertPublicUrl("http://192.168.1.1/"), /Частный адрес/);
  await assert.rejects(() => assertPublicUrl("http://[::1]/"), /Частный адрес/);
  // Литерал в нормализованной hex-записи — тот же loopback, а не «публичный IPv6».
  await assert.rejects(() => assertPublicUrl("http://[::ffff:127.0.0.1]/"), /Частный адрес/);
  await assert.rejects(() => assertPublicUrl("http://[::ffff:a9fe:a9fe]/"), /Частный адрес/);
  await assert.rejects(() => assertPublicUrl("http://example.com:8080/"), /порты 80 и 443/);
  await assert.rejects(() => assertPublicUrl("https://user:secret@example.com/"), /логин и пароль/);
  await assert.rejects(() => assertPublicUrl("не адрес"), /Это не адрес/);
  const allowed = await assertPublicUrl("http://93.184.216.34/");
  assert.equal(allowed.url.href, "http://93.184.216.34/");
});

test("readWebPage refuses an internal address without opening it", async () => {
  const page = await readWebPage("http://127.0.0.1:443/");
  assert.equal(page.ok, false);
  assert.equal(page.code, "blocked_host");
  assert.equal(page.text, "");
});

/**
 * DNS rebinding работает так: имя сначала указывает на публичный адрес (проверка проходит), а к
 * моменту соединения — на внутренний. Поэтому запрещать по имени бессмысленно: проверяется и
 * запоминается адрес, и он же отдаётся транспорту вместо повторного DNS.
 */
test("a name with at least one private answer is refused entirely", async () => {
  const answers: string[][] = [
    ["93.184.216.34", "127.0.0.1"],
    ["93.184.216.34", "10.0.0.7"],
    ["2606:4700:4700::1111", "::ffff:169.254.169.254"],
  ];
  for (const addresses of answers) {
    await assert.rejects(
      () => assertPublicUrl("https://rebind.example/", async () => addresses),
      /ведёт на внутренний адрес/,
      addresses.join(", "),
    );
  }
});

test("the pinned lookup answers with the checked address, not with the hostname", async () => {
  for (const [address, hostname] of [
    ["93.184.216.34", "rebind.example"],
    ["2606:4700:4700::1111", "rebind.example"],
  ] as const) {
    const lookup = pinnedLookup([address]);
    const answer = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      (lookup as unknown as (
        host: string,
        options: { family: number },
        done: (error: Error | null, address: string, family: number) => void,
      ) => void)(hostname, { family: 0 }, (error, found, family) => (error ? reject(error) : resolve({ address: found, family })));
    });
    assert.equal(answer.address, address);
    assert.equal(answer.family, address.includes(":") ? 6 : 4);
  }
});

test("without a requested family the pinned lookup prefers IPv4", async () => {
  const lookup = pinnedLookup(["2606:4700:4700::1111", "93.184.216.34"]);
  const address = await new Promise<string>((resolve, reject) => {
    (lookup as unknown as (
      host: string,
      options: { family?: number },
      done: (error: Error | null, address: string, family: number) => void,
    ) => void)("rebind.example", {}, (error, found) => (error ? reject(error) : resolve(found)));
  });
  assert.equal(address, "93.184.216.34");
});

type LocalSite = { port: number; close: () => Promise<void>; hits: string[] };

async function localSite(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<LocalSite> {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(String(request.headers.host ?? ""));
    handler(request, response);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { port, close: () => new Promise<void>(resolve => server.close(() => resolve())), hits };
}

const signal = () => new AbortController().signal;

/**
 * Имя в этом тесте не резолвится вообще (`rebind.invalid` — зарезервированный TLD). Соединение всё
 * равно происходит: транспорт получил проверенный адрес и DNS не спрашивает. Именно это закрывает
 * rebinding — второго ответа DNS, который мог бы отличаться от проверенного, просто нет.
 */
test("the transport connects to the checked address without asking DNS again", async () => {
  const target = await localSite((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
  try {
    const page = await requestPage(new URL("http://rebind.invalid:" + target.port + "/"), ["127.0.0.1"], signal());
    assert.equal(page.status, 200);
    assert.equal(page.body, "ok");
    // Host остаётся именем: приложение получает тот адрес, который запросили, а не IP.
    assert.equal(target.hits[0], "rebind.invalid:" + target.port);
  } finally {
    await target.close();
  }
});

test("the transport unpacks a compressed answer", async () => {
  const target = await localSite((_request, response) => {
    response.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
    response.end(gzipSync("<html><body>сжатый ответ</body></html>"));
  });
  try {
    const page = await requestPage(new URL("http://127.0.0.1:" + target.port + "/"), ["127.0.0.1"], signal());
    assert.match(page.body, /сжатый ответ/);
  } finally {
    await target.close();
  }
});

test("the body stops at the byte cap instead of reading the whole answer", async () => {
  const target = await localSite((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("x".repeat(500_000));
  });
  try {
    const page = await requestPage(new URL("http://127.0.0.1:" + target.port + "/"), ["127.0.0.1"], signal());
    assert.equal(page.body.length, 400_000);
    assert.equal(page.oversized, true);
  } finally {
    await target.close();
  }
});

test("a tail read keeps the end of the answer, where logs matter", async () => {
  const target = await localSite((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("начало-" + "x".repeat(200) + "-конец");
  });
  try {
    const page = await requestPage(new URL("http://127.0.0.1:" + target.port + "/"), ["127.0.0.1"], signal(), { maxBytes: 20, keep: "tail" });
    // Потолок считается в байтах, а `body` — уже текст, поэтому длина в символах может быть меньше.
    assert.ok(Buffer.byteLength(page.body) <= 20);
    assert.match(page.body, /-конец$/);
    assert.equal(page.oversized, true);
  } finally {
    await target.close();
  }
});

test("a redirect comes back as its status and location, without a body", async () => {
  const target = await localSite((_request, response) => {
    response.writeHead(302, { location: "/next" });
    response.end("тело редиректа");
  });
  try {
    const page = await requestPage(new URL("http://127.0.0.1:" + target.port + "/"), ["127.0.0.1"], signal());
    assert.equal(page.status, 302);
    assert.equal(page.headers.location, "/next");
    assert.equal(page.body, "");
  } finally {
    await target.close();
  }
});

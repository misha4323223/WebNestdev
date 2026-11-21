import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { GUARDED_CHROMIUM_ARGS, launchGuardedBrowser, parseHostPort, resolveProxyTarget, startBrowserProxy } from "./browser-network.js";

const lookup = async (hostname: string) => {
  if (hostname === "public.example") return [{ address: "93.184.216.34", family: 4 }];
  if (hostname === "private.example") return [{ address: "10.0.0.7", family: 4 }];
  if (hostname === "mixed.example") {
    return [{ address: "93.184.216.34", family: 4 }, { address: "169.254.169.254", family: 4 }];
  }
  throw new Error("unexpected host " + hostname);
};

test("private и metadata адреса не проходят, публичные проходят", async () => {
  await assert.rejects(
    () => resolveProxyTarget("169.254.169.254", 80, new Set(), lookup),
    /private/,
  );
  await assert.rejects(
    () => resolveProxyTarget("private.example", 443, new Set(), lookup),
    /private/,
  );
  await assert.rejects(
    () => resolveProxyTarget("mixed.example", 443, new Set(), lookup),
    /private/,
    "одна приватная запись DNS уже отказ: rebinding не должен проскочить",
  );
  assert.equal((await resolveProxyTarget("public.example", 443, new Set(), lookup)).address, "93.184.216.34");
});

test("явно разрешённый preview может быть private, но только точное имя и порт", async () => {
  const allowed = new Set(["127.0.0.1:4123"]);
  assert.equal((await resolveProxyTarget("127.0.0.1", 4123, allowed, lookup)).address, "127.0.0.1");
  await assert.rejects(
    () => resolveProxyTarget("127.0.0.1", 4124, allowed, lookup),
    /private/,
  );
});

test("parseHostPort понимает IPv6 в скобках", () => {
  assert.deepEqual(parseHostPort("[::1]:8787", 443), { hostname: "::1", port: 8787 });
  assert.deepEqual(parseHostPort("example.com:8443", 443), { hostname: "example.com", port: 8443 });
  assert.deepEqual(parseHostPort("example.com", 443), { hostname: "example.com", port: 443 });
  assert.equal(parseHostPort("example.com:99999", 443), null);
});

test("HTTP-прокси пропускает разрешённый upstream и отказывает другому localhost", async () => {
  const upstream = http.createServer((_request, response) => response.end("proxied-ok"));
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const upstreamPort = address.port;
  const proxy = await startBrowserProxy({ allowUrls: ["http://127.0.0.1:" + upstreamPort] });
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const request = http.request({
        host: "127.0.0.1",
        port: proxy.port,
        path: "http://127.0.0.1:" + upstreamPort + "/hello",
        headers: { host: "127.0.0.1:" + upstreamPort },
      }, response => {
        const chunks: Buffer[] = [];
        response.on("data", chunk => chunks.push(Buffer.from(chunk)));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(body, "proxied-ok");
  } finally {
    await proxy.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }

  const second = await startBrowserProxy({ allowUrls: [] });
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request({
        host: "127.0.0.1",
        port: second.port,
        path: "http://127.0.0.1:" + upstreamPort + "/",
      }, response => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(status, 403);
  } finally {
    await second.close();
  }
});

test("guarded launch передаёт Chromium прокси, отключает обход loopback и закрывает прокси", async () => {
  let options: Record<string, unknown> | undefined;
  let closed = false;
  const guarded = await launchGuardedBrowser(async next => {
    options = next as unknown as Record<string, unknown>;
    return { close: async () => { closed = true; } } as never;
  }, { headless: true, args: ["--existing"] }, ["http://127.0.0.1:4123"]);
  assert.ok(String((options?.proxy as { server?: string } | undefined)?.server).startsWith("http://127.0.0.1:"));
  assert.ok((options?.args as string[]).includes("--existing"));
  for (const arg of GUARDED_CHROMIUM_ARGS) assert.ok((options?.args as string[]).includes(arg));
  await guarded.close();
  assert.equal(closed, true, "браузер закрывается вместе с фильтром");
});

test("CONNECT разрешён только для белого списка", async () => {
  const upstream = net.createServer(socket => {
    socket.on("data", chunk => socket.write(chunk));
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const upstreamPort = address.port;
  const proxy = await startBrowserProxy({ allowUrls: ["http://127.0.0.1:" + upstreamPort] });
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxy.port, "127.0.0.1", () => {
        socket.write("CONNECT 127.0.0.1:" + upstreamPort + " HTTP/1.1\r\nHost: 127.0.0.1:" + upstreamPort + "\r\n\r\n");
      });
      let buffer = "";
      socket.on("data", chunk => {
        buffer += chunk.toString("utf8");
        if (buffer.includes("200 Connection Established")) {
          socket.write("ping");
        }
        if (buffer.includes("ping")) {
          socket.destroy();
          resolve(buffer);
        }
      });
      socket.on("error", reject);
    });
    assert.match(result, /200 Connection Established/);
    assert.match(result, /ping/);
  } finally {
    await proxy.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

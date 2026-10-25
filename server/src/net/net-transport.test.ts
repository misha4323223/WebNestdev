import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { requestPage } from "../web/read-url.js";

/** Транспорт обязан передавать метод и тело: без этого `net.request` не вызовет ни один API. */
test("requestPage sends the method, headers and body it was given", async () => {
  let seen: { method?: string; body?: string; header?: string } = {};
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      seen = {
        method: request.method,
        body: Buffer.concat(chunks).toString("utf8"),
        header: request.headers["x-test"] as string | undefined,
      };
      response.writeHead(201, { "content-type": "application/json", "set-cookie": "a=1" });
      response.end('{"ok":true}');
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const result = await requestPage(
      new URL("http://127.0.0.1:" + port + "/api"),
      ["127.0.0.1"],
      AbortSignal.timeout(5_000),
      { method: "POST", headers: { "x-test": "yes", "content-type": "application/json" }, body: '{"hello":"world"}' },
    );
    assert.equal(seen.method, "POST");
    assert.equal(seen.body, '{"hello":"world"}');
    assert.equal(seen.header, "yes");
    assert.equal(result.status, 201);
    assert.equal(result.body, '{"ok":true}');
    assert.equal(result.bytes.toString("utf8"), '{"ok":true}');
    assert.equal(result.oversized, false);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

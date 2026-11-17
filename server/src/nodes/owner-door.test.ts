import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

test("the owner door keeps the WebSocket upgrade headers", async () => {
  const token = "d".repeat(40);
  process.env.WEBNESTDEV_OWNER_ROUTING = "1";
  process.env.WEBNESTDEV_INTERNAL_TOKEN = token;

  let seen: { connection?: string; upgrade?: string } = {};
  const targetSockets: Array<{ destroy: () => void }> = [];
  const target = http.createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  target.on("upgrade", (request, socket) => {
    targetSockets.push(socket);
    seen = {
      connection: String(request.headers.connection ?? ""),
      upgrade: String(request.headers.upgrade ?? ""),
    };
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
  });
  await new Promise<void>(resolve => target.listen(0, "127.0.0.1", resolve));
  const address = target.address();
  if (!address || typeof address === "string") throw new Error("target has no port");

  const { startOwnerDoor } = await import("./owner-door.js");
  const door = await startOwnerDoor({
    port: 0,
    apiPort: address.port,
    host: "127.0.0.1",
    token,
  });
  assert.ok(door, "owner door did not start");

  try {
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request({
        host: "127.0.0.1",
        port: door.port,
        path: "/ws?projectId=p1",
        headers: {
          Connection: "Upgrade",
          Upgrade: "websocket",
          "x-webnestdev-internal-token": token,
        },
      });
      request.on("upgrade", (response, socket) => {
        const code = response.statusCode ?? 0;
        socket.destroy();
        resolve(code);
      });
      request.on("response", response => {
        response.resume();
        reject(new Error("upgrade was not forwarded: HTTP " + response.statusCode));
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(status, 101);
    assert.match(seen.connection ?? "", /upgrade/i);
    assert.equal((seen.upgrade ?? "").toLowerCase(), "websocket");
  } finally {
    for (const socket of targetSockets) socket.destroy();
    await door.close();
    await new Promise<void>(resolve => target.close(() => resolve()));
    delete process.env.WEBNESTDEV_OWNER_ROUTING;
    delete process.env.WEBNESTDEV_INTERNAL_TOKEN;
  }
});

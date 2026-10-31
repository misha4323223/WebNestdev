import test from "node:test";
import assert from "node:assert/strict";
import { createServer, connect } from "node:net";
import { once } from "node:events";
import { createPreviewRelayManager } from "./preview-relay.js";

const upstream = createServer(socket => {
  socket.on("data", chunk => socket.write(chunk));
});
await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
const upstreamAddress = upstream.address();
if (!upstreamAddress || typeof upstreamAddress === "string") throw new Error("upstream has no port");

const relay = createPreviewRelayManager({
  bind: "127.0.0.1",
  docker: async args => {
    assert.deepEqual(args, ["inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}\n{{end}}", "abc123"]);
    return { code: 0, stdout: "127.0.0.1\n", stderr: "" };
  },
});

test("a preview relay carries bytes over a private TCP port and closes with its container", async () => {
  const address = await relay.open("abc123", upstreamAddress.port);
  assert.equal(address.host, "127.0.0.1");
  const socket = connect(address.port, address.host);
  await once(socket, "connect");
  socket.write("ping");
  const [chunk] = await once(socket, "data");
  assert.equal(chunk.toString(), "ping");
  socket.destroy();

  await relay.close("abc123");
  const closed = connect(address.port, address.host);
  await once(closed, "error");
  closed.destroy();
});

test.after(async () => {
  await relay.closeAll();
  await new Promise<void>(resolve => upstream.close(() => resolve()));
});

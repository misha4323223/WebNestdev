import assert from "node:assert/strict";
import test from "node:test";
import { FunctionInvokeError, invokeFunction, dockerHostPathForSiteArtifact } from "./invoke.js";
import type { BuiltFunction } from "./build.js";

const fn: BuiltFunction = {
  name: "hello",
  path: "/api/hello",
  methods: ["POST"],
  handler: "node:functions/hello.ts#handler",
  file: "index.mjs",
  bytes: 10,
  sha256: "x",
  timeoutMs: 2000,
  memoryMb: 128,
};

const request = {
  method: "POST",
  path: "/api/hello",
  query: "?x=1",
  headers: { "content-type": "application/json" },
  bodyBase64: Buffer.from('{"name":"Ada"}').toString("base64"),
};

test("разбирает ответ исполнителя и не пропускает length/connection обратно", async () => {
  let args: string[] = [];
  let stdin = "";
  const response = await invokeFunction({
    artifactDir: "/srv/sites/demo/releases/abcdef01/.functions/hello",
    fn,
    request,
    env: { TOKEN: "secret", PATH: "/evil" },
    run: async (nextArgs, _timeout, input) => {
      args = nextArgs;
      stdin = String(input ?? "");
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          ok: true,
          status: 201,
          headers: { "content-type": "text/plain", "content-length": "99", connection: "close" },
          body: Buffer.from("ok").toString("base64"),
        }),
      };
    },
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.toString(), "ok");
  assert.equal(response.headers["content-length"], undefined);
  assert.equal(response.headers.connection, undefined);
  assert.ok(args.includes("-i"));
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("-e"));
  assert.ok(args.includes("TOKEN=secret"));
  assert.equal(args.includes("PATH=/evil"), false);
  assert.match(args.join(" "), /\/workspace:ro/);
  assert.match(stdin, /"bodyBase64"/);
});

test("возвращает задания из ответа функции для постановки в очередь", async () => {
  const response = await invokeFunction({
    artifactDir: "/srv/sites/demo/releases/abcdef01/.functions/hello",
    fn,
    request,
    run: async () => ({
      code: 0,
      stderr: "",
      stdout: JSON.stringify({
        ok: true,
        status: 202,
        headers: {},
        body: Buffer.from("accepted").toString("base64"),
        jobs: [{ name: "send-receipt", idempotencyKey: "order:1", payload: { id: 1 } }],
      }),
    }),
  });
  assert.equal(response.status, 202);
  assert.deepEqual(response.jobs, [{ name: "send-receipt", idempotencyKey: "order:1", payload: { id: 1 } }]);
});

test("превращает ошибку исполнителя в 502 и не отдаёт сырой вывод как успех", async () => {
  await assert.rejects(
    () => invokeFunction({
      artifactDir: "/srv/sites/demo/releases/abcdef01/.functions/hello",
      fn,
      request,
      run: async () => ({ code: 1, stderr: "", stdout: JSON.stringify({ ok: false, error: "boom" }) }),
    }),
    (error: unknown) => error instanceof FunctionInvokeError && /boom/.test(error.message) && error.statusCode === 502,
  );
});

test("не монтирует артефакт вне каталога сайтов", () => {
  assert.throws(
    () => dockerHostPathForSiteArtifact("/tmp/not-a-site"),
    (error: unknown) => error instanceof FunctionInvokeError,
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FunctionManifestError,
  FUNCTIONS_MANIFEST_FILE,
  parseFunctionManifest,
  readFunctionManifest,
} from "./manifest.js";

const valid = {
  version: 1,
  runtime: "node",
  functions: [
    {
      name: "orders",
      path: "/api/orders",
      methods: ["GET", "POST"],
      handler: "functions/orders.ts#handler",
    },
  ],
};

test("валидный манифест получает безопасные значения по умолчанию", () => {
  const manifest = parseFunctionManifest(valid);
  assert.equal(manifest.runtime, "node");
  assert.deepEqual(manifest.functions[0]?.methods, ["GET", "POST"]);
  assert.equal(manifest.functions[0]?.timeoutMs, 10_000);
  assert.equal(manifest.functions[0]?.memoryMb, 256);
});

test("method нормализуется к верхнему регистру без повторов", () => {
  const manifest = parseFunctionManifest({
    ...valid,
    functions: [{ ...valid.functions[0], methods: ["get", "GET", "post"] }],
  });
  assert.deepEqual(manifest.functions[0]?.methods, ["GET", "POST"]);
});

test("маршрут вне /api, с .. или query отклоняется", () => {
  for (const route of ["/orders", "/api/../secret", "/api/orders?x=1", "/api//orders", "/api/orders#x"]) {
    assert.throws(
      () => parseFunctionManifest({ ...valid, functions: [{ ...valid.functions[0], path: route }] }),
      (error: unknown) => error instanceof FunctionManifestError && error.code === "FUNCTIONS_MANIFEST_INVALID",
      route,
    );
  }
});

test("абсолютный обработчик, обратный слэш и выход из проекта отклоняются", () => {
  for (const handler of ["/etc/passwd#handler", "../secret.ts#handler", "functions\\orders.ts#handler", "functions/orders.ts", "functions/orders.ts#bad-name"]) {
    assert.throws(
      () => parseFunctionManifest({ ...valid, functions: [{ ...valid.functions[0], handler }] }),
      FunctionManifestError,
      handler,
    );
  }
});

test("дубли имён и маршрутов отклоняются с указанием поля", () => {
  assert.throws(
    () => parseFunctionManifest({
      ...valid,
      functions: [
        valid.functions[0],
        { ...valid.functions[0], name: "orders-2" },
      ],
    }),
    (error: unknown) => {
      assert.ok(error instanceof FunctionManifestError);
      assert.equal(error.issues[0]?.field, "functions.1.path");
      return true;
    },
  );
  assert.throws(
    () => parseFunctionManifest({
      ...valid,
      functions: [
        valid.functions[0],
        { ...valid.functions[0], path: "/api/other" },
      ],
    }),
    (error: unknown) => {
      assert.ok(error instanceof FunctionManifestError);
      assert.equal(error.issues[0]?.field, "functions.1.name");
      return true;
    },
  );
});

test("неизвестное поле не прощается молча", () => {
  assert.throws(
    () => parseFunctionManifest({ ...valid, functions: [{ ...valid.functions[0], public: true }] }),
    FunctionManifestError,
  );
});

test("слишком много функций отклоняется", () => {
  assert.throws(
    () => parseFunctionManifest({
      ...valid,
      functions: Array.from({ length: 21 }, (_, index) => ({
        ...valid.functions[0],
        name: "fn-" + index,
        path: "/api/fn-" + index,
      })),
    }),
    FunctionManifestError,
  );
});

test("отсутствующий манифест — это null, а не ошибка", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nestdev-functions-"));
  try {
    assert.equal(await readFunctionManifest(root), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readFunctionManifest читает и проверяет файл", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "nestdev-functions-"));
  try {
    await writeFile(path.join(root, FUNCTIONS_MANIFEST_FILE), JSON.stringify(valid));
    const manifest = await readFunctionManifest(root);
    assert.equal(manifest?.functions[0]?.name, "orders");
    await writeFile(path.join(root, FUNCTIONS_MANIFEST_FILE), "{не json");
    await assert.rejects(() => readFunctionManifest(root), /невалидный JSON/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

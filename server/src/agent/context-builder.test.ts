import test from "node:test";
import assert from "node:assert/strict";
import { packageSummary } from "./context-builder.js";

test("снимок package.json сохраняет версии зависимостей, а не только имена", () => {
  const summary = JSON.parse(packageSummary(JSON.stringify({
    name: "site",
    version: "1.0.0",
    packageManager: "npm@11",
    scripts: { build: "vite build" },
    dependencies: { react: "^18.3.1", "react-dom": "^18.3.1" },
    devDependencies: { vite: "^5.4.0" },
  }))) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  assert.deepEqual(summary.dependencies, { react: "^18.3.1", "react-dom": "^18.3.1" });
  assert.deepEqual(summary.devDependencies, { vite: "^5.4.0" });
});

test("слишком большой package.json остаётся валидным JSON и честно говорит об усечении", () => {
  const dependencies = Object.fromEntries(
    Array.from({ length: 300 }, (_, index) => ["package-" + index, "^1.0." + index]),
  );
  const summary = packageSummary(JSON.stringify({
    name: "huge",
    version: "1.0.0",
    dependencies,
    devDependencies: dependencies,
  }));
  assert.ok(summary.length <= 6000, "снимок не должен пробивать лимит контекста");
  const parsed = JSON.parse(summary) as { note?: string; dependencies?: Record<string, string> };
  assert.ok(parsed.note, "усечение должно быть названо, а не молчаливым");
  assert.ok(Object.keys(parsed.dependencies ?? {}).length <= 80);
});

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isDevServerCommand, isServerBuildCommand } from "./plan-work-guard.js";

test("узнаёт сборку и запуск серверных проектов", () => {
  for (const command of [
    "npm run build",
    "pnpm dev",
    "yarn start",
    "next build",
    "vite build",
    "node server/index.js",
    "tsx src/main.ts",
    "npx next build",
    "./node_modules/.bin/next build",
    "uvicorn app:app",
  ]) {
    assert.equal(isServerBuildCommand(command), true, command);
  }
});

test("не трогает тесты, установку и статическую сборку через прямой вызов", () => {
  for (const command of [
    "npm test",
    "npm run lint",
    "npx tsc --noEmit",
    "npm install",
    "node --test test/unit.test.mjs",
  ]) {
    assert.equal(isServerBuildCommand(command), false, command);
  }
});

test("dev/start/preview — это серверный запуск, а build — нет", () => {
  for (const command of ["npm run dev", "npm start", "pnpm serve", "vite preview", "next dev", "uvicorn app:app", "python3 -m http.server 5173"]) {
    assert.equal(isDevServerCommand(command), true, command);
  }
  for (const command of ["npm run build", "next build", "vite build", "npm test", "npm install", "python3 scripts/build.py"]) {
    assert.equal(isDevServerCommand(command), false, command);
  }
});

test("на тарифе без контейнера агент не поднимает dev-сервер даже для статики", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "plan-guard-dev-"));
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "static-site", scripts: { dev: "vite", build: "vite build" } }),
    );
    const { checkPlanCanBuildProject } = await import("./plan-work-guard.js");
    const result = await checkPlanCanBuildProject({ root, userId: "missing-user", command: "npm run dev" });
    assert.equal(result.allowed, false);
    if (!result.allowed) assert.match(result.reason, /preview\.start/);
    const build = await checkPlanCanBuildProject({ root, userId: "missing-user", command: "npm run build" });
    assert.equal(build.allowed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("серверный проект на тарифе без контейнерного preview не собирается", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "plan-guard-"));
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "server-app",
        scripts: { build: "next build", start: "next start" },
        dependencies: { next: "15.0.0", react: "19.0.0" },
      }),
    );
    const { checkPlanCanBuildProject } = await import("./plan-work-guard.js");
    // Без реальной подписки accountPlanFor вернёт free; для серверного проекта этого достаточно.
    const result = await checkPlanCanBuildProject({ root, userId: "missing-user", command: "npm run build" });
    assert.equal(result.allowed, false);
    if (!result.allowed) assert.match(result.reason, /Премиум/);
    const testResult = await checkPlanCanBuildProject({ root, userId: "missing-user", command: "npm test" });
    assert.equal(testResult.allowed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

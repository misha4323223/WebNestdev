import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readDeploymentProfile } from "./profile.js";

async function project(files: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "nestdev-profile-"));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return root;
}

test("статический сайт: готовый index.html, без бэкенда и без сборки", async () => {
  const root = await project({ "index.html": "<h1>Привет</h1>" });
  try {
    const profile = await readDeploymentProfile(root);
    assert.equal(profile.projectType.id, "static");
    assert.equal(profile.projectType.frontend, "static");
    assert.equal(profile.projectType.backend, "none");
    assert.equal(profile.projectType.shape, "instant-site");
    assert.equal(profile.projectType.label, "Статический сайт");
    assert.equal(profile.projectType.framework, null);
    assert.equal(profile.projectType.buildCommand, null);
    assert.deepEqual(profile.projectType.functions, []);
    assert.equal(profile.projectType.serverDir, null);
    assert.equal(profile.needs.database, false);
    assert.deepEqual(Object.values(profile.needs).some(Boolean), false);
    assert.deepEqual(profile.serviceIds, []);
    assert.ok(profile.projectType.evidence.includes("index.html"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("собранный фронтенд: Vite определяется как статика, база не предлагается", async () => {
  const root = await project({
    "package.json": JSON.stringify({
      scripts: { build: "vite build" },
      dependencies: { react: "^19.0.0" },
      devDependencies: { vite: "^7.0.0" },
    }),
    "index.html": "<div id=\"root\"></div>",
    ".env.example": "VITE_API_URL=http://localhost:8787\n",
  });
  try {
    const profile = await readDeploymentProfile(root);
    assert.equal(profile.projectType.id, "static");
    assert.equal(profile.projectType.frontend, "static");
    assert.equal(profile.projectType.backend, "none");
    assert.equal(profile.projectType.shape, "static-build");
    assert.equal(profile.projectType.framework, "Vite");
    assert.equal(profile.projectType.buildCommand, "vite build");
    assert.equal(profile.needs.database, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("серверный проект: зависимости и .env.example дают точный список сервисов", async () => {
  const root = await project({
    "package.json": JSON.stringify({
      scripts: { start: "node server.js" },
      dependencies: {
        express: "^5.0.0",
        pg: "^8.0.0",
        nodemailer: "^7.0.0",
        openai: "^4.0.0",
        "mapbox-gl": "^3.0.0",
      },
    }),
    ".env.example": "DATABASE_URL=postgresql://user:pass@localhost:5432/app\nOPENAI_API_KEY=sk-test\n",
    "server/.env.example": "S3_BUCKET=uploads\nS3_REGION=ru-1\n",
  });
  try {
    const profile = await readDeploymentProfile(root);
    assert.equal(profile.projectType.id, "server");
    assert.equal(profile.projectType.frontend, "unknown");
    assert.equal(profile.projectType.backend, "server");
    assert.equal(profile.projectType.shape, "node-runtime");
    assert.equal(profile.projectType.framework, "Express");
    assert.equal(profile.projectType.startCommand, "node server.js");
    assert.equal(profile.projectType.serverDir, ".");
    assert.equal(profile.needs.database, true);
    assert.equal(profile.needs.email, true);
    assert.equal(profile.needs.storage, true);
    assert.equal(profile.needs.ai, true);
    assert.equal(profile.needs.maps, true);
    assert.equal(profile.needs.payments, false);
    assert.equal(profile.needs.crm, false);
    assert.ok(profile.needsEvidence.database?.includes("pg"));
    assert.ok(profile.needsEvidence.database?.includes("DATABASE_URL"));
    assert.ok(profile.needsEvidence.storage?.some(item => item.includes("S3_BUCKET")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Python: версия и -binary в requirements не мешают распознать базу и фреймворк", async () => {
  const root = await project({
    "requirements.txt": "fastapi==0.115.0\npsycopg2-binary==2.9.9\nredis==5.0.0\n",
    "main.py": "from fastapi import FastAPI\n",
  });
  try {
    const profile = await readDeploymentProfile(root);
    assert.equal(profile.projectType.id, "server");
    assert.equal(profile.projectType.frontend, "unknown");
    assert.equal(profile.projectType.backend, "server");
    assert.equal(profile.projectType.shape, "python-runtime");
    assert.equal(profile.projectType.framework, "FastAPI");
    assert.equal(profile.projectType.serverDir, ".");
    assert.equal(profile.needs.database, true);
    assert.ok(profile.needsEvidence.database?.includes("psycopg2-binary"));
    assert.ok(profile.needsEvidence.database?.includes("redis"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("статика + функции: вложенный манифест даёт функции, базу, почту и оплату", async () => {
  const root = await project({
    "index.html": "<div id=\"app\"></div>",
    "functions/package.json": JSON.stringify({
      dependencies: {
        "@yandex-cloud/functions-framework": "^1.0.0",
        express: "^5.0.0",
        pg: "^8.0.0",
        nodemailer: "^7.0.0",
        robokassa: "^1.0.0",
      },
    }),
    "functions/index.js": "exports.handler = async () => ({ statusCode: 200 });\n",
    ".env.example": "DATABASE_URL=postgresql://user:pass@localhost:5432/app\nPOSTBOX_SMTP_HOST=smtp.postbox.yandexcloud.net\nROBOKASSA_PASSWORD1=secret\nS3_ENDPOINT=https://storage.yandexcloud.net\n",
  });
  try {
    const profile = await readDeploymentProfile(root);
    assert.equal(profile.projectType.id, "static-functions");
    assert.equal(profile.projectType.frontend, "static");
    assert.equal(profile.projectType.backend, "functions");
    assert.equal(profile.projectType.label, "Статический сайт + Cloud Functions");
    assert.equal(profile.projectType.serverDir, null);
    assert.equal(profile.projectType.functions[0]?.path, "functions");
    assert.equal(profile.projectType.functions[0]?.runtime, "node");
    assert.match(profile.projectType.reason, /функции: functions/);
    assert.ok(profile.projectType.evidence.includes("functions/package.json"));
    assert.ok(profile.projectType.evidence.includes("functions/index.js"));
    assert.equal(profile.needs.database, true);
    assert.equal(profile.needs.email, true);
    assert.equal(profile.needs.payments, true);
    assert.ok(profile.needsEvidence.database?.includes("functions/package.json · pg"));
    assert.ok(profile.needsEvidence.payments?.includes("ROBOKASSA_PASSWORD1"));
    assert.ok(profile.serviceIds.includes("yandex-postbox"));
    assert.ok(profile.serviceIds.includes("robokassa"));
    assert.ok(profile.serviceIds.includes("yandex-storage"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("функция на уровень глубже functions/: api-каталог не превращается в сервер", async () => {
  const root = await project({
    "index.html": "<div id=\"app\"></div>",
    "functions/api/package.json": JSON.stringify({
      dependencies: { express: "^5.0.0", pg: "^8.0.0", "@yandex-cloud/functions-framework": "^1.0.0" },
    }),
    "functions/api/index.js": "exports.handler = async () => ({ statusCode: 200 });\n",
    "functions/api/.env.example": "ROBOKASSA_PASSWORD1=secret\n",
  });
  try {
    const profile = await readDeploymentProfile(root);
    assert.equal(profile.projectType.id, "static-functions");
    assert.equal(profile.projectType.backend, "functions");
    assert.equal(profile.projectType.serverDir, null);
    assert.equal(profile.projectType.functions[0]?.path, "functions/api");
    assert.ok(profile.projectType.evidence.includes("functions/api/package.json"));
    assert.equal(profile.needs.database, true);
    assert.equal(profile.needs.payments, true);
    assert.ok(profile.needsEvidence.payments?.some(item => item.includes("ROBOKASSA_PASSWORD1")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("api с обработчиком и express — функция, а не сервер", async () => {
  const root = await project({
    "index.html": "<div id=\"app\"></div>",
    "api/package.json": JSON.stringify({ dependencies: { express: "^5.0.0", pg: "^8.0.0" } }),
    "api/index.js": "module.exports = async (req, res) => res.end('ok');\n",
  });
  try {
    const profile = await readDeploymentProfile(root);
    assert.equal(profile.projectType.id, "static-functions");
    assert.equal(profile.projectType.backend, "functions");
    assert.equal(profile.projectType.serverDir, null);
    assert.equal(profile.projectType.functions[0]?.path, "api");
    assert.equal(profile.needs.database, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("только функции: API без статического фронтенда", async () => {
  const root = await project({
    "functions/package.json": JSON.stringify({ dependencies: { "@yandex-cloud/functions-framework": "^1.0.0", pg: "^8.0.0" } }),
    "functions/index.js": "exports.handler = async () => ({ statusCode: 200 });\n",
  });
  try {
    const profile = await readDeploymentProfile(root);
    assert.equal(profile.projectType.id, "functions");
    assert.equal(profile.projectType.frontend, "unknown");
    assert.equal(profile.projectType.backend, "functions");
    assert.equal(profile.projectType.label, "API на Cloud Functions");
    assert.equal(profile.projectType.functions[0]?.path, "functions");
    assert.equal(profile.needs.database, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serverless.yml в корне: функции распознаются без каталога functions", async () => {
  const root = await project({
    "serverless.yml": "service: site\nprovider:\n  name: yandex\nfunctions:\n  api:\n    handler: handler.main\n",
    "handler.js": "exports.main = async () => ({ statusCode: 200 });\n",
  });
  try {
    const profile = await readDeploymentProfile(root);
    assert.equal(profile.projectType.id, "functions");
    assert.equal(profile.projectType.backend, "functions");
    assert.equal(profile.projectType.functions[0]?.path, ".");
    assert.ok(profile.projectType.evidence.includes("serverless.yml"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("вложенный сервер: статический фронтенд и серверный бэкенд не смешиваются", async () => {
  const root = await project({
    "index.html": "<div id=\"app\"></div>",
    "server/package.json": JSON.stringify({
      scripts: { start: "node index.js" },
      dependencies: { fastify: "^5.0.0", pg: "^8.0.0" },
    }),
    "server/index.js": "const fastify = require('fastify')();\n",
  });
  try {
    const profile = await readDeploymentProfile(root);
    assert.equal(profile.projectType.id, "server");
    assert.equal(profile.projectType.frontend, "static");
    assert.equal(profile.projectType.backend, "server");
    assert.equal(profile.projectType.label, "Статический фронтенд + сервер");
    assert.equal(profile.projectType.serverDir, "server");
    assert.match(profile.projectType.reason, /сервер: server/);
    assert.ok(profile.projectType.evidence.includes("server/package.json"));
    assert.equal(profile.needs.database, true);
    assert.ok(profile.needsEvidence.database?.includes("server/package.json · pg"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("неизвестный проект честно требует подтверждения типа", async () => {
  const root = await project({ "README.md": "# Пока пусто\n" });
  try {
    const profile = await readDeploymentProfile(root);
    assert.equal(profile.projectType.id, "unknown");
    assert.equal(profile.projectType.frontend, "unknown");
    assert.equal(profile.projectType.backend, "none");
    assert.equal(profile.projectType.shape, "unknown");
    assert.match(profile.projectType.label, /подтвердить/);
    assert.deepEqual(Object.values(profile.needs).some(Boolean), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

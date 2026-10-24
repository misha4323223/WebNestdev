import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEPLOY_PLAN_FILE,
  deployPlanNotice,
  normalizeDeploySteps,
  parseDeployPlan,
  readDeployPlan,
  writeDeployPlan,
} from "./deploy-plan.js";

async function project(files: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "nestdev-deploy-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(root, name), content);
  }
  return root;
}

test("deploy_project.md: план записывается, читается и сохраняет параметры и заметки", async () => {
  const root = await project();
  try {
    const written = await writeDeployPlan(root, {
      goal: "production",
      target: { kind: "static", provider: "Timeweb Cloud", region: "ru-1", domain: "example.ru" },
      services: [
        { role: "hosting", provider: "Timeweb Cloud", note: "статика" },
        { role: "email", provider: "NotiSend", note: "письма с сайта" },
      ],
      steps: [
        { title: "Собрать проект", status: "done", note: "npm run build проходит" },
        { title: "Создать бакет", status: "in_progress", note: "бакет example-ru" },
        { title: "Проверить домен", status: "pending" },
      ],
    });

    assert.equal(written.exists, true);
    assert.equal(written.total, 3);
    assert.equal(written.done, 1);
    assert.equal(written.current?.title, "Создать бакет");
    assert.equal(written.goal, "production");
    assert.equal(written.target.domain, "example.ru");
    assert.deepEqual(written.services.map(service => service.role), ["hosting", "email"]);

    const raw = await readFile(path.join(root, DEPLOY_PLAN_FILE), "utf8");
    assert.match(raw, /^# План развёртывания/m);
    assert.match(raw, /- \[x\] Собрать проект — npm run build проходит/);
    assert.match(raw, /- \[~\] Создать бакет — бакет example-ru/);
    assert.match(raw, /- Сервис · email: NotiSend — письма с сайта/);

    const reopened = await readDeployPlan(root);
    assert.deepEqual(reopened.steps, written.steps);
    assert.equal(reopened.updatedAt, written.updatedAt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deploy_project.md: перечитывает файл, написанный вручную, и понимает статусы", async () => {
  const root = await project({
    [DEPLOY_PLAN_FILE]: [
      "# План развёртывания",
      "",
      "## Развёртывание",
      "- Цель: staging",
      "- Тип: server",
      "- Провайдер: Yandex Cloud",
      "- Домен: stage.example.ru",
      "- Обновлено: 2026-10-24T10:00:00.000Z",
      "- Сервис · database: Yandex Managed PostgreSQL — PostgreSQL 16",
      "",
      "## Шаги",
      "",
      "- [x] Собрать проект — сборка проходит",
      "- [>] Создать базу — кластер создаётся",
      "- [!] Подтвердить домен — кабинет REG.RU, https://help.reg.ru/",
      "- [-] Проверить SMS — сервис не нужен",
    ].join("\n"),
  });
  try {
    const plan = await readDeployPlan(root);
    assert.equal(plan.exists, true);
    assert.equal(plan.goal, "staging");
    assert.equal(plan.target.kind, "server");
    assert.equal(plan.target.provider, "Yandex Cloud");
    assert.equal(plan.services[0]?.provider, "Yandex Managed PostgreSQL");
    assert.equal(plan.total, 4);
    assert.equal(plan.done, 1);
    assert.equal(plan.complete, false);
    assert.equal(plan.current?.title, "Создать базу");
    assert.equal(plan.blocked.length, 1);
    assert.equal(plan.blocked[0]?.note, "кабинет REG.RU, https://help.reg.ru/");
    assert.equal(plan.steps[3]?.status, "skipped");
    assert.equal(plan.updatedAt, "2026-10-24T10:00:00.000Z");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deploy_project.md: отсутствующий файл — это пустой план, а не ошибка", async () => {
  const root = await project();
  try {
    const plan = await readDeployPlan(root);
    assert.equal(plan.exists, false);
    assert.equal(plan.total, 0);
    assert.equal(plan.complete, false);
    assert.equal(deployPlanNotice(plan), "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("deploy.plan: один текущий шаг, уникальные заголовки и разделитель в заголовке не ломают чтение", async () => {
  const steps = normalizeDeploySteps([
    { title: "Создать базу — Timeweb", status: "in_progress", note: "PG 16" },
    { title: "Настроить домен", status: "in_progress" },
    { title: "Проверить сайт", status: "done" },
  ]);
  assert.equal(steps[0]?.title, "Создать базу – Timeweb");
  assert.equal(steps[0]?.status, "in_progress");
  assert.equal(steps[1]?.status, "pending", "второй in_progress становится ожидающим");
  assert.equal(steps[2]?.status, "done");

  const parsed = parseDeployPlan("- [~] Создать базу – Timeweb — PG 16");
  assert.equal(parsed.steps[0]?.title, "Создать базу – Timeweb");
  assert.equal(parsed.steps[0]?.note, "PG 16");

  assert.throws(() => normalizeDeploySteps([]), /не может быть пустым/);
  assert.throws(() => normalizeDeploySteps([{ title: "Шаг" }, { title: "шаг" }]), /не должны повторяться/);
  assert.throws(() => normalizeDeploySteps([{ title: "" }]), /должен быть заголовок/);
});

test("deploy.plan: без параметров файл остаётся читаемым и честно говорит об этом", async () => {
  const root = await project();
  try {
    const plan = await writeDeployPlan(root, { steps: [{ title: "Проверить сборку" }] });
    assert.equal(plan.goal, undefined);
    assert.deepEqual(plan.services, []);
    const raw = await readFile(path.join(root, DEPLOY_PLAN_FILE), "utf8");
    assert.match(raw, /- Параметры не заданы/);
    assert.match(raw, /- \[ \] Проверить сборку/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("сводка для контекста: незавершённый план показывает прогресс, текущий шаг и блокер", async () => {
  const plan = parseDeployPlan([
    "- Цель: production",
    "- Тип: server",
    "- Провайдер: Timeweb Cloud",
    "- Домен: example.ru",
    "- Сервис · database: Timeweb Cloud PostgreSQL",
    "",
    "- [x] Собрать проект",
    "- [x] Создать базу",
    "- [~] Настроить DATABASE_URL",
    "- [!] Подтвердить домен — кабинет REG.RU, https://help.reg.ru/",
    "- [ ] Проверить сайт",
  ].join("\n"));
  const notice = deployPlanNotice(plan);
  assert.match(notice, /durable bookmark/);
  assert.match(notice, /Progress: 2 of 5 done; blocked: 1; current: "Настроить DATABASE_URL"/);
  assert.match(notice, /Goal\/target: production · server · Timeweb Cloud · example.ru/);
  assert.match(notice, /database — Timeweb Cloud PostgreSQL/);
  assert.match(notice, /\[blocked\] Подтвердить домен/);
  assert.match(notice, /Never create a resource whose step is already done/);
  assert.match(notice, /deploy\.status/);
});

test("сводка для контекста: завершённый план не занимает место шагами", () => {
  const plan = parseDeployPlan("- [x] Собрать проект\n- [x] Развернуть\n- [-] SMS не нужен");
  const notice = deployPlanNotice(plan);
  assert.match(notice, /is complete/);
  assert.match(notice, /do not recreate its resources/);
  assert.doesNotMatch(notice, /\[done\]/);
});

test("сводка для контекста: файл без шагов требует сначала составить план", () => {
  const plan = parseDeployPlan("# План развёртывания\n\n## Развёртывание\n- Цель: production\n");
  const notice = deployPlanNotice(plan);
  assert.match(notice, /exists but has no steps/);
  assert.match(notice, /deploy\.plan/);
});

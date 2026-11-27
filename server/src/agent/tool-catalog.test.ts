import test from "node:test";
import assert from "node:assert/strict";
import { selectToolNames } from "./tool-catalog.js";
import { getToolDefinitionsFor, registerTool } from "../tool-registry.js";

test("каталог разработчика всегда оставляет инструменты интеграций, но не деплой", () => {
  const names = selectToolNames({ mode: "developer", task: "поправь кнопку в существующем проекте" });
  assert.ok(names.includes("fs.read"));
  assert.ok(names.includes("fs.edit"));
  assert.ok(names.includes("agent.scout"));
  assert.ok(names.includes("image.view"), "локальное изображение можно показать главной модели напрямую");
  assert.ok(names.includes("ui.render"), "интерактивный интерфейс доступен обычному запуску");
  assert.ok(names.includes("seo.check"), "проверка SEO до публикации доступна обычному запуску");
  assert.ok(names.includes("net.request"), "внешний API нужен обычной задаче");
  assert.ok(names.includes("net.download"), "скачивание ассета нужен обычной задаче");
  assert.ok(names.includes("database.status"), "проверка базы нужна до кода хранения");
  assert.ok(names.includes("service.status"), "проверка интеграций нужна до просьбы о ключе");
  assert.ok(names.includes("yandex.request"), "подключённый Yandex Cloud не должен зависеть от слов в короткой реплике");
  assert.ok(names.includes("cloud.request"), "подключённое облако доступно в любом запуске");
  assert.ok(names.includes("domain.request"), "подключённый регистратор доступен в любом запуске");
  assert.ok(!names.includes("web.search"), "поиск выключен по умолчанию");
  assert.ok(!names.includes("browser.runtime"), "Chromium выключен по умолчанию");
  assert.ok(!names.includes("deploy.plan"), "деплой не нужен обычной правке");
  assert.ok(!names.includes("expo.build"), "Expo не нужен обычному сайту");
  assert.ok(!names.includes("repo.map"), "карта репозитория выключена по умолчанию");
  assert.ok(!names.includes("project.test"), "тестовый контур выключен по умолчанию");
  assert.ok(!names.includes("project.memory"), "архитектурная память выключена по умолчанию");
  assert.ok(!names.includes("plan.milestones"), "milestone-план выключен по умолчанию");
  assert.equal(new Set(names).size, names.length, "имена не повторяются");
});

test("переключатели и задача добавляют только нужные группы", () => {
  const web = selectToolNames({ mode: "developer", task: "найди документацию", webSearch: true });
  assert.ok(web.includes("web.search") && web.includes("web.read"));
  const browser = selectToolNames({ mode: "developer", task: "проверь клик", browserCheck: true });
  assert.ok(browser.includes("browser.runtime") && browser.includes("browser.scenario"));
  const deploy = selectToolNames({ mode: "developer", task: "задеплой сайт на Yandex Cloud" });
  assert.ok(deploy.includes("deploy.plan") && deploy.includes("cloud.request") && deploy.includes("yandex.request"));
  const mobile = selectToolNames({ mode: "developer", task: "собери мобильное приложение на Expo" });
  assert.ok(mobile.includes("expo.build") && mobile.includes("expo.setup"));
  // Проект-приложение получает сборку и без слова Expo в короткой реплике.
  const byProject = selectToolNames({ mode: "developer", task: "собери приложение", mobileProject: true });
  assert.ok(byProject.includes("expo.build") && byProject.includes("expo.status"));
  // Незавершённый план деплоя важнее формулировки: «продолжай» — это продолжение работы.
  const byPlan = selectToolNames({ mode: "developer", task: "продолжай", deployPlanActive: true });
  for (const name of ["deploy.status", "deploy.plan", "deploy.check", "access.request"]) {
    assert.ok(byPlan.includes(name), "план деплоя должен давать " + name);
  }
  const noPlan = selectToolNames({ mode: "developer", task: "продолжай" });
  assert.ok(!noPlan.includes("deploy.status"), "без плана и без слов деплой не выдаётся");
  const notMobile = selectToolNames({ mode: "developer", task: "собери приложение" });
  assert.ok(!notMobile.includes("expo.build"), "обычный сайт не получает Expo");
  // `ios` без границ слова матчил portfolios, scenarios, studios, radios и выдавал мобильные схемы.
  for (const word of ["portfolios", "scenarios", "studios", "radios"]) {
    const names = selectToolNames({ mode: "developer", task: "сделай лендинг с " + word });
    assert.ok(!names.includes("expo.build"), word + " не должен включать Expo");
  }
  const ios = selectToolNames({ mode: "developer", task: "собери приложение для ios" });
  assert.ok(ios.includes("expo.build"), "настоящий ios остаётся мобильным");
  const repo = selectToolNames({ mode: "developer", task: "найди заказы", repoMap: true });
  assert.ok(repo.includes("repo.map") && repo.includes("repo.find"));
  const tests = selectToolNames({ mode: "developer", task: "проверь тесты", testRunner: true });
  assert.ok(tests.includes("project.test"));
  const memory = selectToolNames({ mode: "developer", task: "прочитай архитектуру", archMemory: true });
  assert.ok(memory.includes("project.memory"));
  const milestones = selectToolNames({ mode: "developer", task: "большая задача", milestones: true });
  assert.ok(milestones.includes("plan.milestones"));
});

test("планировщик не получает схемы изменяющих инструментов", () => {
  const names = selectToolNames({ mode: "planner", task: "составь план рефакторинга" });
  assert.ok(names.includes("fs.read"));
  assert.ok(names.includes("plan.update"));
  assert.ok(names.includes("seo.check"), "планировщик может проверить SEO: инструмент только читает");
  assert.ok(!names.includes("plan.milestones"), "milestone-план планировщика выключен по умолчанию");
  for (const name of ["fs.write", "fs.edit", "git.commit", "preview.start", "project.check", "image.generate", "database.env", "service.env", "net.download", "cloud.request", "domain.request"]) {
    assert.ok(!names.includes(name), "планировщик не должен видеть " + name);
  }
  // Задача про деплой добавляет группу, но запись секретов остаётся запрещённой и там.
  const deployPlan = selectToolNames({ mode: "planner", task: "подключи базу данных и задеплой сайт", testRunner: true });
  assert.ok(deployPlan.includes("database.status"));
  assert.ok(!deployPlan.includes("database.env") && !deployPlan.includes("service.env"));
  assert.ok(!deployPlan.includes("project.test"), "планировщик не запускает тесты");
  const milestonePlan = selectToolNames({ mode: "planner", task: "разбей большую задачу", milestones: true });
  assert.ok(milestonePlan.includes("plan.milestones"), "планировщик может составить milestone-план");
});

test("getToolDefinitionsFor отдаёт только выбранные схемы", () => {
  registerTool({ name: "catalog.test", description: "тестовая схема", parameters: { type: "object" } });
  const definitions = getToolDefinitionsFor(["catalog.test"]);
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0]?.function.name, "catalog.test");
  assert.equal(getToolDefinitionsFor([]).length, 0);
});

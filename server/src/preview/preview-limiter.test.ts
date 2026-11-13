import test from "node:test";
import assert from "node:assert/strict";
import {
  containerRuntimeUnits,
  decideRuntimePreviewStart,
  describePreviewLimits,
  hybridPreviewLimit,
  perUserPreviewLimit,
  previewRuntimeLimits,
  runtimeHostUnits,
  runtimePreviewLimit,
} from "./preview-limiter.js";
import type { RuntimeLimits } from "./preview-capacity.js";
import type { PreviewMode } from "./types.js";

const live = (projectId: string, userId: string, lastUsedAt: number, mode: PreviewMode = "container", node?: string) => ({
  projectId,
  userId,
  lastUsedAt,
  mode,
  node,
});

const production: RuntimeLimits = {
  containerLimit: 2,
  hybridLimit: 8,
  hostUnits: 12,
  containerUnits: 6,
};

const unlimited: RuntimeLimits = {
  containerLimit: 0,
  hybridLimit: 0,
  hostUnits: 0,
  containerUnits: 1,
};

/** Сохранить окружение вокруг теста: переменные лимитов читаются функциями, а не аргументами. */
function withEnv(values: Record<string, string | undefined>, run: () => void) {
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("один аккаунт держит один runtime-предпросмотр: второй останавливает свой же первый", () => {
  const decision = decideRuntimePreviewStart({
    live: [live("old", "user-1", 100), live("other", "user-2", 900)],
    projectId: "new",
    userId: "user-1",
    limits: unlimited,
  });
  assert.deepEqual(decision, { ok: true, stopProjectId: "old" });
});

test("предпросмотр другого пользователя не мешает и не останавливается", () => {
  const decision = decideRuntimePreviewStart({
    live: [live("a", "user-1", 100), live("b", "user-2", 200)],
    projectId: "c",
    userId: "user-3",
    limits: unlimited,
  });
  assert.deepEqual(decision, { ok: true });
});

test("перезапуск своего же проекта не считается новым предпросмотром", () => {
  const decision = decideRuntimePreviewStart({
    live: [live("a", "user-1", 100), live("a", "user-1", 100)],
    projectId: "a",
    userId: "user-1",
    limits: production,
  });
  assert.deepEqual(decision, { ok: true });
});

test("лимит на аккаунт больше одного: третий предпросмотр останавливает самый старый", () => {
  const decision = decideRuntimePreviewStart({
    live: [live("first", "user-1", 100), live("second", "user-1", 500)],
    projectId: "third",
    userId: "user-1",
    perUser: 2,
    limits: unlimited,
  });
  assert.deepEqual(decision, { ok: true, stopProjectId: "first" });
});

test("лимит на аккаунт 0 снимает ограничение", () => {
  const decision = decideRuntimePreviewStart({
    live: [live("a", "user-1", 100), live("b", "user-1", 200)],
    projectId: "c",
    userId: "user-1",
    perUser: 0,
    limits: unlimited,
  });
  assert.deepEqual(decision, { ok: true });
});

test("явный 0 снимает все потолки хоста", () => {
  const decision = decideRuntimePreviewStart({
    live: [live("a", "user-1", 1), live("b", "user-2", 2), live("c", "user-3", 3), live("d", "user-4", 4)],
    projectId: "new",
    userId: "user-5",
    limits: unlimited,
  });
  assert.deepEqual(decision, { ok: true });
});

test("потолок Docker отвечает причиной, а не остановкой чужого приложения", () => {
  const decision = decideRuntimePreviewStart({
    live: [live("a", "user-1", 100), live("b", "user-2", 200)],
    projectId: "d",
    userId: "user-4",
    limits: production,
  });
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.match(decision.reason, /PREVIEW_MAX_CONTAINERS/);
  assert.match(decision.reason, /2 контейнерных/);
});

test("2 Docker оставляют ноль hybrid-слотов", () => {
  const decision = decideRuntimePreviewStart({
    live: [live("a", "user-1", 100), live("b", "user-2", 200)],
    projectId: "hybrid",
    userId: "user-3",
    mode: "hybrid",
    limits: production,
  });
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.match(decision.reason, /12 из 12 слотов/);
});

test("1 Docker + 6 hybrid помещаются, 1 Docker + 7 hybrid — нет", () => {
  const oneDockerFiveHybrid = [
    live("docker", "user-1", 100),
    ...Array.from({ length: 5 }, (_, index) =>
      live("hybrid-" + index, "user-" + (index + 2), 200 + index, "hybrid"),
    ),
  ];
  const fits = decideRuntimePreviewStart({
    live: oneDockerFiveHybrid,
    projectId: "new-hybrid",
    userId: "user-30",
    mode: "hybrid",
    limits: production,
  });
  assert.deepEqual(fits, { ok: true });

  const over = decideRuntimePreviewStart({
    live: [
      ...oneDockerFiveHybrid,
      live("hybrid-5", "user-40", 300, "hybrid"),
    ],
    projectId: "new-hybrid",
    userId: "user-30",
    mode: "hybrid",
    limits: production,
  });
  assert.equal(over.ok, false);
  if (over.ok) return;
  assert.match(over.reason, /12 из 12 слотов/);
});

test("8 hybrid помещаются, девятый отклоняется отдельным лимитом", () => {
  const eight = Array.from({ length: 8 }, (_, index) =>
    live("hybrid-" + index, "user-" + (index + 1), 100 + index, "hybrid"),
  );
  const ninth = decideRuntimePreviewStart({
    live: eight,
    projectId: "hybrid-9",
    userId: "user-9",
    mode: "hybrid",
    limits: production,
  });
  assert.equal(ninth.ok, false);
  if (ninth.ok) return;
  assert.match(ninth.reason, /PREVIEW_MAX_HYBRID/);
});

test("потолок хоста не считает preview другой реплики", () => {
  const decision = decideRuntimePreviewStart({
    live: [
      live("a", "user-1", 100, "container", "node-2"),
      live("b", "user-2", 200, "container", "node-2"),
    ],
    projectId: "new",
    userId: "user-3",
    node: "node-1",
    limits: production,
  });
  assert.deepEqual(decision, { ok: true });
});

test("предпросмотр без владельца никогда не останавливается за чужой счёт", () => {
  const decision = decideRuntimePreviewStart({
    live: [live("orphan", "", 100), live("b", "user-2", 200)],
    projectId: "d",
    userId: "",
    limits: unlimited,
  });
  assert.deepEqual(decision, { ok: true }, "пустой userId ничего не присваивает");
});

test("окружение: по умолчанию один предпросмотр на аккаунт и потолок по памяти", () => {
  withEnv(
    {
      PREVIEW_MAX_PER_USER: undefined,
      PREVIEW_MAX_CONTAINERS: undefined,
      PREVIEW_MAX_HYBRID: undefined,
      PREVIEW_HOST_UNITS: undefined,
      PREVIEW_CONTAINER_UNITS: undefined,
    },
    () => {
      assert.equal(perUserPreviewLimit(), 1);
      assert.ok(runtimePreviewLimit() >= 1, "потолок хоста обязан быть конечным");
      assert.equal(hybridPreviewLimit(), runtimePreviewLimit());
      assert.equal(runtimeHostUnits(), runtimePreviewLimit());
      assert.equal(containerRuntimeUnits(), 1);
      assert.match(describePreviewLimits(), /Docker: \d+/);
    },
  );
});

test("окружение: отдельные лимиты, общий бюджет и вес Docker читаются", () => {
  withEnv(
    {
      PREVIEW_MAX_PER_USER: "2",
      PREVIEW_MAX_CONTAINERS: "2",
      PREVIEW_MAX_HYBRID: "8",
      PREVIEW_HOST_UNITS: "12",
      PREVIEW_CONTAINER_UNITS: "6",
    },
    () => {
      assert.equal(perUserPreviewLimit(), 2);
      assert.equal(runtimePreviewLimit(), 2);
      assert.equal(hybridPreviewLimit(), 8);
      assert.equal(runtimeHostUnits(), 12);
      assert.equal(containerRuntimeUnits(), 6);
      assert.deepEqual(previewRuntimeLimits(), production);
      assert.equal(
        describePreviewLimits(),
        "предпросмотров на аккаунт: 2; Docker: 2 (вес 6); hybrid: 8; слотов на ноде: 12",
      );
    },
  );
});

test("если задан только hybrid-потолок, вес Docker выводится из него", () => {
  withEnv(
    {
      PREVIEW_MAX_CONTAINERS: "2",
      PREVIEW_MAX_HYBRID: "8",
      PREVIEW_HOST_UNITS: undefined,
      PREVIEW_CONTAINER_UNITS: undefined,
    },
    () => {
      assert.equal(runtimeHostUnits(), 8);
      assert.equal(containerRuntimeUnits(), 4);
    },
  );
});

test("окружение: 0 снимает ограничения, мусор возвращает безопасные значения", () => {
  withEnv(
    {
      PREVIEW_MAX_PER_USER: "0",
      PREVIEW_MAX_CONTAINERS: "0",
      PREVIEW_MAX_HYBRID: "0",
      PREVIEW_HOST_UNITS: "0",
      PREVIEW_CONTAINER_UNITS: "0",
    },
    () => {
      assert.equal(perUserPreviewLimit(), 0);
      assert.equal(runtimePreviewLimit(), 0);
      assert.equal(hybridPreviewLimit(), 0);
      assert.equal(runtimeHostUnits(), 0);
      assert.equal(containerRuntimeUnits(), 1, "нулевой вес Docker опасен: возвращаем 1");
    },
  );
  withEnv(
    {
      PREVIEW_MAX_CONTAINERS: "мусор",
      PREVIEW_MAX_HYBRID: "-1",
      PREVIEW_HOST_UNITS: "мусор",
      PREVIEW_CONTAINER_UNITS: "мусор",
    },
    () => {
      assert.ok(runtimePreviewLimit() >= 1);
      assert.equal(hybridPreviewLimit(), runtimePreviewLimit());
      assert.ok(runtimeHostUnits() >= 1);
      assert.equal(containerRuntimeUnits(), 1);
    },
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  projectArchiveConcurrency,
  projectArchiveDiskHighPercent,
  projectArchiveDiskTargetPercent,
  projectArchiveIdleMs,
  selectArchiveCandidates,
  sweepIdleProjects,
  type ArchiveSweepDeps,
} from "./archive-scheduler.js";

/**
 * Порог простоя читается из окружения при каждом вызове, поэтому тест может переставлять
 * переменные и не зависеть от того, что лежит в рабочем .env. Дни сохранены ради установок,
 * которые настроили холодный ярус до появления минут.
 */
function withEnv(values: { minutes?: string; days?: string }, action: () => void) {
  const savedMinutes = process.env.PROJECT_ARCHIVE_IDLE_MINUTES;
  const savedDays = process.env.PROJECT_ARCHIVE_IDLE_DAYS;
  try {
    if (values.minutes === undefined) delete process.env.PROJECT_ARCHIVE_IDLE_MINUTES;
    else process.env.PROJECT_ARCHIVE_IDLE_MINUTES = values.minutes;
    if (values.days === undefined) delete process.env.PROJECT_ARCHIVE_IDLE_DAYS;
    else process.env.PROJECT_ARCHIVE_IDLE_DAYS = values.days;
    action();
  } finally {
    if (savedMinutes === undefined) delete process.env.PROJECT_ARCHIVE_IDLE_MINUTES;
    else process.env.PROJECT_ARCHIVE_IDLE_MINUTES = savedMinutes;
    if (savedDays === undefined) delete process.env.PROJECT_ARCHIVE_IDLE_DAYS;
    else process.env.PROJECT_ARCHIVE_IDLE_DAYS = savedDays;
  }
}

async function withArchiveEnv(
  values: { high?: string; target?: string; concurrency?: string; guard?: string },
  action: () => void | Promise<void>,
) {
  const names = {
    high: "PROJECT_ARCHIVE_DISK_HIGH_PERCENT",
    target: "PROJECT_ARCHIVE_DISK_TARGET_PERCENT",
    concurrency: "PROJECT_ARCHIVE_CONCURRENCY",
    guard: "PROJECT_ARCHIVE_ACCESS_GUARD_MS",
  } as const;
  const saved = Object.fromEntries(Object.values(names).map(name => [name, process.env[name]]));
  try {
    for (const [key, name] of Object.entries(names)) {
      const value = values[key as keyof typeof values];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await action();
  } finally {
    for (const name of Object.values(names)) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("по умолчанию проект уходит в бакет после трёх часов простоя", () => {
  withEnv({}, () => {
    assert.equal(projectArchiveIdleMs(), 3 * 60 * 60 * 1000);
  });
});

test("минуты важнее дней: старое значение в .env не перебивает новое", () => {
  withEnv({ minutes: "90", days: "14" }, () => {
    assert.equal(projectArchiveIdleMs(), 90 * 60 * 1000);
  });
});

test("старый PROJECT_ARCHIVE_IDLE_DAYS продолжает работать", () => {
  withEnv({ days: "2" }, () => {
    assert.equal(projectArchiveIdleMs(), 2 * 24 * 60 * 60 * 1000);
  });
});

test("порог не опускается ниже минуты", () => {
  withEnv({ minutes: "0" }, () => {
    assert.equal(projectArchiveIdleMs(), 60 * 1000);
  });
});

test("давление на диск: пороги 75/68 и цель всегда ниже срабатывания", async () => {
  await withArchiveEnv({}, () => {
    assert.equal(projectArchiveDiskHighPercent(), 75);
    assert.equal(projectArchiveDiskTargetPercent(), 68);
    assert.equal(projectArchiveConcurrency(), 2);
  });
  await withArchiveEnv({ high: "80", target: "85" }, () => {
    assert.equal(projectArchiveDiskTargetPercent(), 79, "цель не может быть выше порога");
  });
  await withArchiveEnv({ high: "80", target: "60", concurrency: "99" }, () => {
    assert.equal(projectArchiveDiskTargetPercent(), 60);
    assert.equal(projectArchiveConcurrency(), 4, "параллелизм ограничен четырьмя архивами");
  });
  await withArchiveEnv({ concurrency: "0" }, () => {
    assert.equal(projectArchiveConcurrency(), 1, "ноль параллельных архивов бессмысленен");
  });
});

test("отбор: недавно открытый проект не архивируется, старые идут первыми", () => {
  const now = Date.parse("2026-10-30T12:00:00.000Z");
  const base = {
    userId: "user",
    sizeBytes: 1000,
    lastWriteMs: now - 5 * 60 * 60 * 1000,
    lastAccessMs: 0,
    active: false,
    preview: false,
    archived: false,
    workspace: true,
  };
  const candidates = selectArchiveCandidates(
    [
      { ...base, projectId: "oldest", lastWriteMs: now - 9 * 60 * 60 * 1000 },
      { ...base, projectId: "younger", lastWriteMs: now - 4 * 60 * 60 * 1000 },
      { ...base, projectId: "opened-10-min-ago", lastAccessMs: now - 10 * 60 * 1000 },
      { ...base, projectId: "just-written", lastWriteMs: now - 20 * 60 * 1000 },
      { ...base, projectId: "agent-running", active: true },
      { ...base, projectId: "preview-alive", preview: true },
      { ...base, projectId: "already-archived", archived: true },
      { ...base, projectId: "workspace-lost", workspace: false },
    ],
    { now, idleMs: 3 * 60 * 60 * 1000, accessGuardMs: 60 * 60 * 1000 },
  );
  assert.deepEqual(candidates.map(candidate => candidate.projectId), ["oldest", "younger"]);
});

function sweepDeps(options: {
  projects: Array<{ id: string; userId: string }>;
  sizes: Map<string, { sizeBytes: number; updatedAt: string; lastWriteAt: string | null }>;
  disk: { usedPercent: number };
  archive: (projectId: string) => Promise<{ alreadyArchived: boolean; bytes: number }>;
  now: number;
}): Partial<ArchiveSweepDeps> {
  return {
    hasStore: () => true,
    listProjects: async () => options.projects,
    readSizes: async () => options.sizes,
    isProjectActive: () => false,
    hasPreview: () => false,
    lastProjectAccess: () => 0,
    archiveInfo: async () => null,
    workspaceExists: async () => true,
    archiveProject: (projectId, _userId) => options.archive(projectId),
    diskStatus: async () => ({
      path: "/sandboxes",
      totalMb: 100,
      freeMb: 100 - options.disk.usedPercent,
      usedPercent: options.disk.usedPercent,
    }),
    now: () => options.now,
    recordFailure: () => {},
  };
}

test("при заполненном диске архивирует самых старых до цели и не трогает остальные", async () => {
  await withArchiveEnv({ concurrency: "1", guard: "3600000" }, async () => {
    const now = Date.parse("2026-10-30T12:00:00.000Z");
    const projects = [
      { id: "p1", userId: "u" },
      { id: "p2", userId: "u" },
      { id: "p3", userId: "u" },
    ];
    const sizes = new Map(
      projects.map((project, index) => [
        project.id,
        {
          sizeBytes: 1000,
          updatedAt: new Date(now - (10 - index) * 60 * 60 * 1000).toISOString(),
          lastWriteAt: new Date(now - (10 - index) * 60 * 60 * 1000).toISOString(),
        },
      ]),
    );
    const disk = { usedPercent: 78 };
    const archived: string[] = [];
    const result = await sweepIdleProjects(3 * 60 * 60 * 1000, {
      deps: sweepDeps({
        projects,
        sizes,
        disk,
        now,
        archive: async projectId => {
          archived.push(projectId);
          disk.usedPercent = projectId === "p1" ? 72 : 66;
          return { alreadyArchived: false, bytes: 1000 };
        },
      }),
    });

    assert.equal(result.mode, "pressure");
    assert.equal(result.candidates, 3);
    assert.deepEqual(archived, ["p1", "p2"]);
    assert.equal(result.archived, 2);
    assert.equal(result.deferred, 1);
    assert.equal(result.diskAfter, 66);
    assert.equal(result.targetPercent, 68);
    assert.equal(result.targetReached, true);
  });
});

test("без давления на диск обычный обход архивирует все подходящие проекты параллельно", async () => {
  await withArchiveEnv({ concurrency: "2", guard: "3600000" }, async () => {
    const now = Date.parse("2026-10-30T12:00:00.000Z");
    const projects = [
      { id: "p1", userId: "u" },
      { id: "p2", userId: "u" },
    ];
    const sizes = new Map(
      projects.map(project => [
        project.id,
        {
          sizeBytes: 1000,
          updatedAt: new Date(now - 8 * 60 * 60 * 1000).toISOString(),
          lastWriteAt: new Date(now - 8 * 60 * 60 * 1000).toISOString(),
        },
      ]),
    );
    const archived: string[] = [];
    const result = await sweepIdleProjects(3 * 60 * 60 * 1000, {
      deps: sweepDeps({
        projects,
        sizes,
        disk: { usedPercent: 50 },
        now,
        archive: async projectId => {
          archived.push(projectId);
          return { alreadyArchived: false, bytes: 1000 };
        },
      }),
    });

    assert.equal(result.mode, "idle");
    assert.equal(result.candidates, 2);
    assert.deepEqual(archived.sort(), ["p1", "p2"]);
    assert.equal(result.archived, 2);
    assert.equal(result.deferred, 0);
    assert.equal(result.targetPercent, null);
  });
});

test("проверка давления без высокой занятости не делает полный обход", async () => {
  await withArchiveEnv({}, async () => {
    const now = Date.parse("2026-10-30T12:00:00.000Z");
    let listed = 0;
    const result = await sweepIdleProjects(3 * 60 * 60 * 1000, {
      pressureOnly: true,
      deps: {
        ...sweepDeps({
          projects: [{ id: "p1", userId: "u" }],
          sizes: new Map(),
          disk: { usedPercent: 40 },
          now,
          archive: async () => ({ alreadyArchived: false, bytes: 1 }),
        }),
        listProjects: async () => {
          listed++;
          return [];
        },
      },
    });
    assert.equal(listed, 0);
    assert.equal(result.candidates, 0);
    assert.equal(result.mode, "idle");
  });
});

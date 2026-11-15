import test from "node:test";
import assert from "node:assert/strict";
import {
  currentMilestone,
  milestoneCheckpoint,
  milestoneProgress,
  milestoneStateLines,
  milestoneTransition,
  nextMilestone,
  normalizeMilestonePlan,
} from "./milestones.js";

function milestone(title: string, status?: "pending" | "in_progress" | "done") {
  return {
    title,
    scope: "Изменить " + title,
    files: ["src/" + title + ".ts"],
    tests: ["node --test " + title + ".test.ts"],
    definitionOfDone: title + " проверен",
    ...(status ? { status } : {}),
  };
}

test("milestone-план нормализует 3–7 этапов и делает первый текущим", () => {
  const plan = normalizeMilestonePlan({
    milestones: [milestone("Первый"), milestone("Второй"), milestone("Третий")],
  });
  assert.equal(plan.milestones?.length, 3);
  assert.equal(plan.milestones?.[0]?.status, "in_progress");
  assert.equal(plan.milestones?.[1]?.status, "pending");
  assert.equal(plan.items.length, 3);
  assert.equal(plan.items[0]?.title, "Первый");
  assert.equal(currentMilestone(plan)?.title, "Первый");
  assert.equal(nextMilestone(plan)?.title, "Второй");
});

test("завершённый milestone закрывает запуск, а следующий остаётся на новый", () => {
  const plan = normalizeMilestonePlan({
    milestones: [
      milestone("Первый", "done"),
      milestone("Второй", "pending"),
      milestone("Третий", "pending"),
    ],
  });
  assert.equal(plan.milestones?.find(item => item.title === "Второй")?.status, "pending");
  const checkpoint = milestoneCheckpoint(plan);
  assert.equal(checkpoint.closed, true);
  assert.equal(checkpoint.allDone, false);
  assert.equal(checkpoint.completed?.title, "Первый");
  assert.equal(checkpoint.next?.title, "Второй");
  assert.match(milestoneStateLines(plan).join("\n"), /Milestone 2\/3 \(pending\): Второй/);
});

test("все этапы done — это завершение плана, а не checkpoint с продолжением", () => {
  const plan = normalizeMilestonePlan({
    milestones: [
      milestone("Первый", "done"),
      milestone("Второй", "done"),
      milestone("Третий", "done"),
    ],
  });
  const checkpoint = milestoneCheckpoint(plan);
  assert.equal(checkpoint.closed, true);
  assert.equal(checkpoint.allDone, true);
  assert.equal(checkpoint.next, null);
  assert.deepEqual(milestoneProgress(plan), { done: 3, total: 3 });
  assert.match(milestoneStateLines(plan).join("\n"), /все этапы отмечены/);
});

test("количество, уникальность и один in_progress проверяются до запуска", () => {
  assert.throws(() => normalizeMilestonePlan({ milestones: [milestone("Один"), milestone("Два")] }), /от 3 до 7/);
  assert.throws(() => normalizeMilestonePlan({ milestones: Array.from({ length: 8 }, (_, index) => milestone("M" + index)) }), /от 3 до 7/);
  assert.throws(() => normalizeMilestonePlan({ milestones: [milestone("Один"), milestone("один"), milestone("Три")] }), /повторяется/);
  assert.throws(() => normalizeMilestonePlan({ milestones: [milestone("Один", "in_progress"), milestone("Два", "in_progress"), milestone("Три")] }), /только один/);
});

test("переход в следующий этап внутри запуска закрывает checkpoint, а resume — нет", () => {
  const initial = normalizeMilestonePlan({ milestones: [milestone("Первый"), milestone("Второй"), milestone("Третий")] });
  assert.equal(milestoneTransition(undefined, initial).closed, false);

  const completed = normalizeMilestonePlan({
    milestones: [milestone("Первый", "done"), milestone("Второй", "pending"), milestone("Третий", "pending")],
  });
  const closed = milestoneTransition(initial, completed);
  assert.equal(closed.closed, true);
  assert.equal(closed.advanced, false);

  const advanced = normalizeMilestonePlan({
    milestones: [milestone("Первый", "done"), milestone("Второй", "in_progress"), milestone("Третий", "pending")],
  });
  const sameRun = milestoneTransition(initial, advanced);
  assert.equal(sameRun.closed, true);
  assert.equal(sameRun.advanced, true);
  // Новый запуск видит второй этап уже текущим — это resume, а не завершение текущего.
  assert.equal(milestoneTransition(completed, advanced).closed, false);
});

test("пустые files, tests и definitionOfDone не проходят: milestone без проверки не milestone", () => {
  const broken = (patch: Record<string, unknown>) => ({
    milestones: [
      { ...milestone("Первый"), ...patch },
      milestone("Второй"),
      milestone("Третий"),
    ],
  });
  assert.throws(() => normalizeMilestonePlan(broken({ files: [] })), /files/);
  assert.throws(() => normalizeMilestonePlan(broken({ tests: [] })), /tests/);
  assert.throws(() => normalizeMilestonePlan(broken({ definitionOfDone: " " })), /definitionOfDone/);
  assert.throws(() => normalizeMilestonePlan(broken({ scope: "" })), /scope/);
});

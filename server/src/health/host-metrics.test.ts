import test from "node:test";
import assert from "node:assert/strict";
import { parseMeminfo } from "./host-metrics.js";

test("MemAvailable читается отдельно от MemFree", () => {
  const info = parseMeminfo([
    "MemTotal:       16384000 kB",
    "MemFree:         1048576 kB",
    "MemAvailable:    6291456 kB",
    "SwapTotal:       2097152 kB",
    "SwapFree:        1048576 kB",
  ].join("\n"));
  assert.equal(info.availableKb, 6_291_456);
  assert.equal(info.swapTotalKb, 2_097_152);
  assert.equal(info.swapFreeKb, 1_048_576);
});

test("старое ядро без MemAvailable не подменяется MemFree", () => {
  const info = parseMeminfo("MemTotal: 1024 kB\nMemFree: 512 kB\n");
  assert.equal(info.availableKb, null, "нет данных — это null, а не свободная память");
  assert.equal(info.swapTotalKb, null);
  assert.equal(info.swapFreeKb, null);
});

test("мусор в meminfo не превращается в число", () => {
  const info = parseMeminfo("MemAvailable: не число\nSwapTotal:\n");
  assert.equal(info.availableKb, null);
  assert.equal(info.swapTotalKb, null);
});

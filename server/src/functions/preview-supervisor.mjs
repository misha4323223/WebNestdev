/**
 * PID 1 для контейнера functions-preview.
 *
 * Docker broker production-контура запрещает `--restart`, поэтому автоперезапуск нельзя
 * оставить на Docker. Supervisor держит runtime дочерним процессом и поднимает его заново,
 * если тот упал, не меняя контейнер, адрес и listener. Это не обход broker'а: перезапускается
 * процесс внутри уже разрешённого контейнера.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const runtime = process.env.WEBNESTDEV_PREVIEW_RUNTIME || path.join(here, "runtime.mjs");
const MAX_RESTARTS = 3;
const WINDOW_MS = 60_000;
const RESTART_DELAY_MS = 300;

let child = null;
let stopping = false;
let restarts = [];
let restartTimer;

function start() {
  if (stopping) return;
  child = spawn(process.execPath, [runtime], { stdio: "inherit", env: process.env });
  child.once("exit", (code, signal) => {
    child = null;
    if (stopping) return;
    const now = Date.now();
    restarts = restarts.filter(time => now - time < WINDOW_MS);
    if (restarts.length >= MAX_RESTARTS) {
      console.error("[preview-functions] runtime падал " + (restarts.length + 1) + " раз за минуту, перезапуск остановлен");
      process.exit(1);
    }
    restarts.push(now);
    console.error("[preview-functions] runtime завершился (code=" + code + ", signal=" + signal + "), перезапуск");
    // Не unref: между падением и новым runtime нет других handles, и unref-таймер
    // позволил бы supervisor'у выйти вместо перезапуска.
    restartTimer = setTimeout(start, RESTART_DELAY_MS);
  });
  child.once("error", error => {
    console.error("[preview-functions] runtime не запустился: " + (error instanceof Error ? error.message : String(error)));
    if (!stopping) process.exit(1);
  });
}

function stop(signal) {
  if (stopping) return;
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  if (child) {
    child.kill(signal);
    const timer = setTimeout(() => {
      child?.kill("SIGKILL");
      process.exit(0);
    }, 5_000);
    timer.unref?.();
    child.once("exit", () => process.exit(0));
  } else {
    process.exit(0);
  }
}

for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => stop(signal));

start();

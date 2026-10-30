import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { SandboxConfig } from "./sandbox-manager.js";
import { dockerOptions } from "./sandbox/docker/options.js";
import type { SandboxRunOptions } from "./sandbox/host.js";
import { dockerRunArgs } from "./sandbox/docker/args.js";
import { dockerUnavailableMessage } from "./sandbox/docker/unavailable.js";
import { secretEnvMaskMounts } from "./sandbox/secret-mask.js";
import type { DockerCommandResult } from "./sandbox/docker/types.js";

export type { DockerCommandResult };

/**
 * Docker name of one command container. Имя, а не только отсутствие `-d`: если команду отменили
 * или она зависла, нужно чем-то её убить. `docker run` без имени оставляет случайное, которое
 * процесс-клиент уже не знает, если его самого убили.
 */
function containerName(projectId: string) {
  return ("wnd-cmd-" + projectId + "-" + randomUUID().slice(0, 8)).replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 120);
}

/** После гибели клиента контейнер надо убрать: `--rm` срабатывает только при его собственном выходе. */
function removeContainer(name: string) {
  try {
    const child = spawn("docker", ["rm", "-f", name], { stdio: "ignore", windowsHide: true });
    child.once("error", () => undefined);
  } catch {
    // Docker недоступен — контейнера и не было.
  }
}

export async function runDockerSandbox(config: SandboxConfig, command: string, cwd: string, runOptions: SandboxRunOptions = {}): Promise<DockerCommandResult> {
  // Отменённый запуск не должен даже пытаться поднять контейнер: иначе отмена ждёт Docker, а
  // `docker run` успевает создать контейнер, который потом приходится убивать отдельно.
  if (runOptions.signal?.aborted) throw Object.assign(new Error("Запуск агента отменён"), { name: "AbortError" });
  if ((process.env.SANDBOX_MODE ?? "docker") !== "docker") throw new Error("Выполнение команды на хосте отключено. Установите SANDBOX_MODE=docker.");
  const options = dockerOptions(config);
  const name = containerName(config.projectId);
  // Маска готовится до запуска: если секретный файл нельзя изолировать, команда не выполнится
  // вообще, вместо того чтобы выполниться с доступом к ключам.
  const masks = runOptions.maskSecretEnvFiles ? await secretEnvMaskMounts(config) : [];
  // Маски идут последними: если одна и та же точка появится в extraMounts, пустой read-only
  // файл должен победить. Сейчас эти режимы не пересекаются, но порядок сохраняет гарантию.
  const extraMounts = [...(runOptions.extraMounts ?? []), ...masks];
  const args = dockerRunArgs(config, cwd, options, command, runOptions.network ?? options.network, name, extraMounts, {}, runOptions.env ?? {});
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "", truncated = false;
    let finished = false;
    let interrupted = false;
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      const left = options.maxOutput - stdout.length - stderr.length;
      if (left <= 0) { truncated = true; return; }
      const value = chunk.toString();
      if (value.length > left) truncated = true;
      if (target === "stdout") stdout += value.slice(0, left); else stderr += value.slice(0, left);
    };
    child.stdout.on("data", (x: Buffer) => append("stdout", x));
    child.stderr.on("data", (x: Buffer) => append("stderr", x));

    const stop = () => {
      interrupted = true;
      // Сначала просим контейнер завершиться, потом убиваем клиента: иначе `docker run` успевает
      // сообщить «container started», а контейнер остаётся жить после убийства клиента.
      removeContainer(name);
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGTERM");
        setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1500).unref();
      }
    };
    const detach = () => {
      clearTimeout(timer);
      runOptions.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      detach();
      reject(error);
    };
    // Долгая сборка или тесты — не повод обрывать команду на двух минутах. Верхняя граница
    // остаётся у платформы, а вызывающий может попросить больше только в этих пределах.
    const timeoutMs = Math.min(30 * 60_000, Math.max(1_000, runOptions.timeoutMs ?? config.timeoutMs));
    const timer = setTimeout(() => {
      stop();
      fail(new Error("Превышено время выполнения команды в песочнице: " + Math.round(timeoutMs / 1000) + " с"));
    }, timeoutMs);
    const onAbort = () => {
      stop();
      fail(Object.assign(new Error("Запуск агента отменён"), { name: "AbortError" }));
    };
    if (runOptions.signal?.aborted) onAbort();
    else runOptions.signal?.addEventListener("abort", onAbort, { once: true });

    // Хост без Docker (или без прав на сокет демона): сообщение одно и то же для панели, лога и
    // модели — с объяснением, что доступно вместо контейнера.
    child.once("error", e => { stop(); fail(new Error(dockerUnavailableMessage(e))); });
    child.once("close", (code, signal) => {
      // Если команду отменили, клиент уже завершён, а контейнер мог не успеть получить `rm`:
      // повторная уборка после закрытия клиента не даёт осиротевшим контейнерам копиться.
      if (interrupted) removeContainer(name);
      if (finished) return;
      finished = true;
      detach();
      resolve({ ok: code === 0, exitCode: code, signal, stdout, stderr, truncated });
    });
  });
}

export async function sandboxStatus(): Promise<{ mode: string; available: boolean; reason?: string; detail?: string; dockerVersion?: string }> {
  const mode = process.env.SANDBOX_MODE ?? "docker";
  if (mode !== "docker") return { mode, available: false, reason: "Docker sandbox is required." };
  return new Promise(resolve => {
    const child = spawn("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (x: Buffer) => output += x.toString());
    // `/api/health` и `/api/ready` показывают эту причину: без неё «available:false» выглядит
    // как временная неисправность, хотя это отсутствие Docker на хосте.
    child.on("error", error => resolve({ mode, available: false, detail: dockerUnavailableMessage(error) }));
    child.on("close", code => resolve({ mode, available: code === 0, dockerVersion: code === 0 ? output.trim() : undefined }));
  });
}

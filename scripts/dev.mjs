import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

/** Значение `--name value` или `--name=value` из argv — так флаги передаёт `npm run dev -- …`. */
function argValue(argv, name) {
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--" + name) return argv[index + 1];
    if (value.startsWith("--" + name + "=")) return value.slice(name.length + 3);
  }
  return undefined;
}

/**
 * Где слушать веб-части приложения.
 *
 * Предпросмотр платформы запускает `npm run dev -- --host 0.0.0.0 --port 3000` и ждёт приложение
 * именно на этом порту. Раньше флаги до Vite не доходили: он слушал 5173, жёстко записанный в
 * `dev:web`, а платформа стучалась в пустой 3000 — приложение было живым и собранным, а в панели
 * белый экран и «Прокси предпросмотра не сработал». Поэтому порт разбирается здесь и передаётся
 * Vite явно; без флагов остаётся прежнее поведение (0.0.0.0:5173, или PORT из окружения).
 */
export function devTarget(argv, env = process.env) {
  const host = argValue(argv, "host") || "0.0.0.0";
  const raw = argValue(argv, "port") || env.PORT || "5173";
  const port = Number.parseInt(raw, 10);
  return { host, port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 5173 };
}

function main() {
  const target = devTarget(process.argv.slice(2));
  // Обычно Vite слушает 5173, а API — 8787 (на него смотрит прокси в vite.config.ts). Но платформа
  // может отдать 8787 самому веб-интерфейсу; тогда API встаёт рядом (8789, оставляя 8788 двери
  // публичных предпросмотров), и Vite получает его порт через VITE_API_PORT. Иначе оба процесса
  // занимали бы 8787 и API падал бы с EADDRINUSE — ровно то, что ломало предпросмотр.
  const apiPort = target.port === 8787 ? "8789" : "8787";
  const commands = [
    { name: "WEB", args: ["run", "dev:web", "--", "--host", target.host, "--port", String(target.port)], env: { ...process.env, VITE_API_PORT: apiPort } },
    { name: "API", args: ["run", "dev:server"], env: { ...process.env, PORT: apiPort } },
  ];
  const children = commands.map(({ name, args, env }) => {
    const child = spawn(npm, args, { stdio: "inherit", shell: false, env });
    child.on("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      if (code && code !== 0) shutdown(code);
    });
    child.on("error", error => {
      console.error("[" + name + "] failed to start:", error.message);
      shutdown(1);
    });
    return child;
  });
  let stopping = false;
  function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    for (const child of children) if (!child.killed) child.kill("SIGTERM");
    process.exitCode = code;
  }
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
}

// Импорт модуля (например, проверкой разбора флагов) не должен поднимать серверы.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

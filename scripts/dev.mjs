import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
// Vite проксирует /api на 8787 (vite.config.ts), поэтому API в разработке всегда слушает этот
// порт. Иначе в среде, которая задаёт PORT для веб-сервера (например 5173), API пытался бы занять
// тот же порт, что и Vite, и падал бы с EADDRINUSE.
const commands = [
  { name: "WEB", args: ["run", "dev:web"], env: process.env },
  { name: "API", args: ["run", "dev:server"], env: { ...process.env, PORT: "8787" } },
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

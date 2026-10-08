import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const commands = [
  { name: "WEB", args: ["run", "dev:web"] },
  { name: "API", args: ["run", "dev:server"] },
];
const children = commands.map(({ name, args }) => {
  const child = spawn(npm, args, { stdio: "inherit", shell: false, env: process.env });
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

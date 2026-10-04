import { spawn } from "node:child_process";
import path from "node:path";
import { getProject } from "../project-store.js";
import { registerTool } from "../tool-registry.js";

const sandboxRoot = path.resolve(process.env.WEBNESTDEV_SANDBOX_DIR ?? ".webnestdev/sandboxes");
const timeoutMs = Number(process.env.TOOL_COMMAND_TIMEOUT_MS ?? 120000);
const maxOutput = Number(process.env.TOOL_COMMAND_MAX_OUTPUT ?? 200000);

function projectRoot(projectId: string) {
  return path.join(sandboxRoot, projectId);
}

function validateCommand(command: string) {
  if (!command.trim()) throw new Error("command is required");
  if (command.includes("\0")) throw new Error("Invalid command");
}

registerTool({
  name: "terminal.exec",
  description: "Execute a development command inside the current project sandbox. Input: {command:string, cwd?:string}. Commands run without host shell privileges and are subject to timeout/output limits.",
  async execute(input, context) {
    if (!await getProject(context.projectId)) throw new Error("Project not found");
    const value = input as { command?: string; cwd?: string };
    const command = value.command ?? "";
    validateCommand(command);

    const root = projectRoot(context.projectId);
    const cwd = path.resolve(root, value.cwd || ".");
    if (cwd !== root && !cwd.startsWith(root + path.sep)) throw new Error("cwd escapes project sandbox");

    return await new Promise((resolve, reject) => {
      const child = spawn(process.platform === "win32" ? "cmd.exe" : "/bin/sh",
        process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command],
        { cwd, env: { ...process.env, HOME: root, WEBNESTDEV_PROJECT_ID: context.projectId }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
      );

      let stdout = "";
      let stderr = "";
      let truncated = false;
      const append = (target: "stdout" | "stderr", chunk: Buffer) => {
        const text = chunk.toString();
        if ((stdout.length + stderr.length) >= maxOutput) { truncated = true; return; }
        const remaining = maxOutput - stdout.length - stderr.length;
        if (target === "stdout") stdout += text.slice(0, remaining);
        else stderr += text.slice(0, remaining);
      };
      child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, exitCode: code, signal, stdout, stderr, truncated });
      });
    });
  },
});
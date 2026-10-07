import { getSandbox, assertInsideSandbox } from "../sandbox-manager.js";
import { runInSandbox } from "../sandbox-worker.js";
import { registerTool } from "../tool-registry.js";

registerTool({
  name: "terminal.exec",
  description: "Execute a development command in the project's sandbox. Input: {command:string,cwd?:string}. Network is disabled by default.",
  async (input, context) {
    const value = input as { command?: string; cwd?: string };
    const command = value.command?.trim();
    if (!command) throw new Error("command is required");

    const sandbox = await getSandbox(context.projectId, context.userId);
    const cwd = assertInsideSandbox(
      sandbox.root,
      sandbox.root + "/" + (value.cwd ?? ""),
    );
    return runInSandbox(sandbox, command, cwd);
  },
});

registerTool({
  name: "npm.install",
  description: "Install the project's npm dependencies in the sandbox. This is the only tool that enables outbound network access for package installation. Input: {cwd?:string}. Use only when package.json exists.",
  async (input, context) {
    const value = input as { cwd?: string };
    const sandbox = await getSandbox(context.projectId);
    const cwd = assertInsideSandbox(
      sandbox.root,
      sandbox.root + "/" + (value.cwd ?? ""),
    );
    return runInSandbox(sandbox, "npm install --no-audit --no-fund", cwd, { network: "bridge" });
  },
});

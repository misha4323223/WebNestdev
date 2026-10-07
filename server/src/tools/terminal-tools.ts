import { getSandbox, assertInsideSandbox } from "../sandbox-manager.js";
import { runInSandbox } from "../sandbox-worker.js";
import { registerTool } from "../tool-registry.js";

registerTool({
  name: "terminal.exec",
  description: "Execute a development command in the project's sandbox. Input: {command:string,cwd?:string}.",
  async (input, context) {
    const value = input as { command?: string; cwd?: string };
    const command = value.command?.trim();
    if (!command) throw new Error("command is required");

    const sandbox = await getSandbox(context.projectId);
    const cwd = assertInsideSandbox(
      sandbox.root,
      sandbox.root + "/" + (value.cwd ?? ""),
    );
    return runInSandbox(sandbox, command, cwd);
  },
});

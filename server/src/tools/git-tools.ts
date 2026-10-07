import { getSandbox, assertInsideSandbox } from "../sandbox-manager.js";
import { runInSandbox } from "../sandbox-worker.js";
import { registerTool } from "../tool-registry.js";

async function git(context: { projectId: string; userId: string }, command: string) {
  const sandbox = await getSandbox(context.projectId, context.userId);
  return runInSandbox(sandbox, "git " + command, sandbox.root);
}

registerTool({
  name: "git.status",
  description: "Show Git working tree status for the project.",
  async (_input, context) {
    return git(context, "status --short --branch");
  },
});

registerTool({
  name: "git.diff",
  description: "Show unstaged Git diff for the project.",
  async (_input, context) {
    return git(context, "diff --no-ext-diff");
  },
});

registerTool({
  name: "git.log",
  description: "Show recent Git commits.",
  async (_input, context) {
    return git(context, "log --oneline -20");
  },
});

registerTool({
  name: "git.branch",
  description: "List local Git branches.",
  async (_input, context) {
    return git(context, "branch --list");
  },
});

registerTool({
  name: "git.add",
  description: "Stage project paths. Input: {paths:string[]}.",
  async (input, context) {
    const value = input as { paths?: string[] };
    if (!value.paths?.length) throw new Error("paths is required");

    const sandbox = await getSandbox(context.projectId);
    const safe = value.paths.map((projectPath) =>
      assertInsideSandbox(
        sandbox.root,
        pathJoin(sandbox.root, projectPath),
      ).slice(sandbox.root.length + 1),
    );
    const quoted = safe
      .map((projectPath) => "'" + projectPath.replaceAll("'", "'\\''") + "'")
      .join(" ");

    return runInSandbox(sandbox, "git add -- " + quoted, sandbox.root);
  },
});

registerTool({
  name: "git.commit",
  description: "Create a Git commit. Input: {message:string}.",
  async (input, context) {
    const value = input as { message?: string };
    const message = value.message?.trim();
    if (!message) throw new Error("message is required");

    const sandbox = await getSandbox(context.projectId);
    const quoted = message.replaceAll("'", "'\\''");
    return runInSandbox(
      sandbox,
      "git commit -m '" + quoted + "'",
      sandbox.root,
    );
  },
});

function pathJoin(root: string, relative: string) {
  return root + "/" + relative;
}

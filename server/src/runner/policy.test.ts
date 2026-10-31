import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = await mkdtemp(path.join(tmpdir(), "runner-policy-"));
process.env.WEBNESTDEV_SANDBOX_DIR = root;
process.env.WEBNESTDEV_SANDBOX_HOST_DIR = root;
process.env.WEBNESTDEV_NODE_ID = "runner-test";
process.env.SANDBOX_IMAGE = "node:22-bookworm";

const { buildSandboxConfig } = await import("../sandbox/config.js");
const { dockerRunArgs } = await import("../sandbox/docker/args.js");
const { dockerOptions } = await import("../sandbox/docker/options.js");
const { assertDockerArgsAllowed, RunnerPolicyError } = await import("./policy.js");

const project = path.join(root, "project");
const config = buildSandboxConfig("project", project);
await mkdir(project, { recursive: true });

function baseArgs() {
  return dockerRunArgs(config, project, dockerOptions(config), "npm test");
}

function withFlags(flags: string[]) {
  const args = baseArgs();
  const image = args.indexOf(process.env.SANDBOX_IMAGE as string);
  return [...args.slice(0, image), ...flags, ...args.slice(image)];
}

async function rejects(args: string[], pattern: RegExp) {
  await assert.rejects(assertDockerArgsAllowed(args), (error: unknown) => {
    assert.ok(error instanceof RunnerPolicyError);
    assert.match(error.message, pattern);
    return true;
  });
}

test("the exact dockerRunArgs shape is accepted on a runner", async () => {
  await assert.doesNotReject(assertDockerArgsAllowed(baseArgs()));
});

test("privileged escape hatches are refused", async () => {
  await rejects(withFlags(["--privileged"]), /не разрешён/);
  await rejects(withFlags(["--cap-add", "SYS_ADMIN"]), /не разрешён/);
  await rejects(withFlags(["--network", "host"]), /host/);
  await rejects(withFlags(["--network", "webnestdev"]), /сети/);
  await rejects(withFlags(["--read-only=false"]), /не принимает/);
  await rejects(withFlags(["--init=false"]), /не принимает/);
  await rejects(withFlags(["--user", "0:0"]), /uid 1000/);
  await rejects(baseArgs().filter(value => value !== "--read-only"), /read-only/);
});

test("only project mounts are accepted", async () => {
  await rejects(withFlags(["-v", "/etc:/workspace/etc:ro"]), /только внутрь|каталог/);
  await rejects(withFlags(["-v", project + ":/etc:ro"]), /внутрь \/workspace/);
});

test("the remaining preview and job operations stay available", async () => {
  await assert.doesNotReject(assertDockerArgsAllowed(["rm", "-f", "wnd-job-1"]));
  await assert.doesNotReject(assertDockerArgsAllowed(["logs", "--tail", "120", "wnd-preview-1"]));
  await assert.doesNotReject(assertDockerArgsAllowed(["inspect", "-f", "{{.State.Running}}", "abc123"]));
  await assert.doesNotReject(assertDockerArgsAllowed(["ps", "-aq", "--filter", "label=webnestdev.preview"]));
  await assert.doesNotReject(assertDockerArgsAllowed(["network", "ls", "--format", "{{.Name}}"]));
  await assert.doesNotReject(assertDockerArgsAllowed(["network", "connect", "preview_net", "abc123"]));
  await assert.doesNotReject(assertDockerArgsAllowed(["exec", "-d", "abc123", "node", "-e", "1+1"]));
  await rejects(["rm", "-rf", "abc123"], /rm -f/);
  await rejects(["exec", "abc123", "cat", "/etc/passwd"], /node и sh/);
  await rejects(["network", "connect", "webnestdev", "abc123"], /предпросмотра/);
  await rejects(["network", "inspect", "-f", "{{.Name}}", "webnestdev"], /предпросмотра/);
});

test.after(async () => {
  await rm(root, { recursive: true, force: true });
});

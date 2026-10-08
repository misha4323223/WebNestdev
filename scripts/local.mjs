import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const server = resolve(root, "server");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(args, cwd = root) {
  const result = spawnSync(npm, args, { cwd, stdio: "inherit", shell: false });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function setup() {
  if (!existsSync(resolve(root, "node_modules"))) {
    console.log("[WebNestDev] Installing workspace dependencies...");
    run(["install"]);
  } else {
    console.log("[WebNestDev] Dependencies already installed.");
  }

  const playwrightCache = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (playwrightCache !== "0") {
    console.log("[WebNestDev] Ensuring Chromium is installed for browser QA...");
    run(["exec", "playwright", "install", "chromium"], server);
  }
}

const command = process.argv[2] ?? "dev";

if (command === "setup") {
  setup();
  console.log("\n[WebNestDev] Local setup complete.");
  console.log("  UI:  http://localhost:5173");
  console.log("  API: http://localhost:8787/health");
  process.exit(0);
}

if (command === "dev") {
  setup();
  console.log("\n[WebNestDev] Starting local development workflow...");
  console.log("  UI:  http://localhost:5173");
  console.log("  API: http://localhost:8787/health");
  run(["run", "dev"]);
  process.exit(0);
}

if (command === "verify") {
  console.log("[WebNestDev] Running production build verification...");
  run(["run", "build"]);
  console.log("\n[WebNestDev] Build verification passed.");
  console.log("Next: npm run local");
  process.exit(0);
}

console.error("Usage: npm run local | npm run local:setup | npm run local:verify");
process.exit(2);

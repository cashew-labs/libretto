import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browsersPath = path.join(appRoot, ".playwright-browsers");
const playwrightCli = path.join(appRoot, "node_modules", "playwright", "cli.js");

mkdirSync(browsersPath, { recursive: true });

const result = spawnSync(process.execPath, [playwrightCli, "install", "chromium"], {
  cwd: appRoot,
  env: {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: browsersPath,
  },
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);

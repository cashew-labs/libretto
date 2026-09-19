import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  type OpenDialogOptions,
} from "electron";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

type RunnerEvent = {
  type: "status" | "log" | "result" | "error";
  message: string;
  running?: boolean;
};

type RunRequest = {
  filePath: string;
  showBrowser: boolean;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = app.isPackaged
  ? app.getAppPath()
  : path.resolve(__dirname, "..", "..");
const runtimeRequire = createRequire(import.meta.url);

let mainWindow: BrowserWindow | null = null;
let runnerProcess: ChildProcessWithoutNullStreams | null = null;
let stopRequested = false;

function sendEvent(event: RunnerEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("runner:event", event);
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 760,
    height: 650,
    minWidth: 640,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#111111",
    title: "Libretto Workflow Runner",
    webPreferences: {
      preload: path.join(appRoot, "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  void mainWindow.loadFile(path.join(appRoot, "electron", "index.html"));
}

function browserDirectory(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "playwright-browsers")
    : path.join(appRoot, ".playwright-browsers");
}

function workerPath(): string {
  return path.join(appRoot, "dist", "src", "runner", "worker.js");
}

function emitOutputLine(line: string, type: "log" | "error"): void {
  const eventPrefix = "__WORKFLOW_RUNNER_EVENT__";
  if (line.startsWith(eventPrefix)) {
    try {
      const event = JSON.parse(line.slice(eventPrefix.length)) as RunnerEvent;
      sendEvent(event);
      return;
    } catch {
      sendEvent({ type: "error", message: "The runner returned an invalid event." });
      return;
    }
  }

  if (line.trim()) {
    sendEvent({ type, message: line });
  }
}

async function validateScript(filePath: string): Promise<string> {
  const resolvedPath = path.resolve(filePath);
  const extension = path.extname(resolvedPath).toLowerCase();
  if (extension !== ".ts" && extension !== ".tsx") {
    throw new Error("Choose a .ts or .tsx file.");
  }
  await fs.access(resolvedPath);
  return resolvedPath;
}

async function startRunner(request: RunRequest): Promise<{ started: true }> {
  if (runnerProcess) {
    throw new Error("A workflow is already running.");
  }

  const scriptPath = await validateScript(request.filePath);
  const browsersPath = browserDirectory();
  await fs.access(browsersPath).catch(() => {
    throw new Error(
      "The bundled browser is missing. Reinstall the app or run npm run browser:install in development.",
    );
  });

  const tsxLoader = pathToFileURL(runtimeRequire.resolve("tsx")).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      tsxLoader,
      workerPath(),
      scriptPath,
      request.showBrowser ? "--headed" : "--headless",
    ],
    {
      cwd: path.dirname(scriptPath),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        FORCE_COLOR: "0",
        PLAYWRIGHT_BROWSERS_PATH: browsersPath,
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  runnerProcess = child;
  stopRequested = false;
  sendEvent({ type: "status", message: "Running", running: true });

  const stdout = readline.createInterface({ input: child.stdout });
  const stderr = readline.createInterface({ input: child.stderr });
  stdout.on("line", (line) => emitOutputLine(line, "log"));
  stderr.on("line", (line) => emitOutputLine(line, "error"));

  child.on("error", (error) => {
    sendEvent({ type: "error", message: error.message });
  });

  child.on("close", (code) => {
    stdout.close();
    stderr.close();
    if (runnerProcess === child) {
      runnerProcess = null;
    }

    if (stopRequested) {
      sendEvent({ type: "status", message: "Stopped", running: false });
    } else if (code === 0) {
      sendEvent({ type: "status", message: "Completed", running: false });
    } else {
      sendEvent({
        type: "status",
        message: `Failed${code === null ? "" : ` (exit ${code})`}`,
        running: false,
      });
    }
    stopRequested = false;
  });

  return { started: true };
}

async function stopRunner(): Promise<{ stopped: boolean }> {
  const child = runnerProcess;
  if (!child?.pid) {
    return { stopped: false };
  }

  stopRequested = true;
  sendEvent({ type: "status", message: "Stopping", running: true });

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      });
      killer.once("close", () => resolve());
      killer.once("error", () => resolve());
    });
  } else {
    child.kill("SIGTERM");
  }

  return { stopped: true };
}

ipcMain.handle("runner:select-script", async () => {
  const options: OpenDialogOptions = {
    title: "Choose a TypeScript workflow",
    properties: ["openFile"],
    filters: [{ name: "TypeScript", extensions: ["ts", "tsx"] }],
  };
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  const filePath = result.filePaths[0];
  return { filePath, fileName: path.basename(filePath) };
});

ipcMain.handle("runner:run", async (_event, request: RunRequest) =>
  startRunner(request),
);
ipcMain.handle("runner:stop", async () => stopRunner());

app.on("before-quit", () => {
  if (runnerProcess?.pid) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(runnerProcess.pid), "/T", "/F"], {
        windowsHide: true,
      });
    } else {
      runnerProcess.kill("SIGTERM");
    }
  }
});

app.on("window-all-closed", () => app.quit());

void app.whenReady().then(createWindow);

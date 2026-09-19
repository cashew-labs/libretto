import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { inspect } from "node:util";
import { pathToFileURL } from "node:url";
import { chromium, type Browser } from "playwright";

type RunnableWorkflow = {
  name?: string;
  startUrl?: string;
  viewport?: { width: number; height: number };
  run: (
    context: { session: string; page: Awaited<ReturnType<Browser["newPage"]>> },
    input: unknown,
  ) => Promise<unknown>;
};

type SimpleRunner = (context: {
  browser: Browser;
  page: Awaited<ReturnType<Browser["newPage"]>>;
  log: (...values: unknown[]) => void;
}) => Promise<unknown> | unknown;

const eventPrefix = "__WORKFLOW_RUNNER_EVENT__";
const fallbackRequire = createRequire(import.meta.url);

function emit(type: "status" | "log" | "result" | "error", message: string): void {
  process.stdout.write(`${eventPrefix}${JSON.stringify({ type, message })}\n`);
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return inspect(value, { colors: false, depth: 8, compact: false });
}

function isBareSpecifier(specifier: string): boolean {
  return (
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("file:") &&
    !specifier.startsWith("node:")
  );
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (originalError) {
      if (!isBareSpecifier(specifier)) {
        throw originalError;
      }

      try {
        return {
          url: pathToFileURL(fallbackRequire.resolve(specifier)).href,
          shortCircuit: true,
        };
      } catch {
        throw originalError;
      }
    }
  },
});

function isWorkflow(value: unknown): value is RunnableWorkflow {
  return Boolean(
    value &&
      typeof value === "object" &&
      "run" in value &&
      typeof (value as { run?: unknown }).run === "function",
  );
}

async function run(): Promise<void> {
  const scriptPath = process.argv[2];
  if (!scriptPath) {
    throw new Error("No TypeScript workflow file was provided.");
  }

  const headless = process.argv[3] !== "--headed";
  const moduleUrl = `${pathToFileURL(path.resolve(scriptPath)).href}?run=${Date.now()}`;
  emit("log", `Loading ${path.basename(scriptPath)}`);
  // oxlint-disable-next-line libretto/no-await-import -- The user selects the workflow file at runtime.
  const loadedModule = (await import(moduleUrl)) as Record<string, unknown>;
  const runnable = loadedModule.default ?? loadedModule.run;

  if (!isWorkflow(runnable) && typeof runnable !== "function") {
    throw new Error(
      "The file must default-export a Libretto workflow or an async function.",
    );
  }

  let browser: Browser | undefined;
  try {
    emit("log", `Starting Chromium${headless ? " headlessly" : ""}`);
    browser = await chromium.launch({
      headless,
      args: ["--disable-blink-features=AutomationControlled"],
    });

    const viewport = isWorkflow(runnable)
      ? (runnable.viewport ?? { width: 1366, height: 768 })
      : { width: 1366, height: 768 };
    const context = await browser.newContext({ viewport });
    await context.addInitScript(() => {
      (globalThis as Record<string, unknown>).__name = (
        target: unknown,
        value: string,
      ) =>
        Object.defineProperty(target as object, "name", {
          value,
          configurable: true,
        });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(45_000);
    page.on("console", (message) => emit("log", `[browser] ${message.text()}`));

    let output: unknown;
    if (isWorkflow(runnable)) {
      emit("log", `Running ${runnable.name ?? path.basename(scriptPath)}`);
      if (runnable.startUrl) {
        await page.goto(runnable.startUrl, { waitUntil: "commit" });
      }
      output = await runnable.run(
        { session: `desktop-${Date.now()}`, page },
        {},
      );
    } else {
      emit("log", `Running ${path.basename(scriptPath)}`);
      output = await (runnable as SimpleRunner)({
        browser,
        page,
        log: (...values) => emit("log", values.map(formatValue).join(" ")),
      });
    }

    emit("result", output === undefined ? "Workflow completed." : formatValue(output));
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  emit("error", message);
  process.exitCode = 1;
});

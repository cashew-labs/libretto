const chooseFileButton = document.querySelector("#choose-file");
const runButton = document.querySelector("#run");
const stopButton = document.querySelector("#stop");
const clearOutputButton = document.querySelector("#clear-output");
const fileName = document.querySelector("#file-name");
const filePath = document.querySelector("#file-path");
const showBrowser = document.querySelector("#show-browser");
const status = document.querySelector("#status");
const output = document.querySelector("#output");

let selectedFilePath = "";
let running = false;

function setStatus(message, isRunning = false) {
  running = isRunning;
  status.textContent = message;
  status.dataset.state = isRunning
    ? "running"
    : message === "Completed"
      ? "completed"
      : message.startsWith("Failed")
        ? "failed"
        : "ready";
  chooseFileButton.disabled = isRunning;
  runButton.disabled = isRunning || !selectedFilePath;
  stopButton.disabled = !isRunning;
}

function appendOutput(message, type = "log") {
  if (output.dataset.empty === "true" || output.textContent === "Choose a workflow to begin.") {
    output.textContent = "";
    output.dataset.empty = "false";
  }

  const prefix = type === "error" ? "Error: " : type === "result" ? "Result: " : "";
  output.textContent += `${prefix}${message}\n`;
  output.scrollTop = output.scrollHeight;
}

chooseFileButton.addEventListener("click", async () => {
  const selected = await window.workflowRunner.selectScript();
  if (!selected) {
    return;
  }

  selectedFilePath = selected.filePath;
  fileName.textContent = selected.fileName;
  filePath.textContent = selected.filePath;
  output.textContent = "Ready to run.";
  output.dataset.empty = "false";
  setStatus("Ready");
});

runButton.addEventListener("click", async () => {
  if (!selectedFilePath || running) {
    return;
  }

  output.textContent = "";
  output.dataset.empty = "false";
  setStatus("Starting", true);
  try {
    await window.workflowRunner.runScript({
      filePath: selectedFilePath,
      showBrowser: showBrowser.checked,
    });
  } catch (error) {
    appendOutput(error instanceof Error ? error.message : String(error), "error");
    setStatus("Failed");
  }
});

stopButton.addEventListener("click", async () => {
  stopButton.disabled = true;
  await window.workflowRunner.stopScript();
});

clearOutputButton.addEventListener("click", () => {
  output.textContent = "";
  output.dataset.empty = "true";
});

window.workflowRunner.onEvent((event) => {
  if (event.type === "status") {
    setStatus(event.message, Boolean(event.running));
    return;
  }
  appendOutput(event.message, event.type);
});

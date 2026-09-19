const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("workflowRunner", {
  selectScript: () => ipcRenderer.invoke("runner:select-script"),
  runScript: (request) => ipcRenderer.invoke("runner:run", request),
  stopScript: () => ipcRenderer.invoke("runner:stop"),
  onEvent: (callback) => {
    const listener = (_event, runnerEvent) => callback(runnerEvent);
    ipcRenderer.on("runner:event", listener);
    return () => ipcRenderer.off("runner:event", listener);
  },
});

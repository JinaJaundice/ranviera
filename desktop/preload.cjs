// The one thing the Cortex page may ask of the desktop shell: the colours of the Windows title bar buttons, so that
// they follow the light and dark themes. Nothing else of Electron is exposed to the page.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cortexDesktop", {
  setTitleBar: (colour, symbols) => ipcRenderer.send("cortex:title-bar", String(colour), String(symbols)),
});

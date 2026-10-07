import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";
import { Desktop } from "./shell/Desktop";
import { connectStream, loadGraph, loadSideData } from "./lib/store";
import { syncDesktopTitleBar } from "./lib/theme";

void loadGraph();
void loadSideData();
connectStream();
syncDesktopTitleBar();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Desktop />
  </StrictMode>,
);

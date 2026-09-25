import { createRoot } from "react-dom/client";
import "./ui/styles.css";
import { App } from "./ui/App";
import { session } from "./core/session";
import { applyTheme } from "./ui/util";

applyTheme();
matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", () => applyTheme());
createRoot(document.getElementById("root")!).render(<App />);
void session.init();

if (__BUILD__ === "pwa" && "serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  window.addEventListener("load", () => { void navigator.serviceWorker.register("./sw.js").catch(() => undefined); });
}

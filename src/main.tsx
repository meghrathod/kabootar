import { createRoot } from "react-dom/client";

import App from "./App";
import { resumableDirs } from "./lib/resume";
import { clearIncoming } from "./lib/sinks";
import "./index.css";

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register(import.meta.env.DEV ? "/dev-sw.js?dev-sw" : "/sw.js", {
    type: import.meta.env.DEV ? "module" : "classic",
    scope: "/",
  });
}

// Files received into private storage on earlier visits are no longer
// needed, except partial downloads this tab can resume after a reload.
void clearIncoming(resumableDirs());

createRoot(document.getElementById("root")!).render(<App />);

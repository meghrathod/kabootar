import { useEffect } from "react";
import { toast } from "./Toasts";

/** Offers to reload when a new version of the app has been installed. */
export function UpdatePrompt() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (reloading) return;
      reloading = true;
    });
    void navigator.serviceWorker.getRegistration().then((reg) => {
      if (!reg) return;
      const prompt = (w: ServiceWorker) =>
        toast("A new version of Kabootar is ready", "info", {
          label: "Update",
          run: () => {
            w.postMessage({ type: "SKIP_WAITING" });
            setTimeout(() => location.reload(), 300);
          },
        });
      if (reg.waiting && navigator.serviceWorker.controller)
        prompt(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        w?.addEventListener("statechange", () => {
          if (w.state === "installed" && navigator.serviceWorker.controller)
            prompt(w);
        });
      });
    });
  }, []);
  return null;
}

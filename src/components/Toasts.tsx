import { Store } from "../lib/store";
import { useStore } from "../lib/useStore";
import { Icon } from "./Icon";

interface Toast {
  id: number;
  message: string;
  tone: "info" | "error" | "success";
  action?: { label: string; run: () => void };
}

const toasts = new Store<{ items: Toast[] }>({ items: [] });
let nextId = 0;

export function toast(
  message: string,
  tone: Toast["tone"] = "info",
  action?: Toast["action"],
) {
  const id = nextId++;
  toasts.set((s) => ({
    items: [...s.items.slice(-3), { id, message, tone, action }],
  }));
  if (!action) setTimeout(() => dismiss(id), tone === "error" ? 6000 : 3000);
}

function dismiss(id: number) {
  toasts.set((s) => ({ items: s.items.filter((t) => t.id !== id) }));
}

export function Toasts() {
  const { items } = useStore(toasts);
  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      role="status"
      aria-live="polite"
    >
      {items.map((t) => (
        <div
          key={t.id}
          className={`panel pointer-events-auto flex max-w-md animate-rise items-center gap-3 rounded-2xl px-4 py-3 text-sm ${
            t.tone === "error"
              ? "border-rose-400/30"
              : t.tone === "success"
                ? "border-emerald-400/30"
                : ""
          }`}
        >
          <Icon
            name={
              t.tone === "error"
                ? "alert"
                : t.tone === "success"
                  ? "check"
                  : "radar"
            }
            className={`h-4 w-4 shrink-0 ${t.tone === "error" ? "text-rose-300" : t.tone === "success" ? "text-emerald-300" : "text-sky"}`}
          />
          <span className="flex-1">{t.message}</span>
          {t.action && (
            <button
              className="font-semibold text-sky"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button
            className="text-white/40 hover:text-white"
            onClick={() => dismiss(t.id)}
            aria-label="Dismiss"
          >
            <Icon name="x" className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import { Icon } from "../components/Icon";
import { toast } from "../components/Toasts";
import { Spinner } from "../components/ui";
import { errorMessage } from "../lib/api";
import {
  addFiles,
  addText,
  clearDraft,
  draft,
  filesFromDataTransfer,
  removeFile,
  removeText,
} from "../lib/draft";
import { formatBytes } from "../lib/format";
import { SenderSession, senderSlot } from "../lib/sender";
import { pruneShared, takeShared } from "../lib/shareStore";
import { stage } from "../lib/stage";
import { useStore } from "../lib/useStore";

export default function Home() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const d = useStore(draft);
  const { session } = useStore(senderSlot);
  const [dragging, setDragging] = useState(false);
  const [composing, setComposing] = useState(false);
  const [text, setText] = useState("");
  const [discoverable, setDiscoverable] = useState(true);
  const [starting, setStarting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const count = d.files.length + d.texts.length;
  const total = d.files.reduce((n, f) => n + f.file.size, 0);

  useEffect(() => stage.set({ mode: "perch", effort: 0 }), []);

  // Content shared from other apps (Web Share Target).
  useEffect(() => {
    const shared = params.get("shared");
    if (!shared) return;
    setParams({}, { replace: true });
    if (shared === "error") {
      toast("Couldn't receive what you shared. Try again.", "error");
      return;
    }
    void takeShared(shared).then((p) => {
      if (!p) return;
      addFiles(p.files);
      const msg = [p.title, p.text, p.url].filter(Boolean).join("\n").trim();
      if (msg) addText(msg);
      const n = p.files.length + (msg ? 1 : 0);
      if (n) toast(`Ready to send ${n} item${n > 1 ? "s" : ""}`, "success");
    });
    void pruneShared();
  }, [params, setParams]);

  // Paste files or text anywhere on the page.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea")) return;
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) {
        addFiles(files);
        e.preventDefault();
        return;
      }
      const t = e.clipboardData?.getData("text");
      if (t?.trim()) {
        addText(t);
        toast("Added text from clipboard");
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  // Drag and drop over the whole window.
  useEffect(() => {
    let depth = 0;
    const has = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => has(e) && (depth++, setDragging(true));
    const leave = () => --depth <= 0 && ((depth = 0), setDragging(false));
    const over = (e: DragEvent) => has(e) && e.preventDefault();
    const drop = async (e: DragEvent) => {
      if (!has(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      addFiles(await filesFromDataTransfer(e.dataTransfer!));
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);

  const start = async () => {
    if (session && session.store.get().status === "live") {
      toast("You're already sharing. Stop that share first.", "error");
      return;
    }
    setStarting(true);
    try {
      const s = await SenderSession.start(draft.get(), discoverable);
      senderSlot.set({ session: s });
      clearDraft();
      navigate(`/${s.id}${new URL(s.store.get().link).hash}`);
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setStarting(false);
    }
  };

  const live =
    session && session.store.get().status === "live" ? session : undefined;

  return (
    <div className="flex flex-col">
      {live && (
        <Link
          to={`/${live.id}${new URL(live.store.get().link).hash}`}
          className="panel mb-4 flex items-center gap-3 px-4 py-3 text-sm"
        >
          <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
          <span className="flex-1">
            Sharing as {live.store.get().room.name}
          </span>
          <span className="text-sky">Open</span>
        </Link>
      )}

      <section className="panel animate-rise p-3">
        {count === 0 ? (
          <div
            className={`airmail transition ${dragging ? "brightness-125" : ""}`}
          >
            <button
              onClick={() => fileInput.current?.click()}
              className="flex w-full flex-col items-center gap-2 px-6 py-10 transition hover:bg-ink-3"
            >
              <Icon name="upload" className="h-6 w-6 text-sky" />
              <span className="font-display text-xl font-semibold">
                Choose files
              </span>
              <span className="label">or drop · paste</span>
            </button>
          </div>
        ) : (
          <ul className="max-h-[42vh] divide-y divide-white/5 overflow-y-auto px-1">
            {d.files.map((f, i) => (
              <li
                key={`f${i}`}
                className="kb-stagger flex items-center gap-3 py-2.5"
                style={{ "--i": i } as React.CSSProperties}
              >
                <Icon name="file" className="h-5 w-5 shrink-0 text-white/50" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{f.path ?? f.file.name}</p>
                  <p className="text-xs text-white/45">
                    {formatBytes(f.file.size)}
                  </p>
                </div>
                <button
                  className="icon-btn"
                  onClick={() => removeFile(i)}
                  aria-label={`Remove ${f.file.name}`}
                >
                  <Icon name="x" className="h-4 w-4" />
                </button>
              </li>
            ))}
            {d.texts.map((t, i) => (
              <li
                key={`t${i}`}
                className="kb-stagger flex items-center gap-3 py-2.5"
                style={{ "--i": d.files.length + i } as React.CSSProperties}
              >
                <Icon
                  name={/^https?:\/\//.test(t) ? "link" : "text"}
                  className="h-5 w-5 shrink-0 text-white/50"
                />
                <p className="line-clamp-2 min-w-0 flex-1 text-sm text-white/80">
                  {t}
                </p>
                <button
                  className="icon-btn"
                  onClick={() => removeText(i)}
                  aria-label="Remove text"
                >
                  <Icon name="x" className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}

        {composing && (
          <div className="mt-3 space-y-2 px-1">
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Text or link"
              rows={3}
              maxLength={60000}
              className="input resize-none"
            />
            <div className="flex justify-end gap-2">
              <button
                className="btn-ghost py-2"
                onClick={() => setComposing(false)}
              >
                Cancel
              </button>
              <button
                className="btn-primary py-2"
                disabled={!text.trim()}
                onClick={() => {
                  addText(text);
                  setText("");
                  setComposing(false);
                }}
              >
                Add
              </button>
            </div>
          </div>
        )}

        <div className="mt-2 flex items-center gap-1 px-1 text-sm">
          {count > 0 && (
            <button
              className="btn-ghost px-3 py-1.5"
              onClick={() => fileInput.current?.click()}
            >
              <Icon name="plus" className="h-4 w-4" /> Files
            </button>
          )}
          <button
            className="btn-ghost px-3 py-1.5"
            onClick={() => folderInput.current?.click()}
          >
            <Icon name="folder" className="h-4 w-4" /> Folder
          </button>
          <button
            className="btn-ghost px-3 py-1.5"
            onClick={() => setComposing(true)}
          >
            <Icon name="text" className="h-4 w-4" /> Text
          </button>
          {count > 0 && (
            <span className="ml-auto text-xs text-white/45">
              {formatBytes(total)}
            </span>
          )}
        </div>
      </section>

      {count > 0 && (
        <div className="mt-4 flex animate-rise flex-col gap-3">
          <label className="flex cursor-pointer items-center gap-2 px-2 text-sm text-white/60">
            <input
              type="checkbox"
              checked={discoverable}
              onChange={(e) => setDiscoverable(e.target.checked)}
              className="h-4 w-4 accent-sky"
            />
            Show to nearby devices
          </label>
          <button
            className="btn-primary py-4 text-base"
            onClick={start}
            disabled={starting}
          >
            {starting ? <Spinner /> : <Icon name="share" />}
            Send
          </button>
        </div>
      )}

      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          addFiles(e.target.files ?? []);
          e.target.value = "";
        }}
      />
      <input
        ref={folderInput}
        type="file"
        hidden
        // @ts-expect-error non-standard but widely supported
        webkitdirectory=""
        onChange={(e) => {
          addFiles(e.target.files ?? []);
          e.target.value = "";
        }}
      />

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-ink/70 backdrop-blur-sm">
          <div className="rounded-3xl border-2 border-dashed border-sky px-10 py-8 font-display text-2xl font-semibold text-sky">
            Drop to add
          </div>
        </div>
      )}
    </div>
  );
}

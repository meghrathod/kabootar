import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import QRCodeSVG from "qrcode-svg";

import type { RoomInfo } from "../lib/api";
import type { ItemMeta } from "../lib/transfer/protocol";
import { Icon, type IconName } from "./Icon";

/** Circular postmark with the room name stamped around the avatar. */
export function Postmark({ room, size = 64 }: { room: Pick<RoomInfo, "emoji" | "color" | "name">; size?: number }) {
  const id = `pm-${room.name.replace(/\W/g, "")}`;
  const text = `${room.name.toUpperCase()} · KABOOTAR · `;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" className="shrink-0 -rotate-12" aria-hidden>
      <defs>
        <path id={id} d="M50,50 m-36,0 a36,36 0 1,1 72,0 a36,36 0 1,1 -72,0" />
      </defs>
      <circle cx="50" cy="50" r="47" fill="none" stroke={room.color} strokeOpacity="0.7" strokeWidth="2" />
      <circle cx="50" cy="50" r="27" fill={room.color} fillOpacity="0.16" stroke={room.color} strokeOpacity="0.7" strokeWidth="1.5" />
      <text fill={room.color} fillOpacity="0.85" fontSize="10.5" fontFamily="var(--font-mono)" letterSpacing="1.2">
        <textPath href={`#${id}`} textLength="222">
          {text}
        </textPath>
      </text>
      <text x="50" y="51" textAnchor="middle" dominantBaseline="central" fontSize="28">
        {room.emoji}
      </text>
    </svg>
  );
}

/** The share code as a perforated postage stamp. */
export function Stamp({ code, emoji }: { code: string; emoji?: string }) {
  return (
    <div className="stamp inline-block rotate-[-1.5deg]">
      <div className="border border-dashed border-ink/25 px-5 py-3">
        <div className="flex items-center justify-between gap-6 font-mono text-[10px] font-medium tracking-[0.18em] text-ink/55">
          <span>AIRMAIL · CODE</span>
          {emoji && <span className="text-base leading-none">{emoji}</span>}
        </div>
        <p className="mt-1 font-mono text-[2.6rem] leading-none font-medium tracking-[0.08em] tabular-nums" aria-label={`Code ${code.split("").join(" ")}`}>
          {code.slice(0, 3)}
          <span className="text-ink/30">·</span>
          {code.slice(3)}
        </p>
      </div>
    </div>
  );
}

export function QRCode({ value }: { value: string }) {
  const svg = new QRCodeSVG({
    content: value,
    padding: 0,
    ecl: "M",
    color: "#060818",
    background: "transparent",
    join: true,
    container: "svg-viewbox",
  }).svg();
  return (
    <div className="rounded-lg bg-paper p-2.5 [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />
  );
}

export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className="panel m-auto w-[min(92vw,26rem)] bg-ink-2/90 p-0 text-white backdrop:bg-black/60 backdrop:backdrop-blur-sm"
    >
      <div className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold">{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

/** Six separate digit boxes that behave like one input (paste, backspace, autofill). */
export function CodeInput({
  value,
  onChange,
  onComplete,
  autoFocus,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onComplete?: (v: string) => void;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  return (
    <label className="relative block cursor-text" onClick={() => ref.current?.focus()}>
      <span className="sr-only">6-digit code</span>
      <input
        ref={ref}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={6}
        disabled={disabled}
        value={value}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, "").slice(0, 6);
          onChange(v);
          if (v.length === 6) onComplete?.(v);
        }}
        className="absolute inset-0 opacity-0"
      />
      <div className="grid grid-cols-6 gap-2" aria-hidden>
        {Array.from({ length: 6 }, (_, i) => {
          const active = focused && (i === value.length || (i === 5 && value.length === 6));
          return (
            <div
              key={i}
              className={`flex aspect-[4/5] items-center justify-center rounded-xl border bg-ink font-mono text-2xl font-medium tabular-nums transition ${
                active ? "border-sky shadow-[0_0_0_4px_rgb(0_223_216_/_0.15)]" : "border-white/10"
              }`}
            >
              {value[i] ?? ""}
            </div>
          );
        })}
      </div>
    </label>
  );
}

export function itemIcon(item: ItemMeta): IconName {
  if (item.kind === "text") return /^https?:\/\//i.test(item.text.trim()) ? "link" : "text";
  return "file";
}

export function fileKind(type: string, name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (type.startsWith("image/")) return "Image";
  if (type.startsWith("video/")) return "Video";
  if (type.startsWith("audio/")) return "Audio";
  if (type === "application/pdf" || ext === "pdf") return "PDF";
  if (["zip", "rar", "7z", "gz", "tar"].includes(ext)) return "Archive";
  return ext ? ext.toUpperCase() : "File";
}

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return <span className={`${className} inline-block animate-spin rounded-full border-2 border-white/20 border-t-sky`} />;
}

/** Renders text with http(s) links made clickable; nothing else is interpreted. */
export function LinkifiedText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-sky underline">
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/**
 * A badge that explains itself: hover on desktop, tap on touch screens.
 * The small ⓘ signals on phones that it can be tapped.
 */
export function Tip({
  tip,
  children,
  className = "chip",
  align = "left",
}: {
  tip: ReactNode;
  children: ReactNode;
  className?: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState(0);
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);

  // Keep the bubble inside the viewport on narrow screens.
  useLayoutEffect(() => {
    if (!open || !bubble.current || !ref.current) return;
    const anchor = ref.current.getBoundingClientRect();
    const width = bubble.current.offsetWidth;
    const margin = 16;
    const left = align === "right" ? anchor.right - width : anchor.left;
    const clamped = Math.min(Math.max(left, margin), window.innerWidth - width - margin);
    setShift(clamped - left);
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <span
      ref={ref}
      className="relative inline-flex"
      // Hover only for real mice: touch screens fire a synthetic hover just
      // before the tap, which would open and then immediately toggle closed.
      onPointerEnter={(e) => e.pointerType === "mouse" && setOpen(true)}
      onPointerLeave={(e) => e.pointerType === "mouse" && setOpen(false)}
    >
      <button
        type="button"
        className={`${className} cursor-help`}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {children}
        <Icon name="info" className="h-3 w-3 opacity-50" />
      </button>
      {open && (
        <span
          ref={bubble}
          role="tooltip"
          id={id}
          style={{ transform: `translateX(${shift}px)` }}
          className={`absolute top-full z-30 mt-2 w-64 max-w-[calc(100vw-24px)] rounded-xl border border-white/10 bg-ink-3 p-3 font-sans text-xs leading-relaxed tracking-normal text-white/80 normal-case shadow-2xl shadow-black/50 ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {tip}
        </span>
      )}
    </span>
  );
}

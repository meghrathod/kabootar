import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";

import { Icon } from "../components/Icon";
import { Centered } from "../components/Centered";
import { Logo } from "../components/Logo";
import { toast } from "../components/Toasts";
import {
  CodeInput,
  Dialog,
  LinkifiedText,
  Postmark,
  QRCode,
  Spinner,
  Stamp,
  Tip,
  fileKind,
} from "../components/ui";
import { errorMessage, joinWithPin } from "../lib/api";
import { formatBytes, formatDuration, formatSpeed } from "../lib/format";
import { isIOS } from "../lib/platform";
import { ReceiverSession, type ReceiverState } from "../lib/receiver";
import {
  encryptionHelp,
  nearbyHiddenHelp,
  relayAvailableHelp,
  routeHelp,
  routeLabel,
  senderAwayHelp,
  verifiedHelp,
} from "../lib/rtc";
import { type SavedShare, dropShare, savedShare } from "../lib/resume";
import { type PeerView, SenderSession, senderSlot } from "../lib/sender";
import { endShare } from "../lib/signal";
import {
  bestStrategy,
  pickDirectory,
  pickSaveFile,
  shareOrDownload,
  supportsFolderSave,
} from "../lib/sinks";
import { stage } from "../lib/stage";
import type { ItemState } from "../lib/transfer/client";
import type { FileMeta, ItemMeta } from "../lib/transfer/protocol";
import { useStore } from "../lib/useStore";

export default function Room() {
  const { id = "" } = useParams();
  const { hash } = useLocation();
  const { session } = useStore(senderSlot);
  const key = new URLSearchParams(hash.slice(1)).get("k");

  if (session && session.id === id) return <SenderView session={session} />;
  const saved = savedShare(id);
  if (saved) return <ResumeShare saved={saved} />;
  if (!key) return <NeedCode roomId={id} />;
  return <ReceiverView key={`${id}:${key}`} roomId={id} clientKey={key} />;
}

/**
 * The sender reloaded: the room and code are still valid, but the browser no
 * longer has access to the files. Re-adding them resumes the same share and
 * receivers carry on where they stopped.
 */
function ResumeShare({ saved }: { saved: SavedShare }) {
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [matched, setMatched] = useState(new Map<number, File>());
  const [ending, setEnding] = useState(false);
  const needed = saved.items.filter((i): i is FileMeta => i.kind === "file");
  const missing = needed.filter((i) => !matched.has(i.id));

  const add = (files: Iterable<File>) => {
    const next = new Map(matched);
    for (const f of files) {
      const item =
        needed.find(
          (i) =>
            !next.has(i.id) &&
            i.name === f.name &&
            i.size === f.size &&
            (!i.lastModified || i.lastModified === f.lastModified),
        ) ??
        needed.find(
          (i) => !next.has(i.id) && i.name === f.name && i.size === f.size,
        );
      if (item) next.set(item.id, f);
    }
    if (next.size === matched.size)
      toast("Those aren't the files from this share", "error");
    setMatched(next);
  };

  const resume = () => {
    senderSlot.set({ session: SenderSession.resume(saved, matched) });
  };

  useEffect(() => {
    if (needed.length > 0 && missing.length === 0) resume();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missing.length]);

  const end = async () => {
    setEnding(true);
    await endShare(saved.created.id, saved.created.masterKey);
    dropShare(saved.created.id);
    navigate("/", { replace: true });
  };

  return (
    <Shell>
      <h1 className="font-display text-2xl font-semibold">Continue sharing</h1>
      <p className="mt-1 text-sm text-white/60">
        Reloading the page cleared access to your files. Add the same files
        again to keep sharing as <b>{saved.created.name}</b>. Receivers will
        pick up where they left off.
      </p>
      <ul
        className="mt-5 divide-y divide-white/5"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          add(e.dataTransfer.files);
        }}
      >
        {needed.map((i) => (
          <li key={i.id} className="flex items-center gap-3 py-2.5 text-sm">
            <Icon
              name={matched.has(i.id) ? "check" : "file"}
              className={`h-5 w-5 shrink-0 ${matched.has(i.id) ? "text-emerald-300" : "text-white/40"}`}
            />
            <span className="min-w-0 flex-1 truncate">{i.path ?? i.name}</span>
            <span className="text-xs text-white/45">{formatBytes(i.size)}</span>
          </li>
        ))}
      </ul>
      <div className="mt-5 flex flex-wrap gap-2">
        <button
          className="btn-primary flex-1"
          onClick={() => input.current?.click()}
        >
          <Icon name="plus" className="h-4 w-4" /> Add files
        </button>
        {matched.size > 0 && missing.length > 0 && (
          <button className="btn-ghost" onClick={resume}>
            Continue without {missing.length} file
            {missing.length > 1 ? "s" : ""}
          </button>
        )}
        <button className="btn-danger" onClick={end} disabled={ending}>
          End share
        </button>
      </div>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          add(e.target.files ?? []);
          e.target.value = "";
        }}
      />
    </Shell>
  );
}

function NeedCode({ roomId }: { roomId: string }) {
  const navigate = useNavigate();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const join = async (v: string) => {
    setBusy(true);
    try {
      const { clientKey } = await joinWithPin(v, roomId);
      navigate(`/${roomId}#k=${clientKey}`, { replace: true });
    } catch (err) {
      toast(errorMessage(err), "error");
      setPin("");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell>
      <h1 className="font-display text-xl font-bold">Enter the code</h1>
      <p className="mt-1 mb-5 text-sm text-white/60">
        This link is missing its key. Enter the 6-digit code from the sender.
      </p>
      <CodeInput
        value={pin}
        onChange={setPin}
        onComplete={join}
        autoFocus
        disabled={busy}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <Centered className="max-w-xl">
      <Logo size="5rem" link />
      <div className="h-6" />
      <div className="panel animate-rise p-5 md:p-7">{children}</div>
    </Centered>
  );
}

function StatusDot({ tone }: { tone: "ok" | "warn" | "bad" | "idle" }) {
  const c = {
    ok: "bg-emerald-400",
    warn: "bg-amber-400",
    bad: "bg-rose-400",
    idle: "bg-white/40",
  }[tone];
  return (
    <span
      className={`h-2 w-2 rounded-full ${c} ${tone === "ok" ? "animate-pulse" : ""}`}
    />
  );
}

// ---------------------------------------------------------------------------
// Sender

const peerLabel: Record<PeerView["state"], string> = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  failed: "Connection lost",
  left: "Left",
};

function SenderView({ session }: { session: SenderSession }) {
  const navigate = useNavigate();
  const s = useStore(session.store);
  const [qrOpen, setQrOpen] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const completedRef = useRef(0);

  const activePeers = s.peers.filter((p) => p.current);
  const speed = s.peers.reduce((n, p) => n + p.speed, 0);
  const completions = s.peers.reduce((n, p) => n + p.completed.length, 0);

  useEffect(() => {
    if (completions > completedRef.current) {
      completedRef.current = completions;
      stage.set({ mode: "celebrate" });
      return;
    }
    if (stage.get().mode === "celebrate") return;
    stage.set({
      mode: activePeers.length ? "fly" : "perch",
      effort: Math.min(1, speed / (30 * 1024 * 1024)),
    });
  }, [activePeers.length, speed, completions]);

  const copy = async () => {
    await navigator.clipboard.writeText(s.link);
    toast("Link copied", "success");
  };
  const share = () =>
    navigator
      .share?.({
        title: "Kabootar",
        text: `Get my files on Kabootar (code ${s.pin})`,
        url: s.link,
      })
      .catch(() => {});

  const stop = () => {
    session.end();
    senderSlot.set({ session: undefined });
    navigate("/", { replace: true });
  };

  if (s.status !== "live") {
    return (
      <Shell>
        <h1 className="font-display text-xl font-bold">
          {s.status === "error" ? "Share stopped" : "Share ended"}
        </h1>
        <p className="mt-1 text-sm text-white/60">
          {s.error ?? "Receivers can no longer download these files."}
        </p>
        <button
          className="btn-primary mt-5"
          onClick={() => {
            senderSlot.set({ session: undefined });
            navigate("/");
          }}
        >
          Share something else
        </button>
      </Shell>
    );
  }

  const fileCount = s.items.filter((i) => i.kind === "file").length;
  const textCount = s.items.length - fileCount;

  return (
    <Centered className="max-w-xl">
      <Logo size="5rem" link />
      <div className="h-6" />
      <div className="panel animate-rise p-5 md:p-7">
        <header className="flex items-center gap-4">
          <Postmark room={s.room} />
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-display text-2xl font-semibold">
              {s.room.name}
            </h1>
            <p className="flex items-center gap-2 text-xs text-white/55">
              <StatusDot tone={s.signal === "open" ? "ok" : "warn"} />
              {s.signal === "open"
                ? "Live: keep this page open"
                : "Reconnecting to server…"}
            </p>
          </div>
          <button
            className="btn-danger py-2"
            onClick={() => setConfirmStop(true)}
          >
            <Icon name="stop" className="h-4 w-4" /> Stop
          </button>
        </header>

        <div className="mt-6 grid gap-5 md:grid-cols-[1fr_auto] md:items-center">
          <div>
            <Stamp code={s.pin} emoji={s.room.emoji} />
            <p className="label mt-3">
              Enter at{" "}
              <span className="text-white/75 normal-case">
                {location.host}/receive
              </span>
            </p>
          </div>
          <button
            className="mx-auto w-32 md:w-28"
            onClick={() => setQrOpen(true)}
            aria-label="Show QR code"
          >
            <QRCode value={s.link} />
          </button>
        </div>

        <div className="mt-5 flex gap-2">
          <button className="btn-ghost flex-1" onClick={copy}>
            <Icon name="copy" className="h-4 w-4" /> Copy link
          </button>
          {"share" in navigator && (
            <button className="btn-ghost flex-1" onClick={share}>
              <Icon name="share" className="h-4 w-4" /> Share
            </button>
          )}
        </div>

        <div className="mt-6 flex flex-wrap gap-2">
          <span className="chip">
            <Icon name="file" className="h-3.5 w-3.5" />
            {fileCount > 0 &&
              `${fileCount} file${fileCount > 1 ? "s" : ""} · ${formatBytes(s.totalBytes)}`}
            {fileCount > 0 && textCount > 0 && " + "}
            {textCount > 0 && `${textCount} text`}
          </span>
          <Tip tip={encryptionHelp}>
            <Icon name="shield" className="h-3.5 w-3.5" /> End-to-end encrypted
          </Tip>
          {s.relay && (
            <Tip tip={relayAvailableHelp}>
              <Icon name="relay" className="h-3.5 w-3.5" /> Relay available
            </Tip>
          )}
          {s.nearbyHidden && (
            <Tip tip={nearbyHiddenHelp} className="chip text-amber-200">
              <Icon name="wifi" className="h-3.5 w-3.5" /> Hidden from Nearby
            </Tip>
          )}
        </div>

        <section className="mt-6">
          <h2 className="label mb-2">Receivers</h2>
          {s.peers.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-white/10 p-4 text-center text-sm text-white/45">
              Waiting for someone to join…
            </p>
          ) : (
            <ul className="space-y-2">
              {s.peers.map((p, i) => (
                <PeerRow key={p.id} peer={p} index={i} items={s.items} />
              ))}
            </ul>
          )}
        </section>
      </div>

      <Dialog
        open={qrOpen}
        onClose={() => setQrOpen(false)}
        title="Scan to receive"
      >
        <div className="mx-auto w-64">
          <QRCode value={s.link} />
        </div>
        <p className="mt-4 text-center text-sm text-white/60">
          Or enter code <b className="tabular-nums">{s.pin}</b>
        </p>
      </Dialog>
      <Dialog
        open={confirmStop}
        onClose={() => setConfirmStop(false)}
        title="Stop sharing?"
      >
        <p className="text-sm text-white/60">
          Anyone still downloading will be disconnected.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setConfirmStop(false)}>
            Keep sharing
          </button>
          <button className="btn-danger" onClick={stop}>
            Stop sharing
          </button>
        </div>
      </Dialog>
    </Centered>
  );
}

function PeerRow({
  peer,
  index,
  items,
}: {
  peer: PeerView;
  index: number;
  items: ItemMeta[];
}) {
  const current = peer.current
    ? items.find((i) => i.id === peer.current!.id)
    : undefined;
  const size = current?.kind === "file" ? current.size : 0;
  const pct = size ? Math.min(100, (peer.current!.acked / size) * 100) : 0;
  const tone =
    peer.state === "failed"
      ? "bad"
      : peer.state === "connecting" || peer.state === "reconnecting"
        ? "warn"
        : peer.state === "left"
          ? "idle"
          : "ok";
  return (
    <li className="rounded-2xl border border-white/5 bg-white/[0.03] p-3">
      <div className="flex items-center gap-2 text-sm">
        <StatusDot tone={tone} />
        <span className="font-medium">Receiver {index + 1}</span>
        <span className="text-white/45">· {peerLabel[peer.state]}</span>
        {peer.route && (
          <span className="ml-auto">
            <Tip
              tip={routeHelp[peer.route]}
              align="right"
              className="inline-flex items-center gap-1 text-xs text-white/45"
            >
              {routeLabel[peer.route]}
            </Tip>
          </span>
        )}
      </div>
      {current?.kind === "file" && (
        <div className="mt-2">
          <div className="flex justify-between text-xs text-white/55">
            <span className="truncate pr-2">{current.name}</span>
            <span className="tabular-nums">
              {peer.speed > 0 ? formatSpeed(peer.speed) : `${pct.toFixed(0)}%`}
            </span>
          </div>
          <div className="progress mt-1.5">
            <span style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}
      {peer.completed.length > 0 && (
        <p className="mt-2 flex items-center gap-1 text-xs text-emerald-300/90">
          <Icon name="check" className="h-3.5 w-3.5" /> {peer.completed.length}{" "}
          file{peer.completed.length > 1 ? "s" : ""} delivered
        </p>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Receiver

const statusText: Record<ReceiverState["status"], string> = {
  connecting: "Connecting…",
  waiting: "Connecting to sender…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  closed: "Sender stopped sharing",
  error: "Connection failed",
};

function ReceiverView({
  roomId,
  clientKey,
}: {
  roomId: string;
  clientKey: string;
}) {
  const navigate = useNavigate();
  const session = useMemo(
    () => new ReceiverSession(roomId, clientKey),
    [roomId, clientKey],
  );
  useEffect(() => () => session.leave(), [session]);
  const s = useStore(session.store);
  const [slow, setSlow] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const files = s.items.filter((i): i is FileMeta => i.kind === "file");
  const texts = s.items.filter((i) => i.kind === "text");
  const states = s.states;
  const active = files.filter((f) =>
    ["queued", "receiving", "verifying"].includes(states[f.id]?.status ?? ""),
  );
  const done = files.filter((f) => states[f.id]?.status === "done");
  const pending = files.filter((f) =>
    ["idle", "error", "cancelled", undefined].includes(states[f.id]?.status),
  );
  const requestedBytes = [...active, ...done].reduce((n, f) => n + f.size, 0);
  const receivedBytes = [...active, ...done].reduce(
    (n, f) => n + (states[f.id]?.received ?? 0),
    0,
  );
  const remaining = requestedBytes - receivedBytes;

  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 12_000);
    return () => clearTimeout(t);
  }, []);

  const allDone = files.length > 0 && done.length === files.length;
  const doneRef = useRef(0);
  useEffect(() => {
    if (done.length > doneRef.current && active.length === 0) {
      doneRef.current = done.length;
      stage.set({ mode: "celebrate" });
      return;
    }
    if (stage.get().mode === "celebrate") return;
    stage.set({
      mode: active.length ? "fly" : "perch",
      effort: Math.min(1, s.speed / (30 * 1024 * 1024)),
    });
  }, [active.length, done.length, s.speed]);

  const downloadOne = async (meta: FileMeta) => {
    try {
      if (bestStrategy() === "picker") {
        const file = await pickSaveFile(meta);
        session.download([meta.id], { strategy: "picker", file });
      } else {
        session.download([meta.id]);
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError"))
        toast(errorMessage(err), "error");
    }
  };

  const downloadAll = async () => {
    const ids = pending.map((f) => f.id);
    if (ids.length === 0) return;
    try {
      if (supportsFolderSave && ids.length > 1) {
        const dir = await pickDirectory();
        session.download(ids, { strategy: "picker", dir });
      } else if (ids.length === 1) {
        await downloadOne(pending[0]);
      } else {
        session.download(ids);
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError"))
        toast(errorMessage(err), "error");
    }
  };

  const ended = s.status === "closed" || s.status === "error";
  const tone =
    s.status === "connected"
      ? "ok"
      : ended
        ? s.status === "error"
          ? "bad"
          : "idle"
        : "warn";
  const bigOnIOS = isIOS && files.some((f) => f.size > 2 * 1024 ** 3);

  // Leaving drops an active transfer, and on iPhone files received into
  // device storage can't be saved afterwards, so confirm in those cases.
  const unsaved = isIOS && done.some((f) => states[f.id]?.file);
  const leave = () => {
    session.leave();
    navigate("/", { replace: true });
  };
  const requestLeave = () =>
    active.length > 0 || unsaved ? setConfirmLeave(true) : leave();

  return (
    <Centered className="max-w-xl">
      <Logo size="5rem" link />
      <div className="h-6" />
      <div className="panel animate-rise p-5 md:p-7">
        <header className="flex items-center gap-4">
          <button
            className="icon-btn -ml-2 shrink-0"
            onClick={requestLeave}
            aria-label="Leave and go home"
          >
            <Icon name="arrowLeft" />
          </button>
          {s.room ? (
            <Postmark room={s.room} />
          ) : (
            <div className="h-16 w-16 animate-pulse rounded-full bg-white/10" />
          )}
          <div className="min-w-0 flex-1">
            <p className="label">Receiving from</p>
            <h1 className="truncate font-display text-2xl font-semibold">
              {s.room?.name ?? "…"}
            </h1>
          </div>
        </header>

        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-white/60">
          <span className="chip">
            <StatusDot tone={tone} />{" "}
            {allDone && ended ? "All files received" : statusText[s.status]}
          </span>
          {s.route && <Tip tip={routeHelp[s.route]}>{routeLabel[s.route]}</Tip>}
          <Tip tip={encryptionHelp}>
            <Icon name="shield" className="h-3.5 w-3.5" /> End-to-end encrypted
          </Tip>
          {!s.senderOnline && !ended && (
            <Tip tip={senderAwayHelp} className="chip text-amber-200">
              Sender's connection dropped, waiting…
            </Tip>
          )}
        </div>

        {(s.status === "connecting" || s.status === "waiting") &&
          s.items.length === 0 && (
            <div className="mt-8 flex flex-col items-center gap-3 py-6 text-center">
              <span className="relative flex h-16 w-16 items-center justify-center">
                <span className="absolute inset-0 animate-ping rounded-full bg-sky/15" />
                <span className="absolute inset-2 animate-pulse rounded-full bg-sky/10" />
                <Icon name="radar" className="h-7 w-7 text-sky" />
              </span>
              <p className="text-sm text-white/60">
                Establishing a secure peer-to-peer connection…
              </p>
              {slow && (
                <p className="max-w-xs text-xs text-white/40">
                  Taking a while? Make sure the sender still has Kabootar open.
                  Some strict networks block direct connections.
                </p>
              )}
            </div>
          )}

        {s.error && (
          <p className="mt-4 rounded-2xl bg-rose-500/10 p-3 text-sm text-rose-200">
            {s.error}
          </p>
        )}

        {texts.length > 0 && (
          <ul className="mt-5 space-y-2">
            {texts.map((t) => (
              <TextItem key={t.id} text={t.kind === "text" ? t.text : ""} />
            ))}
          </ul>
        )}

        {files.length > 0 && (
          <ul className="mt-5 divide-y divide-white/5">
            {files.map((f) => (
              <FileRow
                key={f.id}
                meta={f}
                state={states[f.id]}
                disabled={ended || s.status !== "connected"}
                onDownload={() => downloadOne(f)}
                onCancel={() => session.cancel(f.id)}
              />
            ))}
          </ul>
        )}

        {bigOnIOS && (
          <p className="mt-4 rounded-2xl bg-amber-400/10 p-3 text-xs text-amber-100/90">
            Large files are written to this device's storage first, then you
            save them with the share sheet. Keep Kabootar open and the screen on
            until it finishes.
          </p>
        )}

        {active.length > 0 && (
          <div className="mt-5 rounded-2xl bg-white/[0.04] p-4">
            <div className="flex justify-between text-sm">
              <span className="tabular-nums">
                {formatBytes(receivedBytes)} of {formatBytes(requestedBytes)}
              </span>
              <span className="text-white/60 tabular-nums">
                {formatSpeed(s.speed)} ·{" "}
                {s.speed > 0 ? formatDuration(remaining / s.speed) : "–"} left
              </span>
            </div>
            <div className="progress mt-2">
              <span
                style={{
                  width: `${requestedBytes ? (receivedBytes / requestedBytes) * 100 : 0}%`,
                }}
              />
            </div>
          </div>
        )}

        {pending.length > 0 && !ended && (
          <button
            className="btn-primary mt-5 w-full py-4 text-base"
            disabled={s.status !== "connected"}
            onClick={downloadAll}
          >
            <Icon
              name={
                supportsFolderSave && pending.length > 1 ? "folder" : "download"
              }
            />
            {pending.length === 1
              ? `Download · ${formatBytes(pending[0].size)}`
              : supportsFolderSave
                ? `Save all ${pending.length} to a folder…`
                : `Download all ${pending.length} · ${formatBytes(pending.reduce((n, f) => n + f.size, 0))}`}
          </button>
        )}

        {ended && (
          <Link to="/" className="btn-ghost mt-5 w-full">
            Done
          </Link>
        )}
      </div>
      <Dialog
        open={confirmLeave}
        onClose={() => setConfirmLeave(false)}
        title="Leave this share?"
      >
        <p className="text-sm text-white/60">
          {active.length > 0
            ? "The download in progress will stop."
            : "Files you haven't saved with the Save button will be lost."}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setConfirmLeave(false)}>
            Stay
          </button>
          <button className="btn-danger" onClick={leave}>
            Leave
          </button>
        </div>
      </Dialog>
    </Centered>
  );
}

function TextItem({ text }: { text: string }) {
  return (
    <li className="rounded-2xl border border-white/5 bg-white/[0.03] p-3">
      <p className="text-sm whitespace-pre-wrap text-white/85">
        <LinkifiedText text={text} />
      </p>
      <div className="mt-2 flex justify-end">
        <button
          className="btn-ghost px-3 py-1.5 text-xs"
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            toast("Copied", "success");
          }}
        >
          <Icon name="copy" className="h-3.5 w-3.5" /> Copy
        </button>
      </div>
    </li>
  );
}

function FileRow({
  meta,
  state,
  disabled,
  onDownload,
  onCancel,
}: {
  meta: FileMeta;
  state: ItemState | undefined;
  disabled: boolean;
  onDownload: () => void;
  onCancel: () => void;
}) {
  const st = state?.status ?? "idle";
  const pct = meta.size
    ? ((state?.received ?? 0) / meta.size) * 100
    : st === "done"
      ? 100
      : 0;
  return (
    <li className="py-3">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/5 text-white/70">
          <Icon
            name={st === "done" ? "check" : "file"}
            className={st === "done" ? "h-5 w-5 text-emerald-300" : "h-5 w-5"}
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {meta.path ?? meta.name}
          </p>
          <p className="flex items-center gap-1.5 text-xs text-white/45">
            {fileKind(meta.type, meta.name)} · {formatBytes(meta.size)}
            {st === "done" && state?.verified && (
              <Tip
                tip={verifiedHelp}
                className="inline-flex items-center gap-1 text-emerald-300/80"
              >
                · <Icon name="shield" className="h-3 w-3" /> Verified
              </Tip>
            )}
            {st === "error" && (
              <span className="text-rose-300">· {state?.error}</span>
            )}
          </p>
        </div>
        {(st === "idle" || st === "error" || st === "cancelled") && (
          <button
            className="icon-btn"
            disabled={disabled}
            onClick={onDownload}
            aria-label={`Download ${meta.name}`}
          >
            <Icon name="download" />
          </button>
        )}
        {(st === "queued" || st === "receiving") && (
          <button
            className="icon-btn"
            onClick={onCancel}
            aria-label={`Cancel ${meta.name}`}
          >
            <Icon name="x" className="h-4 w-4" />
          </button>
        )}
        {st === "verifying" && <Spinner />}
        {st === "done" && state?.file && (isIOS || state.file.size > 0) && (
          <button
            className="btn-ghost px-3 py-1.5 text-xs"
            onClick={() => shareOrDownload(state.file!)}
          >
            Save
          </button>
        )}
      </div>
      {(st === "receiving" || st === "queued") && (
        <div className="mt-2 pl-13">
          <div className="progress">
            <span style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}
    </li>
  );
}

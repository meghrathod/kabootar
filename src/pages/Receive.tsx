import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { Icon } from "../components/Icon";
import { toast } from "../components/Toasts";
import { CodeInput, Dialog, Postmark, Spinner } from "../components/ui";
import { type RoomInfo, errorMessage, joinWithPin } from "../lib/api";
import { Discovery } from "../lib/discovery";
import { isIOS } from "../lib/platform";
import { stage } from "../lib/stage";
import { useStore } from "../lib/useStore";

export default function Receive() {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<RoomInfo>();
  const [pin, setPin] = useState("");
  const discovery = useMemo(() => new Discovery(), []);
  const { rooms, status, hidden } = useStore(discovery.store);

  useEffect(() => () => discovery.close(), [discovery]);
  useEffect(() => stage.set({ mode: "perch", effort: 0 }), []);

  const join = async (value: string, roomId?: string) => {
    if (value.length !== 6) return;
    setBusy(true);
    try {
      const { room, clientKey } = await joinWithPin(value, roomId);
      navigate(`/${room.id}#k=${clientKey}`);
    } catch (err) {
      toast(errorMessage(err), "error");
      setCode("");
      setPin("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6">
      <section className="panel animate-rise p-6">
        <p className="text-sm text-white/60">Enter the code from the sender's screen.</p>
        <div className="mt-5">
          <CodeInput value={code} onChange={setCode} onComplete={(v) => join(v)} autoFocus disabled={busy} />
        </div>
        <button className="btn-primary mt-5 w-full" disabled={code.length !== 6 || busy} onClick={() => join(code)}>
          {busy ? <Spinner /> : <Icon name="download" className="h-4 w-4" />}
          Connect
        </button>
      </section>

      <section className="panel animate-rise p-6 [animation-delay:80ms]">
        <div className="flex items-center gap-2">
          <h2 className="label">Nearby</h2>
          {status !== "open" && !hidden && <Spinner className="ml-auto h-3.5 w-3.5" />}
        </div>
        {hidden ? (
          <div className="mt-3 space-y-2 text-sm text-white/60">
            <p>
              {isIOS ? "iCloud Private Relay" : "A VPN or iCloud Private Relay"} hides your network, so shares nearby
              aren't listed here. You don't need to turn it off: enter the code above and sharing works as usual,
              just possibly a little slower.
            </p>
            <p className="text-xs text-white/45">
              {isIOS
                ? "Optional, to see nearby shares on this Wi-Fi: Settings → Wi-Fi → ⓘ next to your network → turn off Limit IP Address Tracking."
                : "Optional, to see nearby shares: turn off your VPN or iCloud Private Relay for this network."}
            </p>
          </div>
        ) : rooms.length === 0 ? (
          <div className="mt-4 flex items-center gap-3 text-sm text-white/50">
            <span className="relative flex h-8 w-8 items-center justify-center">
              <span className="absolute inset-0 animate-ping rounded-full bg-sky/20" />
              <Icon name="radar" className="h-5 w-5 text-sky" />
            </span>
            Looking for shares on your network…
          </div>
        ) : (
          <ul className="mt-3 space-y-2">
            {rooms.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => setPicked(r)}
                  className="flex w-full items-center gap-3 rounded-2xl border border-white/5 bg-white/[0.03] p-3 text-left transition hover:bg-white/[0.07]"
                >
                  <Postmark room={r} size={40} />
                  <span className="flex-1 font-medium">{r.name}</span>
                  <Icon name="arrowLeft" className="h-4 w-4 rotate-180 text-white/40" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog open={!!picked} onClose={() => (setPicked(undefined), setPin(""))} title={picked?.name ?? ""}>
        <p className="mb-4 text-sm text-white/60">Enter the code shown on the sender's screen.</p>
        <CodeInput value={pin} onChange={setPin} onComplete={(v) => join(v, picked?.id)} autoFocus disabled={busy} />
        <button className="btn-primary mt-5 w-full" disabled={pin.length !== 6 || busy} onClick={() => join(pin, picked?.id)}>
          {busy && <Spinner />} Connect
        </button>
      </Dialog>
    </div>
  );
}

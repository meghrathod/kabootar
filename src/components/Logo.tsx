import { type CSSProperties, type RefObject, useEffect, useRef } from "react";
import { Link } from "react-router";

import { stage } from "../lib/stage";
import { useStore } from "../lib/useStore";

/** Wingbeat at rest; faster transfers speed it up to FLAP_BASE / FLAP_FAST. */
const FLAP_BASE = 0.75;
const FLAP_FAST = 0.35;

/**
 * The logo, centered. During a transfer it flies (beating faster when the
 * transfer is faster); when something arrives it does a little hop.
 */
export function Logo({
  size = "7rem",
  link = false,
}: {
  size?: string;
  link?: boolean;
}) {
  const { mode, effort } = useStore(stage);
  const img = useRef<HTMLImageElement>(null);
  useFlapRate(img, mode === "fly", effort);

  const bird = (
    <span
      className="kb-perch relative mx-auto block transition-[width] duration-[600ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]"
      data-mode={mode}
      style={{ width: size, "--flap": `${FLAP_BASE}s` } as CSSProperties}
    >
      <img
        ref={img}
        src="/assets/logo-mark.png"
        alt=""
        className="kb-bird block w-full"
        onAnimationEnd={(e) => {
          if (e.animationName === "kb-hop") stage.set({ mode: "perch" });
        }}
      />
    </span>
  );
  return link ? (
    <Link to="/" aria-label="Kabootar home" className="block w-fit mx-auto">
      {bird}
    </Link>
  ) : (
    <div aria-hidden>{bird}</div>
  );
}

/**
 * Speeds the wingbeat up with effort without jumps. Changing the CSS
 * animation's duration mid-flight makes the browser recompute its position,
 * so the bird skipped to another point in its beat on every speed update.
 * Changing the playback rate keeps the current position; easing towards the
 * target rate keeps the speed-up gradual.
 */
function useFlapRate(
  img: RefObject<HTMLImageElement | null>,
  flying: boolean,
  effort: number,
) {
  const target = useRef(1);
  useEffect(() => {
    target.current = FLAP_BASE / (FLAP_BASE - (FLAP_BASE - FLAP_FAST) * effort);
  }, [effort]);

  useEffect(() => {
    if (!flying) return;
    let frame = 0;
    let rate = 1;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const el = img.current;
      const fly = el
        ?.getAnimations()
        .find((a) => (a as CSSAnimation).animationName === "kb-fly");
      if (!fly) return;
      rate += (target.current - rate) * 0.05;
      // Skip changes too small to see; each update costs a style pass.
      if (Math.abs(fly.playbackRate - rate) > 0.01)
        fly.updatePlaybackRate(rate);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [img, flying]);
}

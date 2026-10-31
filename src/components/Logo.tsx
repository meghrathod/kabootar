import type { CSSProperties } from "react";
import { Link } from "react-router";

import { stage } from "../lib/stage";
import { useStore } from "../lib/useStore";

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
  const bird = (
    <span
      className="kb-perch relative mx-auto block transition-[width] duration-[600ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]"
      data-mode={mode}
      style={
        { width: size, "--flap": `${0.75 - 0.4 * effort}s` } as CSSProperties
      }
    >
      <img
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

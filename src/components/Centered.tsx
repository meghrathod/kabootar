import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

const TOP = 28;

/**
 * Vertically centers its content, or pins it near the top when `top` is set.
 * Position changes glide with a transform instead of jumping.
 */
export function Centered({
  children,
  className = "",
  top = false,
}: {
  children: ReactNode;
  className?: string;
  top?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const topRef = useRef(top);
  topRef.current = top;
  const [layout, setLayout] = useState({ offset: 0, height: 0, ready: false });
  const measureRef = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const h = el.offsetHeight;
      const vh = window.innerHeight;
      const offset = topRef.current ? TOP : Math.max(TOP, (vh - h) / 2);
      setLayout((l) => ({
        offset,
        height: Math.max(vh, h + offset + TOP),
        ready: l.ready || l.height > 0,
      }));
    };
    measureRef.current = measure;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  useLayoutEffect(() => measureRef.current(), [top]);

  return (
    <div style={{ height: layout.height || "100dvh" }}>
      <div
        ref={ref}
        className={`mx-auto w-full px-5 ${layout.ready ? "transition-transform duration-[600ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]" : ""} ${className}`}
        style={{ transform: `translateY(${layout.offset}px)` }}
      >
        {children}
      </div>
    </div>
  );
}

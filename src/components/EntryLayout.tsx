import { NavLink, Outlet, useLocation } from "react-router";

import { draft } from "../lib/draft";
import { useStore } from "../lib/useStore";
import { Centered } from "./Centered";
import { Logo } from "./Logo";

/**
 * Logo, wordmark and the Send / Receive switch, mounted across both modes.
 * Centered and large when there's nothing else to show; when the page has
 * content (receive, or files staged to send) it shrinks and moves up.
 */
export function EntryLayout() {
  const { pathname } = useLocation();
  const { files, texts } = useStore(draft);
  const compact = pathname === "/receive" || files.length + texts.length > 0;
  const ease = "duration-[600ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]";

  return (
    <Centered className="max-w-xl" top={compact}>
      <header className="flex flex-col items-center text-center">
        <Logo size={compact ? "3.25rem" : "7rem"} />
        <h1
          className={`font-display leading-none font-extrabold tracking-tight transition-all ${ease} ${
            compact ? "mt-1 text-3xl md:text-4xl" : "mt-3 text-6xl md:text-8xl"
          }`}
        >
          Kabootar
        </h1>
        <nav
          className={`grid w-64 grid-cols-2 rounded-xl border border-white/10 bg-ink-2 p-1 transition-all ${ease} ${
            compact ? "mt-4" : "mt-7"
          }`}
          aria-label="Mode"
        >
          {[
            ["/", "Send"],
            ["/receive", "Receive"],
          ].map(([to, label]) => (
            <NavLink
              key={to}
              to={to}
              end
              className={({ isActive }) =>
                `rounded-lg py-2 text-center font-mono text-xs font-medium tracking-[0.14em] uppercase transition ${
                  isActive
                    ? "bg-sky text-ink"
                    : "text-white/55 hover:text-white"
                }`
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
      </header>
      <div className={`transition-all ${ease} ${compact ? "mt-6" : "mt-8"}`}>
        {/* Re-keyed per mode so switching Send/Receive cross-fades. */}
        <div key={pathname} className="animate-rise">
          <Outlet />
        </div>
      </div>
    </Centered>
  );
}

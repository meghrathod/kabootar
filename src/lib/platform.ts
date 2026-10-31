const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";

export const isIOS =
  /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1);
export const isAndroid = /Android/.test(ua);
export const isMobile = isIOS || isAndroid;
export const isSafari = /Safari/.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|Android/.test(ua);
export const isFirefox = /Firefox|FxiOS/.test(ua);

export const isStandalone =
  typeof window !== "undefined" &&
  (window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true);

export const hasSavePicker = typeof window !== "undefined" && "showSaveFilePicker" in window && !isMobile;
export const hasDirectoryPicker = typeof window !== "undefined" && "showDirectoryPicker" in window && !isMobile;
export const hasOPFS = typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;
export const canShareFiles =
  typeof navigator !== "undefined" &&
  !!navigator.canShare &&
  (() => {
    try {
      return navigator.canShare({ files: [new File([""], "x.txt", { type: "text/plain" })] });
    } catch {
      return false;
    }
  })();

/** Keeps the screen awake during transfers; mobile browsers suspend background tabs. */
export class WakeLock {
  private sentinel: WakeLockSentinel | undefined;
  private wanted = false;

  constructor() {
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (this.wanted && document.visibilityState === "visible") void this.acquire();
      });
    }
  }

  async acquire() {
    this.wanted = true;
    if (this.sentinel || !("wakeLock" in navigator)) return;
    try {
      this.sentinel = await navigator.wakeLock.request("screen");
      this.sentinel.addEventListener("release", () => (this.sentinel = undefined));
    } catch {
      // Denied (e.g. low battery); transfers still work while visible.
    }
  }

  release() {
    this.wanted = false;
    void this.sentinel?.release();
    this.sentinel = undefined;
  }
}

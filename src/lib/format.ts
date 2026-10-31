const units = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const v = bytes / 1024 ** i;
  return `${v.toFixed(i === 0 || v >= 100 ? 0 : digits)} ${units[i]}`;
}

export function formatSpeed(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "–";
  if (seconds < 1) return "<1s";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${r.toString().padStart(2, "0")}s`;
  return `${r}s`;
}

/** Exponentially smoothed throughput meter. */
export class SpeedMeter {
  private lastBytes = 0;
  private lastTime = 0;
  speed = 0;

  constructor(private alpha = 0.3) {}

  reset(bytes = 0) {
    this.lastBytes = bytes;
    this.lastTime = performance.now();
    this.speed = 0;
  }

  sample(bytes: number): number {
    const now = performance.now();
    const dt = (now - this.lastTime) / 1000;
    if (dt >= 0.25) {
      const instant = Math.max(0, bytes - this.lastBytes) / dt;
      this.speed =
        this.speed === 0
          ? instant
          : this.alpha * instant + (1 - this.alpha) * this.speed;
      this.lastBytes = bytes;
      this.lastTime = now;
    }
    return this.speed;
  }
}

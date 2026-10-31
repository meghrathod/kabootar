/**
 * The app is normally served by the same Go process that handles signalling,
 * so everything is same-origin. VITE_SERVER_URL allows a split deployment.
 */
const override = import.meta.env.VITE_SERVER_URL as string | undefined;

export const httpBase = (override ?? location.origin).replace(/\/$/, "");
export const wsBase = httpBase.replace(/^http/, "ws");

export const fallbackIceServers: RTCIceServer[] = [
  { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] },
];

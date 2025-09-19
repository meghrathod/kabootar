export const iceServers: RTCConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
    { urls: "stun:stun4.l.google.com:19302" },
  ],
  iceCandidatePoolSize: 10,
};

const envSecure = import.meta.env.VITE_SIGNALING_SECURE;
const envHost = import.meta.env.VITE_SIGNALING_HOST;
const isBrowser = typeof window !== "undefined";

let resolvedSecure = true;
if (envSecure !== undefined) {
  resolvedSecure = envSecure === "true";
} else if (import.meta.env.DEV) {
  resolvedSecure = false;
} else if (isBrowser) {
  resolvedSecure = window.location.protocol === "https:";
}

export const secure = resolvedSecure;

let resolvedHost = "localhost";
if (envHost !== undefined) {
  resolvedHost = envHost;
} else if (import.meta.env.DEV) {
  resolvedHost = "localhost:5000";
} else if (isBrowser) {
  resolvedHost = window.location.host;
}

export const baseURL = resolvedHost;
export const httpScheme = secure ? "https://" : "http://";
export const wsScheme = secure ? "wss://" : "ws://";

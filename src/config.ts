export const iceServers: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export const secure = false; // TODO(AG): Flip this to true once we have a tailscale setup
export const baseURL = "lithium.ts:5000";
export const httpScheme = secure ? "https://" : "http://";
export const wsScheme = secure ? "wss://" : "ws://";

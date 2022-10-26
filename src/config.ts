export const iceServers: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export const secure = true; // TODO(AG): Flip this to true once we have a tailscale setup
export const baseURL = "signaling.staging.kabootar.potatokitty.me";
export const httpScheme = secure ? "https://" : "http://";
export const wsScheme = secure ? "wss://" : "ws://";

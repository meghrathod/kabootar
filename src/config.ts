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

export const secure = true;
export const baseURL = "signaling.kabootar.meghrathod.dev";
export const httpScheme = secure ? "https://" : "http://";
export const wsScheme = secure ? "wss://" : "ws://";

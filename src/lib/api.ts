import { httpBase } from "./config";

export interface RoomInfo {
  id: string;
  name: string;
  emoji: string;
  color: string;
}

export interface CreatedRoom extends RoomInfo {
  /** Network keys this share is listed under for "Nearby" (diagnostics). */
  network?: string[];
  /** The sender is behind Private Relay / a VPN, so the share isn't listed nearby. */
  hidden?: boolean;
  masterKey: string;
  clientKey: string;
  pin: string;
  expiresAt: string;
}

export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
  ) {
    super(code);
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${httpBase}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError("offline", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? "unknown", res.status);
  return data as T;
}

export function createRoom(discoverable: boolean, ip?: { v4?: string; v6?: string }) {
  return post<CreatedRoom>("/api/rooms", { discoverable, ip: ip?.v4 ?? "", ip6: ip?.v6 ?? "" });
}

export function joinWithPin(pin: string, roomId?: string) {
  return post<{ room: RoomInfo; clientKey: string }>("/api/join", { pin, roomId: roomId ?? "" });
}

export function errorMessage(err: unknown): string {
  const code = err instanceof ApiError ? err.code : err instanceof Error ? err.message : String(err);
  switch (code) {
    case "offline":
      return "Can't reach the Kabootar server. Check your connection.";
    case "rate_limited":
      return "Too many attempts. Wait a minute and try again.";
    case "room_not_found":
      return "No share found with that code.";
    case "invalid_key":
      return "This share link is invalid or has expired.";
    case "room_full":
      return "This share already has the maximum number of receivers.";
    case "server_busy":
      return "The server is busy right now. Try again shortly.";
    case "master_absent":
      return "The sender is not connected right now.";
    default:
      return "Something went wrong. Please try again.";
  }
}

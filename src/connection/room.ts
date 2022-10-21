import { getPublicIP } from "./ip";

class Room {
  static async create() {
    const response = await fetch("http://localhost:5000/room", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(await getDiscoveryParams()),
    });
    await response.json();
  }
}

async function getDiscoveryParams(): Promise<[string, string]> {
  try {
    const ip = await getPublicIP();
    if (ip !== undefined) {
      return ["t", ip];
    }

    return ["f", ""];
  } catch {
    return ["f", ""];
  }
}

export default Room;

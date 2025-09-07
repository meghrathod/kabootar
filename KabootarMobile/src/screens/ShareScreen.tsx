import React, { useEffect, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Modal } from "react-native";
import QRCodeSVG from "react-native-qrcode-svg";
import * as Clipboard from "expo-clipboard";
import { NativeStackScreenProps } from "@react-navigation/native-stack";
import { RootStackParamList } from "../../App";
import Room from "../connection/room";

export type ShareProps = NativeStackScreenProps<RootStackParamList, "Share">;

export default function ShareScreen({ route, navigation }: ShareProps) {
  const [room, setRoom] = useState<Room<boolean> | undefined>();
  const [url, setUrl] = useState("");
  const [progress, setProgress] = useState(0);
  const [connected, setConnected] = useState(false);
  const [needsStart, setNeedsStart] = useState(true);
  const [qrOpen, setQrOpen] = useState(false);

  useEffect(() => {
    (async () => {
      if (!room) {
        const id = route.params?.id;
        const key = route.params?.key?.replace(/^k=/, "");
        if (id && key) {
          const newRoom = await Room.joinDirect(id, key, {
            roomMetaChanged(name: string, roomName: string, emoji: string) {},
            connectionStatusChanged(connected: boolean) {
              setConnected(connected);
            },
            receivePercentageChanged(percentage: number) {
              setProgress(percentage);
            },
            connectionSpeed(_speed: number) {},
            needsStart(needs: boolean) {
              setNeedsStart(needs);
            },
            complete() {
              navigation.replace("Home");
            },
          });
          if (newRoom) setRoom(newRoom as any);
        }
      }
    })();
  }, [route.params]);

  useEffect(() => {
    return () => {
      room?.close();
      setRoom(undefined);
    };
  }, [room]);

  useEffect(() => {
    if (room?.isMaster) {
      setUrl(`https://kabootar.me/${room.id}#${(room as any).constructHash()}`);
    }
  }, [room]);

  const copyURL = async () => {
    if (!url) return;
    await Clipboard.setStringAsync(url);
  };

  return (
    <View style={styles.container}>
      {room ? (
        <View style={styles.card}>
          {room.isMaster ? (
            <>
              <View style={{ marginBottom: 12 }}>
                <Text style={styles.url} numberOfLines={1}>
                  {url}
                </Text>
                <TouchableOpacity style={styles.btnInline} onPress={copyURL}>
                  <Text style={styles.btnText}>Copy URL</Text>
                </TouchableOpacity>
              </View>
              <View style={{ flexDirection: "row", gap: 12 }}>
                <TouchableOpacity
                  style={styles.btn}
                  onPress={() => setQrOpen(true)}
                >
                  <Text style={styles.btnText}>QR Code</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.footer}>Peers: —/8</Text>
            </>
          ) : (
            <>
              {connected ? (
                needsStart ? (
                  <TouchableOpacity
                    style={styles.btn}
                    onPress={() => (room as any).dispatch("ready")}
                  >
                    <Text style={styles.btnText}>Start Download</Text>
                  </TouchableOpacity>
                ) : (
                  <>
                    <View style={styles.progressBar}>
                      <View
                        style={[styles.progress, { width: `${progress}%` }]}
                      />
                    </View>
                    <Text style={styles.footer}>Receiving: {progress}%</Text>
                  </>
                )
              ) : (
                <Text style={styles.footer}>Connecting…</Text>
              )}
            </>
          )}
        </View>
      ) : (
        <Text style={{ color: "white" }}>Connecting…</Text>
      )}

      <Modal
        visible={qrOpen}
        transparent
        onRequestClose={() => setQrOpen(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modal}>
            <QRCodeSVG
              value={url || "kabootar"}
              size={220}
              color="white"
              backgroundColor="transparent"
            />
            <TouchableOpacity
              style={[styles.btn, { marginTop: 16 }]}
              onPress={() => setQrOpen(false)}
            >
              <Text style={styles.btnText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  card: {
    backgroundColor: "rgba(0,0,0,0.5)",
    padding: 16,
    borderRadius: 8,
    width: "100%",
    maxWidth: 600,
  },
  url: { color: "white", marginBottom: 6 },
  btn: {
    backgroundColor: "rgba(255,255,255,0.2)",
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 6,
    alignSelf: "flex-start",
  },
  btnInline: {
    backgroundColor: "rgba(255,255,255,0.15)",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
    alignSelf: "flex-start",
  },
  btnText: { color: "white", fontWeight: "700" },
  footer: { color: "white", marginTop: 12 },
  progressBar: {
    width: "100%",
    height: 8,
    borderRadius: 4,
    backgroundColor: "#222",
    overflow: "hidden",
    marginTop: 12,
  },
  progress: { height: "100%", backgroundColor: "#4ade80" },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
  },
  modal: {
    backgroundColor: "rgba(0,0,0,0.85)",
    borderRadius: 8,
    padding: 16,
    width: 260,
    alignItems: "center",
  },
});

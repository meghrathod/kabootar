import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, TextInput, Modal } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../App';
import Discovery, { DiscoveredRoomItem } from '../connection/discovery';
import Room from '../connection/room';

export type DiscoverProps = NativeStackScreenProps<RootStackParamList, 'Discover'>;

export default function DiscoverScreen({ navigation }: DiscoverProps) {
  const [rooms, setRooms] = useState<Record<string, DiscoveredRoomItem>>({});
  const [selected, setSelected] = useState<DiscoveredRoomItem | undefined>();
  const [pin, setPin] = useState('');

  useEffect(() => {
    let client: Discovery | undefined;
    (async () => {
      client = await Discovery.connect(
        (room) => setRooms((r) => ({ ...r, [room.id]: room })),
        (id) => setRooms((r) => { const copy = { ...r }; delete copy[id]; return copy; }),
      );
    })();
    return () => client?.close();
  }, []);

  const connect = async () => {
    if (!selected) return;
    const key = await Room.getClientKey(selected.id, pin);
    if (!key) return;
    navigation.navigate('Share', { id: selected.id, key: key });
    setSelected(undefined);
    setPin('');
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Discovering…</Text>
      <FlatList
        data={Object.values(rooms)}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.item} onPress={() => setSelected(item)}>
            <Text style={styles.emoji}>{item.emoji}</Text>
            <Text style={styles.name}>{item.name}</Text>
          </TouchableOpacity>
        )}
        ListEmptyComponent={<Text style={{ color: '#ccc' }}>No nearby shares found</Text>}
      />

      <Modal visible={!!selected} transparent animationType="fade" onRequestClose={() => setSelected(undefined)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modal}>
            <Text style={{ color: 'white', fontWeight: '800', fontSize: 16, marginBottom: 8 }}>Enter PIN</Text>
            <TextInput
              value={pin}
              onChangeText={setPin}
              placeholder="PIN"
              placeholderTextColor="#999"
              keyboardType="number-pad"
              style={styles.input}
            />
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <TouchableOpacity style={styles.btn} onPress={connect}><Text style={styles.btnText}>Connect</Text></TouchableOpacity>
              <TouchableOpacity style={[styles.btn, { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#666' }]} onPress={() => setSelected(undefined)}>
                <Text style={styles.btnText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', padding: 16 },
  title: { color: 'white', fontSize: 20, fontWeight: '700', marginBottom: 12 },
  item: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#222' },
  emoji: { color: 'white', fontSize: 20, marginRight: 12 },
  name: { color: 'white', fontSize: 16, fontWeight: '600' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' },
  modal: { backgroundColor: 'rgba(0,0,0,0.85)', borderRadius: 8, padding: 16, width: '80%' },
  input: { backgroundColor: '#111', color: 'white', paddingHorizontal: 12, paddingVertical: 10, borderRadius: 6, marginBottom: 12, borderWidth: 1, borderColor: '#222' },
  btn: { backgroundColor: 'rgba(255,255,255,0.2)', paddingVertical: 10, paddingHorizontal: 16, borderRadius: 6 },
  btnText: { color: 'white', fontWeight: '700' },
});
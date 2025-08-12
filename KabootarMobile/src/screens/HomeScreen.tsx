import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../App';
import Room from '../connection/room';

export type HomeProps = NativeStackScreenProps<RootStackParamList, 'Home'>;

export default function HomeScreen({ navigation }: HomeProps) {
  const [shareDisabled, setShareDisabled] = useState(false);

  const createRoom = async () => {
    const result = await DocumentPicker.getDocumentAsync({ multiple: false });
    if (result.canceled || !result.assets?.length) return;
    const file = result.assets[0] as any;

    setShareDisabled(true);
    const room = await Room.create(file, {
      numClientsChanged(n: number) {
        // could show peers count
      },
    });
    if (room) {
      navigation.navigate('Share', { id: room.id, key: (room as any).constructHash() });
    }
    setShareDisabled(false);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Kabootar</Text>
      <TouchableOpacity style={[styles.btn, shareDisabled && styles.btnDisabled]} onPress={createRoom} disabled={shareDisabled}>
        <Text style={styles.btnText}>Share a file</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.link} onPress={() => navigation.navigate('Discover')}>
        <Text style={styles.linkText}>Discover nearby</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { color: 'white', fontSize: 32, fontWeight: '800', marginBottom: 24 },
  btn: { backgroundColor: 'rgba(255,255,255,0.2)', paddingVertical: 12, paddingHorizontal: 20, borderRadius: 8 },
  btnDisabled: { opacity: 0.6 },
  btnText: { color: 'white', fontSize: 16, fontWeight: '700' },
  link: { marginTop: 16 },
  linkText: { color: '#ccc' },
});
import React, { useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator, ScrollView } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/types';
import { adminResetCode } from '../api/client';
import { useSession } from '../context/SessionContext';

type Props = NativeStackScreenProps<RootStackParamList, 'Admin'>;

export default function AdminScreen({ navigation }: Props) {
  const { session, setKioskLocked } = useSession();
  const [resetUsername, setResetUsername] = useState('');
  const [isResetting, setIsResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issuedCode, setIssuedCode] = useState<{ employeeId: string; setupCode: string } | null>(null);

  if (!session) return null;

  const onReset = async () => {
    setError(null);
    setIssuedCode(null);
    setIsResetting(true);
    const result = await adminResetCode(session.sessionToken, resetUsername.trim());
    setIsResetting(false);

    if (result.success) {
      setIssuedCode({ employeeId: result.employeeId, setupCode: result.setupCode });
      setResetUsername('');
    } else {
      setError(result.message);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {issuedCode && (
        <View style={styles.codeCard}>
          <Text style={styles.codeLabel}>Setup code for {issuedCode.employeeId}</Text>
          <Text style={styles.codeValue}>{issuedCode.setupCode}</Text>
          <Text style={styles.codeHint}>
            Share this with them directly. It only works once for their first login.
          </Text>
        </View>
      )}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <Text style={styles.sectionTitle}>Start Kiosk Mode</Text>
      <Text style={styles.kioskHint}>
        Turns this device into a shared check-in station. Employees type their personal 4-digit code — no QR, no
        login. Leave it plugged in at the entrance.
      </Text>
      <Pressable
        style={styles.button}
        onPress={async () => {
          await setKioskLocked(true);
          navigation.navigate('Kiosk');
        }}
      >
        <Text style={styles.buttonText}>Start Kiosk Mode</Text>
      </Pressable>

      <View style={styles.divider} />

      <Text style={styles.sectionTitle}>Lost Device / New Setup Code</Text>
      <Text style={styles.kioskHint}>
        For pairing an admin account (like this one) onto another device — regular employees use their Kiosk code,
        not this.
      </Text>
      <Text style={styles.label}>Username</Text>
      <TextInput style={styles.input} value={resetUsername} onChangeText={setResetUsername} autoCapitalize="characters" placeholder="EMP002" />
      <Pressable
        style={[styles.button, styles.buttonSecondary, isResetting && styles.buttonDisabled]}
        onPress={onReset}
        disabled={isResetting || !resetUsername}
      >
        {isResetting ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Issue New Setup Code</Text>}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 24, paddingBottom: 48 },
  sectionTitle: { fontSize: 16, fontWeight: '600', marginBottom: 16 },
  label: { fontSize: 14, color: '#555', marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
    fontSize: 16
  },
  error: { color: '#c0392b', marginBottom: 16, textAlign: 'center' },
  button: { backgroundColor: '#2e7d32', borderRadius: 8, padding: 14, alignItems: 'center' },
  buttonSecondary: { backgroundColor: '#455a64' },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  divider: { height: 1, backgroundColor: '#eee', marginVertical: 32 },
  kioskHint: { fontSize: 13, color: '#777', marginBottom: 16, lineHeight: 18 },
  codeCard: {
    backgroundColor: '#e8f5e9',
    borderRadius: 12,
    padding: 20,
    marginBottom: 24,
    alignItems: 'center'
  },
  codeLabel: { fontSize: 14, color: '#2e7d32', marginBottom: 8 },
  codeValue: { fontSize: 32, fontWeight: '700', letterSpacing: 4, color: '#1b5e20', marginBottom: 8 },
  codeHint: { fontSize: 12, color: '#2e7d32', textAlign: 'center', marginBottom: 12 }
});

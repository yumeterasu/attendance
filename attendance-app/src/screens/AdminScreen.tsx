import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator, ScrollView } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import Constants from 'expo-constants';
import { RootStackParamList } from '../navigation/types';
import { adminResetCode } from '../api/client';
import { useSession } from '../context/SessionContext';
import { AttemptEntry, clearAttemptLog, getAttemptLog } from '../utils/attemptLog';
import { getQueueLength } from '../utils/offlineQueue';

// Read straight from app.config.ts's `version` at build time -- one place to
// bump (already done for every release), nothing to keep in sync by hand.
const APP_VERSION = Constants.expoConfig?.version ?? 'unknown';

type Props = NativeStackScreenProps<RootStackParamList, 'Admin'>;

const RESULT_LABELS: Record<AttemptEntry['result'], string> = {
  success: 'OK',
  timeout: 'Timed out',
  network_error: 'No connection',
  rejected: 'Rejected'
};

const RESULT_COLORS: Record<AttemptEntry['result'], string> = {
  success: '#2e7d32',
  timeout: '#e65100',
  network_error: '#c0392b',
  rejected: '#777'
};

export default function AdminScreen({ navigation }: Props) {
  const { session, setKioskLocked } = useSession();
  const [resetUsername, setResetUsername] = useState('');
  const [isResetting, setIsResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issuedCode, setIssuedCode] = useState<{ employeeId: string; setupCode: string } | null>(null);
  const [attemptLog, setAttemptLog] = useState<AttemptEntry[] | null>(null);
  const [pendingSyncCount, setPendingSyncCount] = useState<number | null>(null);

  useEffect(() => {
    getQueueLength().then(setPendingSyncCount);
  }, []);

  if (!session) return null;

  const onToggleLog = async () => {
    if (attemptLog !== null) {
      setAttemptLog(null);
      return;
    }
    setAttemptLog(await getAttemptLog());
  };

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

      <View style={styles.divider} />

      <Text style={styles.sectionTitle}>Connection Log</Text>
      {pendingSyncCount !== null && pendingSyncCount > 0 && (
        <View style={styles.pendingSyncBadge}>
          <Text style={styles.pendingSyncText}>
            {pendingSyncCount} check-in{pendingSyncCount === 1 ? '' : 's'} recorded offline, waiting to sync
          </Text>
        </View>
      )}
      <Text style={styles.kioskHint}>
        Every kiosk PIN attempt made on this device, including ones that never reached the server -- useful for
        pinpointing exactly when and why a check-in got stuck.
      </Text>
      <Pressable style={[styles.button, styles.buttonSecondary]} onPress={onToggleLog}>
        <Text style={styles.buttonText}>{attemptLog === null ? 'View Connection Log' : 'Hide Connection Log'}</Text>
      </Pressable>

      {attemptLog !== null && (
        <View style={styles.logBox}>
          {attemptLog.length === 0 && <Text style={styles.logEmpty}>No attempts recorded yet on this device.</Text>}
          {attemptLog.map((entry, i) => (
            <View key={i} style={styles.logRow}>
              <Text style={styles.logTime}>{new Date(entry.timestamp).toLocaleString()}</Text>
              <Text style={[styles.logResult, { color: RESULT_COLORS[entry.result] }]}>
                {RESULT_LABELS[entry.result]}
              </Text>
              <Text style={styles.logAction}>{entry.action}</Text>
            </View>
          ))}
          {attemptLog.length > 0 && (
            <Pressable
              style={styles.clearLogButton}
              onPress={async () => {
                await clearAttemptLog();
                setAttemptLog([]);
              }}
            >
              <Text style={styles.clearLogButtonText}>Clear log</Text>
            </Pressable>
          )}
        </View>
      )}

      <Text style={styles.versionText}>Attendance v{APP_VERSION}</Text>
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
  pendingSyncBadge: {
    backgroundColor: '#fff3e0',
    borderRadius: 8,
    padding: 10,
    marginBottom: 12
  },
  pendingSyncText: { color: '#e65100', fontSize: 13, fontWeight: '600', textAlign: 'center' },
  codeCard: {
    backgroundColor: '#e8f5e9',
    borderRadius: 12,
    padding: 20,
    marginBottom: 24,
    alignItems: 'center'
  },
  codeLabel: { fontSize: 14, color: '#2e7d32', marginBottom: 8 },
  codeValue: { fontSize: 32, fontWeight: '700', letterSpacing: 4, color: '#1b5e20', marginBottom: 8 },
  codeHint: { fontSize: 12, color: '#2e7d32', textAlign: 'center', marginBottom: 12 },
  logBox: {
    marginTop: 16,
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 8,
    padding: 12
  },
  logEmpty: { fontSize: 13, color: '#999', textAlign: 'center', paddingVertical: 12 },
  logRow: { paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f2f2f2' },
  logTime: { fontSize: 11, color: '#999' },
  logResult: { fontSize: 13, fontWeight: '700', marginTop: 2 },
  logAction: { fontSize: 11, color: '#aaa', marginTop: 1 },
  clearLogButton: { marginTop: 8, alignItems: 'center', paddingVertical: 8 },
  clearLogButtonText: { fontSize: 12, color: '#c0392b', fontWeight: '600' },
  versionText: { fontSize: 12, color: '#bbb', textAlign: 'center', marginTop: 40 }
});

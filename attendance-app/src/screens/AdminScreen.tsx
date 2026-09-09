import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, StyleSheet, ActivityIndicator, ScrollView, Alert } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import Constants from 'expo-constants';
import { RootStackParamList } from '../navigation/types';
import { adminResetCode } from '../api/client';
import { useSession } from '../context/SessionContext';
import { AttemptEntry, clearAttemptLog, getAttemptLog } from '../utils/attemptLog';
import { getQueueLength } from '../utils/offlineQueue';
import { DeviceBranch, DEVICE_BRANCH_LABELS, getDeviceBranch, setDeviceBranch } from '../utils/deviceBranch';

// Derived from DEVICE_BRANCH_LABELS (the single source of truth for what
// branches exist) rather than its own separate list, so a future branch
// added there automatically becomes selectable here too.
const BRANCH_OPTIONS = Object.keys(DEVICE_BRANCH_LABELS) as DeviceBranch[];

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
  const [deviceBranch, setDeviceBranchState] = useState<DeviceBranch | null>(null);
  const [branchLoaded, setBranchLoaded] = useState(false);
  const [isSavingBranch, setIsSavingBranch] = useState(false);
  const [branchSaveError, setBranchSaveError] = useState(false);
  // True once onSelectBranch has been called at least once -- guards
  // against the mount-time load below resolving AFTER a fast tap's own
  // read-back and clobbering the just-saved value back to whatever was
  // stored before. Once the user has interacted, the mount load's result
  // for the branch itself is no longer trusted (branchLoaded still gets
  // set either way, so the "not set yet" hint isn't stuck showing loading).
  const userSavedBranchRef = useRef(false);
  // Synchronous in-flight guard for onSelectBranch -- see the comment
  // there. isSavingBranch (state) drives the buttons' disabled look but
  // only takes effect on the next render; this ref is checked immediately.
  const isSavingBranchRef = useRef(false);

  useEffect(() => {
    getQueueLength().then(setPendingSyncCount);
    getDeviceBranch().then((branch) => {
      if (!userSavedBranchRef.current) setDeviceBranchState(branch);
      setBranchLoaded(true);
    });
  }, []);

  const onSelectBranch = async (branch: DeviceBranch) => {
    // Synchronous ref check, not just disabled={isSavingBranch} below --
    // that's real-state-driven and only takes effect on the next render, so
    // two taps landing within the same render frame could otherwise both
    // get past it and race each other's read-back.
    if (isSavingBranchRef.current) return;
    isSavingBranchRef.current = true;
    userSavedBranchRef.current = true;
    setIsSavingBranch(true);
    setBranchSaveError(false);
    await setDeviceBranch(branch);
    // Read back rather than trust the write blindly -- setDeviceBranch
    // swallows a storage failure rather than throwing (same reasoning as
    // the offline check-in queue), so confirming what's actually stored is
    // the only way this screen can tell a save really took.
    const confirmed = await getDeviceBranch();
    setDeviceBranchState(confirmed);
    if (confirmed !== branch) setBranchSaveError(true);
    isSavingBranchRef.current = false;
    setIsSavingBranch(false);
  };

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

      <Text style={styles.sectionTitle}>Kiosk Branch</Text>
      <Text style={styles.kioskHint}>
        Which branch this tablet is set up at. Attached to every check-in/out recorded here, so head office can tell
        where someone actually tapped.
      </Text>
      <View style={styles.branchRow}>
        {BRANCH_OPTIONS.map((branch) => (
          <Pressable
            key={branch}
            style={[styles.branchButton, deviceBranch === branch && styles.branchButtonActive]}
            onPress={() => onSelectBranch(branch)}
            disabled={isSavingBranch}
          >
            <Text style={[styles.branchButtonText, deviceBranch === branch && styles.branchButtonTextActive]}>
              {DEVICE_BRANCH_LABELS[branch]}
            </Text>
          </Pressable>
        ))}
      </View>
      {branchLoaded && deviceBranch === null && (
        <Text style={styles.branchUnsetHint}>Not set yet — pick one above before using Kiosk Mode.</Text>
      )}
      {branchSaveError && <Text style={styles.error}>Could not save. Try again.</Text>}

      <View style={styles.divider} />

      <Text style={styles.sectionTitle}>Start Kiosk Mode</Text>
      <Text style={styles.kioskHint}>
        Turns this device into a shared check-in station. Employees type their personal 4-digit code — no QR, no
        login. Leave it plugged in at the entrance.
      </Text>
      <Pressable
        style={[styles.button, (!branchLoaded || isSavingBranch) && styles.buttonDisabled]}
        disabled={!branchLoaded || isSavingBranch}
        onPress={async () => {
          const startKiosk = async () => {
            await setKioskLocked(true);
            navigation.navigate('Kiosk');
          };
          // branchLoaded is guaranteed true here (button's disabled until
          // then), so deviceBranch === null at this point means genuinely
          // confirmed unset, not just "still loading". A silent "not set
          // yet" hint above is easy to miss -- a hard block would be worse
          // if a device is being set up in a hurry or deliberately left
          // unassigned, so ask instead of either extreme.
          if (deviceBranch === null) {
            Alert.alert(
              'No branch set',
              "This tablet's branch hasn't been picked above. Every check-in/out from it will be recorded with no branch info. Start anyway?",
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Start Anyway', style: 'destructive', onPress: startKiosk }
              ]
            );
            return;
          }
          await startKiosk();
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
  branchRow: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  branchButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center'
  },
  branchButtonActive: { backgroundColor: '#2e7d32', borderColor: '#2e7d32' },
  branchButtonText: { fontSize: 15, fontWeight: '600', color: '#333' },
  branchButtonTextActive: { color: '#fff' },
  branchUnsetHint: { fontSize: 13, color: '#e65100', marginBottom: 16 },
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

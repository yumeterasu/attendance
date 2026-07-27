import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import * as Haptics from 'expo-haptics';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/types';
import { kioskCheckin, kioskLookupPin, kioskMyAttendance, verifyKioskExitPin } from '../api/client';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { useSession } from '../context/SessionContext';

type Props = NativeStackScreenProps<RootStackParamList, 'Kiosk'>;

const PIN_LENGTH = 4;
const FEEDBACK_DURATION_MS = 2500;
const ERROR_FLASH_DURATION_MS = 1200;
const CONFIRM_TIMEOUT_MS = 20000; // auto-cancel back to the PIN screen if nobody confirms -- shared kiosk, don't leave someone else's name up
const KEYPAD_ROWS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['clear', '0', 'back']
];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

type Feedback =
  | { kind: 'success'; type: 'IN' | 'OUT'; name: string; timestamp: string; late?: boolean; ot?: boolean }
  | { kind: 'error'; message: string };

type ScheduleData = {
  name: string;
  year: number;
  month: number;
  days: { day: number; date: string; timeIn: string; timeOut: string; shift: string; late: boolean; ot: boolean }[];
};

type Mode = 'checkin' | 'exit' | 'scheduleEntry' | 'scheduleResult';
// 'OUT_OT' is a regular OUT with the overtime flag set -- a third button so the
// kiosk can tell a genuine overtime departure apart from a normal one.
type Selection = 'IN' | 'OUT' | 'OUT_OT';

function Keypad({
  onPress,
  disabled,
  danger,
  light
}: {
  onPress: (key: string) => void;
  disabled?: boolean;
  danger?: boolean;
  light?: boolean;
}) {
  return (
    <View style={styles.keypad}>
      {KEYPAD_ROWS.map((row, rowIndex) => (
        <View key={rowIndex} style={styles.keypadRow}>
          {row.map((key) => (
            <Pressable
              key={key}
              style={[styles.key, danger && styles.keyDanger, light && styles.keyLight]}
              onPress={() => onPress(key)}
              disabled={disabled}
            >
              <Text
                style={[
                  key === 'clear' || key === 'back' ? styles.keyTextSmall : styles.keyText,
                  light && styles.keyTextLight
                ]}
              >
                {key === 'clear' ? 'Clear' : key === 'back' ? '⌫' : key}
              </Text>
            </Pressable>
          ))}
        </View>
      ))}
    </View>
  );
}

function Dots({
  length,
  filled,
  error,
  danger,
  light
}: {
  length: number;
  filled: number;
  error?: boolean;
  danger?: boolean;
  light?: boolean;
}) {
  return (
    <View style={styles.dots}>
      {Array.from({ length }).map((_, i) => (
        <View
          key={i}
          style={[
            styles.dot,
            danger && styles.dotDanger,
            light && styles.dotLight,
            i < filled && (danger ? styles.dotFilledDanger : light ? styles.dotFilledLight : styles.dotFilled),
            error && styles.dotError
          ]}
        />
      ))}
    </View>
  );
}

export default function KioskScreen({ navigation }: Props) {
  const isConnected = useNetworkStatus();
  const { setKioskLocked } = useSession();
  const [mode, setMode] = useState<Mode>('checkin');

  const [pin, setPin] = useState('');
  const [lookupName, setLookupName] = useState<string | null>(null);
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set only for a retriable failure (timeout / no connection) -- unlike
  // a wrong-PIN rejection, the pin/name/selection stay put so "Try Again"
  // can resubmit without the employee re-entering anything.
  const [lookupIssue, setLookupIssue] = useState<string | null>(null);
  const [confirmIssue, setConfirmIssue] = useState<string | null>(null);

  const [exitPin, setExitPin] = useState('');
  const [exitError, setExitError] = useState(false);

  const [schedulePin, setSchedulePin] = useState('');
  const [scheduleError, setScheduleError] = useState(false);
  const [scheduleData, setScheduleData] = useState<ScheduleData | null>(null);

  const showFeedback = (next: Feedback) => {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    setFeedback(next);
    feedbackTimerRef.current = setTimeout(() => setFeedback(null), FEEDBACK_DURATION_MS);
  };

  const resetCheckin = () => {
    setPin('');
    setLookupName(null);
    setSelection(null);
    setLookupIssue(null);
    setConfirmIssue(null);
  };

  // Shared kiosk: if someone looks themselves up and walks away without
  // confirming, don't leave their name on screen for the next person.
  useEffect(() => {
    if (lookupName === null) return;
    const timer = setTimeout(resetCheckin, CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [lookupName]);

  const lookupPin = async (value: string) => {
    if (!isConnected) {
      setLookupIssue('No internet connection.');
      return; // keep the pin as-is so Try Again can resubmit it directly
    }

    setLookupIssue(null);
    setIsLookingUp(true);
    const res = await kioskLookupPin(value);
    setIsLookingUp(false);

    if (res.success) {
      setLookupName(res.name);
    } else if (res.error === 'timeout' || res.error === 'network_error') {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setLookupIssue(res.message);
    } else {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      showFeedback({ kind: 'error', message: res.message });
      setPin('');
    }
  };

  const onPinKeyPress = (key: string) => {
    if (isLookingUp) return;
    setLookupIssue(null);
    if (key === 'back') return setPin((p) => p.slice(0, -1));
    if (key === 'clear') return setPin('');

    const next = pin + key;
    setPin(next);
    if (next.length === PIN_LENGTH) lookupPin(next);
  };

  const onConfirm = async () => {
    if (!selection) return;
    const type = selection === 'IN' ? 'IN' : 'OUT';
    const ot = selection === 'OUT_OT';

    setConfirmIssue(null);
    setIsProcessing(true);
    const res = await kioskCheckin(pin, type, ot);
    setIsProcessing(false);

    if (res.success) {
      resetCheckin();
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showFeedback({ kind: 'success', type: res.type, name: res.name, timestamp: res.timestamp, late: res.late, ot: res.ot });
    } else if (res.error === 'timeout' || res.error === 'network_error') {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setConfirmIssue(res.message);
    } else {
      resetCheckin();
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      showFeedback({ kind: 'error', message: res.message });
    }
  };

  const submitExitPin = async (value: string) => {
    const res = await verifyKioskExitPin(value);
    if (res.success) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setMode('checkin');
      setExitPin('');
      await setKioskLocked(false);
      // Kiosk may be the stack's initial route (see RootNavigator, used to
      // survive the app being killed while locked), in which case there's no
      // previous screen for goBack() to return to -- reset explicitly instead.
      navigation.reset({ index: 0, routes: [{ name: 'Admin' }] });
    } else {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setExitError(true);
      setExitPin('');
      setTimeout(() => setExitError(false), ERROR_FLASH_DURATION_MS);
    }
  };

  const onExitKeyPress = (key: string) => {
    if (key === 'back') return setExitPin((p) => p.slice(0, -1));
    if (key === 'clear') return setExitPin('');

    const next = exitPin + key;
    setExitPin(next);
    if (next.length === PIN_LENGTH) submitExitPin(next);
  };

  const submitSchedulePin = async (value: string) => {
    if (!isConnected) {
      setScheduleError(true);
      setSchedulePin('');
      setTimeout(() => setScheduleError(false), ERROR_FLASH_DURATION_MS);
      return;
    }

    const res = await kioskMyAttendance(value);
    setSchedulePin('');

    if (res.success) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setScheduleData({ name: res.name, year: res.year, month: res.month, days: res.days });
      setMode('scheduleResult');
    } else {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setScheduleError(true);
      setTimeout(() => setScheduleError(false), ERROR_FLASH_DURATION_MS);
    }
  };

  const onScheduleKeyPress = (key: string) => {
    if (key === 'back') return setSchedulePin((p) => p.slice(0, -1));
    if (key === 'clear') return setSchedulePin('');

    const next = schedulePin + key;
    setSchedulePin(next);
    if (next.length === PIN_LENGTH) submitSchedulePin(next);
  };

  if (mode === 'exit') {
    return (
      <View style={[styles.container, styles.containerDanger]}>
        <Text style={styles.title}>🔒 Admin Exit PIN</Text>
        <Text style={styles.subtitle}>This leaves Kiosk Mode — not for check-in</Text>
        <Dots length={PIN_LENGTH} filled={exitPin.length} error={exitError} danger />
        <Keypad onPress={onExitKeyPress} danger />
        {exitError && <Text style={styles.errorText}>Incorrect PIN</Text>}
        <Pressable
          style={styles.cornerButton}
          onPress={() => {
            setMode('checkin');
            setExitPin('');
          }}
        >
          <Text style={styles.cornerButtonText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  if (mode === 'scheduleEntry') {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Enter Your Code to View Schedule</Text>
        <Dots length={PIN_LENGTH} filled={schedulePin.length} error={scheduleError} />
        <Keypad onPress={onScheduleKeyPress} />
        {scheduleError && <Text style={styles.errorText}>Code not recognized</Text>}
        <Pressable
          style={styles.cornerButton}
          onPress={() => {
            setMode('checkin');
            setSchedulePin('');
          }}
        >
          <Text style={styles.cornerButtonText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  if (mode === 'scheduleResult' && scheduleData) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>{scheduleData.name}</Text>
        <Text style={styles.subtitle}>
          {MONTH_NAMES[scheduleData.month - 1]} {scheduleData.year}
        </Text>

        <ScrollView style={styles.scheduleList} contentContainerStyle={{ paddingBottom: 24 }}>
          {scheduleData.days.length === 0 && <Text style={styles.scheduleEmpty}>No records yet this month.</Text>}
          {scheduleData.days.map((d) => (
            <View key={d.date} style={styles.scheduleRow}>
              <View style={styles.scheduleDateCol}>
                <Text style={styles.scheduleDate}>{d.date}</Text>
                {!!d.shift && <Text style={styles.scheduleShift}>{d.shift}</Text>}
              </View>
              <Text style={styles.scheduleTime}>{d.timeIn || '--:--'}</Text>
              <Text style={styles.scheduleArrow}>→</Text>
              <Text style={styles.scheduleTime}>{d.timeOut || '--:--'}</Text>
              {d.late && <Text style={styles.scheduleLate}>Late</Text>}
              {d.ot && <Text style={styles.scheduleOt}>OT</Text>}
            </View>
          ))}
        </ScrollView>

        <Pressable
          style={styles.doneButton}
          onPress={() => {
            setMode('checkin');
            setScheduleData(null);
          }}
        >
          <Text style={styles.buttonText}>Done</Text>
        </Pressable>
      </View>
    );
  }

  const feedbackOverlay = (
    <>
      {feedback && feedback.kind === 'success' && (
        <View style={[styles.feedbackCard, feedback.type === 'IN' ? styles.feedbackIn : styles.feedbackOut]}>
          <Text style={styles.feedbackType}>{feedback.type}</Text>
          <Text style={styles.feedbackName}>{feedback.name}</Text>
          <Text style={styles.feedbackTime}>{new Date(feedback.timestamp).toLocaleTimeString()}</Text>
          {feedback.late && <Text style={styles.feedbackLate}>Late</Text>}
          {feedback.ot && <Text style={styles.feedbackLate}>OT</Text>}
        </View>
      )}
      {feedback && feedback.kind === 'error' && (
        <View style={[styles.feedbackCard, styles.feedbackError]}>
          <Text style={styles.feedbackName}>{feedback.message}</Text>
        </View>
      )}
    </>
  );

  // One continuous screen for the whole check-in flow -- entering the PIN
  // and confirming IN/OUT never feels like a page change, just this same
  // frame updating in place. lookupName === null shows the keypad;
  // otherwise it shows the name + IN/OUT/OUT OT + Confirm.
  return (
    <View style={[styles.container, styles.containerLight]}>
      <View style={styles.netStatusDot}>
        <View style={[styles.netDot, isConnected ? styles.netDotOnline : styles.netDotOffline]} />
      </View>

      {lookupName === null ? (
        <>
          <Text style={[styles.title, styles.titleDark]}>Enter Your Code</Text>

          <Dots length={PIN_LENGTH} filled={pin.length} light />
          <Keypad onPress={onPinKeyPress} disabled={isLookingUp} light />

          {isLookingUp && (
            <View style={styles.checkingRow}>
              <ActivityIndicator color="#1d1d1f" />
              <Text style={styles.checkingText}>Checking...</Text>
            </View>
          )}

          {lookupIssue && !isLookingUp && (
            <View style={styles.retryBox}>
              <Text style={styles.retryMessage}>{lookupIssue}</Text>
              <Pressable style={styles.retryButton} onPress={() => lookupPin(pin)}>
                <Text style={styles.retryButtonText}>Try Again</Text>
              </Pressable>
            </View>
          )}
        </>
      ) : (
        <>
          <Text style={[styles.title, styles.titleDark]}>Hi, {lookupName}</Text>
          <Text style={styles.subtitleDark}>Select IN or OUT, then confirm</Text>

          <View style={styles.typeRow}>
            <Pressable
              style={[styles.typeButton, styles.typeButtonIn, selection === 'IN' && styles.typeButtonInSelected]}
              onPress={() => setSelection('IN')}
              disabled={isProcessing}
            >
              <Text style={[styles.typeButtonInText, selection === 'IN' && styles.typeButtonTextSelected]}>IN</Text>
            </Pressable>
            <Pressable
              style={[styles.typeButton, styles.typeButtonOut, selection === 'OUT' && styles.typeButtonOutSelected]}
              onPress={() => setSelection('OUT')}
              disabled={isProcessing}
            >
              <Text style={[styles.typeButtonOutText, selection === 'OUT' && styles.typeButtonTextSelected]}>OUT</Text>
            </Pressable>
            <Pressable
              style={[styles.typeButton, styles.typeButtonOt, selection === 'OUT_OT' && styles.typeButtonOtSelected]}
              onPress={() => setSelection('OUT_OT')}
              disabled={isProcessing}
            >
              <Text style={[styles.typeButtonOtText, selection === 'OUT_OT' && styles.typeButtonTextSelected]}>
                OUT OT
              </Text>
            </Pressable>
          </View>

          <Pressable
            style={[styles.confirmButton, (!selection || isProcessing) && styles.confirmButtonDisabled]}
            onPress={onConfirm}
            disabled={!selection || isProcessing}
          >
            {isProcessing ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Confirm</Text>}
          </Pressable>

          <Pressable style={styles.cancelLink} onPress={resetCheckin} disabled={isProcessing}>
            <Text style={styles.cancelLinkText}>Not you? Cancel</Text>
          </Pressable>

          {confirmIssue && !isProcessing && (
            <View style={styles.retryBox}>
              <Text style={styles.retryMessage}>{confirmIssue}</Text>
              <Pressable style={styles.retryButton} onPress={onConfirm}>
                <Text style={styles.retryButtonText}>Try Again</Text>
              </Pressable>
            </View>
          )}
        </>
      )}

      {feedbackOverlay}

      <Pressable style={[styles.scheduleButton, styles.cornerButtonLight]} onPress={() => setMode('scheduleEntry')}>
        <Text style={styles.cornerButtonTextLight}>My Schedule</Text>
      </Pressable>
      <Pressable style={[styles.cornerButton, styles.cornerButtonLight]} onPress={() => setMode('exit')}>
        <Text style={styles.cornerButtonTextLight}>Exit</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', padding: 24 },
  containerDanger: { backgroundColor: '#2a0e0e' },
  containerLight: { backgroundColor: '#fff' },
  title: { color: '#fff', fontSize: 22, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  titleDark: { color: '#1d1d1f' },
  subtitleDark: { color: '#777', fontSize: 15, marginBottom: 8 },
  netStatusDot: { position: 'absolute', top: 16, right: 16 },
  netDot: { width: 12, height: 12, borderRadius: 6 },
  netDotOnline: { backgroundColor: '#7cb987' },
  netDotOffline: { backgroundColor: '#c0392b' },
  retryBox: { marginTop: 20, alignItems: 'center' },
  retryMessage: { color: '#c0392b', fontSize: 13, textAlign: 'center', marginBottom: 10, maxWidth: 280 },
  retryButton: { backgroundColor: '#1d1d1f', borderRadius: 14, paddingVertical: 12, paddingHorizontal: 32 },
  retryButtonText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  confirmButton: {
    marginTop: 32,
    backgroundColor: '#2e7d32',
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 64,
    alignItems: 'center'
  },
  confirmButtonDisabled: { backgroundColor: '#ccc' },
  checkingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 24 },
  checkingText: { color: '#666', fontSize: 14, fontWeight: '600' },
  cancelLink: {
    marginTop: 20,
    backgroundColor: '#eee',
    borderRadius: 16,
    paddingVertical: 10,
    paddingHorizontal: 20
  },
  cancelLinkText: { color: '#555', fontSize: 13, fontWeight: '700' },
  subtitle: { color: 'rgba(255,255,255,0.6)', fontSize: 15, marginBottom: 24 },
  typeRow: { flexDirection: 'row', gap: 12, marginTop: 20, marginBottom: 8 },
  typeButton: {
    borderRadius: 14,
    paddingVertical: 18,
    paddingHorizontal: 22,
    borderWidth: 2
  },
  typeButtonIn: { backgroundColor: '#c8e6c9', borderColor: '#7cb987' },
  typeButtonOut: { backgroundColor: '#ffcdd2', borderColor: '#e6949c' },
  typeButtonOt: { backgroundColor: '#ffe0b2', borderColor: '#e6b571' },
  typeButtonInSelected: { backgroundColor: '#2e7d32', borderColor: '#1b5e20' },
  typeButtonOutSelected: { backgroundColor: '#c0392b', borderColor: '#b71c1c' },
  typeButtonOtSelected: { backgroundColor: '#e65100', borderColor: '#bf360c' },
  typeButtonInText: { color: '#1b5e20', fontSize: 17, fontWeight: '700' },
  typeButtonOutText: { color: '#b71c1c', fontSize: 17, fontWeight: '700' },
  typeButtonOtText: { color: '#e65100', fontSize: 17, fontWeight: '700' },
  typeButtonTextSelected: { color: '#fff' },
  dots: { flexDirection: 'row', gap: 20, marginTop: 24, marginBottom: 40 },
  dot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.4)'
  },
  dotFilled: { backgroundColor: '#fff', borderColor: '#fff' },
  dotDanger: { borderColor: 'rgba(255,140,140,0.5)' },
  dotFilledDanger: { backgroundColor: '#ff6b6b', borderColor: '#ff6b6b' },
  dotLight: { borderColor: '#ccc' },
  dotFilledLight: { backgroundColor: '#333', borderColor: '#333' },
  dotError: { borderColor: '#c0392b', backgroundColor: '#c0392b' },
  errorText: { color: '#e57373', fontSize: 14, fontWeight: '600', marginTop: 20 },
  keypad: { gap: 16 },
  keypadRow: { flexDirection: 'row', gap: 16 },
  key: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  keyDanger: { backgroundColor: 'rgba(255,107,107,0.15)' },
  keyLight: { backgroundColor: '#f0f0f0' },
  keyText: { color: '#fff', fontSize: 30, fontWeight: '600' },
  keyTextSmall: { color: 'rgba(255,255,255,0.7)', fontSize: 16, fontWeight: '600' },
  keyTextLight: { color: '#1d1d1f' },
  scheduleButton: {
    position: 'absolute',
    bottom: 24,
    left: 24,
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 16
  },
  cornerButton: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 16
  },
  cornerButtonText: { color: 'rgba(255,255,255,0.7)', fontSize: 12, fontWeight: '600' },
  cornerButtonLight: { backgroundColor: '#eee' },
  cornerButtonTextLight: { color: '#555', fontSize: 12, fontWeight: '600' },
  feedbackCard: {
    position: 'absolute',
    top: '20%',
    left: 32,
    right: 32,
    borderRadius: 20,
    paddingVertical: 32,
    alignItems: 'center'
  },
  feedbackIn: { backgroundColor: '#2e7d32' },
  feedbackOut: { backgroundColor: '#455a64' },
  feedbackError: { backgroundColor: '#c0392b' },
  feedbackType: { color: '#fff', fontSize: 28, fontWeight: '800', letterSpacing: 2 },
  feedbackName: { color: '#fff', fontSize: 22, fontWeight: '600', marginTop: 8, textAlign: 'center' },
  feedbackTime: { color: 'rgba(255,255,255,0.8)', fontSize: 14, marginTop: 4 },
  feedbackLate: {
    color: '#fff',
    backgroundColor: 'rgba(0,0,0,0.25)',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 10,
    paddingVertical: 4,
    paddingHorizontal: 12,
    borderRadius: 10
  },
  scheduleList: { width: '100%', maxWidth: 420, maxHeight: '55%' },
  scheduleEmpty: { color: 'rgba(255,255,255,0.5)', textAlign: 'center', marginTop: 24 },
  scheduleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.1)'
  },
  scheduleDateCol: { flex: 1 },
  scheduleDate: { color: '#fff', fontSize: 14 },
  scheduleShift: { color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 2 },
  scheduleTime: { color: '#fff', fontSize: 14, fontWeight: '600', width: 56, textAlign: 'center' },
  scheduleArrow: { color: 'rgba(255,255,255,0.4)', fontSize: 14, width: 20, textAlign: 'center' },
  scheduleLate: {
    color: '#e57373',
    fontSize: 11,
    fontWeight: '700',
    marginLeft: 8
  },
  scheduleOt: {
    color: '#e65100',
    fontSize: 11,
    fontWeight: '700',
    marginLeft: 8
  },
  doneButton: {
    marginTop: 24,
    backgroundColor: '#455a64',
    borderRadius: 8,
    paddingVertical: 14,
    paddingHorizontal: 48,
    alignItems: 'center'
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' }
});

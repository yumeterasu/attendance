import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ScrollView, ActivityIndicator } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Constants from 'expo-constants';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList } from '../navigation/types';
import { kioskCheckin, kioskLookupPin, kioskMyAttendance, verifyKioskExitPin } from '../api/client';
import { useNetworkStatus } from '../hooks/useNetworkStatus';
import { useOfflineSync } from '../hooks/useOfflineSync';
import { useSession } from '../context/SessionContext';
import { lookupPinLocally } from '../utils/employeeDirectory';
import { enqueueCheckin } from '../utils/offlineQueue';
import { configureCheckinAudio, playCheckinSound, playCheckoutSound } from '../utils/sound';

type Props = NativeStackScreenProps<RootStackParamList, 'Kiosk'>;

// Read straight from app.config.ts's `version` at build time -- lets anyone
// check which build is on a given tablet without pulling the APK apart.
const APP_VERSION = Constants.expoConfig?.version ?? 'unknown';

const PIN_LENGTH = 4;
const FEEDBACK_DURATION_MS = 2500;
const ERROR_FLASH_DURATION_MS = 1200;
const CONFIRM_TIMEOUT_MS = 20000; // auto-cancel back to the PIN screen if nobody confirms -- shared kiosk, don't leave someone else's name up
const AUTO_IN_START_HOUR = 5; // morning arrival window -- pre-select IN from this hour...
const AUTO_IN_END_HOUR = 9; // ...up to (not including) this hour
const AUTO_OUT_HOUR = 16; // nobody realistically checks IN this late -- pre-select OUT after this hour so the common case is a single tap on Confirm

// The two busiest windows -- most of the workforce clocks in/out within a
// couple minutes of each other, so during these, skip the network round-trip
// entirely and go straight to the same local-queue path already used when
// actually offline: enqueue immediately (see queueOffline), sync happens in
// the background moments later via useOfflineSync. Local device time; end
// is exclusive. The decision is locked in once per visit at PIN-lookup time
// (see forcedOffline below), not re-checked at Confirm -- otherwise someone
// who starts right as a window closes could see inconsistent behavior
// between the lookup and the confirm step.
const PEAK_OFFLINE_WINDOWS: { startMin: number; endMin: number }[] = [
  { startMin: 7 * 60 + 57, endMin: 8 * 60 + 0 }, // 7:57–8:00
  { startMin: 17 * 60 + 0, endMin: 17 * 60 + 3 } // 17:00–17:03
];

function isPeakOfflineWindowNow(): boolean {
  const now = new Date();
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  return PEAK_OFFLINE_WINDOWS.some((w) => minutesNow >= w.startMin && minutesNow < w.endMin);
}
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
const WEEKDAY_HEADERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

// `note` is set only for a day with no actual punch that was scheduled as
// something other than a real clock-time shift (Leave, Holiday, and any
// future addition like Sick Leave -- the server decides this generically,
// nothing here needs updating when a new one is added). Shown instead of
// the (blank) time-in/time-out for that day.
type ScheduleDay = { day: number; date: string; timeIn: string; timeOut: string; shift: string; note: string; late: boolean; ot: boolean };
type CalendarCell = { day: number; entry?: ScheduleDay } | null;

// Lays the month out as a real calendar grid (leading/trailing blanks so day 1
// lands under its real weekday), instead of a flat list of only the days that
// have a record -- makes it easy to spot missed days at a glance.
function buildCalendarWeeks(year: number, month: number, days: ScheduleDay[]): CalendarCell[][] {
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const byDay = new Map(days.map((d) => [d.day, d]));

  const cells: CalendarCell[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push({ day, entry: byDay.get(day) });
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks: CalendarCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

type Feedback =
  | { kind: 'success'; type: 'IN' | 'OUT'; name: string; timestamp: string; late?: boolean; ot?: boolean; queued?: boolean }
  | { kind: 'error'; message: string };

type ScheduleData = {
  name: string;
  year: number;
  month: number;
  days: ScheduleDay[];
};

type Mode = 'checkin' | 'exit' | 'scheduleEntry' | 'scheduleResult';
// 'OUT_OT' is a regular OUT with the overtime flag set -- a third button so the
// kiosk can tell a genuine overtime departure apart from a normal one.
type Selection = 'IN' | 'OUT' | 'OUT_OT';

function Keypad({
  onPress,
  disabled,
  danger,
  light,
  schedule
}: {
  onPress: (key: string) => void;
  disabled?: boolean;
  danger?: boolean;
  light?: boolean;
  // white keys with a visible border -- for the blue Schedule background,
  // where the plain light-gray keys blended into the background.
  schedule?: boolean;
}) {
  return (
    <View style={styles.keypad}>
      {KEYPAD_ROWS.map((row, rowIndex) => (
        <View key={rowIndex} style={styles.keypadRow}>
          {row.map((key) => (
            <Pressable
              key={key}
              style={[styles.key, danger && styles.keyDanger, light && styles.keyLight, schedule && styles.keySchedule]}
              onPress={() => onPress(key)}
              disabled={disabled}
            >
              <Text
                style={[
                  key === 'clear' || key === 'back' ? styles.keyTextSmall : styles.keyText,
                  (light || schedule || danger) && styles.keyTextLight
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
  light,
  schedule
}: {
  length: number;
  filled: number;
  error?: boolean;
  danger?: boolean;
  light?: boolean;
  schedule?: boolean;
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
            schedule && styles.dotSchedule,
            i < filled &&
              (danger
                ? styles.dotFilledDanger
                : schedule
                ? styles.dotFilledSchedule
                : light
                ? styles.dotFilledLight
                : styles.dotFilled),
            error && styles.dotError
          ]}
        />
      ))}
    </View>
  );
}

export default function KioskScreen({ navigation }: Props) {
  const isConnected = useNetworkStatus();
  useOfflineSync(isConnected);
  const { setKioskLocked } = useSession();
  const [mode, setMode] = useState<Mode>('checkin');

  const [pin, setPin] = useState('');
  const [lookupName, setLookupName] = useState<string | null>(null);
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set only for a lookup that fails for a retriable reason AND has no local
  // fallback either -- pin stays put so "Try Again" can resubmit it as-is.
  // Confirm has no equivalent: a connectivity failure there gets queued
  // offline automatically instead of asking the employee to retry (see queueOffline).
  const [lookupIssue, setLookupIssue] = useState<string | null>(null);
  // Locked in once per visit by lookupPin -- true only when we're inside a
  // peak window AND the PIN resolved from the on-device cache (see
  // PEAK_OFFLINE_WINDOWS above). Reused as-is by onConfirm so the whole
  // visit behaves consistently even if the window closes mid-interaction.
  const [forcedOffline, setForcedOffline] = useState(false);

  const [exitPin, setExitPin] = useState('');
  const [exitError, setExitError] = useState(false);

  const [schedulePin, setSchedulePin] = useState('');
  const [scheduleError, setScheduleError] = useState(false);
  const [isLoadingSchedule, setIsLoadingSchedule] = useState(false);
  const [scheduleData, setScheduleData] = useState<ScheduleData | null>(null);
  // Set only for a lookup that fails for a retriable reason (timeout/no
  // connection) -- pin stays put so "Try Again" can resubmit it as-is,
  // same pattern as lookupIssue on the main check-in screen.
  const [scheduleIssue, setScheduleIssue] = useState<string | null>(null);

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
    setForcedOffline(false);
  };

  // Prime the audio session once so the first check-in chime isn't delayed.
  useEffect(() => {
    configureCheckinAudio();
  }, []);

  // Shared kiosk: if someone looks themselves up and walks away without
  // confirming, don't leave their name on screen for the next person.
  useEffect(() => {
    if (lookupName === null) return;
    const timer = setTimeout(resetCheckin, CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [lookupName]);

  // Pre-select IN during the morning arrival window and OUT once it's late
  // enough that nobody is realistically checking IN -- still fully
  // overridable (all three buttons stay tappable), this just saves the
  // common case an extra tap. Anything outside both windows is left
  // unselected, same as before this existed -- no reasonable default to
  // guess at mid-shift.
  useEffect(() => {
    if (lookupName === null) return;
    const hour = new Date().getHours();
    if (hour >= AUTO_IN_START_HOUR && hour < AUTO_IN_END_HOUR) setSelection('IN');
    else if (hour >= AUTO_OUT_HOUR) setSelection('OUT');
  }, [lookupName]);

  // Falls back to the on-device PIN->Name copy (see employeeDirectory) when
  // there's truly no way to reach the server -- returns whether a name was found.
  const tryLocalLookup = async (value: string): Promise<boolean> => {
    const localName = await lookupPinLocally(value);
    if (!localName) return false;
    setLookupName(localName);
    return true;
  };

  const lookupPin = async (value: string) => {
    if (!isConnected) {
      if (await tryLocalLookup(value)) return;
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      showFeedback({ kind: 'error', message: "Code not recognized offline. Connect to the internet and try again." });
      setPin('');
      return;
    }

    // Peak window: try the fast on-device path first so Confirm doesn't have
    // to wait on the network at all. The local PIN directory refreshes every
    // 30s while connected (see useOfflineSync), so this is only a miss for
    // someone added in roughly the last 30 seconds -- fall through to the
    // normal online lookup below for that rare case instead of blocking them.
    if (isPeakOfflineWindowNow() && (await tryLocalLookup(value))) {
      setForcedOffline(true);
      return;
    }
    setForcedOffline(false);

    setLookupIssue(null);
    setIsLookingUp(true);
    const res = await kioskLookupPin(value);
    setIsLookingUp(false);

    if (res.success) {
      setLookupName(res.name);
    } else if (res.error === 'timeout' || res.error === 'network_error') {
      // Connection dropped mid-request -- try the local copy before giving up.
      if (await tryLocalLookup(value)) return;
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

  // Saves locally and treats it as a success from the employee's point of
  // view -- useOfflineSync drains this queue automatically once the
  // connection comes back, no separate "sync now" step for anyone to remember.
  const queueOffline = async (type: 'IN' | 'OUT', ot: boolean) => {
    const name = lookupName ?? '';
    await enqueueCheckin(pin, type, ot);
    resetCheckin();
    if (type === 'IN') playCheckinSound(); else playCheckoutSound();
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    showFeedback({ kind: 'success', type, name, timestamp: new Date().toISOString(), queued: true });
  };

  const onConfirm = async () => {
    if (!selection) return;
    const type = selection === 'IN' ? 'IN' : 'OUT';
    const ot = selection === 'OUT_OT';

    if (!isConnected || forcedOffline) {
      setIsProcessing(true);
      await queueOffline(type, ot);
      setIsProcessing(false);
      return;
    }

    setIsProcessing(true);
    const res = await kioskCheckin(pin, type, ot);

    if (res.success) {
      setIsProcessing(false);
      resetCheckin();
      if (res.type === 'IN') playCheckinSound(); else playCheckoutSound();
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      showFeedback({ kind: 'success', type: res.type, name: res.name, timestamp: res.timestamp, late: res.late, ot: res.ot });
    } else if (res.error === 'timeout' || res.error === 'network_error') {
      // Connection dropped mid-request -- queue it rather than making them retry manually.
      await queueOffline(type, ot);
      setIsProcessing(false);
    } else {
      setIsProcessing(false);
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

    setScheduleIssue(null);
    setIsLoadingSchedule(true);
    const res = await kioskMyAttendance(value);
    setIsLoadingSchedule(false);

    if (res.success) {
      setSchedulePin('');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setScheduleData({ name: res.name, year: res.year, month: res.month, days: res.days });
      setMode('scheduleResult');
    } else if (res.error === 'timeout' || res.error === 'network_error') {
      // Connection dropped mid-request -- offer a retry instead of just flashing an error.
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setScheduleIssue(res.message);
    } else {
      setSchedulePin('');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setScheduleError(true);
      setTimeout(() => setScheduleError(false), ERROR_FLASH_DURATION_MS);
    }
  };

  const onScheduleKeyPress = (key: string) => {
    if (isLoadingSchedule) return;
    setScheduleIssue(null);
    if (key === 'back') return setSchedulePin((p) => p.slice(0, -1));
    if (key === 'clear') return setSchedulePin('');

    const next = schedulePin + key;
    setSchedulePin(next);
    if (next.length === PIN_LENGTH) submitSchedulePin(next);
  };

  if (mode === 'exit') {
    return (
      <View style={[styles.container, styles.containerDanger]}>
        <Text style={[styles.title, styles.titleDanger]}>Admin Exit PIN</Text>
        <Text style={styles.subtitleDanger}>This leaves Kiosk Mode — not for check-in</Text>

        <View style={[styles.badge, styles.badgeDanger]}>
          <Text style={styles.badgeGlyph}>🔒</Text>
        </View>

        <Dots length={PIN_LENGTH} filled={exitPin.length} error={exitError} danger />
        <Keypad onPress={onExitKeyPress} danger />
        {exitError && <Text style={styles.errorText}>Incorrect PIN</Text>}
        <Pressable
          style={[styles.cornerButton, styles.cornerButtonLight]}
          onPress={() => {
            setMode('checkin');
            setExitPin('');
          }}
        >
          <Text style={styles.cornerButtonTextLight}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  if (mode === 'scheduleEntry') {
    return (
      <LinearGradient
        colors={['#ffffff', ACCENT_BG]}
        start={GRADIENT_START}
        end={GRADIENT_END}
        locations={GRADIENT_LOCATIONS}
        style={styles.container}
      >
        <Text style={[styles.title, styles.titleDark]}>Enter Your Code to View Schedule</Text>

        <View style={[styles.badge, styles.badgeSchedule]}>
          <Text style={styles.badgeGlyph}>🗓️</Text>
        </View>

        <Dots length={PIN_LENGTH} filled={schedulePin.length} error={scheduleError} schedule />
        <Keypad onPress={onScheduleKeyPress} disabled={isLoadingSchedule} schedule />
        {scheduleError && <Text style={styles.errorText}>Code not recognized</Text>}

        {isLoadingSchedule && (
          <View style={styles.checkingRow}>
            <ActivityIndicator color={ACCENT_DARK} />
            <Text style={styles.checkingText}>Loading...</Text>
          </View>
        )}

        {scheduleIssue && !isLoadingSchedule && (
          <View style={styles.retryBox}>
            <Text style={styles.retryMessage}>{scheduleIssue}</Text>
            <Pressable style={styles.retryButton} onPress={() => submitSchedulePin(schedulePin)}>
              <Text style={styles.retryButtonText}>Try Again</Text>
            </Pressable>
          </View>
        )}
        <Pressable
          style={[styles.cornerButton, styles.cornerButtonLight]}
          onPress={() => {
            setMode('checkin');
            setSchedulePin('');
            setScheduleIssue(null);
          }}
        >
          <Text style={styles.cornerButtonTextLight}>Cancel</Text>
        </Pressable>
      </LinearGradient>
    );
  }

  if (mode === 'scheduleResult' && scheduleData) {
    const weeks = buildCalendarWeeks(scheduleData.year, scheduleData.month, scheduleData.days);

    return (
      <LinearGradient
        colors={['#ffffff', ACCENT_BG]}
        start={GRADIENT_START}
        end={GRADIENT_END}
        locations={GRADIENT_LOCATIONS}
        style={styles.container}
      >
        <Text style={[styles.title, styles.titleDark]}>{scheduleData.name}</Text>
        <Text style={styles.subtitleDark}>
          {MONTH_NAMES[scheduleData.month - 1]} {scheduleData.year}
        </Text>

        <View style={styles.calendarWeekRow}>
          {WEEKDAY_HEADERS.map((h, i) => (
            <Text key={i} style={styles.calendarHeaderCell}>{h}</Text>
          ))}
        </View>
        <ScrollView style={styles.calendarWrap} contentContainerStyle={{ paddingBottom: 12 }}>
          {weeks.map((week, wi) => (
            <View key={wi} style={styles.calendarWeekRow}>
              {week.map((cell, ci) => {
                // Holiday and anything containing "Leave" (Leave, Half Day
                // Leave, a future Sick Leave, ...) get their own tint so
                // they read at a glance -- matched on the note text itself,
                // not a fixed list, so a new Leave-type option picks up the
                // same red without a code change; anything else generic
                // (a future non-Leave, non-Holiday label) keeps the neutral
                // calendarCellWorked treatment.
                const isHoliday = cell && cell.entry && cell.entry.note === 'Holiday';
                const isLeave = cell && cell.entry && cell.entry.note && cell.entry.note.indexOf('Leave') !== -1;
                return (
                <View
                  key={ci}
                  style={[
                    styles.calendarCell,
                    !cell && styles.calendarCellBlank,
                    cell && cell.entry && styles.calendarCellWorked,
                    isHoliday && styles.calendarCellHoliday,
                    isLeave && styles.calendarCellLeave
                  ]}
                >
                  {cell && (
                    <>
                      <Text style={styles.calendarDayNum}>{cell.day}</Text>
                      {cell.entry && cell.entry.note ? (
                        <Text
                          style={[styles.calendarNote, isHoliday && styles.calendarNoteHoliday, isLeave && styles.calendarNoteLeave]}
                          numberOfLines={2}
                        >
                          {cell.entry.note}
                        </Text>
                      ) : (
                        cell.entry && (
                          <>
                            <Text style={styles.calendarTime}>{cell.entry.timeIn || '--:--'}</Text>
                            <Text style={styles.calendarTime}>{cell.entry.timeOut || '--:--'}</Text>
                            {(cell.entry.late || cell.entry.ot) && (
                              <View style={styles.calendarDotsRow}>
                                {cell.entry.late && <View style={[styles.calendarDot, styles.calendarDotLate]} />}
                                {cell.entry.ot && <View style={[styles.calendarDot, styles.calendarDotOt]} />}
                              </View>
                            )}
                          </>
                        )
                      )}
                    </>
                  )}
                </View>
                );
              })}
            </View>
          ))}
        </ScrollView>

        <View style={styles.calendarLegend}>
          <View style={styles.legendItem}>
            <View style={[styles.calendarDot, styles.calendarDotLate]} />
            <Text style={styles.legendText}>Late</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.calendarDot, styles.calendarDotOt]} />
            <Text style={styles.legendText}>OT</Text>
          </View>
        </View>

        <Pressable
          style={styles.doneButton}
          onPress={() => {
            setMode('checkin');
            setScheduleData(null);
          }}
        >
          <Text style={styles.buttonText}>Done</Text>
        </Pressable>
      </LinearGradient>
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
          {feedback.queued && <Text style={styles.feedbackLate}>Saved offline — will sync automatically</Text>}
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
    <LinearGradient
      colors={['#ffffff', BG]}
      start={GRADIENT_START}
      end={GRADIENT_END}
      locations={GRADIENT_LOCATIONS}
      style={styles.container}
    >
      <View style={styles.netStatusDot}>
        <View style={[styles.netDot, isConnected ? styles.netDotOnline : styles.netDotOffline]} />
      </View>

      {lookupName === null ? (
        <>
          <Text style={[styles.title, styles.titleDark]}>Enter Your Code</Text>

          <View style={styles.badge}>
            <Text style={styles.badgeGlyph}>👤</Text>
          </View>

          <Dots length={PIN_LENGTH} filled={pin.length} light />
          <Keypad onPress={onPinKeyPress} disabled={isLookingUp} light />

          {isLookingUp && (
            <View style={styles.checkingRow}>
              <ActivityIndicator color={ACCENT_DARK} />
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
            {isProcessing ? <ActivityIndicator color={ACCENT_TEXT} /> : <Text style={styles.confirmButtonText}>Confirm</Text>}
          </Pressable>

          <Pressable style={styles.cancelLink} onPress={resetCheckin} disabled={isProcessing}>
            <Text style={styles.cancelLinkText}>Not you? Cancel</Text>
          </Pressable>
        </>
      )}

      {feedbackOverlay}

      {lookupName === null && (
        <Pressable style={[styles.scheduleButton, styles.cornerButtonLight]} onPress={() => setMode('scheduleEntry')}>
          <Text style={styles.cornerButtonTextLight}>My Schedule</Text>
        </Pressable>
      )}
      {lookupName === null && (
        <Pressable style={[styles.cornerButton, styles.cornerButtonLight]} onPress={() => setMode('exit')}>
          <Text style={styles.cornerButtonTextLight}>Admin</Text>
        </Pressable>
      )}
      {lookupName === null && <Text style={styles.versionText}>v{APP_VERSION}</Text>}
    </LinearGradient>
  );
}

// "Blossom" theme: Baloo 2 (rounded, friendly) for headings/buttons/labels,
// Nunito for body copy and dense data (calendar numbers, times) -- see the
// Blossom Kiosk design-preview Artifact this was matched against. Sky
// pastel palette below, chosen over Peach/Mint/Lavender/Blush/etc.
const FONT_DISPLAY_MEDIUM = 'Baloo2_500Medium';
const FONT_DISPLAY_SEMIBOLD = 'Baloo2_600SemiBold';
const FONT_DISPLAY_BOLD = 'Baloo2_700Bold';
const FONT_DISPLAY_EXTRABOLD = 'Baloo2_800ExtraBold';
const FONT_BODY_MEDIUM = 'Nunito_500Medium';
const FONT_BODY_SEMIBOLD = 'Nunito_600SemiBold';
const FONT_BODY_BOLD = 'Nunito_700Bold';
const FONT_BODY_EXTRABOLD = 'Nunito_800ExtraBold';

// Sky Medium palette (a step more saturated than the original "Sky Soft" --
// that one read as too washed-out). IN/OUT/OT keep their own fixed semantic
// colors (sage/rose/butter) no matter what the brand accent is, same rule
// as the web preview.
const BG = '#E4F1FC';
const CARD = '#F6FBFF';
const BORDER = '#BFDDF3';
const ACCENT = '#85C2EE';
const ACCENT_DARK = '#2C74AD';
const ACCENT_BG = '#D9EDFB';
const ACCENT_TEXT = '#1C4A6E';
const SAGE = '#6E9C69';
const SAGE_BG = '#E8F2E4';
const SAGE_BORDER = '#CDE3C6';
const BUTTER = '#C98A22';
const BUTTER_BG = '#FFF3D6';
const BUTTER_BORDER = '#F3DFA6';
const ROSE_BG = '#FCE4E1';
const ROSE_TEXT = '#C2604F';
const ROSE_BORDER = '#F4C6BD';
const TEXT = '#503A2E';
const TEXT_MUTED = '#9C8171';

// "Glow" background from the web preview -- a soft white glow near the top
// fading into the Sky background, not a flat fill. The preview's CSS recipe
// is a wide/short radial ellipse (120% width x 55% height, centered just
// above the top edge) -- expo-linear-gradient has no radial mode, but at
// 120% width the ellipse already extends past both screen edges, so at any
// given height the color barely varies left-to-right; a plain top-to-bottom
// linear fade is a very close stand-in. The 0.68 stop matches "0%, 68%"
// from the preview.
const GRADIENT_START = { x: 0.5, y: 0 };
const GRADIENT_END = { x: 0.5, y: 1 };
const GRADIENT_LOCATIONS: [number, number] = [0, 0.68];

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', padding: 24 },
  containerDanger: { backgroundColor: '#FCF3F2' },
  containerLight: { backgroundColor: BG },
  containerSchedule: { backgroundColor: ACCENT_BG },
  title: { color: TEXT, fontSize: 22, fontFamily: FONT_DISPLAY_BOLD, marginBottom: 8, textAlign: 'center' },
  titleDark: { color: TEXT },
  titleDanger: { color: '#3A1210' },
  subtitleDark: { color: TEXT_MUTED, fontSize: 15, fontFamily: FONT_BODY_MEDIUM, marginBottom: 8 },
  subtitleDanger: { color: '#A9645D', fontSize: 13, fontFamily: FONT_BODY_MEDIUM, marginBottom: 8, textAlign: 'center' },
  badge: {
    width: 64,
    height: 64,
    borderRadius: 24,
    backgroundColor: SAGE_BG,
    borderWidth: 1,
    borderColor: SAGE_BORDER,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6
  },
  badgeSchedule: { backgroundColor: ACCENT_BG, borderColor: BORDER },
  badgeDanger: { backgroundColor: '#F7DAD6', borderColor: '#F7DAD6' },
  badgeGlyph: { fontSize: 26 },
  netStatusDot: { position: 'absolute', top: 16, right: 16 },
  netDot: { width: 12, height: 12, borderRadius: 6 },
  netDotOnline: { backgroundColor: '#7cb987' },
  netDotOffline: { backgroundColor: '#c0392b' },
  retryBox: { marginTop: 20, alignItems: 'center' },
  retryMessage: { color: '#C0392B', fontSize: 13, fontFamily: FONT_BODY_MEDIUM, textAlign: 'center', marginBottom: 10, maxWidth: 280 },
  retryButton: { backgroundColor: TEXT, borderRadius: 999, paddingVertical: 12, paddingHorizontal: 32 },
  retryButtonText: { color: '#fff', fontSize: 15, fontFamily: FONT_DISPLAY_BOLD },
  confirmButton: {
    marginTop: 32,
    backgroundColor: ACCENT,
    borderRadius: 999,
    paddingVertical: 18,
    paddingHorizontal: 64,
    alignItems: 'center'
  },
  confirmButtonDisabled: { backgroundColor: '#DCE9F5' },
  checkingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 24 },
  checkingText: { color: TEXT_MUTED, fontSize: 14, fontFamily: FONT_BODY_SEMIBOLD },
  cancelLink: {
    marginTop: 20,
    backgroundColor: CARD,
    borderWidth: 1,
    borderColor: BORDER,
    borderRadius: 999,
    paddingVertical: 10,
    paddingHorizontal: 20
  },
  cancelLinkText: { color: TEXT_MUTED, fontSize: 13, fontFamily: FONT_BODY_BOLD },
  subtitle: { color: 'rgba(255,255,255,0.6)', fontSize: 15, marginBottom: 24 },
  typeRow: { flexDirection: 'row', gap: 12, marginTop: 20, marginBottom: 8 },
  typeButton: {
    borderRadius: 20,
    paddingVertical: 18,
    paddingHorizontal: 22,
    borderWidth: 2
  },
  typeButtonIn: { backgroundColor: SAGE_BG, borderColor: SAGE_BORDER },
  typeButtonOut: { backgroundColor: ROSE_BG, borderColor: ROSE_BORDER },
  typeButtonOt: { backgroundColor: BUTTER_BG, borderColor: BUTTER_BORDER },
  typeButtonInSelected: { backgroundColor: SAGE, borderColor: SAGE },
  // OUT stays this fixed rose/red regardless of accent palette -- same rule
  // as the web preview, so it always reads as recognizably "OUT" no matter
  // what theme is picked later.
  typeButtonOutSelected: { backgroundColor: ROSE_TEXT, borderColor: ROSE_TEXT },
  typeButtonOtSelected: { backgroundColor: BUTTER, borderColor: BUTTER },
  typeButtonInText: { color: SAGE, fontSize: 17, fontFamily: FONT_DISPLAY_EXTRABOLD },
  typeButtonOutText: { color: ROSE_TEXT, fontSize: 17, fontFamily: FONT_DISPLAY_EXTRABOLD },
  typeButtonOtText: { color: BUTTER, fontSize: 17, fontFamily: FONT_DISPLAY_EXTRABOLD },
  typeButtonTextSelected: { color: '#fff' },
  dots: { flexDirection: 'row', gap: 20, marginTop: 20, marginBottom: 36 },
  dot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.4)'
  },
  dotFilled: { backgroundColor: '#fff', borderColor: '#fff' },
  dotDanger: { borderColor: '#EBC4BF' },
  dotFilledDanger: { backgroundColor: '#C0392B', borderColor: '#C0392B' },
  dotLight: { borderColor: BORDER },
  dotFilledLight: { backgroundColor: ACCENT_DARK, borderColor: ACCENT_DARK },
  dotSchedule: { borderColor: BORDER }, // light outline so empty dots are visible on the soft blue Schedule background
  dotFilledSchedule: { backgroundColor: ACCENT_DARK, borderColor: ACCENT_DARK },
  dotError: { borderColor: '#c0392b', backgroundColor: '#c0392b' },
  errorText: { color: '#C0392B', fontSize: 14, fontFamily: FONT_BODY_SEMIBOLD, marginTop: 20 },
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
  keyDanger: { backgroundColor: '#ffffff', borderWidth: 1.5, borderColor: '#EBC4BF' },
  keyLight: { backgroundColor: '#ffffff', borderWidth: 1, borderColor: BORDER },
  keySchedule: { backgroundColor: '#ffffff', borderWidth: 1.5, borderColor: BORDER },
  keyText: { color: '#fff', fontSize: 30, fontFamily: FONT_DISPLAY_BOLD },
  keyTextSmall: { color: 'rgba(255,255,255,0.7)', fontSize: 16, fontFamily: FONT_BODY_BOLD },
  keyTextLight: { color: TEXT },
  scheduleButton: {
    position: 'absolute',
    bottom: 24,
    left: 24,
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 999
  },
  cornerButton: {
    position: 'absolute',
    bottom: 24,
    right: 24,
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 999
  },
  cornerButtonText: { color: 'rgba(255,255,255,0.7)', fontSize: 12, fontFamily: FONT_DISPLAY_SEMIBOLD },
  cornerButtonLight: { backgroundColor: ACCENT_BG },
  cornerButtonTextLight: { color: ACCENT_DARK, fontSize: 12, fontFamily: FONT_DISPLAY_BOLD },
  versionText: {
    position: 'absolute',
    bottom: 4,
    left: 0,
    right: 0,
    textAlign: 'center',
    color: TEXT_MUTED,
    fontSize: 10,
    fontFamily: FONT_BODY_SEMIBOLD
  },
  // Kept deliberately compact -- this floats over the same keypad screen
  // the next person in line is about to use, so it must never eat into the
  // number rows below it (was 20% top + 32 vertical padding, tall enough to
  // cover the first keypad row on the real tablet).
  feedbackCard: {
    position: 'absolute',
    top: '14%',
    left: 40,
    right: 40,
    borderRadius: 20,
    paddingVertical: 16,
    alignItems: 'center'
  },
  feedbackIn: { backgroundColor: SAGE },
  feedbackOut: { backgroundColor: ROSE_TEXT },
  feedbackError: { backgroundColor: '#c0392b' },
  feedbackType: { color: '#fff', fontSize: 22, fontFamily: FONT_DISPLAY_EXTRABOLD, letterSpacing: 2 },
  feedbackName: { color: '#fff', fontSize: 17, fontFamily: FONT_DISPLAY_BOLD, marginTop: 4, textAlign: 'center' },
  feedbackTime: { color: 'rgba(255,255,255,0.8)', fontSize: 13, fontFamily: FONT_BODY_MEDIUM, marginTop: 2 },
  feedbackLate: {
    color: '#fff',
    backgroundColor: 'rgba(0,0,0,0.25)',
    fontSize: 11,
    fontFamily: FONT_DISPLAY_BOLD,
    marginTop: 6,
    paddingVertical: 3,
    paddingHorizontal: 10,
    borderRadius: 10
  },
  calendarWrap: { width: '100%', maxWidth: 500, maxHeight: '62%' },
  calendarWeekRow: { flexDirection: 'row', width: '100%', maxWidth: 500 },
  calendarHeaderCell: {
    flex: 1,
    textAlign: 'center',
    color: TEXT_MUTED,
    fontSize: 13,
    fontFamily: FONT_DISPLAY_BOLD,
    paddingBottom: 6
  },
  calendarCell: {
    flex: 1,
    aspectRatio: 0.75, // taller than before (was 0.92 -- aspectRatio is width/height, so this is the smaller-is-taller direction) -- 0.92 left the Late/OT dots (and the Holiday/Leave note) too cramped to read comfortably; the calendar area already scrolls (see calendarWrap), so a taller grid costs a bit more scrolling, not clipped content
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 7,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: BORDER,
    backgroundColor: ACCENT_BG // real calendar days default to a muted tint; calendarCellWorked (below) brightens the ones with an actual record
  },
  calendarCellBlank: { borderColor: 'transparent', backgroundColor: 'transparent' },
  calendarCellWorked: { backgroundColor: CARD, borderColor: BORDER }, // days with an actual record stand out against the muted default
  calendarCellHoliday: { backgroundColor: '#FFF3E0', borderColor: '#F5C88F' },
  calendarCellLeave: { backgroundColor: '#FDECEA', borderColor: '#F1B3AB' },
  calendarDayNum: { color: TEXT, fontSize: 15, fontFamily: FONT_BODY_EXTRABOLD },
  calendarTime: { color: ACCENT_DARK, fontSize: 11, fontFamily: FONT_BODY_BOLD, marginTop: 2 },
  calendarNote: { color: TEXT_MUTED, fontSize: 10, fontFamily: FONT_BODY_BOLD, marginTop: 3, textAlign: 'center', paddingHorizontal: 2 },
  calendarNoteHoliday: { color: '#B8631A' },
  calendarNoteLeave: { color: '#C0392B' },
  calendarDotsRow: { flexDirection: 'row', gap: 4, marginTop: 3 },
  calendarDot: { width: 7, height: 7, borderRadius: 3.5 },
  calendarDotLate: { backgroundColor: '#c0392b' },
  calendarDotOt: {
    backgroundColor: BUTTER // matches the OT=amber semantic used everywhere else now, was a plain green before
  },
  calendarLegend: { flexDirection: 'row', gap: 20, marginTop: 12 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendText: { color: TEXT_MUTED, fontSize: 12, fontFamily: FONT_BODY_SEMIBOLD },
  doneButton: {
    marginTop: 24,
    backgroundColor: TEXT,
    borderRadius: 999,
    paddingVertical: 14,
    paddingHorizontal: 48,
    alignItems: 'center'
  },
  buttonText: { color: '#fff', fontSize: 16, fontFamily: FONT_DISPLAY_SEMIBOLD },
  // Separate from buttonText: the Confirm button sits on a light pastel
  // fill (see confirmButton), so it needs dark text for contrast, never
  // white-on-pastel -- same rule as every button in the web preview.
  confirmButtonText: { color: ACCENT_TEXT, fontSize: 16, fontFamily: FONT_DISPLAY_EXTRABOLD }
});

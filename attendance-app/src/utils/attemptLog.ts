import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'kiosk_attempt_log_v1';
// Was 100 -- too short-lived in practice: diagnosing a real incident
// (2026-10-01, missing OUT rows from the evening before) found the
// relevant entries had already rolled off by the next morning on a busy
// shared tablet. Each entry is tiny (a timestamp, an action name, a
// result, a short message), so 1000 costs negligible storage.
const MAX_ENTRIES = 1000;

export type AttemptResult = 'success' | 'timeout' | 'network_error' | 'rejected';

export type AttemptEntry = {
  timestamp: number;
  action: string;
  result: AttemptResult;
  message?: string;
};

/** Best-effort, local-only -- a logging failure should never break the kiosk flow. */
export async function logAttempt(entry: AttemptEntry): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const existing: AttemptEntry[] = raw ? JSON.parse(raw) : [];
    const next = [entry, ...existing].slice(0, MAX_ENTRIES);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore -- logging is diagnostic only
  }
}

export async function getAttemptLog(): Promise<AttemptEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function clearAttemptLog(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

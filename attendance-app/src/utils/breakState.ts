import AsyncStorage from '@react-native-async-storage/async-storage';

// Per-PIN "am I currently on break, and since when" marker, consulted when a
// PIN lookup falls back to the on-device directory (no live server round
// trip, so no authoritative onBreak from handleKioskLookupPin_ -- see
// KioskScreen's tryLocalLookup) AND when an offline Back from Break needs to
// estimate how long the just-ending session lasted (see
// breakMinutesCache.ts). While online, the live lookup/kioskBreak responses
// are always used instead where available -- this marker is the fallback.
// Storing the start timestamp (not just a boolean) is what makes the
// offline-estimate feature possible; a plain on/off flag can't tell you how
// long a session ran.
const KEY = 'kiosk_break_state_v1';

// pin -> ISO timestamp of when that PIN's currently-open break started;
// absent key means not on break.
async function readMap(): Promise<Record<string, string>> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/**
 * `startedAt`: an ISO timestamp to mark this PIN as on-break since that
 * moment, or `null` to clear (back from break / clocked out). Best-effort;
 * a failure here just means the offline fallback guesses "not on break" for
 * this PIN next time, same as before this existed.
 */
export async function setLocalOnBreak(pin: string, startedAt: string | null): Promise<void> {
  try {
    const map = await readMap();
    if (startedAt) map[pin] = startedAt;
    else delete map[pin];
    await AsyncStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

export async function getLocalOnBreak(pin: string): Promise<boolean> {
  const map = await readMap();
  return pin in map;
}

/** ISO timestamp the PIN's currently-open break started, or null if not on break (or unknown). */
export async function getLocalBreakStartedAt(pin: string): Promise<string | null> {
  const map = await readMap();
  return map[pin] ?? null;
}

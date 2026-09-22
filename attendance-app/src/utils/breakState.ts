import AsyncStorage from '@react-native-async-storage/async-storage';

// Per-PIN "am I currently on break" marker, consulted ONLY when a PIN lookup
// falls back to the on-device directory (no live server round trip, so no
// authoritative onBreak from handleKioskLookupPin_ -- see KioskScreen's
// tryLocalLookup). While online, the live lookup's own onBreak is always
// used instead and this marker is irrelevant. Written on a successful
// offline BREAK_START enqueue, cleared on BREAK_END enqueue (or once the
// matching queue entry is confirmed synced) -- see KioskScreen's onConfirm.
const KEY = 'kiosk_break_state_v1';

async function readMap(): Promise<Record<string, 'on_break'>> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Best-effort; a failure here just means the offline fallback guesses "not on break" for this PIN next time, same as before this existed. */
export async function setLocalOnBreak(pin: string, onBreak: boolean): Promise<void> {
  try {
    const map = await readMap();
    if (onBreak) map[pin] = 'on_break';
    else delete map[pin];
    await AsyncStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

export async function getLocalOnBreak(pin: string): Promise<boolean> {
  const map = await readMap();
  return map[pin] === 'on_break';
}

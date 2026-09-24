import AsyncStorage from '@react-native-async-storage/async-storage';
import { todayKey } from './localDate';

// Per-PIN "did this employee already clock IN today" marker, kept on-device
// PURELY to decide whether the morning auto-select (see KioskScreen's
// AUTO_IN_START_HOUR/AUTO_IN_END_HOUR effect) should default the selection
// to IN again -- never used to hide, disable, or gate the IN button itself,
// which always stays fully visible and tappable regardless of this marker.
// Best-effort and allowed to be wrong: if it's ever stale or missing (app
// reinstalled, storage cleared, employee clocked in from a different
// device), the only consequence is IN gets defaulted again unnecessarily --
// a minor annoyance, never a block on actually clocking in.
//
// setLocalCheckedInToday/clearLocalCheckedInToday do an unlocked read-
// modify-write (no equivalent of offlineQueue.ts's withQueueLock) -- two
// concurrent calls for the same PIN (e.g. a background flushQueue
// correction racing a brand-new foreground check-in) could in principle
// interleave and drop one update. Deliberately not guarded against: the
// window is a handful of milliseconds, requires two rare events to land at
// once, and the worst outcome either way is still just a wrong default
// pre-selection next lookup -- not worth a dedicated lock for.
const KEY = 'kiosk_checked_in_today_v1';

async function readMap(): Promise<Record<string, string>> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function writeMap(map: Record<string, string>): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // ignore -- best-effort, same as breakState.ts/breakMinutesCache.ts
  }
}

/** Records that this PIN clocked IN today (device-local date). Not awaited by callers -- fire-and-forget, same convention as every other local-cache write in KioskScreen. */
export async function setLocalCheckedInToday(pin: string): Promise<void> {
  const map = await readMap();
  map[pin] = todayKey();
  await writeMap(map);
}

/**
 * Reverts the marker. Two callers, two reasons:
 * - A queued offline IN later turns out to have never actually landed
 *   (permanently rejected on sync, e.g. the employee was deactivated in the
 *   meantime), so the auto-select doesn't keep silently skipping IN for a
 *   check-in that never really happened. Same "worst case is a missed
 *   default, never a block" reasoning as everywhere else this marker is
 *   used -- IN was always still tappable in the meantime.
 * - A real OUT succeeds (online or queued offline) -- see KioskScreen's
 *   onConfirm/queueOffline -- so the Kiosk's Break button (gated on
 *   alreadyCheckedInToday || onBreak) stops showing for the rest of the
 *   day; otherwise it would keep inviting a tap that recordBreak_ can only
 *   ever reject with already_clocked_out.
 */
export async function clearLocalCheckedInToday(pin: string): Promise<void> {
  const map = await readMap();
  delete map[pin];
  await writeMap(map);
}

/** True only if this PIN's stored IN date is today -- a stale (older) or missing entry reads as false, same "treat a stale entry as a fresh day" rule the other local caches use. */
export async function getLocalCheckedInToday(pin: string): Promise<boolean> {
  const map = await readMap();
  return map[pin] === todayKey();
}

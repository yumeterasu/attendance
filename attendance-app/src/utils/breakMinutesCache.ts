import AsyncStorage from '@react-native-async-storage/async-storage';
import { todayKey } from './localDate';

// Per-PIN "how many real break minutes has this employee used today" running
// ESTIMATE, kept on-device so an offline Back from Break can still show a
// number instead of nothing. Ground truth only ever comes from the server
// (totalMinutesUsedToday in kioskBreak/kioskSyncOffline's BREAK_END
// responses, see Attendance.gs) -- this cache exists purely to approximate
// that number for the window between an offline break ending and it actually
// syncing, and self-corrects back to the real value the moment a sync
// succeeds (see setConfirmedTotalMinutesToday). Never treated as
// authoritative by the UI -- always shown with an "estimate" marker (see
// KioskScreen's feedback card).
const KEY = 'kiosk_break_minutes_estimate_v1';

type Entry = { date: string; totalMinutes: number }; // date: device-local YYYY-MM-DD

async function readMap(): Promise<Record<string, Entry>> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function writeMap(map: Record<string, Entry>): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // ignore -- best-effort, same as breakState.ts
  }
}

/**
 * Adds `minutes` on top of today's current estimate (resetting first if the
 * cached entry is stale) -- called when an offline Back from Break is
 * queued, using that session's own locally-computed duration. `minutes` may
 * be negative -- used to precisely UNDO a session's own earlier contribution
 * if the queued entry it came from later gets permanently rejected by the
 * server (see offlineQueue.ts's flushQueue), rather than letting a rejected
 * session's minutes stay stuck in the estimate forever with no correction
 * path (the server's own totalMinutesUsedToday never arrives for a rejected
 * entry, so setConfirmedTotalMinutesToday never fires for it either).
 * Floored at 0 either way. Returns the new total so callers that need it
 * immediately (see queueOffline) don't have to do a second read.
 */
export async function addEstimatedOfflineBreakMinutes(pin: string, minutes: number): Promise<number> {
  const map = await readMap();
  const today = todayKey();
  const prior = map[pin] && map[pin].date === today ? map[pin].totalMinutes : 0;
  const total = Math.max(0, prior + minutes);
  map[pin] = { date: today, totalMinutes: total };
  await writeMap(map);
  return total;
}

/**
 * Overwrites today's estimate with the server's own authoritative total --
 * called whenever a BREAK_END actually syncs (live, or later from the
 * offline queue), so the estimate self-corrects the moment ground truth is
 * known, instead of drifting further with every subsequent offline break.
 */
export async function setConfirmedTotalMinutesToday(pin: string, totalMinutes: number): Promise<void> {
  const map = await readMap();
  map[pin] = { date: todayKey(), totalMinutes };
  await writeMap(map);
}

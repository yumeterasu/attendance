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

// Every export below does read-modify-write on the SAME whole-map
// AsyncStorage entry (not one key per PIN), so two calls left to interleave
// freely (e.g. a BREAK_END sync's setConfirmedTotalMinutesToday racing a
// concurrent lookup's seedFromDirectoryIfUnknown -- added 2026-10-14, and
// now firing on every single PIN lookup, not just a break action, which
// made this pre-existing race meaningfully easier to hit) could lose
// whichever write's readMap() happened to run first, even for two
// DIFFERENT PINs. This tiny queue chains every call through the same
// promise, so each one's whole read-modify-write cycle fully finishes
// before the next one's read ever starts -- cheap (this file's write
// volume is trivial) and simpler than per-PIN locking for what's still a
// single-device, mostly-sequential kiosk flow.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn, fn);
  queue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
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
  return serialized(async () => {
    const map = await readMap();
    const today = todayKey();
    const prior = map[pin] && map[pin].date === today ? map[pin].totalMinutes : 0;
    const total = Math.max(0, prior + minutes);
    map[pin] = { date: today, totalMinutes: total };
    await writeMap(map);
    return total;
  });
}

/**
 * Overwrites today's estimate with the server's own authoritative total --
 * called whenever a BREAK_END actually syncs (live, or later from the
 * offline queue), so the estimate self-corrects the moment ground truth is
 * known, instead of drifting further with every subsequent offline break.
 */
export async function setConfirmedTotalMinutesToday(pin: string, totalMinutes: number): Promise<void> {
  return serialized(async () => {
    const map = await readMap();
    map[pin] = { date: todayKey(), totalMinutes };
    await writeMap(map);
  });
}

/**
 * Seeds today's estimate from the directory's own totalMinutesUsedToday
 * (see Attendance.gs's bulkCompletedBreakMinutesToday_/
 * handleKioskDirectory_, and employeeDirectory.ts's own comment) -- but
 * ONLY when this device has no entry of its own for this PIN today at all.
 * Real gap this closes: this cache is per-device storage, never synced
 * across tablets, so a device an employee has never broken on TODAY starts
 * from 0 regardless of how much they already used at a DIFFERENT branch --
 * an offline Back from Break there would then show close to the full
 * budget remaining, understating real usage. The directory (refreshed
 * ~30s while online) gives any device a recent cross-branch baseline
 * instead of a bare 0.
 *
 * Deliberately conservative: if this device already has ANY entry for this
 * PIN today (its own confirmed total, or its own earlier offline
 * estimate), that is left completely untouched -- this device's own
 * knowledge of what actually happened ON it is never overwritten by a
 * periodic, possibly-stale directory snapshot. This does not fully close
 * the gap (a THIRD round, cross-branch again, after this device's own
 * now-stale local entry, still won't pick up the directory's newer figure
 * until this device's own entry rolls over to a new day) -- an accepted,
 * smaller remaining edge case, same spirit as this file's other documented
 * limitations.
 */
export async function seedFromDirectoryIfUnknown(pin: string, directoryTotalMinutes: number): Promise<void> {
  return serialized(async () => {
    const map = await readMap();
    const today = todayKey();
    if (map[pin] && map[pin].date === today) return; // this device already knows something about today -- never overwritten
    map[pin] = { date: today, totalMinutes: Math.max(0, directoryTotalMinutes) };
    await writeMap(map);
  });
}

/**
 * Read-only: today's current estimate for this PIN, or 0 if this device has
 * no entry for today (never broken here yet, and seedFromDirectoryIfUnknown
 * hasn't been called for it either). Added 2026-10-16 for KioskScreen's
 * post-lookup "break time left today" display (tryLocalLookup) -- callers
 * should call seedFromDirectoryIfUnknown first and await it, so this read
 * reflects the best locally-available knowledge (this device's own
 * confirmed/estimated total if it has one, otherwise the directory's
 * cross-branch figure just seeded). Routed through the same `serialized`
 * queue as every write here, not a bare AsyncStorage.getItem, so a read
 * immediately following an awaited write (the seed call above) can never
 * observe a stale value from a write still in flight.
 */
export async function getTodayTotalMinutes(pin: string): Promise<number> {
  return serialized(async () => {
    const map = await readMap();
    const today = todayKey();
    return map[pin] && map[pin].date === today ? map[pin].totalMinutes : 0;
  });
}

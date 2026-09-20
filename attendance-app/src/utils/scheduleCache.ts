import AsyncStorage from '@react-native-async-storage/async-storage';
import { ScheduleDay } from '../api/client';

// Keyed by PIN + year + month -- past months only (the current month is
// never read from here, see KioskScreen's goToScheduleMonth: it changes
// throughout the day so it's always fetched live, and syncScheduleHistory
// deliberately never writes a cache entry for it either). A cached past
// month's attendance essentially never changes once it's over, so there's
// no freshness/expiry concern here the way there is for the PIN directory
// cache -- once a month is cached it's good until an admin backdates
// something into it, which a fresh sync (next My Schedule visit) picks up.
const KEY_PREFIX = 'kiosk_schedule_cache_v1';

export type CachedMonth = { name: string; year: number; month: number; days: ScheduleDay[] };

function keyFor(pin: string, year: number, month: number): string {
  return `${KEY_PREFIX}_${pin}_${year}_${month}`;
}

/** Saves one month's result so goToScheduleMonth can serve it instantly next time, no network round trip. Silently does nothing on a storage failure -- that month just falls back to a live fetch, same as before this cache existed. */
export async function cacheScheduleMonth(pin: string, month: CachedMonth): Promise<void> {
  try {
    await AsyncStorage.setItem(keyFor(pin, month.year, month.month), JSON.stringify(month));
  } catch {
    // ignore
  }
}

/** Returns the cached month, or null if it was never synced (including on a storage read failure) -- the caller falls back to a live fetch either way. */
export async function getCachedScheduleMonth(pin: string, year: number, month: number): Promise<CachedMonth | null> {
  try {
    const raw = await AsyncStorage.getItem(keyFor(pin, year, month));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

// A separate, single-entry-per-PIN slot for the CURRENT month specifically
// (the one CachedMonth above deliberately never stores -- see its comment).
// Unlike a past month, this snapshot goes stale the moment more of the day
// passes, so it's only ever shown labeled as such (see KioskScreen's stale
// banner) after a live fetch has failed -- never silently in place of one.
const CURRENT_KEY_PREFIX = 'kiosk_schedule_current_v1';
export type CurrentSnapshot = { name: string; year: number; month: number; days: ScheduleDay[]; fetchedAt: number };

function currentKeyFor(pin: string): string {
  return `${CURRENT_KEY_PREFIX}_${pin}`;
}

/** Saves the current month's just-fetched result as a fallback for the next time a live fetch fails. Silently does nothing on a storage failure -- same no-fallback behavior as before this cache existed. */
export async function cacheCurrentScheduleSnapshot(pin: string, snapshot: Omit<CurrentSnapshot, 'fetchedAt'>): Promise<void> {
  try {
    await AsyncStorage.setItem(currentKeyFor(pin), JSON.stringify({ ...snapshot, fetchedAt: Date.now() }));
  } catch {
    // ignore
  }
}

/** Returns the last successfully-fetched current-month snapshot for this PIN, or null if there's never been one (including on a storage read failure). */
export async function getCurrentScheduleSnapshot(pin: string): Promise<CurrentSnapshot | null> {
  try {
    const raw = await AsyncStorage.getItem(currentKeyFor(pin));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Same slot as cacheCurrentScheduleSnapshot above, but for the device-wide
 * daily sync (see useScheduleSync) writing every employee's snapshot in one
 * pass -- one multiSet call instead of one setItem per employee, cheaper on
 * a large roster. Unlike cacheCurrentScheduleSnapshot, a storage failure
 * here is NOT swallowed (returns false instead of silently doing nothing):
 * the caller uses this as an all-or-nothing signal for whether today's sync
 * actually landed, so it can decide whether to mark the day done or retry
 * the whole batch later -- silently losing that signal would leave some
 * employees permanently stuck on a stale cache until the next calendar day.
 * year/month are one shared value for the whole batch (the sync is always
 * "everyone, this same month"), not per employee -- takes them once instead
 * of duplicated onto every array element, which also rules out a batch ever
 * silently mixing employees from two different months.
 */
export async function cacheCurrentScheduleSnapshots(
  year: number,
  month: number,
  employees: { pin: string; name: string; days: ScheduleDay[] }[]
): Promise<boolean> {
  if (employees.length === 0) return true;
  try {
    const fetchedAt = Date.now();
    const pairs: [string, string][] = employees.map((e) => [
      currentKeyFor(e.pin),
      JSON.stringify({ name: e.name, year, month, days: e.days, fetchedAt })
    ]);
    await AsyncStorage.multiSet(pairs);
    return true;
  } catch {
    return false;
  }
}

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

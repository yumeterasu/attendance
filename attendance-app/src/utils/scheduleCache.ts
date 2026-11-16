import AsyncStorage from '@react-native-async-storage/async-storage';
import { ScheduleDay, ScheduleSyncEmployee, KioskMonthFields } from '../api/client';

// Keyed by PIN + year + month -- past months only (the current month is
// never read from here, see KioskScreen's goToScheduleMonth: it changes
// throughout the day so it's always fetched live, and syncScheduleHistory
// deliberately never writes a cache entry for it either). A cached past
// month's attendance essentially never changes once it's over, so there's
// no freshness/expiry concern here the way there is for the PIN directory
// cache -- once a month is cached it's good until an admin backdates
// something into it, which a fresh sync (next My Schedule visit) picks up.
// Bumped v1 -> v2, 2026-10-07: otUnit/otMinutesTotal/otQuartersTotal (added
// below) are now REQUIRED fields, but a tablet already running a prior
// build has v1 entries on disk with no such fields at all -- reading one of
// those back under the old key would silently produce otUnit: undefined
// (TypeScript's static typing doesn't survive a JSON.parse of real stored
// data), rendering "+undefinedq" per day and "undefined quarters" in the
// new month-total summary, in exactly the offline-fallback path this cache
// exists to make reliable. No migration (unlike breakState.ts's v1->v2,
// where an in-progress break was worth preserving) -- this is a read-only
// display cache that self-heals from the next live fetch/background sync,
// so simply starting clean under a new key is simpler and safer than
// writing a migration for data that's cheap to just re-fetch.
// Bumped v2 -> v3, 2026-10-20: lateCount/overCount/allowanceTotal (added
// below) are now REQUIRED fields too -- identical reasoning, a v2 tablet
// cache has none of them, so this starts clean again rather than risking
// "undefined day(s)"/"฿undefined" in the My Schedule summary grid's new
// Late/Over Break/Allowance cells when reading an old entry back offline.
// Bumped v3 -> v4, 2026-11-03: daysWorked (added below) is now a REQUIRED
// field too, for the summary grid's new Days Worked box -- same reasoning,
// a v3 tablet cache has no such field at all.
// Bumped v4 -> v5, 2026-11-16 (real review catch): unpaidLeaveDeduction
// shipped first (2026-11-14) as OPTIONAL, reasoning that a cached month
// without it would just show no Unpaid Leave hint -- a harmless, honest
// "nothing to show" degradation. That reasoning broke the moment the UI
// redesigned the SAME day to show unpaidLeaveDays (new) as its own
// number instead: a month cached by that first build has a real nonzero
// unpaidLeaveDeduction but no unpaidLeaveDays/unpaidLeaveDetail at all,
// so reading it back under the OLD key would render "0" for Unpaid
// Leave and leave the box non-tappable -- actively WRONG (hiding a real,
// already-known pay figure), not a graceful "nothing to show" -- exactly
// the failure mode every other bump above exists to prevent. Starting
// clean under v5 is simpler and safer than a migration, same reasoning
// every prior bump gives.
const KEY_PREFIX = 'kiosk_schedule_cache_v5';

// otUnit/otMinutesTotal/otQuartersTotal cached alongside days (added
// 2026-10-07) so the month-total summary shown below the calendar is
// correct from a cached read too, not just a live one -- see
// ScheduleDay/kioskMyAttendance's own comments in client.ts for why otUnit
// specifically can't just be re-derived from the cached days themselves.
// lateCount/overCount/allowanceTotal (added 2026-10-20) follow the same
// reasoning, for the summary grid's 3 new stats. daysWorked (added
// 2026-11-03) follows it too, for the grid's newest stat. allowanceDetail
// (2026-10-20) is intentionally OPTIONAL -- not part of any of these
// required-fields bumps, since the tap-to-expand breakdown it backs
// degrades gracefully (just not tappable) rather than needing yet another
// cache wipe for a nice-to-have. unpaidLeaveDays/unpaidLeaveDeduction/
// unpaidLeaveDetail stay OPTIONAL in the type (KioskMonthFields, client.ts)
// for the same graceful-degradation reason on a FUTURE field that might
// be missing -- the v4->v5 bump just above exists so that specific
// scenario can't actually happen for *this* trio on *this* rollout.
export type CachedMonth = { name: string; year: number; month: number; days: ScheduleDay[] } & KioskMonthFields;

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
// Bumped v1 -> v2 alongside KEY_PREFIX above, same reason and same day.
// Bumped v2 -> v3 alongside KEY_PREFIX above too, same reason and same day.
// Bumped v3 -> v4 alongside KEY_PREFIX above too, same reason and same day.
// Bumped v4 -> v5 alongside KEY_PREFIX above too, same reason and same day
// (2026-11-16) -- this is the slot goToScheduleMonth/the stale banner
// fall back to after a failed live fetch, so it's just as capable of
// surfacing a stale, pre-redesign unpaidLeaveDeduction with no
// unpaidLeaveDays/unpaidLeaveDetail alongside it.
const CURRENT_KEY_PREFIX = 'kiosk_schedule_current_v5';
export type CurrentSnapshot = { name: string; year: number; month: number; days: ScheduleDay[]; fetchedAt: number } & KioskMonthFields;

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
  employees: ScheduleSyncEmployee[]
): Promise<boolean> {
  if (employees.length === 0) return true;
  try {
    const fetchedAt = Date.now();
    const pairs: [string, string][] = employees.map((e) => [
      currentKeyFor(e.pin),
      // Spread (not a 9-field-and-growing manual list) so a future field
      // added to ScheduleSyncEmployee is carried over here automatically --
      // `pin` rides along harmlessly (CurrentSnapshot doesn't declare it,
      // but nothing reads it back off this cache entry either).
      JSON.stringify({ ...e, year, month, fetchedAt })
    ]);
    await AsyncStorage.multiSet(pairs);
    return true;
  } catch {
    return false;
  }
}

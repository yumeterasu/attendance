import { useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { kioskScheduleSyncAll } from '../api/client';
import { cacheCurrentScheduleSnapshots } from '../utils/scheduleCache';

const SYNC_HOUR = 11; // local time -- everyone's current-month My Schedule gets pre-synced once each day at/after this hour
const POLL_INTERVAL_MS = 5 * 60 * 1000; // no urgency here (unlike useOfflineSync's queue) -- just needs to notice "it's past 11:00" sometime after it actually is
const LAST_SYNCED_DATE_KEY = 'kiosk_schedule_sync_last_date_v1';

/** Local calendar date only, as a comparable string -- toDateString() ("Fri Sep 18 2026") is locale-independent and deterministic; it's never shown to anyone, just compared against itself. */
function todayKey(): string {
  return new Date().toDateString();
}

/**
 * Device-wide background sync: once a day, at/after SYNC_HOUR local time,
 * pulls every active employee's current-month schedule in one call and
 * caches all of them on-device in one batch (see cacheCurrentScheduleSnapshots) --
 * before anyone ever taps "My Schedule", not only after (see
 * submitSchedulePin's own fallback in KioskScreen, which only ever had
 * something to fall back on for a PIN that had already been looked up
 * live at least once on this device). No employee interaction needed;
 * whoever taps in later gets an instant cache hit if the live fetch that
 * moment happens to fail.
 *
 * "Once a day" is tracked by date string in AsyncStorage (LAST_SYNCED_DATE_KEY),
 * not a timer fired once -- the app can be killed/reopened any number of
 * times, and a kiosk tablet realistically never truly "restarts" a running
 * JS process on a schedule, so a persisted marker checked on a cheap
 * periodic poll is the reliable way to guarantee "at most once, but
 * eventually" for the day, surviving app restarts and picking back up
 * automatically if the tablet was offline right at SYNC_HOUR (the marker
 * is only written on a SUCCESSFUL sync -- see runSync below -- so a failed
 * attempt just gets retried on the next poll tick, same backup-retry
 * reasoning useOfflineSync's own interval already uses for the same class
 * of problem).
 *
 * SYNC_HOUR/todayKey() both read the tablet's own local clock, while the
 * backend derives "today"/"current month" from the Apps Script project's
 * own timezone -- if a tablet's OS date/timezone is ever badly
 * misconfigured, the two could disagree about what day or month it is.
 * Accepted, not defended against here: same inherent risk any device-local-
 * clock gate has, and this app already depends elsewhere on the tablet's
 * clock being roughly correct (every check-in timestamp is stamped
 * client-side).
 */
export function useScheduleSync(isConnected: boolean) {
  const isSyncingRef = useRef(false);

  const runSync = async () => {
    // Set synchronously, before any await -- the mount/isConnected effect
    // and the interval's periodic tick can both call this, and without
    // setting the guard first (same reasoning as onConfirm/lookupPin/
    // submitExitPin in KioskScreen), two near-simultaneous calls could each
    // pass this check and both start the same AsyncStorage read below
    // before either sets isSyncingRef -- harmless in outcome (both would
    // write the same data), but a wasted duplicate network round trip.
    if (isSyncingRef.current) return;
    isSyncingRef.current = true;
    try {
      if (!isConnected) return;

      const now = new Date();
      if (now.getHours() < SYNC_HOUR) return;

      const today = todayKey();
      let lastSyncedDate: string | null;
      try {
        lastSyncedDate = await AsyncStorage.getItem(LAST_SYNCED_DATE_KEY);
      } catch {
        lastSyncedDate = null; // can't tell if today's already done -- try anyway; worst case this just re-syncs a day that already succeeded
      }
      if (lastSyncedDate === today) return;

      const res = await kioskScheduleSyncAll();
      if (!res.success) return; // network hiccup or similar -- marker stays unset, next poll tick retries
      // An empty list is treated as "nothing synced" (retry next tick), not
      // success -- cacheCurrentScheduleSnapshots itself reports true for an
      // empty batch (a reasonable no-op for that generic primitive), but
      // here it would otherwise mark the whole day done despite nothing
      // actually having been cached, e.g. a transient empty read while the
      // Employees sheet is mid-edit -- silently disabling any retry for the
      // rest of the day.
      if (res.employees.length === 0) return;
      // No ordering guarantee against a concurrent live write for the same
      // PIN (an employee opening My Schedule right as this batch lands) --
      // accepted on purpose: this whole request can take up to the full
      // SCHEDULE_BULK_SYNC_TIMEOUT_MS budget (45s), so the actual worst
      // case is "however stale this batch's own fetch was by the time it
      // finally writes", not just a couple seconds -- still not data loss
      // either way (both writers agree on the same shape, and the next
      // live fetch or the next day's sync corrects it), just a longer
      // staleness window than a quick glance at this comment used to imply.
      const wrote = await cacheCurrentScheduleSnapshots(res.year, res.month, res.employees);
      // Marked done only if every employee's snapshot actually landed --
      // cacheCurrentScheduleSnapshots reports false (rather than silently
      // swallowing, unlike the single-employee fallback cache) on a storage
      // failure, so a partial write means this date never gets marked
      // synced and the whole batch is simply retried in full on the next
      // poll tick, instead of leaving some employees permanently stuck on a
      // stale cache for the day.
      if (wrote) await AsyncStorage.setItem(LAST_SYNCED_DATE_KEY, today);
    } catch {
      // Leave the marker unset -- same retry-next-tick reasoning as above.
    } finally {
      isSyncingRef.current = false;
    }
  };

  useEffect(() => {
    if (isConnected) runSync();
  }, [isConnected]);

  useEffect(() => {
    // Re-created whenever isConnected changes so the interval's closure
    // never reads a stale value -- runSync (unlike useOfflineSync's own
    // periodic callback, which never touches isConnected at all) checks
    // isConnected directly, so a `[]`-deps interval here would freeze that
    // check against whatever isConnected happened to be on first mount,
    // silently ignoring every connectivity change for the rest of the
    // session.
    const interval = setInterval(runSync, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isConnected]);
}

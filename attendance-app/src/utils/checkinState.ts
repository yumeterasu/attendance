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
//
// Record shape added 2026-10-06 (real incident, structurally the same class
// of bug as breakState.ts's Kahana fix, lower stakes): clearLocalCheckedInToday
// used to DELETE the key rather than write anything, so "this device just
// confirmed OUT today" and "this device has never heard anything about this
// PIN today" both read back as the same bare "no entry" (the old
// `map[pin] === todayKey()` check). That ambiguity is why KioskScreen's
// tryLocalLookup had to fall back to a plain `local.onShift || checkedInNow`
// OR against the cross-branch directory (refreshed only every ~30s): a
// stale directory onShift=true could resurrect `alreadyCheckedInToday` right
// after a genuine OUT on THIS device, briefly re-showing the Break button.
// Lower severity than the break-state version of this bug -- this marker
// only gates Break-button VISIBILITY (see this file's own top comment), so
// a wrongly-shown button still gets rejected server-side with
// already_clocked_out; nothing is ever actually lost or recorded wrong --
// but the same fix applies: clear now WRITES { checkedIn: false,
// date: todayKey() } instead of deleting, so "confirmed not checked in
// today" is a real, distinguishable fact. See getLocalCheckedInRecordToday
// and its caller in KioskScreen.tsx's tryLocalLookup.
const KEY = 'kiosk_checked_in_today_v1';

type CheckinRecord = { checkedIn: boolean; date: string };

async function readMap(): Promise<Record<string, CheckinRecord>> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: Record<string, unknown> = JSON.parse(raw);
    // Guards against the pre-2026-10-06 shape (plain pin -> date string,
    // presence alone meant checked-in) still sitting in storage right after
    // an app update -- no migration pass, unlike breakState.ts's v1->v2: this
    // marker is day-scoped and purely a best-effort UX default (see this
    // file's own top comment), so dropping an old-shaped entry just means
    // this PIN reads as "unknown today" for the rest of that one transition
    // day, the exact same fallback behavior it would have gotten anyway
    // before today's fix existed -- not worth a second storage key and
    // migration pass for that.
    const result: Record<string, CheckinRecord> = {};
    Object.keys(parsed).forEach((pin) => {
      const entry = parsed[pin] as Partial<CheckinRecord> | null | undefined;
      if (entry && typeof entry === 'object' && typeof entry.checkedIn === 'boolean' && typeof entry.date === 'string') {
        result[pin] = { checkedIn: entry.checkedIn, date: entry.date };
      }
    });
    return result;
  } catch {
    return {};
  }
}

async function writeMap(map: Record<string, CheckinRecord>): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // ignore -- best-effort, same as breakState.ts/breakMinutesCache.ts
  }
}

/** Records that this PIN clocked IN today (device-local date). Not awaited by callers -- fire-and-forget, same convention as every other local-cache write in KioskScreen. */
export async function setLocalCheckedInToday(pin: string): Promise<void> {
  const map = await readMap();
  map[pin] = { checkedIn: true, date: todayKey() };
  await writeMap(map);
}

/**
 * Reverts the marker (writes `{ checkedIn: false, date: todayKey() }`,
 * deliberately not a delete -- see this file's own top comment on `source`
 * for why). Two callers, two reasons:
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
  map[pin] = { checkedIn: false, date: todayKey() };
  await writeMap(map);
}

/**
 * Combined accessor for tryLocalLookup's hot path -- `hasRecord` is true
 * only when this device has confirmed SOMETHING about this PIN TODAY
 * specifically (checked in, or explicitly cleared via a real OUT/rejected
 * offline IN), as opposed to never having heard anything about it today at
 * all (a stale older-dated entry counts as never having heard, same as a
 * missing one). When `hasRecord` is false, `checkedIn` is meaningless
 * (always false) -- the caller is expected to fall back to a fresher source
 * (the cross-branch directory) instead of using it. See this file's own top
 * comment for why this distinction exists.
 */
export async function getLocalCheckedInRecordToday(pin: string): Promise<{ hasRecord: boolean; checkedIn: boolean }> {
  const map = await readMap();
  const record = map[pin];
  if (record && record.date === todayKey()) {
    return { hasRecord: true, checkedIn: record.checkedIn };
  }
  return { hasRecord: false, checkedIn: false };
}

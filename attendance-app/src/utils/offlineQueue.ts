import AsyncStorage from '@react-native-async-storage/async-storage';
import { kioskSyncOffline } from '../api/client';
import { setLocalOnBreak } from './breakState';
import { setConfirmedTotalMinutesToday, addEstimatedOfflineBreakMinutes } from './breakMinutesCache';
import { clearLocalCheckedInToday } from './checkinState';
import { logAttempt } from './attemptLog';

const STORAGE_KEY = 'kiosk_offline_queue_v1';
// Prefix for a best-effort backup of a queue value that failed to
// JSON.parse, so a corrupted read has *some* recovery path (pulled off the
// device later) instead of every still-unsynced check-in just vanishing
// with no trace. Suffixed with a timestamp (see readQueue) rather than one
// fixed key, so a second corruption event before anyone's retrieved the
// first backup doesn't just overwrite and lose it too.
const CORRUPTED_BACKUP_KEY_PREFIX = 'kiosk_offline_queue_v1_corrupted_backup_';

export type QueuedCheckin = {
  clientId: string;
  pin: string;
  type: 'IN' | 'OUT' | 'BREAK_START' | 'BREAK_END';
  ot: boolean;
  timestamp: string; // ISO -- the real moment the employee tapped, not whenever this eventually syncs
  branch: string | null; // this device's configured branch (see deviceBranch.ts) AT THE TIME OF THE TAP -- captured here, not re-read at sync time, in case the device's branch setting changes in between; meaningless for BREAK_START/BREAK_END, always null there
  shift: string | null; // the shift the employee picked (IN only -- always null for OUT/BREAK_START/BREAK_END); server ignores it for OUT and falls back to the admin-set schedule if null
  breakDurationMinutes?: number; // BREAK_START only -- the employee's own pick (15/30/45/60), see handleKioskBreak_ server-side; absent for every other type
  // BREAK_END only -- this session's own locally-estimated duration, already
  // added to the on-device running total (see breakMinutesCache.ts) at
  // enqueue time. Kept here so flushQueue can precisely UNDO exactly this
  // amount if this specific entry later gets permanently rejected by the
  // server -- without it there'd be no way to know how much to revert.
  breakSessionMinutes?: number;
};

function makeClientId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function readQueue(): Promise<QueuedCheckin[]> {
  // One retry, same as writeQueue() below -- a native-module hiccup on a
  // read is just as likely to be transient as one on a write, so an
  // employee tapping Confirm shouldn't see "could not save" over a single
  // blip that a retry would have silently ridden out. A failure that
  // survives the retry is deliberately NOT swallowed into "empty queue" --
  // it propagates to the caller instead. Silently treating "couldn't read
  // storage" as "empty queue" used to be a second, sneakier way to lose
  // data: enqueueCheckin would then push its one new entry onto that
  // fake-empty array and write it back, permanently overwriting however
  // many earlier unsynced check-ins were actually sitting in storage.
  // Every caller runs this inside withQueueLock and is expected to treat a
  // throw as "don't know the real state, don't touch storage" rather than
  // press on with a guess.
  let raw: string | null;
  try {
    raw = await AsyncStorage.getItem(STORAGE_KEY);
  } catch {
    raw = await AsyncStorage.getItem(STORAGE_KEY); // let this one throw for real if it fails again
  }
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    // The stored queue is corrupted -- shouldn't normally happen (e.g. a
    // partial write from the app being killed mid-save). This used to
    // silently discard every still-unsynced check-in with zero trace.
    // Now: stash the raw value under a separate key (best-effort, fire-
    // and-forget is fine here -- it's a different key, so it can't race
    // with anything) so it's at least recoverable from the device later.
    AsyncStorage.setItem(CORRUPTED_BACKUP_KEY_PREFIX + Date.now(), raw).catch(() => {});
    // Then reset STORAGE_KEY itself to a valid empty array -- AWAITED, not
    // fire-and-forget, unlike the backup write above. This call and every
    // caller's own writeQueue() target the exact same key, and every
    // caller here runs inside withQueueLock (see below), so the only thing
    // that keeps two writes to STORAGE_KEY from racing is doing them one
    // at a time within that single locked call, in order. Firing this one
    // off without waiting for it would let it land AFTER a caller's own
    // writeQueue() (e.g. enqueueCheckin's) and silently erase whatever
    // was just legitimately saved -- still swallowed on failure (best-
    // effort), so a repair that can't complete never turns readQueue()
    // into something that fails the caller outright; it just means the
    // same corruption gets detected and retried next time instead.
    await AsyncStorage.setItem(STORAGE_KEY, '[]').catch(() => {});
    console.warn('[offlineQueue] stored queue was corrupted; backed up and reset to empty');
    return [];
  }
}

async function writeQueueOnce(queue: QueuedCheckin[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
}

// One retry (a native-module hiccup is usually transient) before giving up.
// Unlike before, a persistent failure now THROWS instead of being silently
// swallowed -- callers (enqueueCheckin) must never tell the employee
// "saved" when it wasn't actually saved.
async function writeQueue(queue: QueuedCheckin[]): Promise<void> {
  try {
    await writeQueueOnce(queue);
  } catch {
    await writeQueueOnce(queue); // let this one throw for real if it fails again
  }
}

// Serializes every read-modify-write against the queue. Without this,
// enqueueCheckin (an employee tapping right now) and flushQueue (syncing an
// older entry in the background) could each read their own snapshot and
// write it back independently -- whichever finished last would win,
// silently discarding whatever the other had just added. The employee
// would still see "Saved offline" (queueOffline shows that only after its
// own write resolves), but the entry itself would already be gone.
let queueLock: Promise<unknown> = Promise.resolve();
function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueLock.then(fn, fn);
  queueLock = run.then(() => undefined, () => undefined); // keep the chain alive even if fn rejects
  return run;
}

/**
 * Records a check-in locally right away and queues it for background sync.
 * Returns { success: false } if it could not actually be persisted -- the
 * caller must NOT show a "saved offline" confirmation in that case (see
 * KioskScreen's queueOffline), since there would be nothing there to sync.
 */
export async function enqueueCheckin(
  pin: string,
  type: 'IN' | 'OUT' | 'BREAK_START' | 'BREAK_END',
  ot: boolean,
  branch: string | null,
  shift: string | null,
  breakDurationMinutes?: number,
  breakSessionMinutes?: number
): Promise<{ success: true; clientId: string } | { success: false }> {
  const entry: QueuedCheckin = {
    clientId: makeClientId(),
    pin,
    type,
    ot,
    timestamp: new Date().toISOString(),
    branch,
    shift,
    breakDurationMinutes,
    breakSessionMinutes
  };
  try {
    await withQueueLock(async () => {
      const queue = await readQueue();
      queue.push(entry);
      await writeQueue(queue);
    });
    return { success: true, clientId: entry.clientId };
  } catch {
    return { success: false };
  }
}

// Best-effort: a transient read failure here just means the "N pending"
// badge doesn't show for a moment -- unlike enqueueCheckin/flushQueue,
// nothing is written, so there's no data-loss risk in falling back to 0.
export async function getQueueLength(): Promise<number> {
  return withQueueLock(async () => (await readQueue()).length).catch(() => 0);
}

/**
 * Epoch ms of the oldest still-queued entry's own tap timestamp, or null if
 * the queue is empty (or unreadable). flushQueue is strict FIFO and stops
 * entirely at the first network_error/timeout (see its own doc comment) --
 * one stuck entry can silently block everyone behind it, including a real
 * BREAK_END, for as long as the device stays in that state. This doesn't
 * fix that (reordering risks breaking a single employee's own action
 * order), it just gives AdminScreen something to show so a stuck queue is
 * visible instead of invisible.
 */
export async function getOldestQueuedAt(): Promise<number | null> {
  return withQueueLock(async () => {
    const queue = await readQueue();
    if (queue.length === 0) return null;
    return new Date(queue[0].timestamp).getTime();
  }).catch(() => null);
}

/**
 * Tries to sync every queued entry, oldest first, stopping at the first one
 * that still fails (keeps order -- a later entry shouldn't sync ahead of an
 * earlier one for the same day). Safe to call repeatedly/concurrently isn't
 * guaranteed -- callers should serialize their own calls (see useOfflineSync).
 *
 * Storage access is serialized via withQueueLock, but each network call
 * (kioskSyncOffline) runs OUTSIDE the lock -- so an employee tapping the
 * kiosk right now isn't stuck waiting on a slow server response for
 * someone else's already-queued entry before they can even see "Saved
 * offline" for their own tap.
 */
export async function flushQueue(): Promise<{ synced: number; remaining: number }> {
  let synced = 0;

  while (true) {
    // A read failure here (readQueue() can now throw, see above) means we
    // don't actually know what's queued -- stop this pass rather than
    // treat it as "nothing queued" and silently skip everyone waiting to
    // sync. useOfflineSync retries every 30s / on reconnect regardless.
    let next: QueuedCheckin | null;
    try {
      next = await withQueueLock(async () => (await readQueue())[0] ?? null);
    } catch {
      break;
    }
    if (!next) break;

    const res = await kioskSyncOffline(next.pin, next.type, next.ot, next.timestamp, next.clientId, next.branch, next.shift ?? undefined, next.breakDurationMinutes);
    let stop = false;

    try {
      await withQueueLock(async () => {
        // Re-read fresh here -- not the array captured above -- since
        // enqueueCheckin may have added (or, at least in principle,
        // something else may have removed) entries while the network call
        // above was in flight. Remove by clientId, not index 0, so this
        // only ever drops the exact entry just attempted, wherever it now
        // sits in the (possibly changed) list.
        const queue = await readQueue();
        const idx = queue.findIndex((e) => e.clientId === next.clientId);
        if (idx === -1) return; // already gone somehow -- nothing to do

        if (!res.success) {
          if (res.error === 'network_error' || res.error === 'timeout') { stop = true; return; } // still offline or server issue -- stop, keep the rest queued in order
          queue.splice(idx, 1); // permanent rejection (e.g. employee deactivated since) -- will never succeed, drop it instead of blocking everyone behind it
          await writeQueue(queue);
          if (next.type === 'BREAK_START' || next.type === 'BREAK_END') {
            // Logged for EVERY permanent drop of a break entry, not just the
            // rejection reasons below that don't have specific marker
            // reconciliation -- an admin reviewing the Connection Log (see
            // AdminScreen.tsx, already reads this same attemptLog storage)
            // needs the full trail to reconstruct what happened for a
            // specific employee, not just the cases this code doesn't know
            // how to self-correct. Not awaited, same fire-and-forget
            // convention as every other best-effort write in this file.
            logAttempt({
              timestamp: Date.now(),
              action: 'kioskSyncOffline_breakDropped',
              result: 'rejected',
              message: `${next.type} for pin ${next.pin} permanently dropped: ${res.error}`
            });
            // A dropped Break entry must not leave the on-device marker (see
            // breakState.ts) stuck on whatever queueOffline optimistically
            // guessed when it was first enqueued -- correct it from the
            // rejection reason instead of blindly resetting to false:
            // already_on_break means the TRUE state is on-break (some other
            // BREAK_START already won), so the marker must become true, not
            // false, or the button would keep showing "Start Break" to
            // someone who actually needs "Back from Break". The other
            // rejections (not_on_break/not_clocked_in/already_clocked_out)
            // all genuinely mean "not on break". "duplicate" and anything
            // else (not_found/inactive/bad_request) are left untouched --
            // for duplicate specifically, the marker is already correct from
            // whichever earlier same-type tap actually succeeded. Not
            // awaited, same as every other setLocalOnBreak call. The
            // already_on_break correction has no real "since when" to set
            // (some OTHER tap is the one actually on break server-side, and
            // its true start time isn't known here) -- "now" is the least-
            // wrong guess available, same accepted-estimate spirit as the
            // rest of this offline break-minutes design.
            if (res.error === 'already_on_break') {
              setLocalOnBreak(next.pin, new Date().toISOString());
            } else if (res.error === 'not_on_break' || res.error === 'not_clocked_in' || res.error === 'already_clocked_out') {
              setLocalOnBreak(next.pin, null);
            }
          }
          if (next.type === 'BREAK_END' && next.breakSessionMinutes != null && res.error !== 'duplicate') {
            // Same "duplicate" exclusion as the setLocalOnBreak correction
            // above, and for the same reason: 'duplicate' means an earlier
            // sibling entry with the same type already synced and IS the
            // real source of truth (its own totalMinutesUsedToday already
            // corrected the cache via setConfirmedTotalMinutesToday) --
            // reverting THIS entry's minutes on top of that would incorrectly
            // undo real, already-confirmed usage. For every other permanent
            // rejection, this entry's own session minutes were optimistically
            // added to the running estimate when it was first queued (see
            // queueOffline) and will never sync to correct it any other way
            // -- undo exactly this entry's contribution instead of leaving it
            // stuck in the estimate for the rest of the day.
            addEstimatedOfflineBreakMinutes(next.pin, -next.breakSessionMinutes);
          }
          if (next.type === 'IN' && res.error !== 'duplicate') {
            // Any permanent rejection OTHER than duplicate (not_found/
            // inactive/bad_request) means this IN never actually landed --
            // revert the optimistic marker queueOffline set at enqueue time,
            // so the morning auto-select doesn't keep silently skipping IN
            // for a check-in that never really happened. The IN button
            // itself was never blocked either way.
            //
            // 'duplicate' is left alone deliberately, NOT because it proves
            // an earlier same-type IN synced -- unlike the Break guard above
            // (sameTypeOnly), recordAttendance_'s duplicate guard is
            // type-agnostic (rejects within 60s of the employee's last log
            // row of ANY type), so a rejected IN's "duplicate" could equally
            // mean some unrelated OUT/Break row landed moments earlier. That
            // makes the true state genuinely undecidable from this response
            // alone; clearing here would be just as likely to wrongly erase
            // a real check-in (a genuine accidental double-tap where the
            // first IN did succeed) as leaving it is to wrongly keep a
            // phantom one. Left as-is as the least-surprising default --
            // still only ever a wrong PRE-SELECTION, never a blocked tap.
            clearLocalCheckedInToday(next.pin);
          }
          return;
        }

        queue.splice(idx, 1);
        synced++;
        await writeQueue(queue);
        if (next.type === 'BREAK_END' && res.success && res.totalMinutesUsedToday != null) {
          // Ground truth is now known -- overwrite the on-device running
          // estimate (see breakMinutesCache.ts) instead of leaving it as
          // whatever this device guessed while offline. Not awaited, same
          // as every other best-effort cache write in this file.
          setConfirmedTotalMinutesToday(next.pin, res.totalMinutesUsedToday);
        }
      });
    } catch {
      // Couldn't persist the post-sync queue update -- stop rather than
      // risk re-attempting (and double-recording) this same entry on the
      // next pass against storage we now can't trust.
      break;
    }

    if (stop) break;
  }

  // -1 here means "couldn't read the count" (a storage failure), never a
  // real queue length -- no current caller inspects `remaining` (useOfflineSync
  // discards it), but a future one must not treat -1 as a literal count.
  const remaining = await withQueueLock(async () => (await readQueue()).length).catch(() => -1);
  return { synced, remaining };
}

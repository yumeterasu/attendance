import AsyncStorage from '@react-native-async-storage/async-storage';
import { kioskSyncOffline } from '../api/client';

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
  type: 'IN' | 'OUT';
  ot: boolean;
  timestamp: string; // ISO -- the real moment the employee tapped, not whenever this eventually syncs
  branch: string | null; // this device's configured branch (see deviceBranch.ts) AT THE TIME OF THE TAP -- captured here, not re-read at sync time, in case the device's branch setting changes in between
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
    // Now: stash the raw value under a separate key (best-effort -- if
    // this write also fails there's nothing more we can do) so it's at
    // least recoverable from the device later, THEN reset STORAGE_KEY
    // itself to a valid empty array -- also best-effort, and deliberately
    // not awaited/thrown on failure, so a corruption event never turns
    // readQueue() into something that can fail the caller outright.
    // Without this reset, the same corrupted value would keep failing
    // JSON.parse on every future read (flushQueue alone reads it every
    // ~30s via useOfflineSync's retry interval) and write a fresh backup
    // key each time forever, rather than a single one-time repair.
    AsyncStorage.setItem(CORRUPTED_BACKUP_KEY_PREFIX + Date.now(), raw).catch(() => {});
    AsyncStorage.setItem(STORAGE_KEY, '[]').catch(() => {});
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
  type: 'IN' | 'OUT',
  ot: boolean,
  branch: string | null
): Promise<{ success: true; clientId: string } | { success: false }> {
  const entry: QueuedCheckin = { clientId: makeClientId(), pin, type, ot, timestamp: new Date().toISOString(), branch };
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

    const res = await kioskSyncOffline(next.pin, next.type, next.ot, next.timestamp, next.clientId, next.branch);
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
          return;
        }

        queue.splice(idx, 1);
        synced++;
        await writeQueue(queue);
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

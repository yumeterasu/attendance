import AsyncStorage from '@react-native-async-storage/async-storage';
import { kioskSyncOffline } from '../api/client';

const STORAGE_KEY = 'kiosk_offline_queue_v1';

export type QueuedCheckin = {
  clientId: string;
  pin: string;
  type: 'IN' | 'OUT';
  ot: boolean;
  timestamp: string; // ISO -- the real moment the employee tapped, not whenever this eventually syncs
};

function makeClientId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function readQueue(): Promise<QueuedCheckin[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function writeQueue(queue: QueuedCheckin[]): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // ignore -- worst case this queued item is lost, same as before offline support existed
  }
}

/** Records a check-in locally right away and queues it for background sync. Returns the generated clientId. */
export async function enqueueCheckin(pin: string, type: 'IN' | 'OUT', ot: boolean): Promise<string> {
  const entry: QueuedCheckin = { clientId: makeClientId(), pin, type, ot, timestamp: new Date().toISOString() };
  const queue = await readQueue();
  queue.push(entry);
  await writeQueue(queue);
  return entry.clientId;
}

export async function getQueueLength(): Promise<number> {
  return (await readQueue()).length;
}

/**
 * Tries to sync every queued entry, oldest first, stopping at the first one
 * that still fails (keeps order -- a later entry shouldn't sync ahead of an
 * earlier one for the same day). Safe to call repeatedly/concurrently isn't
 * guaranteed -- callers should serialize their own calls (see syncManager).
 */
export async function flushQueue(): Promise<{ synced: number; remaining: number }> {
  const queue = await readQueue();
  let synced = 0;

  while (queue.length > 0) {
    const next = queue[0];
    const res = await kioskSyncOffline(next.pin, next.type, next.ot, next.timestamp, next.clientId);
    if (!res.success) break; // still offline or server issue -- stop, keep the rest queued in order

    queue.shift();
    synced++;
    await writeQueue(queue);
  }

  return { synced, remaining: queue.length };
}

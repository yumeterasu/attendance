import { useEffect, useRef } from 'react';
import { refreshDirectory } from '../utils/employeeDirectory';
import { flushQueue } from '../utils/offlineQueue';

const RETRY_INTERVAL_MS = 30000;

/**
 * Keeps the offline PIN directory fresh and drains the offline check-in
 * queue whenever there's a connection -- runs once when connectivity comes
 * back, plus a periodic retry as a backup (NetInfo's isConnected can say
 * true while the connection is actually still bad, so a flush attempt that
 * silently no-ops on failure is cheap insurance).
 */
export function useOfflineSync(isConnected: boolean) {
  const isSyncingRef = useRef(false);

  const runSync = async () => {
    if (isSyncingRef.current) return;
    isSyncingRef.current = true;
    try {
      await refreshDirectory();
      await flushQueue();
    } finally {
      isSyncingRef.current = false;
    }
  };

  useEffect(() => {
    if (isConnected) runSync();
  }, [isConnected]);

  useEffect(() => {
    const interval = setInterval(runSync, RETRY_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);
}

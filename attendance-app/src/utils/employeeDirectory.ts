import AsyncStorage from '@react-native-async-storage/async-storage';
import { kioskDirectory } from '../api/client';

const STORAGE_KEY = 'kiosk_employee_directory_v1';

type DirectoryEntry = { pin: string; name: string; shifts: string[] };

/** Pulls the latest PIN->Name->shifts list from the server and overwrites the local copy. Silently does nothing if offline/failed -- the old cached copy just stays as-is. */
export async function refreshDirectory(): Promise<void> {
  const res = await kioskDirectory();
  if (!res.success) return;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(res.employees));
  } catch {
    // ignore -- next successful refresh will retry
  }
}

/**
 * Looks up a PIN in the last-known-good local copy of the directory.
 * Returns the name + this employee's shift choices, or null if not found
 * (including if there's no cache yet at all, or it's from before `shifts`
 * existed on a disk-cached entry -- see the fallback in KioskScreen, which
 * treats a missing/empty shifts array the same as a fresh lookup would
 * never actually produce, since the server always sends at least the 3
 * standard choices).
 */
export async function lookupPinLocally(pin: string): Promise<{ name: string; shifts: string[] } | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const entries: DirectoryEntry[] = JSON.parse(raw);
    const match = entries.find((e) => e.pin === pin);
    return match ? { name: match.name, shifts: match.shifts || [] } : null;
  } catch {
    return null;
  }
}

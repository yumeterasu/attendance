import AsyncStorage from '@react-native-async-storage/async-storage';
import { kioskDirectory } from '../api/client';

const STORAGE_KEY = 'kiosk_employee_directory_v1';

type DirectoryEntry = { pin: string; name: string };

/** Pulls the latest PIN->Name list from the server and overwrites the local copy. Silently does nothing if offline/failed -- the old cached copy just stays as-is. */
export async function refreshDirectory(): Promise<void> {
  const res = await kioskDirectory();
  if (!res.success) return;
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(res.employees));
  } catch {
    // ignore -- next successful refresh will retry
  }
}

/** Looks up a PIN in the last-known-good local copy of the directory. Returns the name, or null if not found (including if there's no cache yet at all). */
export async function lookupPinLocally(pin: string): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const entries: DirectoryEntry[] = JSON.parse(raw);
    const match = entries.find((e) => e.pin === pin);
    return match ? match.name : null;
  } catch {
    return null;
  }
}

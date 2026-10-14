import AsyncStorage from '@react-native-async-storage/async-storage';
import { kioskDirectory } from '../api/client';

const STORAGE_KEY = 'kiosk_employee_directory_v1';

// onShift/onBreak/breakStartedAt/totalMinutesUsedToday are OPTIONAL on the
// stored type -- an entry cached on-disk by an older app build (before
// 2026-10-05 for the first three, 2026-10-14 for totalMinutesUsedToday)
// never had them, and AsyncStorage keeps whatever was last written until
// the next successful refresh overwrites it, so a freshly-updated app can
// still read an old-shaped cached entry right after install.
// lookupPinLocally below defaults onShift/onBreak/breakStartedAt to
// false/false/null in that case (same "tolerant, never a block" spirit as
// every other on-device marker in this app), but totalMinutesUsedToday
// defaults to `null`, NOT 0 -- 0 would be indistinguishable from a genuine
// "confirmed zero minutes used today," and breakMinutesCache.ts's
// seedFromDirectoryIfUnknown must be able to tell "this directory entry
// doesn't actually know" apart from "this directory entry knows it's
// truly zero" (an old-shaped cache entry means the former).
type DirectoryEntry = {
  pin: string;
  name: string;
  shifts: string[];
  onShift?: boolean;
  onBreak?: boolean;
  breakStartedAt?: string | null;
  totalMinutesUsedToday?: number;
};

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
 * Returns the name + this employee's shift choices + their org-wide
 * onShift/onBreak/breakStartedAt/totalMinutesUsedToday as of the last
 * successful refresh (see DirectoryEntry's own comment for why these are
 * optional/defaulted here), or null if not found (including if there's no
 * cache yet at all).
 */
export async function lookupPinLocally(
  pin: string
): Promise<{
  name: string;
  shifts: string[];
  onShift: boolean;
  onBreak: boolean;
  breakStartedAt: string | null;
  totalMinutesUsedToday: number | null;
} | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const entries: DirectoryEntry[] = JSON.parse(raw);
    const match = entries.find((e) => e.pin === pin);
    if (!match) return null;
    return {
      name: match.name,
      shifts: match.shifts || [],
      onShift: match.onShift ?? false,
      onBreak: match.onBreak ?? false,
      breakStartedAt: match.breakStartedAt ?? null,
      totalMinutesUsedToday: match.totalMinutesUsedToday ?? null
    };
  } catch {
    return null;
  }
}

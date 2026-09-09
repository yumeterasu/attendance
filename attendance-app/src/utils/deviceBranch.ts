import AsyncStorage from '@react-native-async-storage/async-storage';

// Which physical location this specific tablet is set up at -- chosen once
// in the Admin screen, persisted on-device, and attached to every
// check-in/out this tablet ever records (see PunchBranch in AttendanceLog,
// handleKioskCheckin_/handleKioskSyncOffline_). Distinct from an employee's
// own assigned Branch in the Employees sheet -- this is "where the tap
// physically happened", so a mismatch (tapped IN at one branch, OUT at
// another) is visible in the raw log even though nothing in the app itself
// flags it.
const STORAGE_KEY = 'kiosk_device_branch_v1';

export type DeviceBranch = 'PP' | 'TL';

export const DEVICE_BRANCH_LABELS: Record<DeviceBranch, string> = {
  PP: 'Phrom Phong',
  TL: 'Thonglor'
};

// DEVICE_BRANCH_LABELS' own keys, not a separate hardcoded literal check --
// AdminScreen.tsx's BRANCH_OPTIONS already derives from the same object for
// the same reason: a branch added there is automatically valid here too,
// instead of silently failing this check and reading back as "not set".
const VALID_BRANCHES = Object.keys(DEVICE_BRANCH_LABELS) as DeviceBranch[];

export async function getDeviceBranch(): Promise<DeviceBranch | null> {
  try {
    const value = await AsyncStorage.getItem(STORAGE_KEY);
    return (VALID_BRANCHES as string[]).includes(value ?? '') ? (value as DeviceBranch) : null;
  } catch {
    return null; // storage unavailable -- same as "not set yet", never blocks check-in
  }
}

export async function setDeviceBranch(branch: DeviceBranch): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, branch);
  } catch {
    // Best-effort -- if this fails, getDeviceBranch() keeps reading the old
    // (or no) value, which the Admin screen's own read-back after saving
    // will make visible rather than silently claiming success.
  }
}

import AsyncStorage from '@react-native-async-storage/async-storage';

// Per-PIN "am I currently on break, and since when" marker, consulted when a
// PIN lookup falls back to the on-device directory (no live server round
// trip, so no authoritative onBreak from handleKioskLookupPin_ -- see
// KioskScreen's tryLocalLookup) AND when an offline Back from Break needs to
// estimate how long the just-ending session lasted (see
// breakMinutesCache.ts). While online, the live lookup/kioskBreak responses
// are always used instead where available -- this marker is the fallback.
//
// v2 (2026-10-06, real incident -- Kahana): a bare "pin -> started-at ISO
// string, absent key means not on break" map (v1) could not tell "this
// device just confirmed NOT on break" apart from "this device has never
// heard of this PIN at all" -- both read as "no entry". That ambiguity was
// harmless on its own, but became a real bug once tryLocalLookup started
// ALSO consulting the org-wide directory's onBreak (added 2026-10-05 for
// the cross-branch Start Break fix, refreshed only every ~30s): after a
// real, successful Back from Break on THIS device, this device's own
// marker was correctly cleared, but with no way to distinguish "cleared"
// from "unknown" the directory's still-stale onBreak=true got OR'd back in
// and the Back from Break button reappeared even though the break had
// already genuinely ended.
//
// v2 stores an explicit { onBreak, startedAt, recordedAt } record and NEVER
// deletes it on clear (a clear writes { onBreak: false, startedAt: null,
// recordedAt: now }) -- "confirmed not on break" is now a real,
// distinguishable fact. recordedAt additionally bounds how long this
// device trusts its OWN record over a fresh directory read
// (LOCAL_TRUST_WINDOW_MS below) -- without that bound, a record adopted
// from the directory once (e.g. a rarely-used device's first-ever lookup
// of some PIN) would be trusted FOREVER afterward on that device, even
// once the real state had since changed somewhere else and the directory
// had long since caught up -- just the Kahana bug again, in the opposite
// direction. See getTrustedLocalBreakState and its caller in
// KioskScreen.tsx's tryLocalLookup for how this gets used.
const KEY = 'kiosk_break_state_v2';
// Old shape, read once for a best-effort migration (see readMap) then
// never touched again -- not deleted, just superseded.
const LEGACY_KEY = 'kiosk_break_state_v1';

// Generous enough to absorb a slow directory refresh cycle or two (the
// directory refreshes every ~30s) plus normal jitter, short enough that a
// record adopted from a stale/rarely-visited device's directory read
// doesn't get trusted indefinitely once the real state has moved on.
const LOCAL_TRUST_WINDOW_MS = 2 * 60 * 1000;

type BreakRecord = { onBreak: boolean; startedAt: string | null; recordedAt: number };

async function readMap(): Promise<Record<string, BreakRecord>> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    return {};
  }
  // v2 has never been written on this device yet -- best-effort one-time
  // migration from v1, in case a break is still genuinely open under the
  // old shape (e.g. the app updated mid-shift). Every v1 entry only ever
  // meant "on break since this timestamp" (absent key meant not on break),
  // so each valid one migrates straight across as onBreak: true -- guarded
  // with a typeof check since this is reading data this build never wrote
  // itself (a prior build's storage could in principle be corrupted); an
  // entry that isn't a string is dropped rather than carried into
  // `startedAt` unchecked, which would otherwise poison NaN into
  // breakMinutesCache.ts's offline-estimate math downstream the next time
  // that PIN's break ends. recordedAt is "now" (migration time), not the
  // original break's own start time -- this device IS freshly confirming
  // it right now, by migrating it: same LOCAL_TRUST_WINDOW_MS treatment as
  // any other local confirmation from here on. v1 is left in place, not
  // deleted -- harmless, and simpler than also handling a delete failure.
  //
  // Either way (found legacy data or not), KEY is written here before
  // returning -- an empty `{}` when there's nothing to migrate, same as
  // the migrated map otherwise -- so this whole legacy-check branch runs
  // at most ONCE per device, not on every single call for the entire time
  // this PIN/device combination has no break data at all (the common
  // steady state for most lookups, and the whole point of consolidating
  // into one read in the first place).
  const migrated: Record<string, BreakRecord> = {};
  try {
    const legacyRaw = await AsyncStorage.getItem(LEGACY_KEY);
    if (legacyRaw) {
      const legacy: Record<string, unknown> = JSON.parse(legacyRaw);
      const now = Date.now();
      Object.keys(legacy).forEach((pin) => {
        const startedAt = legacy[pin];
        if (typeof startedAt === 'string') migrated[pin] = { onBreak: true, startedAt, recordedAt: now };
      });
    }
  } catch {
    // Legacy data unreadable -- proceed with an empty map, same as if v1 had never existed.
  }
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(migrated));
  } catch {
    // Best-effort -- if this write fails, the same (cheap) migration check just runs again next time.
  }
  return migrated;
}

/**
 * `startedAt`: an ISO timestamp to mark this PIN as on-break since that
 * moment, or `null` to record this PIN as CONFIRMED not on break (back from
 * break / clocked out) -- deliberately still WRITES a record in the `null`
 * case (never deletes the key), so getTrustedLocalBreakState can later tell
 * this apart from a PIN this device has simply never heard anything about.
 * Best-effort; a failure here just means the offline fallback guesses "not
 * on break" for this PIN next time, same as before this existed.
 */
export async function setLocalOnBreak(pin: string, startedAt: string | null): Promise<void> {
  try {
    const map = await readMap();
    map[pin] = { onBreak: !!startedAt, startedAt, recordedAt: Date.now() };
    await AsyncStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

/** ISO timestamp the PIN's currently-open break started, or null if not on break (or unknown). */
export async function getLocalBreakStartedAt(pin: string): Promise<string | null> {
  const map = await readMap();
  return map[pin]?.startedAt ?? null;
}

/**
 * Combined, single-read accessor for tryLocalLookup's hot path (every PIN
 * entry on the Kiosk) -- one AsyncStorage round trip instead of two
 * separate ones for what used to be getLocalOnBreak + a standalone
 * "has any record" check. `trusted` is true only when this device has a
 * record that's still within LOCAL_TRUST_WINDOW_MS of when it was last
 * confirmed (by a real local action OR an earlier directory adoption) --
 * see this file's own v2 comment for why that bound exists. When
 * `trusted` is false, `onBreak` is meaningless (always false) -- the
 * caller is expected to fall back to a fresher source (the directory)
 * instead of using it.
 */
export async function getTrustedLocalBreakState(pin: string): Promise<{ trusted: boolean; onBreak: boolean }> {
  const map = await readMap();
  const record = map[pin];
  if (record) {
    // elapsed >= 0 guards against a backward device-clock adjustment (an
    // NTP resync after being offline, or a manual time change) between
    // writing and reading this record -- without it, `Date.now() -
    // recordedAt` going negative would always pass `< LOCAL_TRUST_WINDOW_MS`
    // and trust a record indefinitely, exactly the "trusts itself forever"
    // failure mode this whole trust window exists to prevent (see this
    // file's own v2 comment).
    const elapsed = Date.now() - record.recordedAt;
    if (elapsed >= 0 && elapsed < LOCAL_TRUST_WINDOW_MS) {
      return { trusted: true, onBreak: record.onBreak };
    }
  }
  return { trusted: false, onBreak: false };
}

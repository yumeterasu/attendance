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
//
// `source` added 2026-10-06, same day, follow-up: the 2-minute window above
// turned out to still let the ORIGINAL Kahana bug recur, just delayed --
// a device that genuinely confirmed its own Back from Break (ground truth,
// not a guess) would still fall back to a stale directory read once
// LOCAL_TRUST_WINDOW_MS elapsed, and if that device stayed offline the
// whole time (the realistic case for a bug that's about trusting the
// network less), the directory could never have refreshed either --
// recreating the exact wrong-button bug, just 2 minutes later instead of
// immediately. The business requirement this device's own confirmed
// actions must never show the wrong button, with or without server access,
// at all, forever -- a time-bound trust window can't deliver that for data
// that was never uncertain in the first place. So every WRITE here now
// tags itself 'confirmed' (this device's own real action, or a
// server-authoritative correction -- every existing call site is one of
// these) or 'adopted' (a guess picked up from the org-wide directory when
// this device never actually confirmed anything about this PIN itself --
// today, only tryLocalLookup's cross-branch fallback writes this kind, via
// adoptDirectoryBreakState). getTrustedLocalBreakState trusts 'confirmed'
// unconditionally, no timer at all -- it's this device's own ground truth,
// never stale by definition. 'adopted' keeps the original bounded
// LOCAL_TRUST_WINDOW_MS treatment, since it genuinely is just a guess from
// a periodically-refreshed cache and SHOULD defer back to a fresher
// directory read once enough time has passed (that fallback changes
// nothing in practice -- it just re-reads the same directory cache this
// value came from, or a newer one).
//
// A record with no `source` at all (written by the v1.19.1 build this
// patch replaces, or migrated from its v1 predecessor) is NOT treated as
// 'confirmed' by default -- caught in review before shipping: v1.19.1's
// own tryLocalLookup already had a cross-branch directory-adoption branch
// that called the old undifferentiated setLocalOnBreak, so some
// source-less records on devices in the field right now genuinely ARE
// guesses, not ground truth. Defaulting them to 'confirmed' would trust a
// stale guess forever -- the reverse-Kahana bug this whole file exists to
// prevent. There's no way to tell, after the fact, which source-less
// record is which, so getTrustedLocalBreakState treats anything that
// isn't explicitly 'confirmed' (including 'adopted' and missing) through
// the same bounded path -- the only downside is a pre-existing genuinely-
// confirmed record gets the old 2-minute treatment instead of permanent
// trust for a short transition window, which heals itself the next time
// this device confirms any real action for that PIN (every new write from
// setLocalOnBreak is explicitly tagged going forward).
const KEY = 'kiosk_break_state_v2';
// Old shape, read once for a best-effort migration (see readMap) then
// never touched again -- not deleted, just superseded.
const LEGACY_KEY = 'kiosk_break_state_v1';

// Generous enough to absorb a slow directory refresh cycle or two (the
// directory refreshes every ~30s) plus normal jitter, short enough that a
// record adopted from a stale/rarely-visited device's directory read
// doesn't get trusted indefinitely once the real state has moved on.
const LOCAL_TRUST_WINDOW_MS = 2 * 60 * 1000;

// `source` is optional for backward compat with records already written by
// v1.19.1 (shipped hours before this field existed) -- NOT defaulted to
// 'confirmed' when absent, since v1.19.1's own tryLocalLookup already had
// the cross-branch directory-adoption branch, so a source-less record in
// the field could genuinely be either kind. getTrustedLocalBreakState
// below treats anything that isn't explicitly 'confirmed' as the bounded
// case -- see this file's own top-of-file comment for the full reasoning.
type BreakRecord = { onBreak: boolean; startedAt: string | null; recordedAt: number; source?: 'confirmed' | 'adopted' };

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
        // Left as 'adopted' (via the default parameter below), NOT
        // 'confirmed' -- caught in review: the 2026-10-05 cross-branch
        // Start Break fix landed a day BEFORE v2 existed, and its
        // directory-adoption branch wrote through this same v1 shape/key,
        // so a legacy entry here could genuinely be either a real local
        // confirmation or an adopted directory guess -- no way to tell
        // which after the fact. 'adopted' is the safe default (bounded
        // LOCAL_TRUST_WINDOW_MS instead of permanent trust) for the same
        // reason explained at this file's own top-of-file comment on
        // `source`.
        if (typeof startedAt === 'string') migrated[pin] = { onBreak: true, startedAt, recordedAt: now, source: 'adopted' };
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
 *
 * Every current caller is this device's own real action (an onConfirm
 * success, online or offline-queued) or a server-authoritative correction
 * (a live lookup's reconciled state, or an offline-queue sync
 * rejection) -- genuine ground truth, never a guess -- so this always tags
 * the record 'confirmed', which getTrustedLocalBreakState then trusts with
 * no expiry. A write that's only a guess picked up from the directory, not
 * this device's own knowledge, must go through adoptDirectoryBreakState
 * instead, not this function.
 */
export async function setLocalOnBreak(pin: string, startedAt: string | null): Promise<void> {
  try {
    const map = await readMap();
    map[pin] = { onBreak: !!startedAt, startedAt, recordedAt: Date.now(), source: 'confirmed' };
    await AsyncStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

/**
 * Same shape and parameters as setLocalOnBreak, for the one case that
 * ISN'T this device's own knowledge: tryLocalLookup's cross-branch
 * fallback, adopting the org-wide directory's onBreak for a PIN this
 * device has never itself confirmed anything about. Tags the record
 * 'adopted' so getTrustedLocalBreakState keeps the original bounded
 * LOCAL_TRUST_WINDOW_MS treatment for it instead of trusting it forever --
 * it's a guess from a periodically-refreshed cache, not ground truth, and
 * should defer back to a fresher directory read once enough time has
 * passed (seamless either way -- that just re-reads the same cache this
 * value came from, or a newer one).
 */
export async function adoptDirectoryBreakState(pin: string, startedAt: string | null): Promise<void> {
  try {
    const map = await readMap();
    map[pin] = { onBreak: !!startedAt, startedAt, recordedAt: Date.now(), source: 'adopted' };
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
 * "has any record" check. When `trusted` is false, `onBreak` is
 * meaningless (always false) -- the caller is expected to fall back to a
 * fresher source (the directory) instead of using it.
 *
 * 'confirmed' records (this device's own real action, or a
 * server-authoritative correction -- see setLocalOnBreak) are trusted
 * UNCONDITIONALLY, no matter how much time has passed or whether this
 * device has been offline the whole time -- real incident, 2026-10-06
 * (Kahana, follow-up): trusting even a device's own ground truth for only
 * LOCAL_TRUST_WINDOW_MS let the original wrong-button bug recur once that
 * window elapsed while still offline (the directory, also unable to
 * refresh while offline, was still showing the pre-action value). Data
 * that was never a guess in the first place has no reason to expire.
 *
 * 'adopted' records (a guess picked up from the org-wide directory for a
 * PIN this device never itself confirmed -- see adoptDirectoryBreakState)
 * keep the original bounded LOCAL_TRUST_WINDOW_MS treatment, since those
 * genuinely are just a snapshot of a periodically-refreshed cache and
 * should defer back to a fresher read of it once enough time has passed.
 * A record with no `source` at all (predates this distinction -- written
 * by v1.19.1, or migrated from v1) is deliberately treated the SAME as
 * 'adopted', not 'confirmed' -- v1.19.1's own tryLocalLookup already had
 * the cross-branch directory-adoption branch writing through the
 * undifferentiated setLocalOnBreak, so a source-less record in the field
 * could genuinely be either kind, and defaulting the ambiguous case to
 * permanent trust would risk freezing a stale guess forever (see
 * BreakRecord's own comment). Checked as `=== 'confirmed'`, not
 * `!== 'adopted'`, so both 'adopted' and missing take the bounded path.
 */
export async function getTrustedLocalBreakState(pin: string): Promise<{ trusted: boolean; onBreak: boolean }> {
  const map = await readMap();
  const record = map[pin];
  if (record) {
    if (record.source === 'confirmed') {
      return { trusted: true, onBreak: record.onBreak };
    }
    // elapsed >= 0 guards against a backward device-clock adjustment (an
    // NTP resync after being offline, or a manual time change) between
    // writing and reading this record -- without it, `Date.now() -
    // recordedAt` going negative would always pass `< LOCAL_TRUST_WINDOW_MS`
    // and trust a record indefinitely, exactly the "trusts itself forever"
    // failure mode this bound exists to prevent for a genuine guess (see
    // this file's own v2 comment).
    const elapsed = Date.now() - record.recordedAt;
    if (elapsed >= 0 && elapsed < LOCAL_TRUST_WINDOW_MS) {
      return { trusted: true, onBreak: record.onBreak };
    }
  }
  return { trusted: false, onBreak: false };
}

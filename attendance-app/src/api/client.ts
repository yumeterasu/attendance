import { logAttempt } from '../utils/attemptLog';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? '';
const API_KEY = process.env.EXPO_PUBLIC_API_KEY ?? '';
const REQUEST_TIMEOUT_MS = 15000; // a hung request with no internet route used to wait forever with no feedback
const KIOSK_TIMEOUT_MS = 3000; // lookup/checkin have a local fallback, so fail fast and let it take over instead of making the employee wait
const SCHEDULE_TIMEOUT_MS = 8000; // My Schedule has no local fallback (it needs a live report) -- was 4000ms, too tight: reads up to 8000 rows of AttendanceLog plus a possible Apps Script cold start regularly pushed past it, showing as "sometimes works, sometimes doesn't"
// A month other than the current one makes the server fall back to a full
// AttendanceLog read (see handleKioskMyAttendance_) instead of the bounded
// tail SCHEDULE_TIMEOUT_MS was tuned for -- give paging to a previous/next
// month more room before giving up, since it's a deliberate, occasional tap,
// not the routine path.
const SCHEDULE_MONTH_NAV_TIMEOUT_MS = 20000;

export type ApiResult<T> =
  | ({ success: true } & T)
  | { success: false; error: string; message: string };

async function postAction<T>(action: string, body: Record<string, unknown>, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, apiKey: API_KEY, ...body }),
      signal: controller.signal
    });
    const result = (await res.json()) as ApiResult<T>;
    logAttempt({ timestamp: Date.now(), action, result: result.success ? 'success' : 'rejected', message: result.success ? undefined : result.message });
    return result;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      const result: ApiResult<T> = { success: false, error: 'timeout', message: 'Taking too long to respond. Check your connection and try again.' };
      logAttempt({ timestamp: Date.now(), action, result: 'timeout' });
      return result;
    }
    const result: ApiResult<T> = { success: false, error: 'network_error', message: 'Could not reach the server. Check your connection.' };
    logAttempt({ timestamp: Date.now(), action, result: 'network_error' });
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export function pair(username: string, setupCode: string) {
  return postAction<{ sessionToken: string; name: string; department: string; isAdmin: boolean }>('pair', {
    username,
    setupCode
  });
}

export function adminResetCode(sessionToken: string, employeeId: string) {
  return postAction<{ employeeId: string; setupCode: string }>('adminResetCode', { sessionToken, employeeId });
}

// shift: the employee's own pick from their shiftChoicesFor_ list (see
// kioskLookupPin/kioskDirectory below) -- only meaningful for type IN, the
// backend ignores it for OUT. undefined for OUT, or for an IN where nothing
// was picked (falls back server-side to the admin-set schedule, same as
// before this feature existed).
export function kioskCheckin(pin: string, type: 'IN' | 'OUT', ot: boolean | undefined, branch: string | null, shift: string | undefined) {
  return postAction<{ type: 'IN' | 'OUT'; timestamp: string; name: string; late?: boolean; ot?: boolean }>(
    'kioskCheckin',
    { pin, type, ot: ot ? 'true' : undefined, branch: branch ?? undefined, shift },
    KIOSK_TIMEOUT_MS
  );
}

// Start Break / Back from Break -- visibility only, no Late/OT/duration
// involved, so no ot/branch/shift params (see handleKioskBreak_ server-side).
// durationMinutes is the employee's own pick of how long they intend to be
// gone (one of VALID_BREAK_DURATIONS server-side) -- required for
// BREAK_START, ignored for BREAK_END.
export function kioskBreak(pin: string, type: 'BREAK_START' | 'BREAK_END', durationMinutes?: number) {
  return postAction<{ type: 'BREAK_START' | 'BREAK_END'; timestamp: string; name: string; durationMinutes?: number }>(
    'kioskBreak',
    { pin, type, durationMinutes },
    KIOSK_TIMEOUT_MS
  );
}

// shifts: the shift strings this specific employee can pick at the Kiosk --
// the 3 standard choices everyone gets, plus their own ExtraShift if they
// have one (see shiftChoicesFor_ server-side). Always non-empty.
// Deliberately no onBreak field here -- see breakState.ts for why that's
// driven by an on-device marker instead of a server round trip on this
// latency-sensitive path (KIOSK_TIMEOUT_MS is only 3000ms).
export function kioskLookupPin(pin: string) {
  return postAction<{ name: string; shifts: string[] }>('kioskLookupPin', { pin }, KIOSK_TIMEOUT_MS);
}

export type ScheduleDay = { day: number; date: string; timeIn: string; timeOut: string; shift: string; note: string; late: boolean; ot: boolean };

// year/month select which month to look back at -- omit both for the
// current month (the default, and the only case the server's fast bounded
// read covers; a past month falls back to a slower full-sheet read there,
// see handleKioskMyAttendance_).
export function kioskMyAttendance(pin: string, year?: number, month?: number) {
  const now = new Date();
  const isCurrentMonth = year === undefined || month === undefined || (year === now.getFullYear() && month === now.getMonth() + 1);
  return postAction<{
    name: string;
    year: number;
    month: number;
    days: ScheduleDay[];
  }>('kioskMyAttendance', { pin, year, month }, isCurrentMonth ? SCHEDULE_TIMEOUT_MS : SCHEDULE_MONTH_NAV_TIMEOUT_MS);
}

// Fetches the last year of My Schedule history in one call, for the
// background sync that runs right after a successful My Schedule PIN entry
// (see syncScheduleHistory in KioskScreen) -- reads more than either of the
// other two timeouts above budget for (a full AttendanceLog read plus up to
// a year of Schedule sheets), but it's a background, best-effort fetch that
// never blocks anything on screen, so a generous timeout costs nothing.
const SCHEDULE_BULK_SYNC_TIMEOUT_MS = 45000;

export function kioskMyAttendanceBulk(pin: string) {
  return postAction<{
    name: string;
    months: { year: number; month: number; days: ScheduleDay[] }[];
  }>('kioskMyAttendanceBulk', { pin }, SCHEDULE_BULK_SYNC_TIMEOUT_MS);
}

export function verifyKioskExitPin(pin: string) {
  return postAction<{}>('verifyKioskExitPin', { pin });
}

export function kioskDirectory() {
  return postAction<{ employees: { pin: string; name: string; shifts: string[] }[] }>('kioskDirectory', {});
}

// Device-wide daily background sync (see useScheduleSync) -- every active
// employee's current month in one call, no PIN. Same budget as
// SCHEDULE_BULK_SYNC_TIMEOUT_MS above and the same reasoning: a background,
// best-effort fetch nothing on screen is waiting on, covering every
// employee instead of just one -- reuses that constant rather than
// defining a second one that could silently drift out of sync with it.
export function kioskScheduleSyncAll() {
  return postAction<{
    year: number;
    month: number;
    employees: { pin: string; name: string; days: ScheduleDay[] }[];
  }>('kioskScheduleSyncAll', {}, SCHEDULE_BULK_SYNC_TIMEOUT_MS);
}

export function kioskSyncOffline(
  pin: string,
  type: 'IN' | 'OUT' | 'BREAK_START' | 'BREAK_END',
  ot: boolean,
  timestamp: string,
  clientId: string,
  branch: string | null | undefined,
  shift: string | undefined,
  durationMinutes?: number
) {
  return postAction<{ alreadySynced: boolean; name: string }>('kioskSyncOffline', {
    pin,
    type,
    ot: ot ? 'true' : undefined,
    timestamp,
    clientId,
    branch: branch ?? undefined,
    shift,
    durationMinutes
  });
}


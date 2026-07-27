import { logAttempt } from '../utils/attemptLog';

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? '';
const API_KEY = process.env.EXPO_PUBLIC_API_KEY ?? '';
const REQUEST_TIMEOUT_MS = 15000; // a hung request with no internet route used to wait forever with no feedback
const KIOSK_TIMEOUT_MS = 5000; // lookup/checkin have a local fallback, so fail fast and let it take over instead of making the employee wait

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

export function kioskCheckin(pin: string, type: 'IN' | 'OUT', ot?: boolean) {
  return postAction<{ type: 'IN' | 'OUT'; timestamp: string; name: string; late?: boolean; ot?: boolean }>(
    'kioskCheckin',
    { pin, type, ot: ot ? 'true' : undefined },
    KIOSK_TIMEOUT_MS
  );
}

export function kioskLookupPin(pin: string) {
  return postAction<{ name: string }>('kioskLookupPin', { pin }, KIOSK_TIMEOUT_MS);
}

export function kioskMyAttendance(pin: string) {
  return postAction<{
    name: string;
    year: number;
    month: number;
    days: { day: number; date: string; timeIn: string; timeOut: string; shift: string; late: boolean; ot: boolean }[];
  }>('kioskMyAttendance', { pin });
}

export function verifyKioskExitPin(pin: string) {
  return postAction<{}>('verifyKioskExitPin', { pin });
}

export function kioskDirectory() {
  return postAction<{ employees: { pin: string; name: string }[] }>('kioskDirectory', {});
}

export function kioskSyncOffline(pin: string, type: 'IN' | 'OUT', ot: boolean, timestamp: string, clientId: string) {
  return postAction<{ alreadySynced: boolean; name: string }>('kioskSyncOffline', {
    pin,
    type,
    ot: ot ? 'true' : undefined,
    timestamp,
    clientId
  });
}


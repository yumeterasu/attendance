const API_URL = process.env.EXPO_PUBLIC_API_URL ?? '';
const API_KEY = process.env.EXPO_PUBLIC_API_KEY ?? '';

export type ApiResult<T> =
  | ({ success: true } & T)
  | { success: false; error: string; message: string };

async function postAction<T>(action: string, body: Record<string, unknown>): Promise<ApiResult<T>> {
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, apiKey: API_KEY, ...body })
    });
    return (await res.json()) as ApiResult<T>;
  } catch {
    return { success: false, error: 'network_error', message: 'Could not reach the server. Check your connection.' };
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
    { pin, type, ot: ot ? 'true' : undefined }
  );
}

export function kioskLookupPin(pin: string) {
  return postAction<{ name: string }>('kioskLookupPin', { pin });
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


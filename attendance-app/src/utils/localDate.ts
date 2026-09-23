/** Device-local calendar day as YYYY-MM-DD -- shared by every local cache that keys an entry to "today" (breakMinutesCache.ts, checkinState.ts), so the day-rollover rule lives in exactly one place. */
export function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

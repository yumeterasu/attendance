/**
 * Check-in/out logic: explicit IN/OUT type from the Kiosk, duplicate-scan guard.
 */

var DUPLICATE_GUARD_MS = 60 * 1000; // reject re-scans within 60s of the last log for the same employee
var SHIFTS = ['7:00-16:00', '7:30-16:30', '8:00-17:00', '8:30-17:30', '7:00-17:00', '8:00-18:30', 'Event 8:00-17:00', 'Annual Leave', 'Sick Leave', 'Unpaid Leave', 'Paid Special Leave', 'Half Day Annual Leave', 'Half Day Sick Leave', 'Half Day Unpaid Leave', 'Holiday'];
// Shift values that mean "nobody's expected in at all that day" -- as
// opposed to a blank cell (not scheduled yet) or "Half Day Annual
// Leave"/"Half Day Sick Leave"/"Half Day Unpaid Leave" (still expected in
// for half the day). Used wherever a scheduled-but-not-working day should
// be excluded from an absence/attendance check: "Annual Leave", "Sick
// Leave", "Unpaid Leave" and "Paid Special Leave" are one person's own day
// off (paid or not doesn't matter here, just whether they're expected in),
// "Holiday" is the whole company closed.
var FULL_DAY_OFF_SHIFTS = ['Annual Leave', 'Sick Leave', 'Unpaid Leave', 'Paid Special Leave', 'Holiday'];
var BRANCHES = ['PP', 'TL']; // Phrom Phong, Thonglor -- Schedule sheet row order: this branch order first, then Japanese before Thai within each branch

/**
 * Validates a kiosk device's reported branch (see attendance-app's
 * deviceBranch.ts) for the AttendanceLog's PunchBranch column. Blank rather
 * than a rejection for anything unrecognized -- an older app build that
 * never sends this, or a device that's never had its branch configured
 * yet, should still record the check-in normally; this is supplementary
 * metadata, not a requirement. Shared by recordAttendance_ (live) and
 * recordOfflineSyncedAttendance_ (queued sync) so both apply the exact
 * same rule.
 */
function normalizePunchBranch_(branch) {
  return BRANCHES.indexOf(branch) !== -1 ? branch : '';
}

// Every employee can pick from these 3 at the Kiosk; a handful of people
// also have one or more of their own (Employees.ExtraShift, blank for
// everyone else) -- e.g. Kahana's 8:30-17:30, Shunya's 7:00-17:00 AND
// 8:00-18:30 (comma-separated in the one cell -- see shiftChoicesFor_).
// Kept separate from SHIFTS (which also lists every Leave/Holiday value,
// none of which an employee should ever pick for themselves at check-in).
var STANDARD_SHIFT_CHOICES = ['7:00-16:00', '7:30-16:30', '8:00-17:00'];

/**
 * True if a value looks like a real clock-time shift an employee could
 * genuinely be scheduled for -- shaped like "H:MM-H:MM" AND a real SHIFTS
 * entry (so it can never be a Leave/Holiday/Event label, and never a typo'd
 * time that isn't in the canonical list the Schedule sheet's own dropdown
 * uses). Shared by shiftChoicesFor_ below (what's actually OFFERED at the
 * Kiosk -- a bad Employees.ExtraShift is filtered out here and simply never
 * becomes pickable, not just flagged after the fact) and
 * checkEmployeesSheet_ in HealthCheck.gs (what's reported as WRONG in the
 * Employees sheet), so the two can never disagree about what counts as
 * valid.
 */
function isValidShiftChoice_(value) {
  return /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(value) && SHIFTS.indexOf(value) !== -1;
}

/**
 * Splits a raw Employees.ExtraShift cell into its individual pieces --
 * comma-separated when an employee has more than one extra shift (e.g.
 * Shunya's "7:00-17:00, 8:00-18:30"), trimmed, blanks dropped. Does NOT
 * validate each piece (see isValidShiftChoice_) -- shared as-is by
 * shiftChoicesFor_ below (Attendance.gs) and checkEmployeesSheet_
 * (HealthCheck.gs) so the two can never disagree about how the cell is
 * split, only about whether a given piece is valid.
 */
function parseExtraShifts_(raw) {
  return String(raw || '')
    .split(',')
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s; });
}

/** The list a given employee sees on the Kiosk's shift picker -- the 3 standard choices, plus their own ExtraShift value(s) if valid (see isValidShiftChoice_ -- an invalid one is silently omitted, not offered broken). ExtraShift can hold more than one shift for the same employee, comma-separated in the one cell (see parseExtraShifts_). Trimmed, so a stray leading/trailing space from a manual Employees-sheet edit doesn't silently break the round-trip match in normalizeShiftChoice_ below. */
function shiftChoicesFor_(emp) {
  var choices = STANDARD_SHIFT_CHOICES.slice();
  var extras = parseExtraShifts_(emp.ExtraShift);
  for (var i = 0; i < extras.length; i++) {
    if (isValidShiftChoice_(extras[i]) && choices.indexOf(extras[i]) === -1) choices.push(extras[i]);
  }
  return choices;
}

/**
 * Validates a Kiosk-submitted shift choice against what this specific
 * employee is actually allowed to pick (their own shiftChoicesFor_) --
 * never trusts the raw value straight from the request. Blank for
 * anything not on their list (an older app build that never sends this, a
 * stale cached shift list from before an ExtraShift was added/removed, or
 * a tampered request) -- callers fall back to the admin-set schedule in
 * that case, same as before this feature existed.
 */
function normalizeShiftChoice_(emp, shift) {
  var trimmed = String(shift || '').trim();
  if (!trimmed) return '';
  return shiftChoicesFor_(emp).indexOf(trimmed) !== -1 ? trimmed : '';
}

/**
 * Overwrites today's cell in the "Schedule YYYY-MM" sheet (this employee's
 * row, this day's column) with the shift they actually picked at check-in
 * -- so the sheet ends up showing what really happened, not just what was
 * planned (including replacing a Leave/Holiday label there, if that's what
 * was scheduled but they came in and worked anyway -- intentional, not a
 * bug: Sheets' own Version History is the audit trail for "what did this
 * cell used to say"). Fails open (does nothing) if that month's sheet, or
 * this employee's row in it, doesn't exist yet. Uses findScheduleCell_
 * (Report.gs) -- the same lookup getScheduledShift_ reads with -- so the
 * two can never disagree about which cell they mean.
 *
 * Callers must wrap this in try/catch, not call it bare: a Sheets API
 * error here (quota, transient failure) must never take the actual
 * check-in down with it -- seconds matter on this path (see
 * KIOSK_TIMEOUT_MS in attendance-app), and there's no scenario where
 * failing the whole check-in over a schedule-sheet cosmetic write is the
 * right tradeoff.
 */
// No locking here, deliberately, same as the read side (getScheduledShift_/
// findScheduleCell_ have never taken one either). A LockService lock would
// only serialize this function against ITSELF -- it wouldn't protect
// against the one real structural race (an admin's "Create/Update Schedule
// Sheet", which re-sorts every row and doesn't take this lock either), so
// it would add latency on this tight check-in-timeout path for
// near-zero actual protection. What DOES make this safe in practice: two
// concurrent check-ins are two different employees' rows almost always
// (the same employee re-checking in within a short window is already
// blocked by DUPLICATE_GUARD_MS well before either tap gets here), so a
// same-cell collision needs both a same-employee double-tap AND an
// admin-triggered resort landing in the same instant -- accepted as a rare
// edge case, same as every other unlocked Schedule-sheet read in this
// codebase.
function writeScheduleShiftCell_(employeeId, date, shiftValue) {
  var loc = findScheduleCell_(employeeId, date);
  if (!loc) return;
  // The common case is an employee picking the shift that's already
  // correctly scheduled for them that day -- findScheduleCell_ already has
  // the current value in memory at zero extra read cost, so skip the
  // setValue() round trip entirely when there's nothing to change. Saves a
  // write (and its latency/quota cost) on the live check-in path for the
  // majority of picks, not just the rare ExtraShift ones.
  var current = String(loc.values[loc.rowIndex][loc.dayCol] || '').trim();
  if (current === shiftValue) return;
  loc.sheet.getRange(loc.rowIndex + 1, loc.dayCol + 1).setValue(shiftValue);
}
var OT_GRACE_MINUTES = 15; // first 15 min after shift end never counts as Japanese OT (see computeJapaneseOtMinutes_). Thai OT's free period is governed by OT_QUARTER_MINUTES instead (see computeThaiOtQuarters_) -- the two happen to be the same value today, but changing one no longer changes the other.
var JP_OT_CAP_MINUTES = 75; // default Japanese OT cap, in minutes/day -- overridden per employee by Employees.OTMaxMinutes when set
var OT_QUARTER_MINUTES = 15; // Thai OT is counted in whole 15-min blocks, no cap

/**
 * True if timestamp is at or past one full minute after the shift/event's
 * start time on that same calendar day -- e.g. shift 8:00, checking in at
 * 8:00:00 through 8:00:59 is on time, 8:01:00 is late. Finds the first
 * "H:MM" anywhere in the string, so both a plain shift ("7:30-16:30") and a
 * labeled event ("Sports Day 8:00-15:00") work the same way. No match ->
 * never late.
 */
function isLate_(shiftOrEvent, timestamp) {
  var match = shiftOrEvent.match(/(\d{1,2}):(\d{2})/);
  if (!match) return false;
  var shiftStart = new Date(timestamp.getFullYear(), timestamp.getMonth(), timestamp.getDate(), Number(match[1]), Number(match[2]), 0);
  return timestamp.getTime() >= shiftStart.getTime() + 60000;
}

/** Extracts the shift/event's end time (the LAST "H:MM" found), e.g. "8:00-17:00" -> {hour:17,minute:0}. Null if not found. */
function getShiftEndTime_(shiftOrEvent) {
  var matches = shiftOrEvent.match(/(\d{1,2}):(\d{2})/g);
  if (!matches || matches.length < 2) return null;
  var parts = matches[matches.length - 1].split(':');
  return { hour: Number(parts[0]), minute: Number(parts[1]) };
}

/** Extracts the shift/event's start time (the FIRST "H:MM" found), e.g. "8:00-17:00" -> {hour:8,minute:0}. Null if not found. Same "first match" rule as isLate_, just shaped like getShiftEndTime_'s result instead of minutes-since-midnight. */
function getShiftStartTime_(shiftOrEvent) {
  var match = shiftOrEvent.match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * For "Event" shifts specifically (e.g. "Event 8:00-17:00"): the recorded
 * IN/OUT time is always the shift's own start/end time, never the actual
 * tap time -- an admin explicitly asked for event-day attendance to always
 * read as the clean official hours, with no Late flag and no OT, no matter
 * when someone genuinely arrived or left. Returns `actualTimestamp`
 * unchanged for every other shift (or an Event shift with no parseable
 * time), so this is a no-op everywhere else. Uses the same isEventShift_
 * definition as everywhere else that treats Event shifts specially (see
 * highlightShiftMismatches_) -- callers pass whatever's in the Shift
 * column, already known to be that day's scheduled shift text.
 */
function eventShiftOverrideTimestamp_(scheduledShift, actualTimestamp, type) {
  if (!isEventShift_(scheduledShift)) return actualTimestamp;
  var time = type === 'IN' ? getShiftStartTime_(scheduledShift) : getShiftEndTime_(scheduledShift);
  if (!time) return actualTimestamp;
  return new Date(actualTimestamp.getFullYear(), actualTimestamp.getMonth(), actualTimestamp.getDate(), time.hour, time.minute, 0);
}

/** Same /^Event\b/ prefix rule as eventShiftOverrideTimestamp_ -- shared so every "is this an Event day" check (reports/summary included, not just the live check-in write path) agrees on the same definition. */
function isEventShift_(scheduledShift) {
  return !!scheduledShift && /^Event\b/.test(scheduledShift);
}

/**
 * "Special Shift": an employee-picked custom start/end (e.g. "Special
 * 12:00-11:00", possibly spanning into the next day), used for genuinely
 * irregular hours. Unlike Event, deliberately NOT run through
 * eventShiftOverrideTimestamp_ -- Special keeps the real tap time (same
 * "real time is always what's recorded" rule break minutes already follow
 * elsewhere in this app), it just skips Late/OT math on top of that real
 * time. See isNoLateNoOtShift_ below for the shared "no Late, no OT"
 * treatment both Event and Special get everywhere else in the system.
 */
function isSpecialShift_(scheduledShift) {
  return !!scheduledShift && /^Special\b/.test(scheduledShift);
}

/**
 * True only for a well-formed "Special H:MM-H:MM" string sent from the
 * Kiosk -- never trusts the client's format blindly. Deliberately separate
 * from normalizeShiftChoice_ (Special is never one of an employee's own
 * shiftChoicesFor_, by design -- it's a custom one-off, not a pre-approved
 * choice), so that function's own contract/callers stay untouched. Checks
 * actual hour/minute RANGES (0-23 / 0-59), not just digit-count shape --
 * \d{1,2}/\d{2} alone would let "Special 25:99-30:00" through, which would
 * then feed garbage into getShiftStartTime_/getShiftEndTime_ everywhere
 * downstream (Report sheet, Dashboard, My Schedule).
 */
function isValidSpecialShiftSubmission_(raw) {
  var match = String(raw || '').trim().match(/^Special (\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!match) return false;
  var startHour = Number(match[1]), startMinute = Number(match[2]);
  var endHour = Number(match[3]), endMinute = Number(match[4]);
  return startHour <= 23 && startMinute <= 59 && endHour <= 23 && endMinute <= 59;
}

/**
 * Shared widening: every existing "is this an Event day" check (Late/OT
 * skip, Dashboard/My-Schedule day classification) needs the exact same
 * treatment for a Special day too -- always reads as on-time, worked, zero
 * OT. Kept as one function so a future third "no Late/no OT" shift type
 * only needs to change this one place, not every call site again.
 */
function isNoLateNoOtShift_(scheduledShift) {
  return isEventShift_(scheduledShift) || isSpecialShift_(scheduledShift);
}

/** Minutes actually worked past shift end, or null if the shift/event string has no end time. */
function minutesPastShiftEnd_(shiftOrEvent, outTimestamp) {
  var end = getShiftEndTime_(shiftOrEvent);
  if (!end) return null;
  var shiftEnd = new Date(outTimestamp.getFullYear(), outTimestamp.getMonth(), outTimestamp.getDate(), end.hour, end.minute, 0);
  return Math.round((outTimestamp.getTime() - shiftEnd.getTime()) / 60000);
}

// A few shifts cap Japanese OT on their own -- e.g. "7:00-17:00" and
// "8:00-18:30" are longer than the other Japanese shifts, so real OT past
// that already-long day is capped low on purpose. Keyed by the exact Shift
// string; combined with capMinutes by taking whichever is STRICTER (see
// computeJapaneseOtMinutes_) -- this is a ceiling, not a replacement, so it
// can only lower an employee's own tighter OTMaxMinutes further, never
// loosen it back up past what the employee's own cap already restricts.
// Thai OT never reads this -- it has no cap at all (see
// computeThaiOtQuarters_).
var SHIFT_OT_CAP_MINUTES_OVERRIDE = { '7:00-17:00': 15, '8:00-18:30': 15 };

/**
 * Japanese OT, in minutes: always auto-computed from actual clock-out vs the
 * day's shift end, regardless of which kiosk button was pressed (OUT and
 * OUT OT are equivalent for this group). First 15 min free, capped at
 * capMinutes (defaults to JP_OT_CAP_MINUTES if not given/blank -- see
 * Employees.OTMaxMinutes for the per-employee override) -- or the shift's
 * own fixed cap (see SHIFT_OT_CAP_MINUTES_OVERRIDE), whichever is stricter.
 */
function computeJapaneseOtMinutes_(shiftOrEvent, outTimestamp, capMinutes) {
  var pastEnd = minutesPastShiftEnd_(shiftOrEvent, outTimestamp);
  if (pastEnd === null || pastEnd <= OT_GRACE_MINUTES) return 0;
  var cap = capMinutes || JP_OT_CAP_MINUTES;
  if (SHIFT_OT_CAP_MINUTES_OVERRIDE.hasOwnProperty(shiftOrEvent)) {
    cap = Math.min(cap, SHIFT_OT_CAP_MINUTES_OVERRIDE[shiftOrEvent]);
  }
  return Math.min(pastEnd - OT_GRACE_MINUTES, cap);
}

/**
 * Whether this employee can earn OT at all -- defaults to TRUE when the
 * column is blank/missing (matches the system's original behavior, before
 * this column existed, of everyone being OT-eligible), only FALSE when
 * explicitly set. Gates both groups: Japanese auto-computed OT and Thai
 * button-pressed OT alike, so a mistaken OUT OT press can't grant OT to
 * someone flagged ineligible either.
 *
 * Note this is a different lever from Employees.OTMaxMinutes (the per-
 * employee OT cap for Japanese) -- setting OTMaxMinutes to 0 does NOT
 * disable OT, it silently falls back to JP_OT_CAP_MINUTES instead (0 is
 * falsy in `capMinutes || JP_OT_CAP_MINUTES` below), which is exactly the
 * trap that prompted adding this column instead.
 */
function isOtEligible_(emp) {
  return emp.OTEligible !== false && emp.OTEligible !== 'FALSE';
}

/**
 * Thai (or any non-Japanese) OT, in 15-minute quarters, no cap. Only counted
 * when the employee explicitly pressed OUT OT -- a plain OUT never earns OT
 * even if they happened to leave late (e.g. just stayed chatting). Reaching a
 * 15-minute mark earns that quarter immediately, no need to go past it --
 * e.g. shift ends 17:00: clocking out anytime 17:00-17:14 earns 0 (the free
 * first 15 min), 17:15-17:29 earns 1 (17:15 exactly already counts), 17:30-
 * 17:44 earns 2, and so on. Note minutesPastShiftEnd_ rounds to the nearest
 * minute first, so e.g. 17:14:30-17:14:59 already rounds up to 15 and earns
 * the quarter a few seconds early -- same round-to-nearest-minute rule
 * computeJapaneseOtMinutes_ uses (via the same minutesPastShiftEnd_ helper).
 * isLate_ is NOT the same: it uses a hard full-minute-elapsed threshold
 * (>=60000ms), not round-to-nearest, so Late and OT do not necessarily trip
 * at the same instant near a boundary.
 */
function computeThaiOtQuarters_(shiftOrEvent, outTimestamp) {
  var pastEnd = minutesPastShiftEnd_(shiftOrEvent, outTimestamp);
  if (pastEnd === null || pastEnd < OT_QUARTER_MINUTES) return 0;
  return Math.floor(pastEnd / OT_QUARTER_MINUTES);
}

/**
 * Kiosk mode: a shared tablet (not logged in as any one employee) checks
 * someone in/out by their personal 4-digit KioskPIN, typed on a keypad.
 * The employee picks Check In or Check Out explicitly, so there's no
 * auto-toggle guessing. Authorized by apiKey only, same as every other action.
 */
function handleKioskCheckin_(params) {
  if (!checkApiKey_(params.apiKey)) return fail_('unauthorized', 'Invalid API key');
  if (!params.pin) return fail_('bad_request', 'pin is required');
  if (params.type !== 'IN' && params.type !== 'OUT') return fail_('bad_request', 'type must be IN or OUT');

  var found = findEmployeeByKioskPin_(params.pin);
  if (!found) return fail_('not_found', 'Code not recognized');

  return recordAttendance_(found.row.EmployeeID, 'KioskPIN', params.pin, params.type, params.ot === 'true', params.branch, params.shift, params.specialShiftSpansNextDay === 'true');
}

/**
 * Kiosk step 1 of 2: looks up whose PIN this is -- name only, nothing is
 * recorded -- so the kiosk can show "Hi, <name>" and let them pick IN/OUT/OUT
 * OT and confirm before handleKioskCheckin_ actually writes anything. Catches
 * a mistyped PIN before it gets attributed to the wrong person.
 */
function handleKioskLookupPin_(params) {
  if (!checkApiKey_(params.apiKey)) return fail_('unauthorized', 'Invalid API key');
  if (!params.pin) return fail_('bad_request', 'pin is required');

  var found = findEmployeeByKioskPin_(params.pin);
  if (!found) return fail_('not_found', 'Code not recognized');
  if (found.row.Active !== true && found.row.Active !== 'TRUE') {
    return fail_('inactive', 'Employee is not active');
  }

  // Deliberately no onShift/onBreak here -- an earlier version called
  // currentShiftBreakState_ (an AttendanceLog read) on every single PIN
  // lookup, adding real Sheets I/O to the highest-frequency, most
  // latency-sensitive path in the whole app (KIOSK_TIMEOUT_MS is only
  // 3000ms) for the sole purpose of labeling the Break button. The app now
  // gets that label from its own on-device kiosk_break_state_v1 marker
  // instead (see breakState.ts), kept correct by every successful
  // BREAK_START/BREAK_END/OUT (see KioskScreen's onConfirm/queueOffline) --
  // no server round trip needed, and recordBreak_ is still the actual
  // source of truth/enforcement regardless of what the button says.
  return ok_({ name: found.row.Name, shifts: shiftChoicesFor_(found.row) });
}

/**
 * Break (พัก) is punch-based (Start Break / Back from Break), recorded as
 * ordinary AttendanceLog rows with Type BREAK_START/BREAK_END -- visibility
 * only, deliberately never feeds Late/OT/duration (Late/OT/Duration columns
 * are left blank on these rows). Every existing Type-column consumer
 * (findTodayInLog_, findLogEntryForDate_, getEmployeeIdsWithInOnDate_,
 * recomputeLateAndOt_, Report.gs's sumMonthTotals_/dashboard readers) filters
 * on exact Type equality against 'IN'/'OUT', so these new Type values are
 * inert to all of them without any further changes there.
 */

/**
 * Figures out whether an employee is currently clocked in and/or on break,
 * by scanning today's rows for them. Shared by handleKioskLookupPin_ (so the
 * kiosk knows which buttons to show) and recordBreak_/recordOfflineSyncedBreak_
 * (to validate a BREAK_START/BREAK_END request). Pass a pre-fetched `log`
 * (see getRecentAttendanceLog_) to avoid re-reading the sheet.
 *
 * `now` doubles as "as of what moment" -- for the live path it's the actual
 * current time, but the offline-sync path passes the queued tap's own
 * (possibly backdated) timestamp instead, so only rows up to and including
 * `now` are considered. Without this bound, a break/OUT row that already
 * synced out of real-time order (offline queue has no ordering guarantee)
 * could make an earlier-timestamped queued tap look like it happened after
 * an OUT/break that, on the device, hadn't happened yet.
 */
function currentShiftBreakState_(employeeId, now, log) {
  log = log || getRecentAttendanceLog_();
  var todayIn = findTodayInLog_(employeeId, now, log);
  if (!todayIn) return { onShift: false, onBreak: false, todayIn: null };

  var idCol = log.headers.indexOf('EmployeeID');
  var tsCol = log.headers.indexOf('Timestamp');
  var typeCol = log.headers.indexOf('Type');

  var clockedOut = false;
  var lastBreakType = null;
  var lastBreakTs = null;
  for (var i = 0; i < log.rows.length; i++) {
    if (String(log.rows[i][idCol]) !== String(employeeId)) continue;
    var ts = new Date(log.rows[i][tsCol]);
    if (ts.getTime() <= todayIn.timestamp.getTime()) continue;
    if (ts.getTime() > now.getTime()) continue;
    var rowType = log.rows[i][typeCol];
    if (rowType === 'OUT') {
      clockedOut = true;
    } else if (rowType === 'BREAK_START' || rowType === 'BREAK_END') {
      if (!lastBreakTs || ts.getTime() > lastBreakTs.getTime()) {
        lastBreakTs = ts;
        lastBreakType = rowType;
      }
    }
  }

  return {
    onShift: !clockedOut,
    onBreak: !clockedOut && lastBreakType === 'BREAK_START',
    todayIn: todayIn,
    // Timestamp of the most recent BREAK_START/BREAK_END event found (null
    // if none today) -- when onBreak is true this IS the open session's own
    // BREAK_START timestamp, which recordBreak_/recordOfflineSyncedBreak_
    // need to compute how long that session lasted once it ends.
    lastBreakTs: lastBreakTs
  };
}

// The employee picks one of these when starting a break -- purely
// informational (see BreakPlannedMinutes below), never compared against the
// actual elapsed time or used to flag/auto-end anything.
var VALID_BREAK_DURATIONS = [15, 30, 45, 60];

// Total real break minutes allowed per employee per day -- used ONLY for the
// "remaining" number shown back to the employee on Back from Break (see
// recordBreak_/recordOfflineSyncedBreak_ below); never affects Late/OT/
// absent, and is completely independent of whichever VALID_BREAK_DURATIONS
// value was picked at Start Break (that pick stays purely informational).
var DAILY_BREAK_BUDGET_MINUTES = 60;

/** Midnight (00:00:00) of the same calendar day as `date`, local time. */
function startOfDay_(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0);
}

/**
 * Sums real elapsed minutes across every COMPLETE BREAK_START->BREAK_END
 * pair for one employee within (sinceTs, now] -- used to compute how much of
 * DAILY_BREAK_BUDGET_MINUTES is left after a break ends. `now` here is
 * always strictly after the just-appended BREAK_END's own timestamp would
 * be (callers run this BEFORE appending that row), so an open/unmatched
 * trailing BREAK_START (the just-ending session itself, or a still-earlier
 * forgotten one) naturally contributes nothing -- callers add the
 * just-ending session's own duration separately.
 *
 * `sinceTs` should be startOfDay_(now) (midnight), NOT state.todayIn.timestamp
 * -- DAILY_BREAK_BUDGET_MINUTES is a whole-CALENDAR-DAY budget, and an
 * employee can clock OUT and back IN again the same day (findTodayInLog_
 * always returns the LATEST IN); scoping from todayIn would silently drop
 * break minutes taken during an earlier stint that same day.
 *
 * Known accepted bound: `log` comes from getRecentAttendanceLog_, capped at
 * RECENT_LOG_ROWS (1000) most recent rows ACROSS EVERY EMPLOYEE, not just
 * this one -- on an implausibly high-volume day (1000+ combined punches
 * before this employee's second same-day break ends) an early-morning pair
 * from their first stint could theoretically scroll out of that window,
 * under-counting priorMinutes and over-stating remainingMinutes. Not
 * fixed here: reaching further back would mean an unbounded/full-sheet read
 * on this latency-sensitive live check-in path (KIOSK_TIMEOUT_MS), which is
 * exactly what RECENT_LOG_ROWS exists to avoid -- and at this org's actual
 * staff size, a single day's combined event count is nowhere near 1000.
 */
function sumCompletedBreakMinutesToday_(employeeId, sinceTs, now, log) {
  var idCol = log.headers.indexOf('EmployeeID');
  var tsCol = log.headers.indexOf('Timestamp');
  var typeCol = log.headers.indexOf('Type');

  var events = [];
  for (var i = 0; i < log.rows.length; i++) {
    if (String(log.rows[i][idCol]) !== String(employeeId)) continue;
    var ts = new Date(log.rows[i][tsCol]);
    if (ts.getTime() <= sinceTs.getTime() || ts.getTime() > now.getTime()) continue;
    var rowType = log.rows[i][typeCol];
    if (rowType === 'BREAK_START' || rowType === 'BREAK_END') events.push({ ts: ts, type: rowType });
  }
  events.sort(function (a, b) { return a.ts.getTime() - b.ts.getTime(); });

  var totalMinutes = 0;
  var openStart = null;
  for (var j = 0; j < events.length; j++) {
    if (events[j].type === 'BREAK_START') {
      openStart = events[j].ts;
    } else if (openStart) {
      totalMinutes += Math.round((events[j].ts.getTime() - openStart.getTime()) / 60000);
      openStart = null;
    }
  }
  return totalMinutes;
}

/**
 * Records a Start Break / Back from Break tap from the live Kiosk. Requires
 * the employee to already be clocked in (a real IN today, no OUT since) and
 * enforces alternating BREAK_START/BREAK_END -- see currentShiftBreakState_.
 * durationMinutes is required for BREAK_START (one of VALID_BREAK_DURATIONS
 * -- the employee's own pick of how long they intend to be gone) and ignored
 * for BREAK_END.
 */
function handleKioskBreak_(params) {
  if (!checkApiKey_(params.apiKey)) return fail_('unauthorized', 'Invalid API key');
  if (!params.pin) return fail_('bad_request', 'pin is required');
  if (params.type !== 'BREAK_START' && params.type !== 'BREAK_END') return fail_('bad_request', 'type must be BREAK_START or BREAK_END');

  var durationMinutes = null;
  if (params.type === 'BREAK_START') {
    durationMinutes = Number(params.durationMinutes);
    if (VALID_BREAK_DURATIONS.indexOf(durationMinutes) === -1) {
      return fail_('bad_request', 'durationMinutes must be one of ' + VALID_BREAK_DURATIONS.join(', '));
    }
  }

  var found = findEmployeeByKioskPin_(params.pin);
  if (!found) return fail_('not_found', 'Code not recognized');
  if (found.row.Active !== true && found.row.Active !== 'TRUE') {
    return fail_('inactive', 'Employee is not active');
  }

  return recordBreak_(found.row.EmployeeID, params.type, durationMinutes);
}

/**
 * Shared duplicate-tap guard for every AttendanceLog writer (recordBreak_,
 * recordOfflineSyncedBreak_, recordAttendance_, recordOfflineSyncedAttendance_)
 * -- true if lastLog exists and referenceTime lands within DUPLICATE_GUARD_MS
 * after (never before) its own Timestamp.
 *
 * `options.ignoreTypes`: treat lastLog as if it doesn't exist when its Type
 * is in this list -- used by the IN/OUT callers so a Break row (a
 * completely different action) can never block a genuine IN/OUT tap just by
 * having happened moments earlier; the IN-vs-OUT/OUT-vs-IN blocking those
 * callers already did before Break existed is otherwise unchanged.
 *
 * `options.sameTypeOnly` + `options.type`: only match when lastLog.Type
 * equals `type` -- used by the Break callers so a BREAK_END right after its
 * own BREAK_START (or vice versa) is never rejected as "duplicate"; that's
 * a deliberate state transition (often someone correcting a mis-tap), not
 * an accidental double-tap. Genuine state conflicts (e.g. starting a break
 * while already on one) are caught separately by currentShiftBreakState_'s
 * own already_on_break/not_on_break checks.
 */
function isWithinDuplicateGuard_(lastLog, referenceTime, options) {
  if (!lastLog || !lastLog.Timestamp) return false;
  if (options.ignoreTypes && options.ignoreTypes.indexOf(lastLog.Type) !== -1) return false;
  if (options.sameTypeOnly && lastLog.Type !== options.type) return false;
  var delta = referenceTime.getTime() - new Date(lastLog.Timestamp).getTime();
  return delta >= 0 && delta < DUPLICATE_GUARD_MS;
}

function recordBreak_(employeeId, type, durationMinutes) {
  var found = findEmployeeRow_(employeeId);
  if (!found) return fail_('not_found', 'Employee not found');
  var emp = found.row;

  var now = new Date(); // one instant for the whole request -- shared by the state check, the duplicate guard, and the row itself, same reasoning recordAttendance_ already follows
  var log = getRecentAttendanceLog_();
  var state = currentShiftBreakState_(employeeId, now, log);
  if (!state.todayIn) return fail_('not_clocked_in', 'Not clocked in yet today');
  if (!state.onShift) return fail_('already_clocked_out', 'Already clocked out today');
  if (type === 'BREAK_START' && state.onBreak) return fail_('already_on_break', 'Already on break');
  if (type === 'BREAK_END' && !state.onBreak) return fail_('not_on_break', 'Not currently on break');

  var lastLog = findLastLogForEmployee_(employeeId, log);
  if (isWithinDuplicateGuard_(lastLog, now, { sameTypeOnly: true, type: type })) {
    return fail_('duplicate', 'Already recorded, please wait a moment before scanning again');
  }

  // Computed BEFORE appendRow_ below (from the `log` snapshot already read,
  // which doesn't include the row about to be written) -- see
  // sumCompletedBreakMinutesToday_'s own doc comment for why that's exactly
  // right: it naturally excludes the just-ending session (no BREAK_END row
  // for it yet), so its own duration is added on separately here.
  var remainingMinutes, totalMinutesUsedToday;
  if (type === 'BREAK_END') {
    var priorMinutes = sumCompletedBreakMinutesToday_(employeeId, startOfDay_(now), now, log);
    var thisSessionMinutes = Math.round((now.getTime() - state.lastBreakTs.getTime()) / 60000);
    totalMinutesUsedToday = priorMinutes + thisSessionMinutes;
    // Sent alongside remainingMinutes (not just derived client-side as
    // 60-remainingMinutes) because remainingMinutes is clamped at 0 -- if
    // actual usage ever exceeds the budget, "60 - remainingMinutes" would
    // silently lie about the true total. The app uses this raw total as the
    // authoritative baseline to correct its own offline running estimate
    // against once a sync actually succeeds (see breakMinutesCache.ts).
    remainingMinutes = Math.max(0, DAILY_BREAK_BUDGET_MINUTES - totalMinutesUsedToday);
  }

  // Same conditional-ensureColumns_ pattern as recordAttendance_'s own
  // PunchBranch/ShiftPicked columns -- only pays for the extra write the
  // first time this sheet has ever seen a BreakPlannedMinutes value.
  var appendHeaders = log.headers;
  if (log.headers.indexOf('BreakPlannedMinutes') === -1) {
    ensureColumns_('AttendanceLog', ['BreakPlannedMinutes']);
    appendHeaders = null; // log.rows/headers were read before this column existed -- let appendRow_ re-read headers fresh
  }

  appendRow_('AttendanceLog', {
    Timestamp: now,
    EmployeeID: emp.EmployeeID,
    Name: emp.Name,
    Department: emp.Department,
    Type: type,
    Method: 'KioskPIN',
    RawScanValue: '',
    BreakPlannedMinutes: type === 'BREAK_START' ? durationMinutes : ''
  }, appendHeaders);

  return ok_({
    type: type,
    timestamp: now.toISOString(),
    name: emp.Name,
    durationMinutes: type === 'BREAK_START' ? durationMinutes : undefined,
    remainingMinutes: remainingMinutes,
    totalMinutesUsedToday: totalMinutesUsedToday
  });
}

/**
 * Full PIN->Name directory of active employees, for the kiosk app to cache
 * on-device so PIN lookup keeps working even with zero internet. Refreshed
 * by the app whenever it does have a connection (see the app's
 * employeeDirectory util) -- adding/renaming/deactivating someone just
 * takes effect on the next refresh, no app rebuild involved.
 */
function handleKioskDirectory_(params) {
  if (!checkApiKey_(params.apiKey)) return fail_('unauthorized', 'Invalid API key');

  var employees = getAllEmployees_()
    .filter(function (emp) { return isTrue_(emp.Active) && emp.KioskPIN; })
    .map(function (emp) { return { pin: pad4_(emp.KioskPIN), name: emp.Name, shifts: shiftChoicesFor_(emp) }; });

  return ok_({ employees: employees });
}

/**
 * Syncs one kiosk check-in/out that was queued locally while the tablet had
 * no connection. See recordOfflineSyncedAttendance_ for the idempotency
 * (clientId) and backdated-timestamp handling.
 */
function handleKioskSyncOffline_(params) {
  if (!checkApiKey_(params.apiKey)) return fail_('unauthorized', 'Invalid API key');
  if (!params.pin) return fail_('bad_request', 'pin is required');
  var isBreakType = params.type === 'BREAK_START' || params.type === 'BREAK_END';
  if (params.type !== 'IN' && params.type !== 'OUT' && !isBreakType) {
    return fail_('bad_request', 'type must be IN, OUT, BREAK_START, or BREAK_END');
  }
  if (!params.clientId) return fail_('bad_request', 'clientId is required');
  if (!params.timestamp) return fail_('bad_request', 'timestamp is required');

  var breakDurationMinutes = null;
  if (params.type === 'BREAK_START') {
    breakDurationMinutes = Number(params.durationMinutes);
    if (VALID_BREAK_DURATIONS.indexOf(breakDurationMinutes) === -1) {
      return fail_('bad_request', 'durationMinutes must be one of ' + VALID_BREAK_DURATIONS.join(', '));
    }
  }

  var found = findEmployeeByKioskPin_(params.pin);
  if (!found) return fail_('not_found', 'Code not recognized');
  if (found.row.Active !== true && found.row.Active !== 'TRUE') {
    return fail_('inactive', 'Employee is not active');
  }

  var timestamp = new Date(params.timestamp);
  if (isNaN(timestamp.getTime())) return fail_('bad_request', 'timestamp did not parse');

  if (isBreakType) {
    var breakResult = recordOfflineSyncedBreak_(found.row.EmployeeID, params.type, timestamp, params.clientId, breakDurationMinutes);
    if (breakResult.error) return fail_(breakResult.error, breakResult.message);
    if (breakResult.duplicate) return fail_('duplicate', 'Already recorded around this time, skipped as a duplicate');
    return ok_(breakResult);
  }

  var result = recordOfflineSyncedAttendance_(
    found.row.EmployeeID, params.type, timestamp, params.ot === 'true', params.clientId, params.branch, params.shift
  );
  if (result.duplicate) return fail_('duplicate', 'Already recorded around this time, skipped as a duplicate');
  return ok_(result);
}

/**
 * Builds the { day, date, timeIn, timeOut, shift, note, late, ot } list for
 * one employee's one month, shared by handleKioskMyAttendance_ (one month)
 * and handleKioskMyAttendanceBulk_ (many months in one call). dayLogs and
 * scheduledShiftsForMonth are already scoped to the one employee (the
 * EmployeeID-keyed lookup already done by the caller).
 */
function buildMyAttendanceDays_(year, month, dayLogs, scheduledShiftsForMonth, tz) {
  var daysInMonth = new Date(year, month, 0).getDate();
  var days = [];
  for (var d = 1; d <= daysInMonth; d++) {
    var entry = dayLogs[d];
    var scheduled = scheduledShiftsForMonth[d];
    // Late/OT suppression (below, on a day WITH a real IN) uses the wider
    // isNoLateNoOtShift_ -- Special's own IN row already has late=false/
    // otMinutes=0 correctly written, but this stays defensive in case of a
    // relabel-after-the-fact, same reasoning as the Event case always had.
    var isNoLateNoOt = isNoLateNoOtShift_(scheduled);
    // Real IN required here, not just "an entry exists" -- a stray OUT-only
    // row (no matching IN) still produces a truthy dayLogs[d] with
    // timeIn: null and shift: '' (Shift is only ever written on the IN
    // row), and on an Event day that case must fall through to the isEventDay
    // branch below instead, same gating Report.gs's writeMonthlyReportData_
    // already uses (`!dayEntry || !dayEntry.timeIn`) -- otherwise this and
    // the Report sheet would show different things for the same employee/day.
    if (entry && entry.timeIn) {
      days.push({
        day: d,
        date: Utilities.formatDate(new Date(year, month - 1, d), tz, 'yyyy-MM-dd'),
        timeIn: Utilities.formatDate(entry.timeIn, tz, 'HH:mm'),
        timeOut: entry.timeOut ? Utilities.formatDate(entry.timeOut, tz, 'HH:mm') : '',
        shift: entry.shift || '',
        note: '',
        // isNoLateNoOt overrides a stale stored Late/OT the same way
        // sumMonthTotals_/handleDashboardDaily_ already do unconditionally
        // from the CURRENT schedule -- without this, a day relabeled Event
        // AFTER a late/OT punch would still show Late/OT to the employee
        // here until an admin remembers to run "Recompute Late/OT for One
        // Month".
        late: !!entry.late && !isNoLateNoOt,
        ot: !isNoLateNoOt && !!(entry.otMinutes || entry.otQuarters)
      });
      continue;
    }

    // An Event day always shows as a clean, complete worked day whenever
    // there's no real IN to show -- whether nobody clocked at all, or only
    // a stray OUT landed that day with no matching IN -- same rule
    // sumMonthTotals_/the Report grid/handleDashboardDaily_ already apply;
    // without this the employee's own calendar would show this day blank
    // (or, for the stray-OUT case, the actual OUT time with a blank shift),
    // even though the whole point of an Event shift is that nobody's
    // expected to tap the kiosk for it.
    //
    // Deliberately isEventShift_ here, NOT isNoLateNoOt -- Special must
    // NEVER have this branch fabricate a synthetic Time Out. The END day of
    // an overnight Special Shift has no real IN either, but usually DOES
    // have a real OUT (falls through to the stray-OUT-only branch below,
    // which shows that real time); Special's whole design point is the real
    // tap time is always what's recorded and shown, unlike Event.
    if (isEventShift_(scheduled)) {
      var eventStart = getShiftStartTime_(scheduled);
      var eventEnd = getShiftEndTime_(scheduled);
      days.push({
        day: d,
        date: Utilities.formatDate(new Date(year, month - 1, d), tz, 'yyyy-MM-dd'),
        timeIn: eventStart ? minutesToHHMM_(eventStart.hour * 60 + eventStart.minute) : '',
        timeOut: eventEnd ? minutesToHHMM_(eventEnd.hour * 60 + eventEnd.minute) : '',
        shift: scheduled,
        note: '',
        late: false,
        ot: false
      });
      continue;
    }

    // Non-Event day with a stray OUT-only row (no matching IN) -- same case
    // as above, just without an Event day's synthetic official hours to
    // fall back on. The real OUT time shows; Shift falls back to whatever's
    // scheduled that day (entry.shift itself is blank here -- it's only
    // ever recorded on the IN row) so a reference label still shows, same
    // parity with Report.gs's writeMonthlyReportData_ its own comment
    // promises -- most relevantly the END day of an overnight Special
    // Shift, which always has a real OUT here but never a Shift value of
    // its own. Nothing to be "late" or earn OT against without a real IN.
    if (entry) {
      days.push({
        day: d,
        date: Utilities.formatDate(new Date(year, month - 1, d), tz, 'yyyy-MM-dd'),
        timeIn: '',
        timeOut: entry.timeOut ? Utilities.formatDate(entry.timeOut, tz, 'HH:mm') : '',
        shift: entry.shift || scheduled || '',
        note: '',
        late: false,
        ot: !!(entry.otMinutes || entry.otQuarters)
      });
      continue;
    }

    // Only consulted for days with no actual punch -- lets a day scheduled
    // as "Leave"/"Holiday"/anything else non-time-based show that label
    // instead of sitting blank. No hardcoded list of which labels count:
    // whatever's typed into the Schedule sheet for that day is shown
    // verbatim as long as it doesn't look like a real shift's clock time,
    // so a brand new option (e.g. "Sick Leave") works here the moment it's
    // added to the Shift dropdown -- nothing in this function needs to
    // change for it.
    if (scheduled && !/\d{1,2}:\d{2}/.test(scheduled)) {
      days.push({
        day: d,
        date: Utilities.formatDate(new Date(year, month - 1, d), tz, 'yyyy-MM-dd'),
        timeIn: '',
        timeOut: '',
        shift: scheduled,
        note: scheduled,
        late: false,
        ot: false
      });
    }
  }
  return days;
}

/**
 * Lets an employee check their own month's check-in/out times right from the
 * kiosk, by re-entering their same 4-digit KioskPIN -- no admin session
 * needed. Defaults to the current year/month if not given.
 */
function handleKioskMyAttendance_(params) {
  if (!checkApiKey_(params.apiKey)) return fail_('unauthorized', 'Invalid API key');
  if (!params.pin) return fail_('bad_request', 'pin is required');

  var found = findEmployeeByKioskPin_(params.pin);
  if (!found) return fail_('not_found', 'Code not recognized');

  var now = new Date();
  var year = Number(params.year) || now.getFullYear();
  var month = Number(params.month) || (now.getMonth() + 1);
  var tz = Session.getScriptTimeZone();

  // The fast bounded-tail read only reliably covers recent activity -- fine
  // for the default (current month, checked by almost everyone almost every
  // day) but a genuinely past month someone deliberately navigates back to
  // could already have scrolled out of that tail once AttendanceLog grows
  // enough, silently coming back empty. Full-sheet read only for that
  // deliberate, occasional case; the everyday current-month path is
  // untouched, so this can't slow down or time out the routine check-in rush.
  var isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;
  var dayLogs = (isCurrentMonth ? getRecentMonthLogsByEmployee_(year, month) : getMonthLogsByEmployee_(year, month))[found.row.EmployeeID] || {};
  var scheduledShiftsForMonth = (getScheduledShiftsForMonth_(year, month))[found.row.EmployeeID] || {};

  var days = buildMyAttendanceDays_(year, month, dayLogs, scheduledShiftsForMonth, tz);
  return ok_({ name: found.row.Name, year: year, month: month, days: days });
}

var MY_ATTENDANCE_BULK_MONTHS = 12; // how many months back (including the current one) the app silently pre-syncs when My Schedule opens

/**
 * Same data as handleKioskMyAttendance_, but for the last
 * MY_ATTENDANCE_BULK_MONTHS months in one call instead of one month per
 * call -- the app fires this once in the background right after a
 * successful My Schedule PIN entry, then caches every month it gets back
 * on-device, so paging Prev/Next through recent history is instant instead
 * of paying a live round trip (and, for any month but the current one, a
 * full-sheet read -- see handleKioskMyAttendance_) on every single tap.
 * Reads AttendanceLog exactly once (aggregateMonthLogs_ takes the already-
 * read values and just re-filters them per month) no matter how many months
 * this covers, unlike calling handleKioskMyAttendance_ N times over -- that
 * repeated full-sheet read is the one this function was written to avoid,
 * since AttendanceLog is by far the biggest sheet here. getScheduledShiftsForMonth_
 * still reads its own "Schedule YYYY-MM" sheet once per month either way
 * (each is its own small sheet, so N reads of those cost little next to the
 * AttendanceLog savings above).
 */
function handleKioskMyAttendanceBulk_(params) {
  if (!checkApiKey_(params.apiKey)) return fail_('unauthorized', 'Invalid API key');
  if (!params.pin) return fail_('bad_request', 'pin is required');

  var found = findEmployeeByKioskPin_(params.pin);
  if (!found) return fail_('not_found', 'Code not recognized');

  var tz = Session.getScriptTimeZone();
  var now = new Date();
  var employeeId = found.row.EmployeeID;
  var logValues = getSheet_('AttendanceLog').getDataRange().getValues();

  var months = [];
  for (var i = 0; i < MY_ATTENDANCE_BULK_MONTHS; i++) {
    var monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
    var year = monthDate.getFullYear();
    var month = monthDate.getMonth() + 1;

    var dayLogs = (aggregateMonthLogs_(logValues, year, month))[employeeId] || {};
    var scheduledShiftsForMonth = (getScheduledShiftsForMonth_(year, month))[employeeId] || {};
    months.push({ year: year, month: month, days: buildMyAttendanceDays_(year, month, dayLogs, scheduledShiftsForMonth, tz) });
  }

  return ok_({ name: found.row.Name, months: months });
}

/**
 * Every active employee's CURRENT month, in one call -- the device-wide
 * daily background sync (see useScheduleSync in the app) that runs once a
 * day so every employee's My Schedule is already cached on-device before
 * anyone ever opens it, instead of only caching it after someone happens to
 * open it live (see cacheCurrentScheduleSnapshot in the app). No PIN --
 * unlike handleKioskMyAttendance_/handleKioskMyAttendanceBulk_, this isn't
 * one employee looking themselves up, it's the device itself syncing
 * everyone at once, same auth shape as handleKioskDirectory_.
 *
 * Reads Employees, AttendanceLog and this month's Schedule sheet exactly
 * ONCE each (getRecentMonthLogsByEmployee_/getScheduledShiftsForMonth_
 * already return every employee's data in one pass -- see their own doc
 * comments; Employees is read directly below, in raw sheet-row order,
 * rather than via getAllEmployees_(), which would mean a SECOND full read
 * of the same sheet plus losing the row order this needs -- see the PIN
 * tie-break note below), then builds each employee's day list from that
 * same in-memory data, so this costs the same one-time reads no matter how
 * many employees there are. Bounded-tail AttendanceLog read (not the
 * full-history one Report/Recompute use) is correct and intentional here --
 * same reasoning as handleKioskMyAttendance_'s current-month case, which
 * this mirrors for every employee at once instead of just one.
 */
function handleKioskScheduleSyncAll_(params) {
  if (!checkApiKey_(params.apiKey)) return fail_('unauthorized', 'Invalid API key');

  var now = new Date();
  var year = now.getFullYear();
  var month = now.getMonth() + 1;
  var tz = Session.getScriptTimeZone();

  var logsByEmployee = getRecentMonthLogsByEmployee_(year, month);
  var scheduledShiftsByEmployee = getScheduledShiftsForMonth_(year, month);

  // getCachedEmployees_ (Utils.gs) rather than a fresh sheet.getDataRange()
  // read or getAllEmployees_() -- same raw row order findEmployeeByKioskPin_
  // resolves PINs by (needed for the tie-break below), already cached for
  // 5 minutes specifically to spare the Employees sheet repeated reads.
  var employeeData = getCachedEmployees_();
  var headers = employeeData.headers;
  var idCol = headers.indexOf('EmployeeID');
  var nameCol = headers.indexOf('Name');
  var activeCol = headers.indexOf('Active');
  var pinCol = headers.indexOf('KioskPIN');

  var seenPins = {};
  var employees = [];
  for (var i = 0; i < employeeData.rows.length; i++) {
    var row = employeeData.rows[i];
    var rawPin = String(row[pinCol] || '').trim();
    if (!rawPin) continue;
    var pin = pad4_(rawPin);
    // First match in row order wins the PIN -- same tie-break
    // findEmployeeByKioskPin_ itself uses (Utils.gs), checked BEFORE the
    // Active filter below so it matches live resolution exactly: even an
    // Inactive row earlier in the sheet still "claims" a shared PIN,
    // because that's genuinely who the live Kiosk would resolve it to too
    // (findEmployeeByKioskPin_ doesn't check Active either). A later
    // Active employee stuck behind a duplicated PIN is already unreachable
    // at the Kiosk today, not a state this sync should paper over by
    // caching them under a PIN that doesn't actually reach them live --
    // checkEmployeesSheet_ is what surfaces that mistake for an admin to fix.
    if (seenPins[pin]) continue;
    seenPins[pin] = true;
    if (!isTrue_(row[activeCol])) continue;

    var employeeId = String(row[idCol]);
    var name = row[nameCol];
    // One employee's malformed Schedule cell (or anything else
    // buildMyAttendanceDays_ might choke on) must not fail the whole batch
    // -- unlike handleKioskMyAttendance_, where a throw only ever affects
    // that one person's own live lookup, an uncaught throw here would fail
    // this entire response and silently cancel today's sync for every
    // other employee too. Skipped (not included with empty/wrong days) on
    // failure -- that employee just falls back to a live fetch only, same
    // as before this feature existed, rather than caching something
    // misleading for them.
    try {
      var dayLogs = logsByEmployee[employeeId] || {};
      var scheduledShiftsForMonth = scheduledShiftsByEmployee[employeeId] || {};
      employees.push({
        pin: pin,
        name: name,
        days: buildMyAttendanceDays_(year, month, dayLogs, scheduledShiftsForMonth, tz)
      });
    } catch (e) {
      Logger.log('handleKioskScheduleSyncAll_: skipped ' + employeeId + ' (' + name + '): ' + e.message);
    }
  }

  return ok_({ year: year, month: month, employees: employees });
}

/**
 * One-off repair: recomputes Shift + Late (from the current Schedule sheet)
 * for every IN row, and OTMinutes for every Japanese OUT row, within
 * [startDay, endDay] of the given month. Fixes rows recorded when the
 * Schedule cell was still blank at check-in time -- Late/Shift/OT get frozen
 * in then and are never re-checked automatically.
 *
 * The Schedule sheet is authoritative whenever it holds an explicit value
 * for that employee/day -- INCLUDING over an IN row whose Shift came from
 * the employee's own Kiosk pick (ShiftPicked=TRUE), so an admin correcting a
 * wrong shift (either in the Schedule sheet, or by fixing what the employee
 * mistakenly picked at the Kiosk) always takes effect on the next Recompute.
 * A ShiftPicked row is left untouched ONLY while the Schedule cell is still
 * genuinely blank -- there's nothing to correct it against yet, and blindly
 * writing blank there would run writeScheduleShiftCell_ backwards: an
 * unrelated later edit to that month's Schedule sheet (e.g. Create/Update
 * Schedule Sheet backfilling a blank row for a different employee) must
 * never overwrite an already-correct picked shift back to blank/wrong.
 *
 * "Japanese" is decided from each employee's *current* Employees sheet
 * Department, not the Department value frozen onto the old row -- old rows
 * can carry a stale label (e.g. "Japanese Staff" from before Department was
 * standardized to just "Japanese"/"Thai") that would otherwise make this
 * silently skip them even after the employee record itself is fixed.
 *
 * Thai/non-Japanese OTQuarters IS recomputed too, but only for rows that
 * already have OT=TRUE -- unlike Japanese OT (always auto-computed
 * regardless of button), Thai OT only counts if the employee pressed
 * "OUT OT" specifically, and AttendanceLog doesn't keep that raw button
 * choice separate from the already-computed OTQuarters value, so a blank
 * Schedule and "pressed plain OUT" both look identical (OTQuarters=0)
 * after the fact -- there's no reliable way to tell those apart, so a row
 * that's currently OT=FALSE is left alone rather than risk inventing OT
 * nobody asked for. A row that's already OT=TRUE has no such ambiguity
 * (the employee did press OUT OT), so its OTQuarters count gets refreshed
 * against the (possibly corrected) shift, same as Japanese.
 *
 * Also can't help a day with no OUT row at all (forgot to check out) -- there's
 * no real clock-out time to compute anything from.
 *
 * Safe to run repeatedly on the same range. Edit YEAR/MONTH/START_DAY/END_DAY
 * below, then select runRecomputeLateAndOt in the editor's toolbar dropdown
 * and Run. Check View > Logs for a summary.
 */
function recomputeLateAndOt_(year, month, startDay, endDay) {
  var sheet = getSheet_('AttendanceLog');
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2) return { inRowsUpdated: 0, outRowsUpdated: 0 };

  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var tsCol = headers.indexOf('Timestamp');
  var idCol = headers.indexOf('EmployeeID');
  var typeCol = headers.indexOf('Type');
  var shiftCol = headers.indexOf('Shift');
  var lateCol = headers.indexOf('Late');
  var otCol = headers.indexOf('OT');
  var otMinCol = headers.indexOf('OTMinutes');
  var otQCol = headers.indexOf('OTQuarters');
  var shiftPickedCol = headers.indexOf('ShiftPicked'); // -1 on a sheet from before this column existed -- every row just behaves as before (schedule-recomputed), see below

  // Find exactly which sheet rows belong to this month by scanning ONLY the
  // Timestamp column first (1 column instead of all of them) -- cheap even
  // once AttendanceLog has years of history piled up. Every row gets
  // checked, none skipped or guessed at, so a backdated entry landing
  // anywhere in the sheet regardless of which date it's actually for (see
  // recordBackdatedAttendance_) still gets found correctly -- this just
  // reads less data per row to find it, it doesn't assume the sheet is in
  // date order.
  var allTimestamps = sheet.getRange(2, tsCol + 1, lastRow - 1, 1).getValues();
  var minRow = -1, maxRow = -1;
  for (var r = 0; r < allTimestamps.length; r++) {
    var t = new Date(allTimestamps[r][0]);
    if (t.getFullYear() === year && t.getMonth() + 1 === month) {
      if (minRow === -1) minRow = r + 2; // +2: allTimestamps[0] is sheet row 2 (row 1 is the header)
      maxRow = r + 2;
    }
  }
  if (minRow === -1) return { inRowsUpdated: 0, outRowsUpdated: 0 }; // nothing recorded for this month at all

  // Now read full width, but only the row range that could possibly matter
  // -- everything from here down is IDENTICAL logic to before, just working
  // on this bounded slice (indexed from 0) instead of the whole sheet
  // (indexed from 1, with the header at 0). Absolute sheet row for
  // sliceValues[i] is (minRow + i).
  var sliceValues = sheet.getRange(minRow, 1, maxRow - minRow + 1, lastCol).getValues();

  // Read the month's Schedule sheet ONCE up front instead of calling
  // getScheduledShift_ per row -- that helper re-reads the whole Schedule
  // sheet on every call, which is fine for a single live check-in/out but
  // was blowing past Apps Script's 6-minute execution cap here once
  // AttendanceLog grew past a few hundred rows (one Schedule sheet read per
  // matching row, times hundreds of rows).
  var shiftsForMonth = getScheduledShiftsForMonth_(year, month);

  // Same idea for the writes: mutate `sliceValues` in memory and write each
  // touched column back in one batched call at the end, instead of a
  // separate setValue() network round-trip per row.
  var shiftByEmployeeDay = {};
  // Tracks which IN row's timestamp currently "owns" shiftByEmployeeDay for
  // each employee/day -- LATEST IN wins, matching findTodayInLog_/
  // findLogEntryForDate_ (what the live/offline paths actually use to pair
  // an OUT with "today's IN"). Needed because a day can have more than one
  // IN row (offline-sync duplicate, admin backdated fix alongside a real
  // Kiosk tap) processed in arbitrary sheet order here -- without this,
  // whichever row happened to be LAST in sheet order would silently decide
  // shiftByEmployeeDay, which could be the wrong one (e.g. clobbering a
  // genuinely later, correctly-picked shift with an earlier row's).
  var latestInTsByKey = {};
  var inRowsUpdated = 0;
  var outRowsUpdated = 0;

  for (var i = 0; i < sliceValues.length; i++) {
    var ts = new Date(sliceValues[i][tsCol]);
    if (ts.getFullYear() !== year || ts.getMonth() + 1 !== month) continue;
    var day = ts.getDate();
    if (day < startDay || day > endDay) continue;
    if (sliceValues[i][typeCol] !== 'IN') continue;

    var employeeId = String(sliceValues[i][idCol]);
    var key = employeeId + '|' + day;
    var isLatestSoFar = !(key in latestInTsByKey) || ts.getTime() >= latestInTsByKey[key];

    var scheduledShift = (shiftsForMonth[employeeId] && shiftsForMonth[employeeId][day]) || '';

    // A row whose Shift came from the employee's own Kiosk pick (see
    // ShiftPicked/writeScheduleShiftCell_ in the live/offline check-in
    // paths) is left untouched ONLY while the Schedule sheet still has
    // nothing to correct it against (scheduledShift blank) -- that's the
    // case writeScheduleShiftCell_'s own comment describes: the Schedule
    // sheet catches up to what was picked, not the other way around, and an
    // unrelated bulk Schedule-sheet operation touching a still-blank cell
    // must never erase an already-correct picked shift back to blank.
    // Once the Schedule sheet DOES hold an explicit value, though, it wins
    // even over a picked row -- an admin correcting a wrong shift the
    // employee picked at the Kiosk (e.g. they picked 8:00-17:00 instead of
    // their real 8:30-17:30) must take effect on the next Recompute, not be
    // silently skipped forever just because ShiftPicked is set.
    //
    // Known accepted risk: this assumes the Schedule cell reflects reality
    // whenever it's non-blank. writeScheduleShiftCell_ (the live check-in
    // path's best-effort sync of a picked shift back to the Schedule sheet)
    // is deliberately fail-open -- a transient Sheets error there is
    // swallowed so it can never take the check-in itself down with it (see
    // its own doc comment) -- so in the rare case that write silently fails
    // AND the Schedule cell already held some other non-blank value before
    // the employee's pick, this rule would treat that stale value as
    // authoritative on a later Recompute instead of the employee's
    // (correct) pick. Not fixed here: distinguishing "admin deliberately
    // corrected this" from "sync-back silently failed" would need its own
    // tracking column, and the failure this depends on is already logged
    // (Logger.log) and rare enough that a full redesign isn't justified yet.
    if (shiftPickedCol !== -1 && isTrue_(sliceValues[i][shiftPickedCol]) && !scheduledShift) {
      if (isLatestSoFar) {
        latestInTsByKey[key] = ts.getTime();
        shiftByEmployeeDay[key] = sliceValues[i][shiftCol];
      }
      continue;
    }
    // An Event or Special day is always on time, no matter when the actual
    // tap happened -- same rule eventShiftOverrideTimestamp_ enforces live
    // for Event, and recordAttendance_'s IN branch enforces directly for
    // Special. Recompute has to enforce it too, since it re-derives Late
    // from the raw stored Timestamp (never touches that column) against
    // whatever the Schedule sheet currently says -- without this, running
    // Recompute on a Special day would wrongly flag Late the moment the
    // real tap deviates from the picked start by more than a minute.
    var late = isNoLateNoOtShift_(scheduledShift) ? false : (scheduledShift ? isLate_(scheduledShift, ts) : false);

    sliceValues[i][shiftCol] = scheduledShift;
    sliceValues[i][lateCol] = late;
    if (isLatestSoFar) {
      latestInTsByKey[key] = ts.getTime();
      shiftByEmployeeDay[key] = scheduledShift;
    }
    inRowsUpdated++;
  }

  for (var j = 0; j < sliceValues.length; j++) {
    var ts2 = new Date(sliceValues[j][tsCol]);
    if (ts2.getFullYear() !== year || ts2.getMonth() + 1 !== month) continue;
    var day2 = ts2.getDate();
    if (day2 < startDay || day2 > endDay) continue;
    if (sliceValues[j][typeCol] !== 'OUT') continue;

    var employeeId2 = String(sliceValues[j][idCol]);
    var currentEmp = findEmployeeRow_(employeeId2);
    if (!currentEmp) continue;
    var currentDept = currentEmp.row.Department;

    // OT only ever counts when there's a matching IN row that same day --
    // same rule the live/offline/backdated write paths already enforce (see
    // recordAttendance_'s todayShift, matchingIn). No fallback to the
    // schedule's shift when there's no matching IN: an OUT with nobody ever
    // clocked IN that day must never earn OT just because a shift happened
    // to be scheduled -- shiftByEmployeeDay only has this key when the
    // IN-row loop above actually found and processed an IN row for this
    // employee/day.
    var key = employeeId2 + '|' + day2;
    var shift = shiftByEmployeeDay.hasOwnProperty(key) ? shiftByEmployeeDay[key] : '';

    // An Event or Special day never has OT, no matter when the actual OUT
    // tap happened -- same rule as the Late fix above. Matters most for a
    // SAME-day Special Shift: unlike Event (whose live-time timestamp
    // forcing already makes minutesPastShiftEnd_ resolve to exactly 0),
    // Special keeps the real OUT tap time, so without this explicit skip a
    // genuinely late real tap would recompute real positive OT.
    var isEventDay = isNoLateNoOtShift_(shift);

    if (currentDept === 'Japanese') {
      var capMinutes = Number(currentEmp.row.OTMaxMinutes) || JP_OT_CAP_MINUTES;
      var otMinutes = (isOtEligible_(currentEmp.row) && shift && !isEventDay) ? computeJapaneseOtMinutes_(shift, ts2, capMinutes) : 0;
      sliceValues[j][otMinCol] = otMinutes;
      if (otQCol !== -1) sliceValues[j][otQCol] = 0; // clear a stale Thai-regime value left over from before a Department correction
      sliceValues[j][otCol] = otMinutes > 0;
      outRowsUpdated++;
    } else {
      // Only touch rows already flagged OT=TRUE -- that's the one
      // unambiguous signal we have that "OUT OT" was actually pressed (see
      // doc comment above). Leave OT=FALSE rows exactly as they are -- except
      // an Event day, which always forces OT off below regardless of that
      // flag, since Event days never have OT.
      var wasOt = isTrue_(sliceValues[j][otCol]);
      if (!wasOt && !isEventDay) continue;
      var otQuarters = (isOtEligible_(currentEmp.row) && shift && !isEventDay) ? computeThaiOtQuarters_(shift, ts2) : 0;
      sliceValues[j][otQCol] = otQuarters;
      sliceValues[j][otMinCol] = 0; // clear a stale Japanese-regime value left over from before a Department correction
      sliceValues[j][otCol] = otQuarters > 0;
      outRowsUpdated++;
    }
  }

  if (inRowsUpdated > 0 || outRowsUpdated > 0) {
    var numRows = sliceValues.length;
    sheet.getRange(minRow, shiftCol + 1, numRows, 1).setValues(sliceValues.map(function (r) { return [r[shiftCol]]; }));
    sheet.getRange(minRow, lateCol + 1, numRows, 1).setValues(sliceValues.map(function (r) { return [r[lateCol]]; }));
    sheet.getRange(minRow, otCol + 1, numRows, 1).setValues(sliceValues.map(function (r) { return [r[otCol]]; }));
    sheet.getRange(minRow, otMinCol + 1, numRows, 1).setValues(sliceValues.map(function (r) { return [r[otMinCol]]; }));
    if (otQCol !== -1) {
      sheet.getRange(minRow, otQCol + 1, numRows, 1).setValues(sliceValues.map(function (r) { return [r[otQCol]]; }));
    }
  }

  return { inRowsUpdated: inRowsUpdated, outRowsUpdated: outRowsUpdated };
}

/**
 * Reads a whole "Schedule YYYY-MM" sheet once and returns
 * { [employeeId]: { [dayOfMonth]: shift } }, or {} if that month's Schedule
 * sheet doesn't exist. Same lookup semantics as getScheduledShift_ (which
 * re-reads the sheet on every call -- fine for one-off lookups like a live
 * check-in/out, but not for recomputing hundreds of rows in a loop).
 */
function getScheduledShiftsForMonth_(year, month) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetName = 'Schedule ' + year + '-' + (month < 10 ? '0' + month : String(month));
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return {};

  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idCol = headers.indexOf('EmployeeID');
  if (idCol === -1) return {};

  var dayCols = {};
  for (var c = 0; c < headers.length; c++) {
    if (typeof headers[c] === 'number') dayCols[headers[c]] = c;
  }

  var result = {};
  for (var i = 1; i < values.length; i++) {
    var employeeId = String(values[i][idCol]);
    var byDay = {};
    for (var day in dayCols) {
      byDay[day] = String(values[i][dayCols[day]] || '').trim();
    }
    result[employeeId] = byDay;
  }
  return result;
}

/**
 * Recomputes the whole month shown on whichever "Schedule YYYY-MM" tab is
 * currently open in the spreadsheet (open that tab first). Select this
 * function in the editor's toolbar dropdown and click Run. Check View > Logs
 * for a summary.
 */
function runRecomputeLateAndOt() {
  var activeSheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var match = activeSheet.getName().match(/^Schedule (\d{4})-(\d{2})$/);
  if (!match) {
    Logger.log('Open the "Schedule YYYY-MM" tab you want to recompute first, then run this again. Active tab was: ' + activeSheet.getName());
    return;
  }

  var year = Number(match[1]);
  var month = Number(match[2]);
  var daysInMonth = new Date(year, month, 0).getDate();

  var result = recomputeLateAndOt_(year, month, 1, daysInMonth);
  Logger.log(
    'Recomputed ' + activeSheet.getName() + ': updated ' + result.inRowsUpdated + ' IN row(s) (Shift/Late) and ' +
    result.outRowsUpdated + ' OUT row(s) (OT -- Japanese: minutes, Thai/other: quarters, only where OT was already TRUE).'
  );
}

/**
 * Confirms the Kiosk Exit PIN before letting the shared tablet back to the
 * Admin screen -- otherwise anyone tapping Exit on the kiosk lands straight
 * in admin tools. If no exit PIN has been set yet (KIOSK_EXIT_PIN script
 * property), exiting is left unprotected rather than locking the device out.
 */
function handleVerifyKioskExitPin_(params) {
  if (!checkApiKey_(params.apiKey)) return fail_('unauthorized', 'Invalid API key');

  var configured = getProp_('KIOSK_EXIT_PIN');
  if (!configured) return ok_({});
  if (params.pin === configured) return ok_({});
  return fail_('invalid_pin', 'Incorrect exit PIN');
}

/** Finds today's most recent IN row for an employee. Returns {timestamp, shift} or null. Pass a pre-fetched `log` (see getRecentAttendanceLog_) to avoid re-reading the sheet. */
function findTodayInLog_(employeeId, now, log) {
  log = log || getRecentAttendanceLog_();
  var idCol = log.headers.indexOf('EmployeeID');
  var tsCol = log.headers.indexOf('Timestamp');
  var typeCol = log.headers.indexOf('Type');
  var shiftCol = log.headers.indexOf('Shift');

  var found = null;
  for (var i = 0; i < log.rows.length; i++) {
    if (String(log.rows[i][idCol]) !== String(employeeId)) continue;
    if (log.rows[i][typeCol] !== 'IN') continue;
    var ts = new Date(log.rows[i][tsCol]);
    if (!isSameDay_(ts, now)) continue;
    if (!found || ts > found.timestamp) {
      found = { timestamp: ts, shift: shiftCol !== -1 ? String(log.rows[i][shiftCol] || '') : '' };
    }
  }
  return found;
}

/** Finds an employee's row for a specific type (IN or OUT) on a specific date, searching the whole AttendanceLog (not just the recent window) since a backdated entry can be from any point in the past. */
/**
 * Reads AttendanceLog once and returns the set of EmployeeIDs (string keys)
 * who have at least one IN row on `date`. Use instead of calling
 * findLogEntryForDate_ inside a loop over many employees -- that helper
 * re-reads the whole AttendanceLog sheet on every single call, which is
 * fine for a one-off lookup but not for checking dozens of employees at
 * once (see menuWhoIsAbsentToday_, menuBulkMarkAttendance_).
 */
function getEmployeeIdsWithInOnDate_(date) {
  var sheet = getSheet_('AttendanceLog');
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idCol = headers.indexOf('EmployeeID');
  var tsCol = headers.indexOf('Timestamp');
  var typeCol = headers.indexOf('Type');

  var ids = {};
  for (var i = 1; i < values.length; i++) {
    if (values[i][typeCol] !== 'IN') continue;
    var ts = new Date(values[i][tsCol]);
    if (!isSameDay_(ts, date)) continue;
    ids[String(values[i][idCol])] = true;
  }
  return ids;
}

function findLogEntryForDate_(employeeId, type, date) {
  var sheet = getSheet_('AttendanceLog');
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idCol = headers.indexOf('EmployeeID');
  var tsCol = headers.indexOf('Timestamp');
  var typeCol = headers.indexOf('Type');
  var shiftCol = headers.indexOf('Shift');

  var found = null;
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idCol]) !== String(employeeId)) continue;
    if (values[i][typeCol] !== type) continue;
    var ts = new Date(values[i][tsCol]);
    if (!isSameDay_(ts, date)) continue;
    if (!found || ts > found.timestamp) {
      found = { timestamp: ts, shift: shiftCol !== -1 ? String(values[i][shiftCol] || '') : '' };
    }
  }
  return found;
}

/**
 * Admin backfill for a missed IN or OUT (e.g. someone forgot to tap the
 * kiosk). Computes Shift/Late (IN) or Duration/OT (OUT) the exact same way a
 * live Kiosk check-in would, then appends the row. Skips the duplicate-guard
 * from recordAttendance_ -- that guard exists to catch accidental rapid
 * double-taps in real time, which isn't relevant to a deliberate historical
 * entry -- and searches the full log rather than the recent window, since the
 * day being backfilled could be from any point in the past.
 *
 * `precomputedShift`, if passed (a string, possibly ''), is used instead of
 * calling getScheduledShift_ -- that helper re-reads the whole Schedule
 * sheet on every call, fine for this function's normal single-call use (see
 * menuAddBackdatedAttendance_) but not when a caller is looping over many
 * employees at once (see menuBulkMarkAttendance_, which already has each
 * employee's shift from a single batch read). Omit it (undefined) to keep
 * the old single-lookup behavior.
 */
function recordBackdatedAttendance_(employeeId, type, timestamp, ot, precomputedShift) {
  var found = findEmployeeRow_(employeeId);
  if (!found) throw new Error('Employee not found: ' + employeeId);
  var emp = found.row;

  var shiftForRow = '';
  var late = '';
  var durationMinutes = '';
  var otForRow = '';
  var otMinutesForRow = '';
  var otQuartersForRow = '';
  var recordedTimestamp = timestamp; // overridden below for "Event" shifts -- see eventShiftOverrideTimestamp_. Not reassigning the `timestamp` param itself so callers' own logging of what was typed stays accurate.

  if (type === 'IN') {
    var scheduledShift = precomputedShift !== undefined ? precomputedShift : getScheduledShift_(employeeId, timestamp);
    if (scheduledShift) {
      shiftForRow = scheduledShift;
      recordedTimestamp = eventShiftOverrideTimestamp_(scheduledShift, timestamp, 'IN');
      late = isLate_(scheduledShift, recordedTimestamp);
    }
  } else {
    var matchingIn = findLogEntryForDate_(employeeId, 'IN', timestamp);
    var todayShift = matchingIn ? matchingIn.shift : '';
    recordedTimestamp = eventShiftOverrideTimestamp_(todayShift, timestamp, 'OUT');
    if (matchingIn) {
      durationMinutes = Math.round((recordedTimestamp.getTime() - matchingIn.timestamp.getTime()) / 60000);
    }

    var todayOtEligible = isOtEligible_(emp);
    if (emp.Department === 'Japanese') {
      var capMinutes = Number(emp.OTMaxMinutes) || JP_OT_CAP_MINUTES;
      otMinutesForRow = (todayOtEligible && todayShift) ? computeJapaneseOtMinutes_(todayShift, recordedTimestamp, capMinutes) : 0;
      otForRow = otMinutesForRow > 0;
    } else {
      otQuartersForRow = (todayOtEligible && ot && todayShift) ? computeThaiOtQuarters_(todayShift, recordedTimestamp) : 0;
      otForRow = otQuartersForRow > 0;
    }
  }

  appendRow_('AttendanceLog', {
    Timestamp: recordedTimestamp,
    EmployeeID: emp.EmployeeID,
    Name: emp.Name,
    Department: emp.Department,
    Type: type,
    Method: 'AdminBackdated',
    RawScanValue: '',
    DurationMinutes: durationMinutes,
    Shift: shiftForRow,
    Late: late,
    OT: otForRow,
    OTMinutes: otMinutesForRow,
    OTQuarters: otQuartersForRow
  });

  return {
    name: emp.Name,
    department: emp.Department,
    shift: shiftForRow,
    late: late,
    durationMinutes: durationMinutes,
    otMinutes: otMinutesForRow,
    otQuarters: otQuartersForRow
  };
}

/** Finds an AttendanceLog row by its client-generated ClientId (full-sheet search). Returns { timestamp } or null. */
function findLogEntryByClientId_(clientId) {
  var sheet = getSheet_('AttendanceLog');
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var clientIdCol = headers.indexOf('ClientId');
  if (clientIdCol === -1) return null;
  var tsCol = headers.indexOf('Timestamp');

  for (var i = 1; i < values.length; i++) {
    if (String(values[i][clientIdCol]) === String(clientId)) {
      return { timestamp: new Date(values[i][tsCol]) };
    }
  }
  return null;
}

/**
 * Records a kiosk check-in/out that happened while the tablet was offline,
 * using the ORIGINAL timestamp captured on the device at the moment of the
 * tap (not the time the sync request eventually reaches the server) --
 * Shift/Late/Duration/OT are computed the same way a live check-in would,
 * just backdated to that real moment.
 *
 * Idempotent by clientId: the app generates one id per queued attempt and
 * keeps retrying the same id until the server confirms it, so a sync that
 * "succeeded but the response got lost" and gets retried never creates a
 * second row -- this function just returns the already-recorded result
 * instead of writing again.
 */
function recordOfflineSyncedAttendance_(employeeId, type, timestamp, ot, clientId, punchBranch, shift) {
  // Unconditional (unlike recordAttendance_'s conditional check against
  // log.headers -- that one's on the tight-timeout live path, this one
  // isn't) -- ClientId already needed this same unconditional call before
  // PunchBranch/ShiftPicked existed, so no extra cost is introduced by
  // adding them here too. Must run before
  // findLogEntryByClientId_/getRecentAttendanceLog_ below, since
  // appendRow_ further down (no explicit headers arg) re-reads the header
  // row fresh at write time, but findLogEntryByClientId_ needs the
  // ClientId column to already exist to find anything by it.
  ensureColumns_('AttendanceLog', ['ClientId', 'PunchBranch', 'ShiftPicked']);

  var existing = findLogEntryByClientId_(clientId);
  if (existing) {
    var found = findEmployeeRow_(employeeId);
    return { alreadySynced: true, name: found ? found.row.Name : employeeId };
  }

  var found = findEmployeeRow_(employeeId);
  if (!found) throw new Error('Employee not found: ' + employeeId);
  var emp = found.row;

  // Same 60s duplicate guard as the online path (recordAttendance_). The
  // offline queue itself has no such protection (enqueueCheckin never blocks
  // a second accidental tap), so without this, two queued taps a few seconds
  // apart -- e.g. someone unsure the first one registered, since offline
  // mode shows no instant Late/OT confirmation -- both land as real rows
  // once synced. Compared against the queued tap's own timestamp, not
  // "now" (which is meaningless here, sync can happen minutes later).
  // ignoreTypes: a Break row must never block a genuine IN/OUT tap just by
  // having happened moments earlier -- see isWithinDuplicateGuard_.
  var log = getRecentAttendanceLog_();
  var lastLog = findLastLogForEmployee_(employeeId, log);
  if (isWithinDuplicateGuard_(lastLog, timestamp, { ignoreTypes: ['BREAK_START', 'BREAK_END'] })) {
    return { duplicate: true, name: emp.Name };
  }

  var punchBranchForRow = normalizePunchBranch_(punchBranch);

  var shiftForRow = '';
  var late = '';
  var durationMinutes = '';
  var otForRow = '';
  var otMinutesForRow = '';
  var otQuartersForRow = '';
  var recordedTimestamp = timestamp; // overridden below for "Event" shifts -- see eventShiftOverrideTimestamp_

  if (type === 'IN') {
    // Same picked-shift-wins-else-fall-back-to-schedule rule as the live
    // path (recordAttendance_) -- see the comment there. Written back to
    // the Schedule sheet dated by `timestamp` (the real moment the tap
    // happened on the device, per this function's own doc comment), not
    // whenever the sync request happens to reach the server.
    var pickedShift = normalizeShiftChoice_(emp, shift);
    var scheduledShift = pickedShift || getScheduledShift_(employeeId, timestamp);
    if (scheduledShift) {
      shiftForRow = scheduledShift;
      recordedTimestamp = eventShiftOverrideTimestamp_(scheduledShift, timestamp, 'IN');
      late = isLate_(scheduledShift, recordedTimestamp);
      // The actual Schedule-sheet write (writeScheduleShiftCell_) happens
      // AFTER appendRow_ below, not here -- see the comment there for why.
    }
  } else {
    var matchingIn = findLogEntryForDate_(employeeId, 'IN', timestamp);
    var todayShift = matchingIn ? matchingIn.shift : '';
    recordedTimestamp = eventShiftOverrideTimestamp_(todayShift, timestamp, 'OUT');
    if (matchingIn) {
      durationMinutes = Math.round((recordedTimestamp.getTime() - matchingIn.timestamp.getTime()) / 60000);
    }

    var todayOtEligible = isOtEligible_(emp);
    if (emp.Department === 'Japanese') {
      var capMinutes = Number(emp.OTMaxMinutes) || JP_OT_CAP_MINUTES;
      otMinutesForRow = (todayOtEligible && todayShift) ? computeJapaneseOtMinutes_(todayShift, recordedTimestamp, capMinutes) : 0;
      otForRow = otMinutesForRow > 0;
    } else {
      otQuartersForRow = (todayOtEligible && ot && todayShift) ? computeThaiOtQuarters_(todayShift, recordedTimestamp) : 0;
      otForRow = otQuartersForRow > 0;
    }
  }

  appendRow_('AttendanceLog', {
    Timestamp: recordedTimestamp,
    EmployeeID: emp.EmployeeID,
    Name: emp.Name,
    Department: emp.Department,
    Type: type,
    Method: 'KioskOfflineSync',
    RawScanValue: '',
    ClientId: clientId,
    DurationMinutes: durationMinutes,
    Shift: shiftForRow,
    Late: late,
    OT: otForRow,
    OTMinutes: otMinutesForRow,
    OTQuarters: otQuartersForRow,
    PunchBranch: punchBranchForRow,
    // True only for an IN row whose Shift came from the employee's own
    // Kiosk pick (pickedShift, set above) -- recomputeLateAndOt_ reads this
    // to know it must never overwrite this row's Shift/Late from the
    // Schedule sheet; it's already correct by definition, and the whole
    // point of this feature is the Schedule sheet catches up to THIS
    // value (see writeScheduleShiftCell_), not the other way around.
    ShiftPicked: !!pickedShift
  });

  // Deliberately AFTER the AttendanceLog append above, not before: that's
  // the real record of the check-in, and it must exist unconditionally
  // regardless of whether this best-effort side effect succeeds. Writing
  // the Schedule sheet first (as an earlier version of this code did)
  // could leave the Schedule sheet showing a picked shift with no
  // AttendanceLog row and no ShiftPicked flag to back it up, if appendRow_
  // itself then failed -- a half-committed state that's structurally
  // impossible with this ordering, since a thrown appendRow_ here means
  // this line is simply never reached. try/catch, not a bare call -- see
  // writeScheduleShiftCell_'s doc comment: a failure here must never be
  // treated as the check-in having failed, since by this point it hasn't.
  // Logger.log so a failure at least leaves SOME trace (View > Logs)
  // instead of vanishing completely -- nothing reads this automatically,
  // but it's the only record if an admin ever goes looking for why a
  // Schedule cell doesn't match what was picked.
  if (pickedShift) {
    try { writeScheduleShiftCell_(employeeId, timestamp, pickedShift); } catch (e) {
      Logger.log('writeScheduleShiftCell_ failed for ' + employeeId + ' on ' + timestamp + ': ' + e);
    }
  }

  return {
    alreadySynced: false,
    name: emp.Name,
    department: emp.Department,
    shift: shiftForRow,
    late: late,
    durationMinutes: durationMinutes,
    otMinutes: otMinutesForRow,
    otQuarters: otQuartersForRow
  };
}

/**
 * Break counterpart to recordOfflineSyncedAttendance_ -- same ClientId
 * dedupe/idempotency, but validated with currentShiftBreakState_ (must be
 * clocked in, not already clocked out, alternating BREAK_START/BREAK_END)
 * using the queued tap's own timestamp rather than "now", same reasoning as
 * recordOfflineSyncedAttendance_'s backdated Shift/Late/OT computation.
 * Returns { error, message } instead of throwing/fail_ directly so the
 * caller (handleKioskSyncOffline_) can turn it into the same fail_() shape
 * it already uses for the IN/OUT path.
 */
function recordOfflineSyncedBreak_(employeeId, type, timestamp, clientId, durationMinutes) {
  ensureColumns_('AttendanceLog', ['ClientId', 'PunchBranch', 'ShiftPicked', 'BreakPlannedMinutes']);

  var existing = findLogEntryByClientId_(clientId);
  if (existing) {
    var foundForName = findEmployeeRow_(employeeId);
    return { alreadySynced: true, name: foundForName ? foundForName.row.Name : employeeId };
  }

  var found = findEmployeeRow_(employeeId);
  if (!found) throw new Error('Employee not found: ' + employeeId);
  var emp = found.row;

  var log = getRecentAttendanceLog_();
  var state = currentShiftBreakState_(employeeId, timestamp, log);
  if (!state.todayIn) return { error: 'not_clocked_in', message: 'Not clocked in yet today' };
  if (!state.onShift) return { error: 'already_clocked_out', message: 'Already clocked out today' };
  if (type === 'BREAK_START' && state.onBreak) return { error: 'already_on_break', message: 'Already on break' };
  if (type === 'BREAK_END' && !state.onBreak) return { error: 'not_on_break', message: 'Not currently on break' };

  var lastLog = findLastLogForEmployee_(employeeId, log);
  if (isWithinDuplicateGuard_(lastLog, timestamp, { sameTypeOnly: true, type: type })) {
    return { duplicate: true, name: emp.Name };
  }

  // Same "computed from the pre-append log snapshot" reasoning as
  // recordBreak_'s own remainingMinutes -- see its comment.
  var remainingMinutes, totalMinutesUsedToday;
  if (type === 'BREAK_END') {
    var priorMinutes = sumCompletedBreakMinutesToday_(employeeId, startOfDay_(timestamp), timestamp, log);
    var thisSessionMinutes = Math.round((timestamp.getTime() - state.lastBreakTs.getTime()) / 60000);
    totalMinutesUsedToday = priorMinutes + thisSessionMinutes;
    remainingMinutes = Math.max(0, DAILY_BREAK_BUDGET_MINUTES - totalMinutesUsedToday);
  }

  appendRow_('AttendanceLog', {
    Timestamp: timestamp,
    EmployeeID: emp.EmployeeID,
    Name: emp.Name,
    Department: emp.Department,
    Type: type,
    Method: 'KioskOfflineSync',
    RawScanValue: '',
    ClientId: clientId,
    BreakPlannedMinutes: type === 'BREAK_START' ? durationMinutes : ''
  });

  return {
    alreadySynced: false, type: type, timestamp: timestamp.toISOString(), name: emp.Name,
    durationMinutes: type === 'BREAK_START' ? durationMinutes : undefined,
    remainingMinutes: remainingMinutes,
    totalMinutesUsedToday: totalMinutesUsedToday
  };
}

function recordAttendance_(employeeId, method, rawScanValue, type, ot, punchBranch, shift, specialShiftSpansNextDay) {
  var found = findEmployeeRow_(employeeId);
  if (!found) return fail_('not_found', 'Employee not found');
  var emp = found.row;
  if (emp.Active !== true && emp.Active !== 'TRUE') {
    return fail_('inactive', 'Employee is not active');
  }

  var log = getRecentAttendanceLog_(); // one bounded read, shared below, instead of re-scanning the whole sheet twice
  // getRecentAttendanceLog_ already reads the header row -- check that
  // instead of unconditionally calling ensureColumns_ on every single live
  // check-in (this path is latency-sensitive, see KIOSK_TIMEOUT_MS). Only
  // pays for the extra write the first time this sheet has ever seen a
  // PunchBranch/ShiftPicked value; after that it's a free array scan on
  // data already fetched. appendHeaders (not log.headers -- see below) is
  // what appendRow_ further down actually gets.
  var appendHeaders = log.headers;
  if (log.headers.indexOf('PunchBranch') === -1 || log.headers.indexOf('ShiftPicked') === -1) {
    ensureColumns_('AttendanceLog', ['PunchBranch', 'ShiftPicked']);
    // Deliberately NOT log.headers.push(...) -- log.rows was already read
    // with the OLD column count, so every row is one shorter than headers
    // would then claim; appendHeaders = null instead, so appendRow_ falls
    // back to its own fresh header read for this one call.
    appendHeaders = null;
  }

  var lastLog = findLastLogForEmployee_(employeeId, log);
  var now = new Date();

  // ignoreTypes: a Break row must never block a genuine IN/OUT tap just by
  // having happened moments earlier -- see isWithinDuplicateGuard_.
  if (isWithinDuplicateGuard_(lastLog, now, { ignoreTypes: ['BREAK_START', 'BREAK_END'] })) {
    return fail_('duplicate', 'Already recorded, please wait a moment before scanning again');
  }

  var punchBranchForRow = normalizePunchBranch_(punchBranch);

  var shiftForRow = '';
  var late = '';
  var durationMinutes = '';
  var otForRow = '';
  var otMinutesForRow = '';
  var otQuartersForRow = '';
  var recordedTimestamp = now; // overridden below for "Event" shifts -- see eventShiftOverrideTimestamp_
  var writtenShift; // pickedShift or specialShift -- whatever the employee's own IN pick was, if anything (see the ShiftPicked column / Schedule-sheet write below)

  if (type === 'IN') {
    // The employee's own pick, validated against their shiftChoicesFor_,
    // wins when present; falls back to the admin-filled monthly schedule
    // otherwise -- an older app build that never sends `shift`, or one
    // that sent something invalid, behaves exactly as before this feature
    // existed.
    var pickedShift = normalizeShiftChoice_(emp, shift);
    // A well-formed "Special H:MM-H:MM" submission is never on the
    // employee's own approved list (normalizeShiftChoice_ always rejects
    // it, by design -- see isValidSpecialShiftSubmission_), so it's only
    // even considered once pickedShift has already come back empty.
    var specialShift = (!pickedShift && isValidSpecialShiftSubmission_(shift)) ? String(shift).trim() : '';
    var scheduledShift = pickedShift || specialShift || getScheduledShift_(employeeId, now);
    writtenShift = pickedShift || specialShift;
    if (scheduledShift) {
      shiftForRow = scheduledShift;
      if (specialShift) {
        // Special Shift: keeps the REAL tap time always (unlike Event,
        // never forced to the shift's own official start) -- Late/OT are
        // simply never computed on top of that real time. See isSpecialShift_.
        recordedTimestamp = now;
        late = false;
      } else {
        recordedTimestamp = eventShiftOverrideTimestamp_(scheduledShift, now, 'IN');
        late = isLate_(scheduledShift, recordedTimestamp);
      }
      // The actual Schedule-sheet write (writeScheduleShiftCell_) happens
      // AFTER appendRow_ below, not here -- see the comment there for why.
    }
  } else {
    var todayIn = findTodayInLog_(employeeId, now, log);
    var todayShift = todayIn ? todayIn.shift : '';
    recordedTimestamp = eventShiftOverrideTimestamp_(todayShift, now, 'OUT');
    if (todayIn) {
      durationMinutes = Math.round((recordedTimestamp.getTime() - todayIn.timestamp.getTime()) / 60000);
    }

    // Event's OT-skip normally falls out for free here, via
    // eventShiftOverrideTimestamp_ above forcing recordedTimestamp to the
    // shift's own exact end time (minutesPastShiftEnd_ = 0). Special
    // deliberately does NOT force the timestamp (real OUT time always), so
    // for a same-day Special Shift a genuinely late real OUT tap would
    // otherwise compute real positive OT -- isNoLateNoOtShift_ guards that
    // explicitly. (An overnight Special Shift never reaches here with a
    // truthy todayShift at all, since todayIn/todayShift only ever resolve
    // for an IN on the OUT's own calendar day -- see findTodayInLog_.)
    var otEligible = isOtEligible_(emp) && !isNoLateNoOtShift_(todayShift);
    if (emp.Department === 'Japanese') {
      // OUT and OUT OT are equivalent for Japanese -- always auto-computed.
      var capMinutes = Number(emp.OTMaxMinutes) || JP_OT_CAP_MINUTES;
      otMinutesForRow = (otEligible && todayShift) ? computeJapaneseOtMinutes_(todayShift, recordedTimestamp, capMinutes) : 0;
      otForRow = otMinutesForRow > 0;
    } else {
      // Everyone else: only counts if they explicitly pressed OUT OT (a plain
      // OUT never earns OT, e.g. someone who just stayed chatting).
      otQuartersForRow = (otEligible && ot && todayShift) ? computeThaiOtQuarters_(todayShift, recordedTimestamp) : 0;
      otForRow = otQuartersForRow > 0;
    }
  }

  // Shift/Late/OT/OTMinutes/OTQuarters columns are a permanent part of the
  // AttendanceLog schema at this point, so no need to check for them on every
  // single check-in/out (that's one more Sheets read on the hottest path).
  appendRow_('AttendanceLog', {
    Timestamp: recordedTimestamp,
    EmployeeID: emp.EmployeeID,
    Name: emp.Name,
    Department: emp.Department,
    Type: type,
    Method: method,
    RawScanValue: rawScanValue,
    DurationMinutes: durationMinutes,
    Shift: shiftForRow,
    Late: late,
    OT: otForRow,
    OTMinutes: otMinutesForRow,
    OTQuarters: otQuartersForRow,
    PunchBranch: punchBranchForRow,
    ShiftPicked: !!writtenShift // see the identical field in recordOfflineSyncedAttendance_ for why -- true for a Special submission too, same as a normal pick: it's the employee's own IN-time choice, not the admin schedule
  }, appendHeaders);

  // Deliberately AFTER the AttendanceLog append above, not before -- see
  // the identical ordering (and the full reasoning) in
  // recordOfflineSyncedAttendance_.
  if (writtenShift) {
    try { writeScheduleShiftCell_(employeeId, now, writtenShift); } catch (e) {
      Logger.log('writeScheduleShiftCell_ failed for ' + employeeId + ' on ' + now + ': ' + e);
    }
    // Overnight Special Shift (e.g. 12:00 today -> 11:00 tomorrow): also
    // write tomorrow's Schedule cell with the same string, so whichever day
    // the real OUT tap (or lack of one) lands on, that day's own
    // handleDashboardDaily_/buildMyAttendanceDays_ classification already
    // sees "Special ..." rather than a blank cell that would otherwise read
    // as an ordinary, un-punched workday (Absent). A separate try/catch so a
    // failure writing one day never blocks the other.
    if (specialShift && specialShiftSpansNextDay) {
      var nextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      try { writeScheduleShiftCell_(employeeId, nextDay, writtenShift); } catch (e) {
        Logger.log('writeScheduleShiftCell_ (next day) failed for ' + employeeId + ' on ' + nextDay + ': ' + e);
      }
    }
  }

  return ok_({
    type: type,
    timestamp: now.toISOString(),
    name: emp.Name,
    durationMinutes: durationMinutes,
    shift: shiftForRow || undefined,
    late: type === 'IN' ? !!late : undefined,
    ot: type === 'OUT' ? !!otForRow : undefined,
    otMinutes: type === 'OUT' && otMinutesForRow !== '' ? otMinutesForRow : undefined,
    otQuarters: type === 'OUT' && otQuartersForRow !== '' ? otQuartersForRow : undefined
  });
}

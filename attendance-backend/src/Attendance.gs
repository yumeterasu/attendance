/**
 * Check-in/out logic: explicit IN/OUT type from the Kiosk, duplicate-scan guard.
 */

var DUPLICATE_GUARD_MS = 60 * 1000; // reject re-scans within 60s of the last log for the same employee
var SHIFTS = ['7:00-16:00', '7:30-16:30', '8:00-17:00', '8:30-17:30', 'Event 8:00-17:00', 'Annual Leave', 'Sick Leave', 'Unpaid Leave', 'Paid Special Leave', 'Half Day Annual Leave', 'Half Day Sick Leave', 'Holiday'];
// Shift values that mean "nobody's expected in at all that day" -- as
// opposed to a blank cell (not scheduled yet) or "Half Day Annual
// Leave"/"Half Day Sick Leave" (still expected in for half the day). Used
// wherever a scheduled-but-not-working day should be excluded from an
// absence/attendance check: "Annual Leave", "Sick Leave", "Unpaid Leave"
// and "Paid Special Leave" are one person's own day off (paid or not
// doesn't matter here, just whether they're expected in), "Holiday" is the
// whole company closed.
var FULL_DAY_OFF_SHIFTS = ['Annual Leave', 'Sick Leave', 'Unpaid Leave', 'Paid Special Leave', 'Holiday'];
var BRANCHES = ['PP', 'TL']; // Phrom Phong, Thonglor -- Schedule sheet row order: this branch order first, then Japanese before Thai within each branch
var OT_GRACE_MINUTES = 15; // first 15 min after shift end never counts as OT, for either group
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

/** Minutes actually worked past shift end, or null if the shift/event string has no end time. */
function minutesPastShiftEnd_(shiftOrEvent, outTimestamp) {
  var end = getShiftEndTime_(shiftOrEvent);
  if (!end) return null;
  var shiftEnd = new Date(outTimestamp.getFullYear(), outTimestamp.getMonth(), outTimestamp.getDate(), end.hour, end.minute, 0);
  return Math.round((outTimestamp.getTime() - shiftEnd.getTime()) / 60000);
}

/**
 * Japanese OT, in minutes: always auto-computed from actual clock-out vs the
 * day's shift end, regardless of which kiosk button was pressed (OUT and
 * OUT OT are equivalent for this group). First 15 min free, capped at
 * capMinutes (defaults to JP_OT_CAP_MINUTES if not given/blank -- see
 * Employees.OTMaxMinutes for the per-employee override).
 */
function computeJapaneseOtMinutes_(shiftOrEvent, outTimestamp, capMinutes) {
  var pastEnd = minutesPastShiftEnd_(shiftOrEvent, outTimestamp);
  if (pastEnd === null || pastEnd <= OT_GRACE_MINUTES) return 0;
  var cap = capMinutes || JP_OT_CAP_MINUTES;
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
 * even if they happened to leave late (e.g. just stayed chatting). Rounds UP
 * to the next quarter as soon as they step into it -- e.g. shift ends 17:00,
 * grace to 17:15: clocking out anytime 17:16-17:30 earns 1 quarter (not just
 * exactly at 17:30), 17:31-17:45 earns 2, and so on. Only staying through
 * the grace period itself (up to and including 17:15) earns 0.
 */
function computeThaiOtQuarters_(shiftOrEvent, outTimestamp) {
  var pastEnd = minutesPastShiftEnd_(shiftOrEvent, outTimestamp);
  if (pastEnd === null) return 0;
  var pastGrace = pastEnd - OT_GRACE_MINUTES;
  if (pastGrace <= 0) return 0;
  return Math.ceil(pastGrace / OT_QUARTER_MINUTES);
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

  return recordAttendance_(found.row.EmployeeID, 'KioskPIN', params.pin, params.type, params.ot === 'true');
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

  return ok_({ name: found.row.Name });
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
    .map(function (emp) { return { pin: pad4_(emp.KioskPIN), name: emp.Name }; });

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
  if (params.type !== 'IN' && params.type !== 'OUT') return fail_('bad_request', 'type must be IN or OUT');
  if (!params.clientId) return fail_('bad_request', 'clientId is required');
  if (!params.timestamp) return fail_('bad_request', 'timestamp is required');

  var found = findEmployeeByKioskPin_(params.pin);
  if (!found) return fail_('not_found', 'Code not recognized');
  if (found.row.Active !== true && found.row.Active !== 'TRUE') {
    return fail_('inactive', 'Employee is not active');
  }

  var timestamp = new Date(params.timestamp);
  if (isNaN(timestamp.getTime())) return fail_('bad_request', 'timestamp did not parse');

  var result = recordOfflineSyncedAttendance_(
    found.row.EmployeeID, params.type, timestamp, params.ot === 'true', params.clientId
  );
  return ok_(result);
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

  var daysInMonth = new Date(year, month, 0).getDate();
  var dayLogs = (getRecentMonthLogsByEmployee_(year, month))[found.row.EmployeeID] || {};
  // Only consulted for days with no actual punch -- lets a day scheduled as
  // "Leave"/"Holiday"/anything else non-time-based show that label instead
  // of sitting blank. No hardcoded list of which labels count: whatever's
  // typed into the Schedule sheet for that day is shown verbatim as long as
  // it doesn't look like a real shift's clock time, so a brand new option
  // (e.g. "Sick Leave") works here the moment it's added to the Shift
  // dropdown -- nothing in this function needs to change for it.
  var scheduledShiftsForMonth = (getScheduledShiftsForMonth_(year, month))[found.row.EmployeeID] || {};

  var days = [];
  for (var d = 1; d <= daysInMonth; d++) {
    var entry = dayLogs[d];
    if (entry) {
      days.push({
        day: d,
        date: Utilities.formatDate(new Date(year, month - 1, d), tz, 'yyyy-MM-dd'),
        timeIn: entry.timeIn ? Utilities.formatDate(entry.timeIn, tz, 'HH:mm') : '',
        timeOut: entry.timeOut ? Utilities.formatDate(entry.timeOut, tz, 'HH:mm') : '',
        shift: entry.shift || '',
        note: '',
        late: !!entry.late,
        ot: !!(entry.otMinutes || entry.otQuarters)
      });
      continue;
    }

    var scheduled = scheduledShiftsForMonth[d];
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

  return ok_({ name: found.row.Name, year: year, month: month, days: days });
}

/**
 * One-off repair: recomputes Shift + Late (from the current Schedule sheet)
 * for every IN row, and OTMinutes for every Japanese OUT row, within
 * [startDay, endDay] of the given month. Fixes rows recorded when the
 * Schedule cell was still blank at check-in time -- Late/Shift/OT get frozen
 * in then and are never re-checked automatically.
 *
 * "Japanese" is decided from each employee's *current* Employees sheet
 * Department, not the Department value frozen onto the old row -- old rows
 * can carry a stale label (e.g. "Japanese Staff" from before Department was
 * standardized to just "Japanese"/"Thai") that would otherwise make this
 * silently skip them even after the employee record itself is fixed.
 *
 * Thai/non-Japanese OTQuarters is intentionally left untouched: unlike
 * Japanese OT (always auto-computed regardless of button), Thai OT only
 * counts if the employee pressed "OUT OT" specifically, and AttendanceLog
 * doesn't keep that raw button choice separate from the already-computed
 * OTQuarters value -- a blank Schedule and "pressed plain OUT" both look
 * identical (OTQuarters=0) after the fact, so there's no reliable way to
 * recompute it correctly after the fact.
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
  var inRowsUpdated = 0;
  var outRowsUpdated = 0;

  for (var i = 0; i < sliceValues.length; i++) {
    var ts = new Date(sliceValues[i][tsCol]);
    if (ts.getFullYear() !== year || ts.getMonth() + 1 !== month) continue;
    var day = ts.getDate();
    if (day < startDay || day > endDay) continue;
    if (sliceValues[i][typeCol] !== 'IN') continue;

    var employeeId = String(sliceValues[i][idCol]);
    var scheduledShift = (shiftsForMonth[employeeId] && shiftsForMonth[employeeId][day]) || '';
    var late = scheduledShift ? isLate_(scheduledShift, ts) : false;

    sliceValues[i][shiftCol] = scheduledShift;
    sliceValues[i][lateCol] = late;
    shiftByEmployeeDay[employeeId + '|' + day] = scheduledShift;
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
    var currentDept = currentEmp ? currentEmp.row.Department : null;
    if (currentDept !== 'Japanese') continue; // Thai/other OT can't be safely recomputed, see doc comment above

    var key = employeeId2 + '|' + day2;
    var shift = shiftByEmployeeDay.hasOwnProperty(key) ? shiftByEmployeeDay[key] : (shiftsForMonth[employeeId2] && shiftsForMonth[employeeId2][day2]) || '';
    var capMinutes = Number(currentEmp.row.OTMaxMinutes) || JP_OT_CAP_MINUTES;

    var otMinutes = (isOtEligible_(currentEmp.row) && shift) ? computeJapaneseOtMinutes_(shift, ts2, capMinutes) : 0;
    sliceValues[j][otMinCol] = otMinutes;
    sliceValues[j][otCol] = otMinutes > 0;
    outRowsUpdated++;
  }

  if (inRowsUpdated > 0 || outRowsUpdated > 0) {
    var numRows = sliceValues.length;
    sheet.getRange(minRow, shiftCol + 1, numRows, 1).setValues(sliceValues.map(function (r) { return [r[shiftCol]]; }));
    sheet.getRange(minRow, lateCol + 1, numRows, 1).setValues(sliceValues.map(function (r) { return [r[lateCol]]; }));
    sheet.getRange(minRow, otCol + 1, numRows, 1).setValues(sliceValues.map(function (r) { return [r[otCol]]; }));
    sheet.getRange(minRow, otMinCol + 1, numRows, 1).setValues(sliceValues.map(function (r) { return [r[otMinCol]]; }));
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
    result.outRowsUpdated + ' OUT row(s) (Japanese OT).'
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

  if (type === 'IN') {
    var scheduledShift = precomputedShift !== undefined ? precomputedShift : getScheduledShift_(employeeId, timestamp);
    if (scheduledShift) {
      shiftForRow = scheduledShift;
      late = isLate_(scheduledShift, timestamp);
    }
  } else {
    var matchingIn = findLogEntryForDate_(employeeId, 'IN', timestamp);
    if (matchingIn) {
      durationMinutes = Math.round((timestamp.getTime() - matchingIn.timestamp.getTime()) / 60000);
    }

    var todayShift = matchingIn ? matchingIn.shift : '';
    var todayOtEligible = isOtEligible_(emp);
    if (emp.Department === 'Japanese') {
      var capMinutes = Number(emp.OTMaxMinutes) || JP_OT_CAP_MINUTES;
      otMinutesForRow = (todayOtEligible && todayShift) ? computeJapaneseOtMinutes_(todayShift, timestamp, capMinutes) : 0;
      otForRow = otMinutesForRow > 0;
    } else {
      otQuartersForRow = (todayOtEligible && ot && todayShift) ? computeThaiOtQuarters_(todayShift, timestamp) : 0;
      otForRow = otQuartersForRow > 0;
    }
  }

  appendRow_('AttendanceLog', {
    Timestamp: timestamp,
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
function recordOfflineSyncedAttendance_(employeeId, type, timestamp, ot, clientId) {
  ensureColumns_('AttendanceLog', ['ClientId']);

  var existing = findLogEntryByClientId_(clientId);
  if (existing) {
    var found = findEmployeeRow_(employeeId);
    return { alreadySynced: true, name: found ? found.row.Name : employeeId };
  }

  var found = findEmployeeRow_(employeeId);
  if (!found) throw new Error('Employee not found: ' + employeeId);
  var emp = found.row;

  var shiftForRow = '';
  var late = '';
  var durationMinutes = '';
  var otForRow = '';
  var otMinutesForRow = '';
  var otQuartersForRow = '';

  if (type === 'IN') {
    var scheduledShift = getScheduledShift_(employeeId, timestamp);
    if (scheduledShift) {
      shiftForRow = scheduledShift;
      late = isLate_(scheduledShift, timestamp);
    }
  } else {
    var matchingIn = findLogEntryForDate_(employeeId, 'IN', timestamp);
    if (matchingIn) {
      durationMinutes = Math.round((timestamp.getTime() - matchingIn.timestamp.getTime()) / 60000);
    }

    var todayShift = matchingIn ? matchingIn.shift : '';
    var todayOtEligible = isOtEligible_(emp);
    if (emp.Department === 'Japanese') {
      var capMinutes = Number(emp.OTMaxMinutes) || JP_OT_CAP_MINUTES;
      otMinutesForRow = (todayOtEligible && todayShift) ? computeJapaneseOtMinutes_(todayShift, timestamp, capMinutes) : 0;
      otForRow = otMinutesForRow > 0;
    } else {
      otQuartersForRow = (todayOtEligible && ot && todayShift) ? computeThaiOtQuarters_(todayShift, timestamp) : 0;
      otForRow = otQuartersForRow > 0;
    }
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
    DurationMinutes: durationMinutes,
    Shift: shiftForRow,
    Late: late,
    OT: otForRow,
    OTMinutes: otMinutesForRow,
    OTQuarters: otQuartersForRow
  });

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

function recordAttendance_(employeeId, method, rawScanValue, type, ot) {
  var found = findEmployeeRow_(employeeId);
  if (!found) return fail_('not_found', 'Employee not found');
  var emp = found.row;
  if (emp.Active !== true && emp.Active !== 'TRUE') {
    return fail_('inactive', 'Employee is not active');
  }

  var log = getRecentAttendanceLog_(); // one bounded read, shared below, instead of re-scanning the whole sheet twice
  var lastLog = findLastLogForEmployee_(employeeId, log);
  var now = new Date();
  var lastTimestamp = lastLog && lastLog.Timestamp ? new Date(lastLog.Timestamp) : null;

  if (lastTimestamp && now.getTime() - lastTimestamp.getTime() < DUPLICATE_GUARD_MS) {
    return fail_('duplicate', 'Already recorded, please wait a moment before scanning again');
  }

  var shiftForRow = '';
  var late = '';
  var durationMinutes = '';
  var otForRow = '';
  var otMinutesForRow = '';
  var otQuartersForRow = '';

  if (type === 'IN') {
    // Shift comes from the admin-filled monthly schedule, not from the employee.
    var scheduledShift = getScheduledShift_(employeeId, now);
    if (scheduledShift) {
      shiftForRow = scheduledShift;
      late = isLate_(scheduledShift, now);
    }
  } else {
    var todayIn = findTodayInLog_(employeeId, now, log);
    if (todayIn) {
      durationMinutes = Math.round((now.getTime() - todayIn.timestamp.getTime()) / 60000);
    }

    var todayShift = todayIn ? todayIn.shift : '';
    var otEligible = isOtEligible_(emp);
    if (emp.Department === 'Japanese') {
      // OUT and OUT OT are equivalent for Japanese -- always auto-computed.
      var capMinutes = Number(emp.OTMaxMinutes) || JP_OT_CAP_MINUTES;
      otMinutesForRow = (otEligible && todayShift) ? computeJapaneseOtMinutes_(todayShift, now, capMinutes) : 0;
      otForRow = otMinutesForRow > 0;
    } else {
      // Everyone else: only counts if they explicitly pressed OUT OT (a plain
      // OUT never earns OT, e.g. someone who just stayed chatting).
      otQuartersForRow = (otEligible && ot && todayShift) ? computeThaiOtQuarters_(todayShift, now) : 0;
      otForRow = otQuartersForRow > 0;
    }
  }

  // Shift/Late/OT/OTMinutes/OTQuarters columns are a permanent part of the
  // AttendanceLog schema at this point, so no need to check for them on every
  // single check-in/out (that's one more Sheets read on the hottest path).
  appendRow_('AttendanceLog', {
    Timestamp: now,
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
    OTQuarters: otQuartersForRow
  }, log.headers);

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

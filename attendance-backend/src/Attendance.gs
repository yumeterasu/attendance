/**
 * Check-in/out logic: explicit IN/OUT type from the Kiosk, duplicate-scan guard.
 */

var DUPLICATE_GUARD_MS = 60 * 1000; // reject re-scans within 60s of the last log for the same employee
var SHIFTS = ['7:00-16:00', '7:30-16:30', '8:00-17:00', '8:30-17:30', 'Event 8:00-17:00'];
var OT_GRACE_MINUTES = 15; // first 15 min after shift end never counts as OT, for either group
var JP_OT_CAP_MINUTES = 75; // default Japanese OT cap, in minutes/day -- overridden per employee by Employees.OTMaxMinutes when set
var OT_QUARTER_MINUTES = 15; // Thai OT is counted in whole 15-min blocks, no cap

/**
 * True if timestamp is later than the shift/event's start time on that same
 * calendar day. No grace period. Finds the first "H:MM" anywhere in the
 * string, so both a plain shift ("7:30-16:30") and a labeled event
 * ("Sports Day 8:00-15:00") work the same way. No match -> never late.
 */
function isLate_(shiftOrEvent, timestamp) {
  var match = shiftOrEvent.match(/(\d{1,2}):(\d{2})/);
  if (!match) return false;
  var shiftStart = new Date(timestamp.getFullYear(), timestamp.getMonth(), timestamp.getDate(), Number(match[1]), Number(match[2]), 0);
  return timestamp.getTime() > shiftStart.getTime();
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
 * Thai (or any non-Japanese) OT, in 15-minute quarters, no cap. Only counted
 * when the employee explicitly pressed OUT OT -- a plain OUT never earns OT
 * even if they happened to leave late (e.g. just stayed chatting). Must
 * complete a full quarter to count it; partial quarters don't round up.
 */
function computeThaiOtQuarters_(shiftOrEvent, outTimestamp) {
  var pastEnd = minutesPastShiftEnd_(shiftOrEvent, outTimestamp);
  if (pastEnd === null) return 0;
  var pastGrace = pastEnd - OT_GRACE_MINUTES;
  if (pastGrace <= 0) return 0;
  return Math.floor(pastGrace / OT_QUARTER_MINUTES);
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
  var dayLogs = (getMonthLogsByEmployee_(year, month))[found.row.EmployeeID] || {};

  var days = [];
  for (var d = 1; d <= daysInMonth; d++) {
    var entry = dayLogs[d];
    if (!entry) continue;
    days.push({
      day: d,
      date: Utilities.formatDate(new Date(year, month - 1, d), tz, 'yyyy-MM-dd'),
      timeIn: entry.timeIn ? Utilities.formatDate(entry.timeIn, tz, 'HH:mm') : '',
      timeOut: entry.timeOut ? Utilities.formatDate(entry.timeOut, tz, 'HH:mm') : '',
      shift: entry.shift || '',
      late: !!entry.late,
      ot: !!(entry.otMinutes || entry.otQuarters)
    });
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
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var tsCol = headers.indexOf('Timestamp');
  var idCol = headers.indexOf('EmployeeID');
  var typeCol = headers.indexOf('Type');
  var shiftCol = headers.indexOf('Shift');
  var lateCol = headers.indexOf('Late');
  var otCol = headers.indexOf('OT');
  var otMinCol = headers.indexOf('OTMinutes');

  var shiftByEmployeeDay = {};
  var inRowsUpdated = 0;
  var outRowsUpdated = 0;

  for (var i = 1; i < values.length; i++) {
    var ts = new Date(values[i][tsCol]);
    if (ts.getFullYear() !== year || ts.getMonth() + 1 !== month) continue;
    var day = ts.getDate();
    if (day < startDay || day > endDay) continue;
    if (values[i][typeCol] !== 'IN') continue;

    var employeeId = String(values[i][idCol]);
    var scheduledShift = getScheduledShift_(employeeId, ts);
    var late = scheduledShift ? isLate_(scheduledShift, ts) : false;

    sheet.getRange(i + 1, shiftCol + 1).setValue(scheduledShift);
    sheet.getRange(i + 1, lateCol + 1).setValue(late);
    shiftByEmployeeDay[employeeId + '|' + day] = scheduledShift;
    inRowsUpdated++;
  }

  for (var j = 1; j < values.length; j++) {
    var ts2 = new Date(values[j][tsCol]);
    if (ts2.getFullYear() !== year || ts2.getMonth() + 1 !== month) continue;
    var day2 = ts2.getDate();
    if (day2 < startDay || day2 > endDay) continue;
    if (values[j][typeCol] !== 'OUT') continue;

    var employeeId2 = String(values[j][idCol]);
    var currentEmp = findEmployeeRow_(employeeId2);
    var currentDept = currentEmp ? currentEmp.row.Department : null;
    if (currentDept !== 'Japanese') continue; // Thai/other OT can't be safely recomputed, see doc comment above

    var key = employeeId2 + '|' + day2;
    var shift = shiftByEmployeeDay.hasOwnProperty(key) ? shiftByEmployeeDay[key] : getScheduledShift_(employeeId2, ts2);
    var capMinutes = Number(currentEmp.row.OTMaxMinutes) || JP_OT_CAP_MINUTES;

    var otMinutes = shift ? computeJapaneseOtMinutes_(shift, ts2, capMinutes) : 0;
    sheet.getRange(j + 1, otMinCol + 1).setValue(otMinutes);
    sheet.getRange(j + 1, otCol + 1).setValue(otMinutes > 0);
    outRowsUpdated++;
  }

  return { inRowsUpdated: inRowsUpdated, outRowsUpdated: outRowsUpdated };
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
    if (emp.Department === 'Japanese') {
      // OUT and OUT OT are equivalent for Japanese -- always auto-computed.
      var capMinutes = Number(emp.OTMaxMinutes) || JP_OT_CAP_MINUTES;
      otMinutesForRow = todayShift ? computeJapaneseOtMinutes_(todayShift, now, capMinutes) : 0;
      otForRow = otMinutesForRow > 0;
    } else {
      // Everyone else: only counts if they explicitly pressed OUT OT (a plain
      // OUT never earns OT, e.g. someone who just stayed chatting).
      otQuartersForRow = ot && todayShift ? computeThaiOtQuarters_(todayShift, now) : 0;
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

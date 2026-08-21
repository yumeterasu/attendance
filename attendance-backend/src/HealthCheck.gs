/**
 * Health Check: scans Employees, this month's Schedule sheet, and this
 * month's AttendanceLog for the kinds of mistakes a fat-fingered edit tends
 * to cause (typo'd Department, missing Kiosk PIN, shift typed instead of
 * picked from the dropdown, forgotten checkout, a scheduled day with no
 * check-in at all, etc.), then jumps straight to the first one found instead
 * of making you hunt for it. Also verifies -- and auto-repairs -- the tab
 * NAME and header ROW of the critical sheets (see checkAndFixCriticalSheets_,
 * checkAndFixScheduleHeaders_), since every lookup in this codebase finds
 * sheets/columns by exact name and a single fat-fingered edit there breaks
 * everything downstream. Menu: Attendance Admin > Health Check.
 */
function menuHealthCheck_() {
  var ui = SpreadsheetApp.getUi();
  var findings = runHealthCheck_();

  if (findings.length === 0) {
    ui.alert('Health Check', 'No issues found. Everything checks out.', ui.ButtonSet.OK);
    return;
  }

  var lines = findings.map(function (f, i) { return (i + 1) + '. [' + f.sheetName + '] ' + f.message; });
  ui.alert('Health Check -- ' + findings.length + ' issue(s) found', lines.join('\n\n'), ui.ButtonSet.OK);

  jumpToFirstFinding_(findings);
}

/** Activates the sheet of the first navigable finding and multi-selects every finding on that same sheet. */
function jumpToFirstFinding_(findings) {
  var navigable = findings.filter(function (f) { return f.a1; })[0];
  if (!navigable) return;

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(navigable.sheetName);
  if (!sheet) return;

  ss.setActiveSheet(sheet);
  var sameSheetRanges = findings
    .filter(function (f) { return f.sheetName === navigable.sheetName && f.a1; })
    .map(function (f) { return f.a1; });
  sheet.setActiveRangeList(sheet.getRangeList(sameSheetRanges));
}

function runHealthCheck_() {
  var findings = [];

  // Run first: if a critical sheet's tab name or header row got
  // fat-fingered, every check below needs to find it by exact name to run
  // at all. Fixing (or at least detecting) that first means the rest of the
  // scan runs against a working sheet instead of the whole thing crashing.
  checkAndFixCriticalSheets_(findings);
  checkAndFixScheduleHeaders_(findings);

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var employeesOk = !!ss.getSheetByName('Employees');
  var logOk = !!ss.getSheetByName('AttendanceLog');

  if (employeesOk) {
    var activeEmployees = getAllEmployees_().filter(function (emp) { return isTrue_(emp.Active); });
    checkEmployeesSheet_(findings);
    checkCurrentSchedule_(findings, activeEmployees);
    if (logOk) checkMissingAttendance_(findings, activeEmployees);
  }
  if (logOk) checkMissingCheckouts_(findings);

  return findings;
}

var HEALTH_CHECK_EMAIL = 'yumeterasu.computer@gmail.com';

/**
 * Same checks as the menu's Health Check, but silent unless something's
 * wrong -- emails a summary only when findings.length > 0. Used to run on a
 * daily timer (see removeDailyHealthCheckTrigger) -- disabled because Health
 * Check now scans/repairs Employees, AttendanceLog, and every Schedule tab
 * (see checkAndFixCriticalSheets_, checkAndFixScheduleHeaders_), and running
 * all of that automatically around 7am collided with the shift-start
 * check-in rush, slowing the Kiosk's PIN lookup down enough to time out and
 * show an error. Attendance Admin > Health Check in the menu still runs the
 * exact same checks on demand -- just no longer on an automatic schedule.
 */
function runHealthCheckAndEmail_() {
  var findings = runHealthCheck_();
  if (findings.length === 0) return;

  var lines = findings.map(function (f, i) { return (i + 1) + '. [' + f.sheetName + '] ' + f.message; });
  var subject = 'Attendance Health Check -- ' + findings.length + ' issue(s) found';
  var body = lines.join('\n\n') + '\n\nOpen the sheet and run Attendance Admin > Health Check to jump straight to each one.';
  MailApp.sendEmail(HEALTH_CHECK_EMAIL, subject, body);
}

/**
 * One-off: removes the daily runHealthCheckAndEmail_ trigger, if one exists.
 * Safe to run more than once -- does nothing if there's no trigger left to
 * remove. Run once from the editor: select removeDailyHealthCheckTrigger in
 * the toolbar dropdown, click Run.
 */
function removeDailyHealthCheckTrigger() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runHealthCheckAndEmail_') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  Logger.log(removed > 0 ? 'Daily Health Check trigger removed.' : 'No daily Health Check trigger was installed.');
}

// Sheets whose exact tab NAME and header row must never drift -- every
// getSheet_ lookup and headers.indexOf(...) call in this codebase depends on
// both. A single accidental rename or header-cell edit silently breaks every
// function that touches that sheet. Checked (and auto-repaired) by Health
// Check on every run -- see checkAndFixCriticalSheets_.
var CANONICAL_HEADERS = {
  Employees: ['EmployeeID', 'Name', 'Department', 'Active', 'CreatedAt', 'SetupCodeHash', 'SetupCodeSalt', 'SetupCodeUsed', 'IsAdmin', 'Branch', 'KioskPIN', 'OTMaxMinutes', 'Salary', 'LastWorkingDay', 'OTEligible'],
  AttendanceLog: ['Timestamp', 'EmployeeID', 'Name', 'Department', 'Type', 'Method', 'RawScanValue', 'DurationMinutes', 'Shift', 'Late', 'OT', 'OTMinutes', 'OTQuarters', 'ClientId']
};

/**
 * Verifies (and repairs) both the tab NAME and header row of Employees and
 * AttendanceLog -- the two append-only source-of-truth sheets everything
 * else in the system is computed from. Two kinds of fat-finger damage are
 * covered:
 *
 * 1. The tab itself got renamed by accident. Detected by fingerprint: the
 *    candidate sheet's own first THREE header cells (columns A/B/C) must
 *    exactly match that sheet's canonical start ("EmployeeID"+"Name"+
 *    "Department" for Employees, "Timestamp"+"EmployeeID"+"Name" for
 *    AttendanceLog). "Schedule YYYY-MM" tabs are also excluded by name
 *    outright before any fingerprint check runs, since their columns A/B
 *    are the same "EmployeeID"/"Name" as Employees -- a 2-column fingerprint
 *    collided with them once already (see incident notes in git history);
 *    the 3rd column and the explicit name exclusion both independently rule
 *    that out now. If nothing matches, it's reported instead of guessed at
 *    -- a missed auto-fix is far cheaper than repairing the wrong sheet.
 * 2. A header CELL within row 1 got overwritten with the wrong text.
 *    Restored to the canonical name for that position, but only when the
 *    canonical name isn't already present somewhere else in the row (so a
 *    genuinely reordered column -- nothing in this codebase does that, but
 *    just in case -- is never clobbered). Extra columns an admin added
 *    beyond the canonical list are left completely untouched.
 *
 * Also checks that "Report" and "Summary" exist by name (no rename-recovery
 * attempted there -- both are pure computed views with no stable row-1
 * fingerprint to match against, and losing the tab just means it stops
 * refreshing rather than losing any data).
 */
function checkAndFixCriticalSheets_(findings) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  Object.keys(CANONICAL_HEADERS).forEach(function (sheetName) {
    var canonical = CANONICAL_HEADERS[sheetName];
    var sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      var candidate = ss.getSheets().filter(function (s) {
        if (CANONICAL_HEADERS[s.getName()]) return false; // already a correctly-named critical sheet
        if (/^Schedule \d{4}-\d{2}$/.test(s.getName())) return false; // shares the EmployeeID/Name start -- never a match, never touch these
        if (s.getLastColumn() < 3) return false;
        var first3 = s.getRange(1, 1, 1, 3).getValues()[0];
        return first3[0] === canonical[0] && first3[1] === canonical[1] && first3[2] === canonical[2];
      })[0];

      if (candidate) {
        var oldName = candidate.getName();
        candidate.setName(sheetName);
        sheet = candidate;
        findings.push({
          sheetName: sheetName,
          a1: null,
          message: 'Tab "' + oldName + '" was renamed back to "' + sheetName + '" -- its name looked like it had been changed by accident (matched by its columns).'
        });
      } else {
        findings.push({
          sheetName: sheetName,
          a1: null,
          message: 'No "' + sheetName + '" tab found, and no other tab looks like it structurally. This is serious -- the whole system depends on this sheet. Check if it was deleted or renamed to something unrecognizable.'
        });
        return;
      }
    }

    var lastCol = Math.max(sheet.getLastColumn(), canonical.length);
    var headerRange = sheet.getRange(1, 1, 1, lastCol);
    var row = headerRange.getValues()[0];
    var fixed = [];

    for (var i = 0; i < canonical.length; i++) {
      if (row[i] === canonical[i]) continue;
      if (row.indexOf(canonical[i]) !== -1) continue; // present elsewhere in the row -- don't touch
      row[i] = canonical[i];
      fixed.push(canonical[i]);
    }

    if (fixed.length > 0) {
      headerRange.setValues([row]);
      findings.push({
        sheetName: sheetName,
        a1: null,
        message: sheetName + ' header row auto-repaired: ' + fixed.join(', ') + ' restored.'
      });
    }
  });

  ['Report', 'Summary'].forEach(function (sheetName) {
    if (ss.getSheetByName(sheetName)) return;
    findings.push({
      sheetName: sheetName,
      a1: null,
      message: 'No "' + sheetName + '" tab found -- was it renamed or deleted? Needed for ' +
        (sheetName === 'Report' ? 'the daily report view.' : 'monthly totals and OT pay.')
    });
  });
}

/** Same idea as checkAndFixCriticalSheets_, scoped to columns A ("EmployeeID") and B ("Name") of every "Schedule YYYY-MM" tab -- those two never legitimately hold anything else. */
function checkAndFixScheduleHeaders_(findings) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var scheduleSheets = ss.getSheets().filter(function (s) { return /^Schedule \d{4}-\d{2}$/.test(s.getName()); });

  scheduleSheets.forEach(function (sheet) {
    if (sheet.getLastColumn() < 2) return;
    var headerRange = sheet.getRange(1, 1, 1, 2);
    var row = headerRange.getValues()[0];
    var fixed = [];

    if (row[0] !== 'EmployeeID') { row[0] = 'EmployeeID'; fixed.push('EmployeeID'); }
    if (row[1] !== 'Name') { row[1] = 'Name'; fixed.push('Name'); }

    if (fixed.length > 0) {
      headerRange.setValues([row]);
      findings.push({
        sheetName: sheet.getName(),
        a1: null,
        message: sheet.getName() + ' header row auto-repaired: ' + fixed.join(', ') + ' restored.'
      });
    }
  });
}

/** Department spelling, missing Kiosk PIN, and an Active column value that isn't cleanly TRUE/FALSE. */
function checkEmployeesSheet_(findings) {
  var sheet = getSheet_('Employees');
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var deptCol = headers.indexOf('Department');
  var branchCol = headers.indexOf('Branch'); // -1 until the admin adds this column -- skip the check until then
  var activeCol = headers.indexOf('Active');
  var pinCol = headers.indexOf('KioskPIN');
  var nameCol = headers.indexOf('Name');
  var otEligibleCol = headers.indexOf('OTEligible'); // -1 until the admin adds this column -- skip the check until then

  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var name = row[nameCol];
    var rawActive = row[activeCol];

    if (rawActive !== '' && rawActive !== true && rawActive !== false && rawActive !== 'TRUE' && rawActive !== 'FALSE') {
      findings.push({
        sheetName: 'Employees',
        a1: sheet.getRange(i + 1, activeCol + 1).getA1Notation(),
        message: name + ': Active column has an unexpected value ("' + rawActive + '") -- should be TRUE or FALSE.'
      });
    }

    if (!isTrue_(rawActive)) continue;

    var dept = row[deptCol];
    if (dept !== 'Japanese' && dept !== 'Thai') {
      findings.push({
        sheetName: 'Employees',
        a1: sheet.getRange(i + 1, deptCol + 1).getA1Notation(),
        message: name + ': Department is "' + dept + '" -- should be exactly "Japanese" or "Thai".'
      });
    }

    if (branchCol !== -1 && BRANCHES.indexOf(row[branchCol]) === -1) {
      findings.push({
        sheetName: 'Employees',
        a1: sheet.getRange(i + 1, branchCol + 1).getA1Notation(),
        message: name + ': Branch is "' + row[branchCol] + '" -- should be exactly one of: ' + BRANCHES.join(', ') + '.'
      });
    }

    var pin = String(row[pinCol] || '').trim();
    if (!pin) {
      findings.push({
        sheetName: 'Employees',
        a1: sheet.getRange(i + 1, pinCol + 1).getA1Notation(),
        message: name + ': Active but has no Kiosk PIN -- needs one assigned.'
      });
    } else if (pin.length !== 4) {
      findings.push({
        sheetName: 'Employees',
        a1: sheet.getRange(i + 1, pinCol + 1).getA1Notation(),
        message: name + ': Kiosk PIN is "' + pin + '" (' + pin.length + ' digit' + (pin.length === 1 ? '' : 's') + ') -- should always be 4. Likely lost a leading zero from a manual edit.'
      });
    }

    if (otEligibleCol !== -1) {
      var rawOtEligible = row[otEligibleCol];
      // Blank is valid here (defaults to eligible -- see isOtEligible_), unlike Active where blank effectively means inactive.
      if (rawOtEligible !== '' && rawOtEligible !== true && rawOtEligible !== false && rawOtEligible !== 'TRUE' && rawOtEligible !== 'FALSE') {
        findings.push({
          sheetName: 'Employees',
          a1: sheet.getRange(i + 1, otEligibleCol + 1).getA1Notation(),
          message: name + ': OTEligible column has an unexpected value ("' + rawOtEligible + '") -- should be TRUE or FALSE.'
        });
      }
    }
  }
}

/** Active employees missing from this month's Schedule, and shift cells that don't match the SHIFTS dropdown. */
function checkCurrentSchedule_(findings, activeEmployees) {
  var now = new Date();
  var year = now.getFullYear();
  var month = now.getMonth() + 1;
  var today = now.getDate();
  var sheetName = 'Schedule ' + year + '-' + (month < 10 ? '0' + month : month);
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);

  if (!sheet) {
    findings.push({ sheetName: 'Employees', a1: null, message: 'No "' + sheetName + '" sheet exists yet for this month.' });
    return;
  }

  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idCol = headers.indexOf('EmployeeID');
  var nameCol = headers.indexOf('Name');

  var scheduledIds = {};
  for (var s = 1; s < values.length; s++) scheduledIds[String(values[s][idCol])] = true;

  activeEmployees.forEach(function (emp) {
    if (!scheduledIds[String(emp.EmployeeID)]) {
      findings.push({
        sheetName: sheetName,
        a1: null,
        message: emp.Name + ' is Active but missing from ' + sheetName + ' -- run "Create / Update Schedule Sheet..." to add them.'
      });
    }
  });

  for (var r = 1; r < values.length; r++) {
    for (var d = 1; d <= today; d++) {
      var dayCol = headers.indexOf(d);
      if (dayCol === -1) continue;
      var cellValue = String(values[r][dayCol] || '').trim();
      if (!cellValue) continue;
      if (SHIFTS.indexOf(cellValue) === -1) {
        findings.push({
          sheetName: sheetName,
          a1: sheet.getRange(r + 1, dayCol + 1).getA1Notation(),
          message: values[r][nameCol] + ', day ' + d + ': "' + cellValue + '" doesn\'t match any Shift option -- typed instead of picked from the dropdown?'
        });
      }
    }
  }
}

/** IN rows with no matching OUT, for days that have already fully passed (not today -- they may still be at work). */
function checkMissingCheckouts_(findings) {
  var sheet = getSheet_('AttendanceLog');
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var tsCol = headers.indexOf('Timestamp');
  var idCol = headers.indexOf('EmployeeID');
  var nameCol = headers.indexOf('Name');
  var typeCol = headers.indexOf('Type');

  var now = new Date();
  var year = now.getFullYear();
  var month = now.getMonth() + 1;
  var today = now.getDate();

  var inByKey = {};
  var outKeys = {};
  for (var i = 1; i < values.length; i++) {
    var ts = new Date(values[i][tsCol]);
    if (ts.getFullYear() !== year || ts.getMonth() + 1 !== month) continue;
    var day = ts.getDate();
    if (day >= today) continue;

    var key = String(values[i][idCol]) + '|' + day;
    if (values[i][typeCol] === 'IN') {
      inByKey[key] = { rowNumber: i + 1, name: values[i][nameCol] };
    } else if (values[i][typeCol] === 'OUT') {
      outKeys[key] = true;
    }
  }

  Object.keys(inByKey).forEach(function (key) {
    if (outKeys[key]) return;
    var info = inByKey[key];
    var day2 = key.split('|')[1];
    findings.push({
      sheetName: 'AttendanceLog',
      a1: sheet.getRange(info.rowNumber, typeCol + 1).getA1Notation(),
      message: info.name + ': has IN on day ' + day2 + ' but no matching OUT -- forgot to check out?'
    });
  });
}

/**
 * Active employees scheduled a real shift (not blank, not a full day off --
 * see FULL_DAY_OFF_SHIFTS -- "Half Day Leave" still counts, they're expected
 * in for half the day) on a day that's already fully passed, but with no
 * check-in recorded at all -- not "forgot to check out"
 * (checkMissingCheckouts_ already covers that), this is nothing on the
 * books whatsoever. Usually means either they genuinely forgot to tap the
 * kiosk all day, or the day should have been marked Leave/Holiday on the
 * Schedule but wasn't.
 *
 * year/month default to the current month (Health Check's own use). Pass
 * them explicitly to check a different month -- e.g. "Recompute Late/OT for
 * ALL Months" calls this once per month it just recomputed. For the current
 * month only days before today are checked (today may not be over yet); for
 * a fully past month every day is checked; a future month is skipped
 * entirely since no days there have passed yet.
 */
function checkMissingAttendance_(findings, activeEmployees, year, month) {
  var now = new Date();
  if (year === undefined) year = now.getFullYear();
  if (month === undefined) month = now.getMonth() + 1;

  var isFutureMonth = year > now.getFullYear() || (year === now.getFullYear() && month > now.getMonth() + 1);
  if (isFutureMonth) return;

  var isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;
  var lastDayToCheck = isCurrentMonth ? now.getDate() - 1 : new Date(year, month, 0).getDate();
  if (lastDayToCheck < 1) return;

  var sheetName = 'Schedule ' + year + '-' + (month < 10 ? '0' + month : month);
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return; // checkCurrentSchedule_ already reports a missing Schedule sheet

  var scheduledShiftsForMonth = getScheduledShiftsForMonth_(year, month);

  var logSheet = getSheet_('AttendanceLog');
  var logValues = logSheet.getDataRange().getValues();
  var logHeaders = logValues[0];
  var logIdCol = logHeaders.indexOf('EmployeeID');
  var logTsCol = logHeaders.indexOf('Timestamp');
  var logTypeCol = logHeaders.indexOf('Type');

  var hasInByKey = {};
  for (var i = 1; i < logValues.length; i++) {
    if (logValues[i][logTypeCol] !== 'IN') continue;
    var ts = new Date(logValues[i][logTsCol]);
    if (ts.getFullYear() !== year || ts.getMonth() + 1 !== month) continue;
    hasInByKey[String(logValues[i][logIdCol]) + '|' + ts.getDate()] = true;
  }

  activeEmployees.forEach(function (emp) {
    var shiftsByDay = scheduledShiftsForMonth[emp.EmployeeID] || {};
    for (var day = 1; day <= lastDayToCheck; day++) {
      var shift = shiftsByDay[day];
      if (!shift || FULL_DAY_OFF_SHIFTS.indexOf(shift) !== -1) continue; // "Half Day Leave" stays checked -- still expected in for half the day
      if (hasInByKey[String(emp.EmployeeID) + '|' + day]) continue;
      findings.push({
        sheetName: sheetName,
        a1: null,
        message: emp.Name + ', day ' + day + ': scheduled "' + shift + '" but no check-in recorded at all -- forgot to punch, or should this day be marked Leave instead?'
      });
    }
  });
}

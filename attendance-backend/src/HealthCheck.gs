/**
 * Health Check: scans Employees, this month's Schedule sheet, and this
 * month's AttendanceLog for the kinds of mistakes a fat-fingered edit tends
 * to cause (typo'd Department, missing Kiosk PIN, shift typed instead of
 * picked from the dropdown, forgotten checkout, a scheduled day with no
 * check-in at all, etc.), then jumps straight to the first one found instead
 * of making you hunt for it. Menu: Attendance Admin > Health Check.
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
  var activeEmployees = getAllEmployees_().filter(function (emp) { return isTrue_(emp.Active); });

  checkEmployeesSheet_(findings);
  checkCurrentSchedule_(findings, activeEmployees);
  checkMissingCheckouts_(findings);
  checkMissingAttendance_(findings, activeEmployees);

  return findings;
}

var HEALTH_CHECK_EMAIL = 'yumeterasu.computer@gmail.com';

/**
 * Same checks as the menu's Health Check, but silent unless something's
 * wrong -- emails a summary only when findings.length > 0. Meant to run on a
 * daily timer (see setupDailyHealthCheckTrigger) instead of waiting for
 * someone to open the sheet and click the menu.
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
 * One-off: installs a daily trigger that runs runHealthCheckAndEmail_ every
 * morning. Safe to run more than once -- clears any existing trigger for the
 * same function first, so it never ends up duplicated. Run once from the
 * editor: select setupDailyHealthCheckTrigger in the toolbar dropdown, click
 * Run (you'll be asked to authorize Gmail send access the first time).
 */
function setupDailyHealthCheckTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runHealthCheckAndEmail_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runHealthCheckAndEmail_')
    .timeBased()
    .everyDays(1)
    .atHour(7)
    .create();
  Logger.log('Daily Health Check trigger created -- runs around 7am, emails ' + HEALTH_CHECK_EMAIL + ' only if issues are found.');
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

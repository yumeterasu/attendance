/**
 * Health Check: scans Employees, this month's Schedule sheet, and this
 * month's AttendanceLog for the kinds of mistakes a fat-fingered edit tends
 * to cause (typo'd Department, missing Kiosk PIN, shift typed instead of
 * picked from the dropdown, forgotten checkout, etc.), then jumps straight to
 * the first one found instead of making you hunt for it. Menu: Attendance
 * Admin > Health Check.
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

  return findings;
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

    if (!String(row[pinCol] || '').trim()) {
      findings.push({
        sheetName: 'Employees',
        a1: sheet.getRange(i + 1, pinCol + 1).getA1Notation(),
        message: name + ': Active but has no Kiosk PIN -- run "Generate Kiosk Codes for Everyone".'
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

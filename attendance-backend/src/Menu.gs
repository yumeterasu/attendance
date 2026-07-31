/**
 * Custom Google Sheets menu so the routine admin actions (Schedule, Kiosk
 * codes, admin setup codes, exit PIN) can be run straight from a computer --
 * no Tablet needed. The Tablet app keeps working exactly as before; this is
 * an additional way to trigger the same underlying functions, not a
 * replacement. onOpen is a simple trigger, so the menu just appears every
 * time the spreadsheet is opened, no manual trigger setup required.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Attendance Admin')
    .addItem('Health Check', 'menuHealthCheck_')
    .addItem('Add Backdated Check-in/Check-out...', 'menuAddBackdatedAttendance_')
    .addItem('Bulk Mark Attendance for a Day...', 'menuBulkMarkAttendance_')
    .addItem('Create / Update Schedule Sheet...', 'menuCreateScheduleSheet_')
    .addItem('Reorder Schedule by Branch/Department', 'menuReorderScheduleByBranch_')
    .addItem('Recompute Late/OT for ALL Months', 'menuRecomputeLateOtAllMonths_')
    .addItem('Generate Kiosk Codes for Everyone', 'menuGenerateKioskPins_')
    .addSeparator()
    .addItem('Issue New Setup Code (Admin Pairing)...', 'menuIssueSetupCode_')
    .addItem('Set Kiosk Exit PIN...', 'menuSetKioskExitPin_')
    .addToUi();
}

function menuCreateScheduleSheet_() {
  var ui = SpreadsheetApp.getUi();
  var now = new Date();

  var yearResp = ui.prompt('Create / Update Schedule Sheet', 'Year (e.g. ' + now.getFullYear() + '):', ui.ButtonSet.OK_CANCEL);
  if (yearResp.getSelectedButton() !== ui.Button.OK) return;
  var year = Number(yearResp.getResponseText().trim());

  var monthResp = ui.prompt('Create / Update Schedule Sheet', 'Month (1-12):', ui.ButtonSet.OK_CANCEL);
  if (monthResp.getSelectedButton() !== ui.Button.OK) return;
  var month = Number(monthResp.getResponseText().trim());

  if (!year || !month || month < 1 || month > 12) {
    ui.alert('Enter a valid year and a month between 1 and 12.');
    return;
  }

  var sheetName = buildScheduleSheet_(year, month);
  ui.alert('Done', '"' + sheetName + '" is ready. Fill in each day\'s shift from the dropdown.', ui.ButtonSet.OK);
}

/**
 * Re-sorts every row on whichever "Schedule YYYY-MM" tab is currently open
 * (Branch order from BRANCHES, then Japanese before Thai, then Employee ID)
 * -- for a sheet whose rows were added before Branch-based ordering existed,
 * or before everyone's Branch was filled in. Moves each employee's whole row
 * (every day's shift together) as one unit, so nothing gets mismatched. Only
 * touches values, not the weekend tint or shift dropdown -- both are
 * column-based, unaffected by row order.
 */
function menuReorderScheduleByBranch_() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var match = sheet.getName().match(/^Schedule (\d{4})-(\d{2})$/);
  if (!match) {
    ui.alert('Open the Schedule tab you want to reorder first (e.g. "Schedule 2026-07"), then run this again.');
    return;
  }

  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idCol = headers.indexOf('EmployeeID');
  var dataRows = values.slice(1);

  if (dataRows.length === 0) {
    ui.alert('No employee rows to reorder.');
    return;
  }

  var employeesById = {};
  getAllEmployees_().forEach(function (emp) { employeesById[String(emp.EmployeeID)] = emp; });

  dataRows.sort(function (rowA, rowB) {
    var empA = employeesById[String(rowA[idCol])];
    var empB = employeesById[String(rowB[idCol])];

    var branchA = empA ? BRANCHES.indexOf(empA.Branch) : -1;
    var branchB = empB ? BRANCHES.indexOf(empB.Branch) : -1;
    if (branchA === -1) branchA = BRANCHES.length;
    if (branchB === -1) branchB = BRANCHES.length;
    if (branchA !== branchB) return branchA - branchB;

    var deptA = empA && empA.Department === 'Japanese' ? 0 : empA && empA.Department === 'Thai' ? 1 : 2;
    var deptB = empB && empB.Department === 'Japanese' ? 0 : empB && empB.Department === 'Thai' ? 1 : 2;
    if (deptA !== deptB) return deptA - deptB;

    return String(rowA[idCol]).localeCompare(String(rowB[idCol]));
  });

  sheet.getRange(2, 1, dataRows.length, headers.length).setValues(dataRows);
  ui.alert('Done', 'Reordered ' + dataRows.length + ' row(s) in ' + sheet.getName() + ' by Branch/Department.', ui.ButtonSet.OK);
}

/**
 * Runs the recompute across every "Schedule YYYY-MM" tab that exists in the
 * spreadsheet, one after another -- no need to open each tab first. Asks for
 * confirmation first since it touches every month at once.
 */
function menuRecomputeLateOtAllMonths_() {
  var ui = SpreadsheetApp.getUi();
  var scheduleMatches = SpreadsheetApp.getActiveSpreadsheet()
    .getSheets()
    .map(function (s) { return s.getName().match(/^Schedule (\d{4})-(\d{2})$/); })
    .filter(function (m) { return m; });

  if (scheduleMatches.length === 0) {
    ui.alert('No "Schedule YYYY-MM" sheets found.');
    return;
  }

  var monthNames = scheduleMatches.map(function (m) { return m[0]; }).join(', ');
  var confirm = ui.alert(
    'Recompute Late/OT for ALL Months',
    'This recomputes Late/OT across every Schedule month found (' + scheduleMatches.length + '): ' + monthNames + '.\n\nContinue?',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  var totalIn = 0;
  var totalOut = 0;
  var summaryLines = scheduleMatches.map(function (m) {
    var year = Number(m[1]);
    var month = Number(m[2]);
    var daysInMonth = new Date(year, month, 0).getDate();
    var result = recomputeLateAndOt_(year, month, 1, daysInMonth);
    totalIn += result.inRowsUpdated;
    totalOut += result.outRowsUpdated;
    return m[0] + ': ' + result.inRowsUpdated + ' IN, ' + result.outRowsUpdated + ' OUT';
  });

  ui.alert(
    'Done',
    'Recomputed ' + scheduleMatches.length + ' month(s):\n\n' + summaryLines.join('\n') +
    '\n\nTotal: ' + totalIn + ' IN row(s), ' + totalOut + ' OUT row(s) updated.\n\n' +
    'Thai/non-Japanese OT was left untouched -- it can only be trusted from the moment it was recorded, not recomputed after the fact.',
    ui.ButtonSet.OK
  );
}

/**
 * Backfills a missed IN or OUT (e.g. someone forgot to tap the kiosk) with
 * the same Shift/Late/Duration/OT computation a live check-in would use.
 * Uses a chain of native ui.prompt()/ui.alert() calls rather than an
 * HtmlService dialog -- an earlier version used a dialog with a dropdown and
 * a date picker, but google.script.run inside that dialog only worked for
 * the file's owner, not for other Editors (Apps Script couldn't complete the
 * authorization flow for them there). Plain prompts run through Sheets' own
 * UI directly, no separate authorization step, so every Editor can use this.
 */
function menuAddBackdatedAttendance_() {
  var ui = SpreadsheetApp.getUi();
  var title = 'Add Backdated Check-in/Check-out';

  var employeeResp = ui.prompt(title, 'Employee name or ID:', ui.ButtonSet.OK_CANCEL);
  if (employeeResp.getSelectedButton() !== ui.Button.OK) return;
  var employee = findEmployeeByNameOrId_(employeeResp.getResponseText().trim());
  if (!employee) {
    ui.alert('No employee found matching "' + employeeResp.getResponseText().trim() + '".');
    return;
  }

  var typeResp = ui.prompt(title, employee.Name + ' -- Type IN, OUT, or OTOT (OUT with overtime):', ui.ButtonSet.OK_CANCEL);
  if (typeResp.getSelectedButton() !== ui.Button.OK) return;
  var typeInput = typeResp.getResponseText().trim().toUpperCase();
  var type, ot;
  if (typeInput === 'IN') { type = 'IN'; ot = false; }
  else if (typeInput === 'OUT') { type = 'OUT'; ot = false; }
  else if (typeInput === 'OTOT' || typeInput === 'OUT OT' || typeInput === 'OUT_OT') { type = 'OUT'; ot = true; }
  else { ui.alert('Type must be IN, OUT, or OTOT.'); return; }

  var dateResp = ui.prompt(title, 'Date (DD/MM/YYYY), e.g. 24/07/2026:', ui.ButtonSet.OK_CANCEL);
  if (dateResp.getSelectedButton() !== ui.Button.OK) return;
  var dateParts = dateResp.getResponseText().trim().split('/');
  if (dateParts.length !== 3) { ui.alert('Enter the date as DD/MM/YYYY.'); return; }
  var day = Number(dateParts[0]), month = Number(dateParts[1]), year = Number(dateParts[2]);

  var timeResp = ui.prompt(title, 'Time (24-hour), e.g. 08:30:', ui.ButtonSet.OK_CANCEL);
  if (timeResp.getSelectedButton() !== ui.Button.OK) return;
  var timeParts = timeResp.getResponseText().trim().split(':');
  if (timeParts.length !== 2) { ui.alert('Enter the time as HH:MM.'); return; }

  var timestamp = new Date(year, month - 1, day, Number(timeParts[0]), Number(timeParts[1]), 0);
  if (isNaN(timestamp.getTime())) {
    ui.alert('That date/time did not parse -- double check the values.');
    return;
  }

  var warnings = [];
  if (timestamp.getTime() > Date.now()) {
    warnings.push('That date/time is in the future.');
  }
  var existing = findLogEntryForDate_(employee.EmployeeID, type, timestamp);
  if (existing) {
    warnings.push(
      employee.Name + ' already has a ' + type + ' recorded that day (at ' +
      Utilities.formatDate(existing.timestamp, Session.getScriptTimeZone(), 'HH:mm') + ').'
    );
  }
  if (warnings.length > 0) {
    var confirmResp = ui.alert(title, warnings.join('\n') + '\n\nAdd anyway?', ui.ButtonSet.YES_NO);
    if (confirmResp !== ui.Button.YES) return;
  }

  var result = recordBackdatedAttendance_(employee.EmployeeID, type, timestamp, ot);
  var tz = Session.getScriptTimeZone();
  var summary = result.name + ': ' + type + (ot ? ' OT' : '') + ' @ ' + Utilities.formatDate(timestamp, tz, 'dd-MM-yyyy HH:mm');
  if (type === 'IN') {
    summary += '\nShift: ' + (result.shift || '(none found in Schedule for that date)') + '\nLate: ' + result.late;
  } else {
    summary += '\nDuration: ' + (result.durationMinutes !== '' ? result.durationMinutes + ' min' : '(no matching IN found that date)');
    summary += result.department === 'Japanese'
      ? '\nOT: ' + (result.otMinutes || 0) + ' min'
      : '\nOT: ' + (result.otQuarters || 0) + ' quarter(s)';
  }
  ui.alert('Done', summary, ui.ButtonSet.OK);
}

/**
 * For days the kiosk was completely unreachable (internet outage) -- lets an
 * admin bulk-record IN/OUT for everyone scheduled that day in one pass,
 * defaulting to "on time, no OT" for each person, with text-based overrides
 * for late arrival or absence. Never overwrites an IN/OUT that's already
 * recorded for someone that day (e.g. they clocked in before the outage
 * started) -- only fills in what's missing.
 *
 * Uses a chain of native ui.prompt()/ui.alert() calls rather than an
 * HtmlService dialog -- see menuAddBackdatedAttendance_'s comment for why
 * (google.script.run inside a dialog only worked for the file's owner, not
 * other Editors). A per-person button list isn't possible with plain
 * prompts, so overrides are entered as comma-separated names/IDs instead of
 * clicked -- everyone scheduled defaults to present/on-time unless named in
 * one of the two override prompts.
 */
function menuBulkMarkAttendance_() {
  var ui = SpreadsheetApp.getUi();
  var title = 'Bulk Mark Attendance for a Day';

  var dateResp = ui.prompt(title, 'Date (DD/MM/YYYY), e.g. 24/07/2026:', ui.ButtonSet.OK_CANCEL);
  if (dateResp.getSelectedButton() !== ui.Button.OK) return;
  var dateParts = dateResp.getResponseText().trim().split('/');
  if (dateParts.length !== 3) { ui.alert('Enter the date as DD/MM/YYYY.'); return; }
  var day = Number(dateParts[0]), month = Number(dateParts[1]), year = Number(dateParts[2]);
  var date = new Date(year, month - 1, day);
  if (isNaN(date.getTime())) { ui.alert('That date did not parse -- double check the values.'); return; }

  var scheduled = getAllEmployees_()
    .filter(function (emp) { return isTrue_(emp.Active); })
    .map(function (emp) { return { employee: emp, shift: getScheduledShift_(emp.EmployeeID, date) }; })
    .filter(function (s) { return s.shift; });

  if (scheduled.length === 0) {
    ui.alert('No active, scheduled employees found for that date. Make sure the Schedule sheet for that month is filled in.');
    return;
  }

  var namesList = scheduled.map(function (s) { return s.employee.Name; }).join(', ');
  var absentResp = ui.prompt(
    title,
    'Scheduled that day (' + scheduled.length + '): ' + namesList +
    '\n\nWho was ABSENT? (comma-separated names/IDs, or leave blank for none):',
    ui.ButtonSet.OK_CANCEL
  );
  if (absentResp.getSelectedButton() !== ui.Button.OK) return;
  var absentNames = absentResp.getResponseText().split(',')
    .map(function (s) { return s.trim().toUpperCase(); })
    .filter(String);

  var lateResp = ui.prompt(
    title,
    'Who was LATE, and by how many minutes? (format: Name:30, Name2:15 -- or leave blank for none):',
    ui.ButtonSet.OK_CANCEL
  );
  if (lateResp.getSelectedButton() !== ui.Button.OK) return;
  var lateMinutesByName = {};
  lateResp.getResponseText().split(',').forEach(function (part) {
    var pieces = part.split(':');
    if (pieces.length !== 2) return;
    var name = pieces[0].trim().toUpperCase();
    var minutes = Number(pieces[1].trim());
    if (name && minutes) lateMinutesByName[name] = minutes;
  });

  var added = 0, skippedExisting = 0, absentCount = 0, errors = [];

  scheduled.forEach(function (s) {
    var emp = s.employee;
    var key = emp.Name.toUpperCase();
    var idKey = String(emp.EmployeeID).toUpperCase();

    if (absentNames.indexOf(key) !== -1 || absentNames.indexOf(idKey) !== -1) {
      absentCount++;
      return;
    }

    var startMatch = s.shift.match(/(\d{1,2}):(\d{2})/);
    var endMatch = getShiftEndTime_(s.shift);
    if (!startMatch || !endMatch) { errors.push(emp.Name + ': could not read shift start/end time'); return; }

    var lateMinutes = lateMinutesByName[key] || lateMinutesByName[idKey] || 0;
    var inTime = new Date(year, month - 1, day, Number(startMatch[1]), Number(startMatch[2]), 0);
    inTime = new Date(inTime.getTime() + lateMinutes * 60000);
    var outTime = new Date(year, month - 1, day, endMatch.hour, endMatch.minute, 0);

    if (findLogEntryForDate_(emp.EmployeeID, 'IN', date)) {
      skippedExisting++;
    } else {
      recordBackdatedAttendance_(emp.EmployeeID, 'IN', inTime, false);
      added++;
    }

    if (findLogEntryForDate_(emp.EmployeeID, 'OUT', date)) {
      skippedExisting++;
    } else {
      recordBackdatedAttendance_(emp.EmployeeID, 'OUT', outTime, false);
      added++;
    }
  });

  var msg = 'Added ' + added + ' record(s).\n' +
    'Skipped ' + skippedExisting + ' (already recorded).\n' +
    'Marked absent (skipped): ' + absentCount + '.';
  if (errors.length) msg += '\n\nErrors:\n' + errors.join('\n');
  ui.alert('Done', msg, ui.ButtonSet.OK);
}

function menuGenerateKioskPins_() {
  var ui = SpreadsheetApp.getUi();
  var assigned = assignMissingKioskPins_();
  ui.alert('Done', assigned + ' new code' + (assigned === 1 ? '' : 's') + ' assigned. View them in the Employees sheet\'s KioskPIN column.', ui.ButtonSet.OK);
}

function menuIssueSetupCode_() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt('Issue New Setup Code', 'Admin username (Employee ID), e.g. EMP001:', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var employeeId = resp.getResponseText().trim();

  var found = findEmployeeRow_(employeeId);
  if (!found) {
    ui.alert('Username not found: ' + employeeId);
    return;
  }

  var setupCode = randomSetupCode_();
  var salt = randomSalt_();
  updateEmployeeFields_(found.rowNumber, {
    SetupCodeHash: sha256Hex_(setupCode + salt),
    SetupCodeSalt: salt,
    SetupCodeUsed: false
  });

  ui.alert('New setup code', 'For ' + employeeId + ': ' + setupCode + '\n\nShare it directly with them -- it only works once, for their first login on the new device.', ui.ButtonSet.OK);
}

function menuSetKioskExitPin_() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt('Set Kiosk Exit PIN', 'New 4-digit PIN:', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var pin = resp.getResponseText().trim();

  if (!/^\d{4}$/.test(pin)) {
    ui.alert('PIN must be exactly 4 digits.');
    return;
  }

  PropertiesService.getScriptProperties().setProperty('KIOSK_EXIT_PIN', pin);
  ui.alert('Done', 'Kiosk Exit PIN updated.', ui.ButtonSet.OK);
}

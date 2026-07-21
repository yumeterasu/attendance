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
    .addItem('Create / Update Schedule Sheet...', 'menuCreateScheduleSheet_')
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
 * Warns (but doesn't block) if that employee already has an entry of the
 * same type on that date, in case this is an accidental double-entry rather
 * than a genuine correction.
 */
function menuAddBackdatedAttendance_() {
  var ui = SpreadsheetApp.getUi();

  var empResp = ui.prompt('Add Backdated Check-in/Check-out', 'Employee (Name or Employee ID):', ui.ButtonSet.OK_CANCEL);
  if (empResp.getSelectedButton() !== ui.Button.OK) return;
  var employee = findEmployeeByNameOrId_(empResp.getResponseText().trim());
  if (!employee) {
    ui.alert('No employee found matching "' + empResp.getResponseText().trim() + '".');
    return;
  }

  var typeResp = ui.prompt('Add Backdated Check-in/Check-out', employee.Name + ' -- Type in IN or OUT:', ui.ButtonSet.OK_CANCEL);
  if (typeResp.getSelectedButton() !== ui.Button.OK) return;
  var type = typeResp.getResponseText().trim().toUpperCase();
  if (type !== 'IN' && type !== 'OUT') {
    ui.alert('Type must be exactly IN or OUT.');
    return;
  }

  var dateResp = ui.prompt('Add Backdated Check-in/Check-out', 'Date (YYYY-MM-DD):', ui.ButtonSet.OK_CANCEL);
  if (dateResp.getSelectedButton() !== ui.Button.OK) return;
  var dateParts = dateResp.getResponseText().trim().split('-');

  var timeResp = ui.prompt('Add Backdated Check-in/Check-out', 'Time (HH:MM, 24-hour):', ui.ButtonSet.OK_CANCEL);
  if (timeResp.getSelectedButton() !== ui.Button.OK) return;
  var timeParts = timeResp.getResponseText().trim().split(':');

  if (dateParts.length !== 3 || timeParts.length !== 2) {
    ui.alert('Enter the date as YYYY-MM-DD and the time as HH:MM.');
    return;
  }

  var timestamp = new Date(
    Number(dateParts[0]), Number(dateParts[1]) - 1, Number(dateParts[2]),
    Number(timeParts[0]), Number(timeParts[1]), 0
  );
  if (isNaN(timestamp.getTime())) {
    ui.alert('That date/time didn\'t parse -- double check the format.');
    return;
  }

  if (timestamp.getTime() > Date.now()) {
    var futureConfirm = ui.alert('That date/time is in the future -- continue anyway?', '', ui.ButtonSet.YES_NO);
    if (futureConfirm !== ui.Button.YES) return;
  }

  var existing = findLogEntryForDate_(employee.EmployeeID, type, timestamp);
  if (existing) {
    var dupConfirm = ui.alert(
      employee.Name + ' already has a ' + type + ' recorded that day (at ' +
      Utilities.formatDate(existing.timestamp, Session.getScriptTimeZone(), 'HH:mm') + '). Add another anyway?',
      '', ui.ButtonSet.YES_NO
    );
    if (dupConfirm !== ui.Button.YES) return;
  }

  var ot = false;
  if (type === 'OUT' && employee.Department !== 'Japanese') {
    var otConfirm = ui.alert('Count this as OT (like pressing OUT OT on the kiosk)?', '', ui.ButtonSet.YES_NO);
    ot = otConfirm === ui.Button.YES;
  }

  var result = recordBackdatedAttendance_(employee.EmployeeID, type, timestamp, ot);
  var tz = Session.getScriptTimeZone();
  var summary = result.name + ': ' + type + ' @ ' + Utilities.formatDate(timestamp, tz, 'yyyy-MM-dd HH:mm');
  if (type === 'IN') {
    summary += '\nShift: ' + (result.shift || '(none found in Schedule for that date)') + '\nLate: ' + result.late;
  } else {
    summary += '\nDuration: ' + (result.durationMinutes !== '' ? result.durationMinutes + ' min' : '(no matching IN found that date)');
    summary += result.department === 'Japanese'
      ? '\nOT: ' + (result.otMinutes || 0) + ' min'
      : '\nOT: ' + (result.otQuarters || 0) + ' quarter(s)';
  }
  ui.alert('Added', summary, ui.ButtonSet.OK);
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

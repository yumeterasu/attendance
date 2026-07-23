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
 * Shows an HTML dialog (BackdatedEntryDialog.html) instead of a chain of
 * prompts -- employee has type-ahead suggestions, IN/OUT/OUT OT are buttons,
 * and the date is 3 separate DD/MM/YYYY fields, no format guessing.
 */
function menuAddBackdatedAttendance_() {
  var html = HtmlService.createHtmlOutputFromFile('BackdatedEntryDialog')
    .setWidth(420)
    .setHeight(520);
  SpreadsheetApp.getUi().showModalDialog(html, 'Add Backdated Check-in/Check-out');
}

/** Called from BackdatedEntryDialog.html to populate the employee type-ahead list. */
function getEmployeeListForDialog_() {
  return getAllEmployees_()
    .filter(function (emp) { return isTrue_(emp.Active); })
    .map(function (emp) { return { id: emp.EmployeeID, name: emp.Name }; })
    .sort(function (a, b) { return a.name.localeCompare(b.name); });
}

/**
 * Called from BackdatedEntryDialog.html. payload: { employeeQuery, type
 * ('IN'|'OUT'|'OUT_OT'), day, month, year, time ('HH:MM'), skipWarnings }.
 * First call (skipWarnings false) returns { ok:false, warnings:[...] } for
 * anything that would normally need a Yes/No confirm (future date,
 * already-has-an-entry-that-day) -- the dialog shows those as confirm()
 * boxes client-side and resubmits with skipWarnings:true if all are accepted.
 */
function submitBackdatedEntry_(payload) {
  var employee = findEmployeeByNameOrId_(String(payload.employeeQuery || '').trim());
  if (!employee) {
    return { ok: false, error: 'No employee found matching "' + payload.employeeQuery + '".' };
  }

  var type = payload.type === 'OUT_OT' ? 'OUT' : payload.type;
  var ot = payload.type === 'OUT_OT';
  if (type !== 'IN' && type !== 'OUT') {
    return { ok: false, error: 'Pick IN, OUT, or OUT OT.' };
  }

  var day = Number(payload.day), month = Number(payload.month), year = Number(payload.year);
  var timeParts = String(payload.time || '').split(':');
  if (!day || !month || !year || timeParts.length !== 2) {
    return { ok: false, error: 'Enter a valid date and time.' };
  }

  var timestamp = new Date(year, month - 1, day, Number(timeParts[0]), Number(timeParts[1]), 0);
  if (isNaN(timestamp.getTime())) {
    return { ok: false, error: 'That date/time didn\'t parse -- double check the values.' };
  }

  if (!payload.skipWarnings) {
    var warnings = [];
    if (timestamp.getTime() > Date.now()) {
      warnings.push('That date/time is in the future -- continue anyway?');
    }
    var existing = findLogEntryForDate_(employee.EmployeeID, type, timestamp);
    if (existing) {
      warnings.push(
        employee.Name + ' already has a ' + type + ' recorded that day (at ' +
        Utilities.formatDate(existing.timestamp, Session.getScriptTimeZone(), 'HH:mm') + '). Add another anyway?'
      );
    }
    if (warnings.length > 0) {
      return { ok: false, warnings: warnings };
    }
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
  return { ok: true, summary: summary };
}

/**
 * For days the kiosk was completely unreachable (internet outage) -- lets an
 * admin bulk-record IN/OUT for everyone scheduled that day in one pass,
 * defaulting to "on time, no OT" for each person, with per-person overrides
 * for late arrival or absence. Never overwrites an IN/OUT that's already
 * recorded for someone that day (e.g. they clocked in before the outage
 * started) -- only fills in what's missing.
 */
function menuBulkMarkAttendance_() {
  var html = HtmlService.createHtmlOutputFromFile('BulkAttendanceDialog')
    .setWidth(480)
    .setHeight(620);
  SpreadsheetApp.getUi().showModalDialog(html, 'Bulk Mark Attendance for a Day');
}

/**
 * Called from BulkAttendanceDialog.html. Returns every active employee
 * scheduled to work the given date, with their shift and whether they
 * already have an IN and/or OUT recorded that day.
 */
function getScheduledEmployeesForDate_(dateStr) {
  var parts = dateStr.split('-'); // YYYY-MM-DD
  var date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  var activeEmployees = getAllEmployees_().filter(function (emp) { return isTrue_(emp.Active); });

  var rows = [];
  activeEmployees.forEach(function (emp) {
    var shift = getScheduledShift_(emp.EmployeeID, date);
    if (!shift) return;
    rows.push({
      id: emp.EmployeeID,
      name: emp.Name,
      department: emp.Department,
      shift: shift,
      hasIn: !!findLogEntryForDate_(emp.EmployeeID, 'IN', date),
      hasOut: !!findLogEntryForDate_(emp.EmployeeID, 'OUT', date)
    });
  });
  return rows;
}

/**
 * Called from BulkAttendanceDialog.html. payload: { date: 'YYYY-MM-DD',
 * entries: [{ employeeId, status: 'present'|'late'|'absent', lateMinutes }] }.
 * For present/late, adds IN at shift-start (+ lateMinutes if late) and OUT
 * at shift-end -- exactly on time, no OT ever assumed -- but only for
 * whichever of IN/OUT that employee doesn't already have that day. Absent
 * employees are skipped entirely (no record = didn't work that day).
 */
function submitBulkAttendance_(payload) {
  var dateParts = payload.date.split('-');
  var year = Number(dateParts[0]), month = Number(dateParts[1]), day = Number(dateParts[2]);
  var date = new Date(year, month - 1, day);

  var added = 0, skippedExisting = 0, absent = 0, errors = [];

  payload.entries.forEach(function (entry) {
    if (entry.status === 'absent') { absent++; return; }

    var employee = findEmployeeByNameOrId_(entry.employeeId);
    if (!employee) { errors.push(entry.employeeId + ': not found'); return; }

    var shift = getScheduledShift_(employee.EmployeeID, date);
    var startMatch = shift ? shift.match(/(\d{1,2}):(\d{2})/) : null;
    var endMatch = shift ? getShiftEndTime_(shift) : null;
    if (!startMatch || !endMatch) { errors.push(employee.Name + ': could not read shift start/end time'); return; }

    var lateMinutes = entry.status === 'late' ? (Number(entry.lateMinutes) || 0) : 0;
    var inTime = new Date(year, month - 1, day, Number(startMatch[1]), Number(startMatch[2]), 0);
    inTime = new Date(inTime.getTime() + lateMinutes * 60000);
    var outTime = new Date(year, month - 1, day, endMatch.hour, endMatch.minute, 0);

    if (findLogEntryForDate_(employee.EmployeeID, 'IN', date)) {
      skippedExisting++;
    } else {
      recordBackdatedAttendance_(employee.EmployeeID, 'IN', inTime, false);
      added++;
    }

    if (findLogEntryForDate_(employee.EmployeeID, 'OUT', date)) {
      skippedExisting++;
    } else {
      recordBackdatedAttendance_(employee.EmployeeID, 'OUT', outTime, false);
      added++;
    }
  });

  return { added: added, skippedExisting: skippedExisting, absent: absent, errors: errors };
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

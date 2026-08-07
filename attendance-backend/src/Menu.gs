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
    .addItem('Who Hasn\'t Checked In Today', 'menuWhoIsAbsentToday_')
    .addItem('Fix Mis-tapped IN After 16:00 (→ OUT)', 'menuFixLateInAsOut_')
    .addItem('Add New Employee...', 'menuAddNewEmployee_')
    .addItem('Deactivate Employee...', 'menuDeactivateEmployee_')
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

/**
 * Quick read-only check: everyone Active and scheduled to work today who
 * doesn't have an IN recorded yet. Uses today's actual date, not a prompt --
 * this is meant to be a one-click glance, not a lookup for other days (use
 * the Report sheet for past days). Reads the Schedule and AttendanceLog
 * sheets once each (not once per employee) -- see getScheduledShiftsForMonth_
 * and getEmployeeIdsWithInOnDate_.
 */
function menuWhoIsAbsentToday_() {
  var ui = SpreadsheetApp.getUi();
  var date = new Date();
  var today = date.getDate();
  var scheduledShiftsForMonth = getScheduledShiftsForMonth_(date.getFullYear(), date.getMonth() + 1);

  var scheduled = getAllEmployees_()
    .filter(function (emp) { return isTrue_(emp.Active); })
    .map(function (emp) {
      var shift = (scheduledShiftsForMonth[emp.EmployeeID] && scheduledShiftsForMonth[emp.EmployeeID][today]) || '';
      return { employee: emp, shift: shift };
    })
    .filter(function (s) { return s.shift && s.shift !== 'Leave'; }); // "Leave" means intentionally off, not "not scheduled yet" -- exclude from this list

  if (scheduled.length === 0) {
    ui.alert('No one is scheduled today (or the Schedule sheet for this month is not filled in yet).');
    return;
  }

  var checkedInIds = getEmployeeIdsWithInOnDate_(date);
  var missing = scheduled.filter(function (s) {
    return !checkedInIds[String(s.employee.EmployeeID)];
  });

  if (missing.length === 0) {
    ui.alert('Everyone scheduled today (' + scheduled.length + ') has checked in.');
    return;
  }

  var lines = missing.map(function (s) { return s.employee.Name + ' (' + s.shift + ')'; });
  ui.alert(
    'Not checked in yet today',
    missing.length + ' of ' + scheduled.length + ' scheduled:\n\n' + lines.join('\n'),
    ui.ButtonSet.OK
  );
}

/**
 * Finds IN rows tapped at/after LATE_IN_HOUR_THRESHOLD local time -- no shift
 * in SHIFTS starts this late, so this is almost certainly a mis-tap where
 * someone forgot to switch from IN to OUT when leaving for the day (e.g.
 * NUY on Aug 5-6). Shows what it found and asks for one confirmation before
 * converting all of them to OUT at once. Whole AttendanceLog history, not
 * just the current month, since the sheet is small enough to scan in full.
 *
 * OT handling on conversion: Japanese OT is always auto-computed from the
 * (now-OUT) timestamp, same as a live check-out. Thai/other OT is left at 0
 * (plain OUT) -- there's no way to know after the fact whether "OUT OT" was
 * actually intended, so it defaults to the safer no-OT reading; use "Add
 * Backdated Check-in/Check-out..." separately for any case that should carry
 * OT.
 */
var LATE_IN_HOUR_THRESHOLD = 16;

function menuFixLateInAsOut_() {
  var ui = SpreadsheetApp.getUi();
  var sheet = getSheet_('AttendanceLog');
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idCol = headers.indexOf('EmployeeID');
  var nameCol = headers.indexOf('Name');
  var deptCol = headers.indexOf('Department');
  var typeCol = headers.indexOf('Type');
  var tsCol = headers.indexOf('Timestamp');
  var shiftCol = headers.indexOf('Shift');
  var lateCol = headers.indexOf('Late');
  var durationCol = headers.indexOf('DurationMinutes');
  var otCol = headers.indexOf('OT');
  var otMinCol = headers.indexOf('OTMinutes');
  var otQuartersCol = headers.indexOf('OTQuarters');

  var flagged = [];
  for (var i = 1; i < values.length; i++) {
    if (values[i][typeCol] !== 'IN') continue;
    var ts = new Date(values[i][tsCol]);
    if (ts.getHours() >= LATE_IN_HOUR_THRESHOLD) {
      flagged.push({ rowIndex: i, timestamp: ts, employeeId: String(values[i][idCol]), name: values[i][nameCol], department: values[i][deptCol] });
    }
  }

  if (flagged.length === 0) {
    ui.alert('No mis-tapped IN taps found (nothing tapped IN at/after ' + LATE_IN_HOUR_THRESHOLD + ':00).');
    return;
  }

  var tz = Session.getScriptTimeZone();
  var byEmployee = {};
  flagged.forEach(function (f) {
    if (!byEmployee[f.employeeId]) byEmployee[f.employeeId] = { name: f.name, entries: [] };
    byEmployee[f.employeeId].entries.push(f.timestamp);
  });
  var lines = Object.keys(byEmployee).map(function (id) {
    var e = byEmployee[id];
    var times = e.entries.map(function (t) { return Utilities.formatDate(t, tz, 'dd/MM HH:mm'); }).join(', ');
    return e.name + ' (' + e.entries.length + '): ' + times;
  });

  var confirm = ui.alert(
    'Fix Mis-tapped IN After 16:00',
    'Found ' + flagged.length + ' IN tap(s) at/after ' + LATE_IN_HOUR_THRESHOLD + ':00 -- no shift starts this late, so these look like OUT mistakes:\n\n' +
    lines.join('\n') +
    '\n\nConvert them all to OUT? Japanese OT is computed automatically as usual; ' +
    'Thai/other OT defaults to none (add it separately via "Add Backdated Check-in/Check-out..." if it applies).',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  var fixedCount = 0;
  var skipped = [];

  flagged.forEach(function (f) {
    // Pair with that day's genuine earlier IN to compute duration -- if this
    // mis-tap is the only IN that day, there's no real clock-in to pair with,
    // so skip rather than guess at a duration.
    var realIn = null;
    for (var j = 1; j < values.length; j++) {
      if (j === f.rowIndex) continue;
      if (String(values[j][idCol]) !== f.employeeId) continue;
      if (values[j][typeCol] !== 'IN') continue;
      var ts2 = new Date(values[j][tsCol]);
      if (ts2.getFullYear() === f.timestamp.getFullYear() && ts2.getMonth() === f.timestamp.getMonth() && ts2.getDate() === f.timestamp.getDate()) {
        if (!realIn || ts2 < realIn) realIn = ts2;
      }
    }

    if (!realIn) {
      skipped.push(f.name + ' (' + Utilities.formatDate(f.timestamp, tz, 'dd/MM HH:mm') + ' -- no earlier IN that day to pair with)');
      return;
    }

    var durationMinutes = Math.round((f.timestamp.getTime() - realIn.getTime()) / 60000);
    var scheduledShift = getScheduledShift_(f.employeeId, f.timestamp);
    var otMinutesForRow = '';
    var otQuartersForRow = '';
    var otForRow = false;
    if (f.department === 'Japanese') {
      var emp = findEmployeeRow_(f.employeeId);
      var capMinutes = emp ? (Number(emp.row.OTMaxMinutes) || JP_OT_CAP_MINUTES) : JP_OT_CAP_MINUTES;
      otMinutesForRow = scheduledShift ? computeJapaneseOtMinutes_(scheduledShift, f.timestamp, capMinutes) : 0;
      otForRow = otMinutesForRow > 0;
    } else {
      otQuartersForRow = 0; // can't know if OUT OT was intended -- see doc comment above
    }

    var rowNum = f.rowIndex + 1;
    sheet.getRange(rowNum, typeCol + 1).setValue('OUT');
    sheet.getRange(rowNum, shiftCol + 1).setValue('');
    sheet.getRange(rowNum, lateCol + 1).setValue('');
    sheet.getRange(rowNum, durationCol + 1).setValue(durationMinutes);
    sheet.getRange(rowNum, otCol + 1).setValue(otForRow);
    sheet.getRange(rowNum, otMinCol + 1).setValue(otMinutesForRow);
    sheet.getRange(rowNum, otQuartersCol + 1).setValue(otQuartersForRow);
    fixedCount++;
  });

  refreshLiveReportSheet_();
  refreshLiveSummarySheet_();

  var summary = 'Fixed ' + fixedCount + ' of ' + flagged.length + ' flagged row(s).';
  if (skipped.length > 0) {
    summary += '\n\nSkipped (no earlier IN that day to pair with):\n' + skipped.join('\n');
  }
  ui.alert('Done', summary + '\n\nReport and Summary tabs have been refreshed.', ui.ButtonSet.OK);
}

/**
 * Adds a new row to the Employees sheet -- auto-generates the next
 * EmployeeID (highest existing "EMP###" + 1) and a unique Kiosk PIN right
 * away, instead of the admin typing the row by hand and running "Generate
 * Kiosk Codes for Everyone" separately afterward. New employee starts
 * Active, with no Schedule/Salary/OT cap set -- fill those in afterward
 * ("Create / Update Schedule Sheet..." for Schedule, or edit the Employees
 * row directly for Salary/OTMaxMinutes).
 */
function menuAddNewEmployee_() {
  var ui = SpreadsheetApp.getUi();
  var title = 'Add New Employee';

  var nameResp = ui.prompt(title, 'Employee name:', ui.ButtonSet.OK_CANCEL);
  if (nameResp.getSelectedButton() !== ui.Button.OK) return;
  var name = nameResp.getResponseText().trim();
  if (!name) { ui.alert('Name cannot be blank.'); return; }

  var deptResp = ui.prompt(title, name + ' -- Department (Japanese or Thai):', ui.ButtonSet.OK_CANCEL);
  if (deptResp.getSelectedButton() !== ui.Button.OK) return;
  var deptInput = deptResp.getResponseText().trim().toLowerCase();
  var department;
  if (deptInput === 'japanese') department = 'Japanese';
  else if (deptInput === 'thai') department = 'Thai';
  else { ui.alert('Department must be Japanese or Thai.'); return; }

  var branchResp = ui.prompt(title, name + ' -- Branch (' + BRANCHES.join(' or ') + '):', ui.ButtonSet.OK_CANCEL);
  if (branchResp.getSelectedButton() !== ui.Button.OK) return;
  var branch = branchResp.getResponseText().trim().toUpperCase();
  if (BRANCHES.indexOf(branch) === -1) {
    ui.alert('Branch must be one of: ' + BRANCHES.join(', ') + '.');
    return;
  }

  ensureColumns_('Employees', ['KioskPIN', 'CreatedAt']);
  var sheet = getSheet_('Employees');
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idCol = headers.indexOf('EmployeeID');
  var pinCol = headers.indexOf('KioskPIN');

  // Next EmployeeID: highest existing "EMP###" number + 1, keeping whatever
  // zero-padded width the sheet already uses (defaults to 3 digits if the
  // sheet has nothing matching yet).
  var maxNum = 0;
  var padWidth = 3;
  for (var i = 1; i < values.length; i++) {
    var match = String(values[i][idCol] || '').match(/^EMP(\d+)$/i);
    if (!match) continue;
    var num = Number(match[1]);
    if (num > maxNum) { maxNum = num; padWidth = match[1].length; }
  }
  var newId = 'EMP' + String(maxNum + 1).padStart(padWidth, '0');

  // Unique Kiosk PIN -- same approach as assignMissingKioskPins_.
  var usedPins = {};
  for (var j = 1; j < values.length; j++) {
    var existingPin = String(values[j][pinCol] || '').trim();
    if (existingPin) usedPins[pad4_(existingPin)] = true;
  }
  var newPin;
  do {
    newPin = randomKioskPin_();
  } while (usedPins[newPin]);

  var confirm = ui.alert(
    title,
    'Add this employee?\n\n' +
    'Name: ' + name + '\n' +
    'Department: ' + department + '\n' +
    'Branch: ' + branch + '\n' +
    'EmployeeID: ' + newId + ' (auto)\n' +
    'Kiosk PIN: ' + newPin + ' (auto)\n' +
    'Active: Yes',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  // Force plain-text format on the PIN cell before writing -- otherwise
  // Sheets can auto-convert e.g. "0422" to the number 422 and silently drop
  // the leading zero (same issue assignMissingKioskPins_ guards against).
  sheet.getRange(sheet.getLastRow() + 1, pinCol + 1).setNumberFormat('@');

  appendRow_('Employees', {
    EmployeeID: newId,
    Name: name,
    Department: department,
    Active: true,
    Branch: branch,
    KioskPIN: newPin,
    CreatedAt: new Date()
  });
  invalidateEmployeesCache_();

  ui.alert(
    'Done',
    name + ' added.\n\nEmployeeID: ' + newId + '\nKiosk PIN: ' + newPin + '\n\n' +
    'Give them the Kiosk PIN to check in/out. Add them to this month\'s Schedule via "Create / Update Schedule Sheet..." to set their shifts.',
    ui.ButtonSet.OK
  );
}

/**
 * Deactivates an employee, optionally effective on a future date -- they
 * stay Active (can keep checking in/out normally) through their entered
 * last working day, and Active switches off automatically the day after via
 * the daily trigger (see setupDailyDeactivationTrigger in Admin.gs). If the
 * date entered is today or already in the past, Active switches off right
 * away instead of waiting for the next trigger run.
 *
 * Leaving the date blank undoes a previous run instead: if they're still
 * Active (deactivation was scheduled for a future date but hasn't happened
 * yet), it just clears that date, so the trigger won't touch them anymore.
 * If they're already Inactive, it reactivates them and clears the date --
 * covers "changed their mind and decided to keep working" either way.
 */
function menuDeactivateEmployee_() {
  var ui = SpreadsheetApp.getUi();
  var title = 'Deactivate Employee';

  var employeeResp = ui.prompt(title, 'Employee name or ID:', ui.ButtonSet.OK_CANCEL);
  if (employeeResp.getSelectedButton() !== ui.Button.OK) return;
  var employee = findEmployeeByNameOrId_(employeeResp.getResponseText().trim());
  if (!employee) {
    ui.alert('No employee found matching "' + employeeResp.getResponseText().trim() + '".');
    return;
  }

  var confirmEmployee = ui.alert(
    title,
    'Found: ' + employee.Name + ' (' + employee.EmployeeID + '). Is this the right person?',
    ui.ButtonSet.YES_NO
  );
  if (confirmEmployee !== ui.Button.YES) return;

  var dateResp = ui.prompt(
    title,
    employee.Name + ' -- Last working day (DD/MM/YYYY), or leave blank to cancel a previous deactivation and keep/restore them Active:',
    ui.ButtonSet.OK_CANCEL
  );
  if (dateResp.getSelectedButton() !== ui.Button.OK) return;

  if (!dateResp.getResponseText().trim()) {
    menuUndoDeactivation_(ui, title, employee);
    return;
  }

  var dateParts = dateResp.getResponseText().trim().split('/');
  if (dateParts.length !== 3) { ui.alert('Enter the date as DD/MM/YYYY.'); return; }
  var day = Number(dateParts[0]), month = Number(dateParts[1]), year = Number(dateParts[2]);
  var lastWorkingDay = new Date(year, month - 1, day);
  if (isNaN(lastWorkingDay.getTime())) { ui.alert('That date did not parse -- double check the values.'); return; }

  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var isFuture = lastWorkingDay.getTime() >= today.getTime();
  var formattedDate = Utilities.formatDate(lastWorkingDay, Session.getScriptTimeZone(), 'dd/MM/yyyy');

  var confirm = ui.alert(
    title,
    'Set ' + employee.Name + '\'s last working day to ' + formattedDate + '?\n\n' +
    (isFuture
      ? 'They can keep checking in/out normally through that day. Active will switch off automatically the day after -- no need to come back and do it manually.'
      : 'That date has already passed, so Active will switch off right away.'),
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  ensureColumns_('Employees', ['LastWorkingDay']);
  var found = findEmployeeRow_(employee.EmployeeID);
  updateEmployeeFields_(found.rowNumber, { LastWorkingDay: lastWorkingDay });
  invalidateEmployeesCache_();

  applyScheduledDeactivations_(); // catches this row immediately if the date is today/past, rather than waiting for tomorrow's trigger run
  var updated = findEmployeeRow_(employee.EmployeeID);
  var deactivatedNow = updated && !isTrue_(updated.row.Active);

  ui.alert(
    'Done',
    employee.Name + '\'s last working day is set to ' + formattedDate + '.\n\n' +
    (deactivatedNow
      ? 'Active has been switched off now.'
      : 'They remain Active until then -- Active will switch off automatically the day after.'),
    ui.ButtonSet.OK
  );
}

/** Blank-date branch of menuDeactivateEmployee_ -- see its doc comment. */
function menuUndoDeactivation_(ui, title, employee) {
  var found = findEmployeeRow_(employee.EmployeeID);
  var wasActive = found && isTrue_(found.row.Active);
  var hadScheduledDate = found && found.row.LastWorkingDay;

  if (wasActive && !hadScheduledDate) {
    ui.alert(employee.Name + ' is already Active with no last working day set -- nothing to cancel.');
    return;
  }

  var confirm = ui.alert(
    title,
    wasActive
      ? 'Cancel ' + employee.Name + '\'s scheduled deactivation? They\'ll stay Active with no last working day set.'
      : 'Reactivate ' + employee.Name + '? Active will be switched back on and their last working day cleared.',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  ensureColumns_('Employees', ['LastWorkingDay']);
  updateEmployeeFields_(found.rowNumber, { Active: true, LastWorkingDay: '' });
  invalidateEmployeesCache_();

  ui.alert('Done', wasActive
    ? employee.Name + '\'s scheduled deactivation has been cancelled -- they remain Active.'
    : employee.Name + ' is Active again.', ui.ButtonSet.OK);
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

  // Report/Summary only pull fresh data when their Year/Month dropdown is
  // edited (see onEdit in Report.gs) -- refresh both here too so whatever
  // month they're currently showing reflects the recompute immediately,
  // without the admin having to flip the dropdown back and forth.
  refreshLiveReportSheet_();
  refreshLiveSummarySheet_();

  ui.alert(
    'Done',
    'Recomputed ' + scheduleMatches.length + ' month(s):\n\n' + summaryLines.join('\n') +
    '\n\nTotal: ' + totalIn + ' IN row(s), ' + totalOut + ' OUT row(s) updated.\n\n' +
    'Thai/non-Japanese OT was left untouched -- it can only be trusted from the moment it was recorded, not recomputed after the fact.\n\n' +
    'Report and Summary tabs have been refreshed to match (whichever month each is currently showing).',
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

  // Extra safety net on top of findEmployeeByNameOrId_ preferring exact name
  // matches -- a partial-name typo could still resolve to the wrong person,
  // so confirm who was actually found before asking anything else.
  var confirmEmployee = ui.alert(
    title,
    'Found: ' + employee.Name + ' (' + employee.EmployeeID + '). Is this the right person?',
    ui.ButtonSet.YES_NO
  );
  if (confirmEmployee !== ui.Button.YES) return;

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
 * admin bulk-record IN for everyone scheduled that day in one pass,
 * defaulting to "on time" for each person, with text-based overrides for
 * late arrival or absence. OUT is deliberately left out -- arrival is
 * predictable (people show up when scheduled), but departure time varies too
 * much to safely assume everyone left at exactly shift-end (OT, early leave,
 * etc.); check-out still gets recorded normally once the kiosk is back, or
 * backfilled individually via Add Backdated Check-in/Check-out if needed.
 * Never overwrites an IN that's already recorded for someone that day.
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

  // Read Schedule and AttendanceLog once each here, not once per employee
  // (see getScheduledShiftsForMonth_/getEmployeeIdsWithInOnDate_) -- this
  // command is meant for marking many employees at once (a full outage
  // day), so a per-employee re-read of either sheet was the same trap that
  // "Recompute Late/OT for ALL Months" used to fall into.
  var scheduledShiftsForMonth = getScheduledShiftsForMonth_(year, month);
  var scheduled = getAllEmployees_()
    .filter(function (emp) { return isTrue_(emp.Active); })
    .map(function (emp) {
      var shift = (scheduledShiftsForMonth[emp.EmployeeID] && scheduledShiftsForMonth[emp.EmployeeID][day]) || '';
      return { employee: emp, shift: shift };
    })
    .filter(function (s) { return s.shift && s.shift !== 'Leave'; }); // "Leave" means intentionally off, not "not scheduled yet" -- exclude from this list

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
  var checkedInIds = getEmployeeIdsWithInOnDate_(date);

  scheduled.forEach(function (s) {
    var emp = s.employee;
    var key = emp.Name.toUpperCase();
    var idKey = String(emp.EmployeeID).toUpperCase();

    if (absentNames.indexOf(key) !== -1 || absentNames.indexOf(idKey) !== -1) {
      absentCount++;
      return;
    }

    var startMatch = s.shift.match(/(\d{1,2}):(\d{2})/);
    if (!startMatch) { errors.push(emp.Name + ': could not read shift start time'); return; }

    var lateMinutes = lateMinutesByName[key] || lateMinutesByName[idKey] || 0;
    var inTime = new Date(year, month - 1, day, Number(startMatch[1]), Number(startMatch[2]), 0);
    inTime = new Date(inTime.getTime() + lateMinutes * 60000);

    if (checkedInIds[String(emp.EmployeeID)]) {
      skippedExisting++;
    } else {
      recordBackdatedAttendance_(emp.EmployeeID, 'IN', inTime, false, s.shift);
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

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
    .addItem('Fill Missed Punches (One at a Time)', 'guardedMenuFillMissedPunches_')
    .addItem('Fix Mis-tapped IN After 16:00 (→ OUT)', 'guardedMenuFixLateInAsOut_')
    .addItem('Add New Employee', 'guardedMenuAddNewEmployee_')
    .addItem('Deactivate Employee (Resignation)', 'guardedMenuDeactivateEmployee_')
    .addItem('Add Backdated Check-in/Check-out', 'guardedMenuAddBackdatedAttendance_')
    .addItem('Cancel Wrong OT for One Day', 'guardedMenuCancelOtForOneDay_')
    .addItem('Bulk Mark Attendance for a Day', 'guardedMenuBulkMarkAttendance_')
    .addItem('Allowancer', 'guardedMenuAddSpecialAllowance_')
    .addItem('Add Historical Summary Month', 'guardedMenuAddHistoricalSummaryRows_')
    .addItem('Create / Update Schedule + Salary Sheet', 'guardedMenuCreateScheduleAndSalarySheets_')
    // Starred -- easy to overlook among the other menu items, but editing or
    // rebuilding a month's Schedule sheet does NOT auto-recompute Late/OT
    // (see menuRecomputeLateOtOneMonth_'s own doc comment); this is the one
    // step an admin has to remember to re-run by hand afterward. Cosmetic
    // only, no behavior change -- admin request, 2026-11-06.
    .addItem('⭐ Recompute Late/OT for One Month', 'guardedMenuRecomputeLateOtOneMonth_')
    .addItem('Print Employee Report (Choose Person/Month/Year)', 'guardedMenuPrintEmployeeReport_')
    .addItem('Print Employee Report - All Employees', 'guardedMenuPrintAllEmployeeReports_')
    .addSeparator()
    .addItem('Issue New Setup Code', 'guardedMenuIssueSetupCode_')
    .addItem('Set Kiosk Exit PIN', 'guardedMenuSetKioskExitPin_')
    .addToUi();
}

/**
 * Every admin command below except Health Check itself goes through
 * preflightHeaderCheck_ (HealthCheck.gs) first -- a cheap tab-name/header
 * check that catches the "EmployeeID got accidentally cleared" class of
 * mistake before whatever the admin actually clicked reads that same sheet.
 * Health Check is excluded here because menuHealthCheck_ already runs the
 * full, comprehensive scan on its own -- running the short version first
 * would just show the same thing twice.
 */
function guardedMenuFillMissedPunches_() { if (preflightHeaderCheck_()) menuFillMissedPunches_(); }
function guardedMenuFixLateInAsOut_() { if (preflightHeaderCheck_()) menuFixLateInAsOut_(); }
function guardedMenuAddNewEmployee_() { if (preflightHeaderCheck_()) menuAddNewEmployee_(); }
function guardedMenuDeactivateEmployee_() { if (preflightHeaderCheck_()) menuDeactivateEmployee_(); }
function guardedMenuAddBackdatedAttendance_() { if (preflightHeaderCheck_()) menuAddBackdatedAttendance_(); }
function guardedMenuCancelOtForOneDay_() { if (preflightHeaderCheck_()) menuCancelOtForOneDay_(); }
function guardedMenuBulkMarkAttendance_() { if (preflightHeaderCheck_()) menuBulkMarkAttendance_(); }
function guardedMenuAddSpecialAllowance_() { if (preflightHeaderCheck_()) menuAddSpecialAllowance_(); }
function guardedMenuAddHistoricalSummaryRows_() { if (preflightHeaderCheck_()) menuAddHistoricalSummaryRows_(); }
function guardedMenuCreateScheduleAndSalarySheets_() { if (preflightHeaderCheck_()) menuCreateScheduleAndSalarySheets_(); }
function guardedMenuRecomputeLateOtOneMonth_() { if (preflightHeaderCheck_()) menuRecomputeLateOtOneMonth_(); }
function guardedMenuPrintEmployeeReport_() { if (preflightHeaderCheck_()) menuPrintEmployeeReport_(); }
function guardedMenuPrintAllEmployeeReports_() { if (preflightHeaderCheck_()) menuPrintAllEmployeeReports_(); }
function guardedMenuIssueSetupCode_() { if (preflightHeaderCheck_()) menuIssueSetupCode_(); }
function guardedMenuSetKioskExitPin_() { if (preflightHeaderCheck_()) menuSetKioskExitPin_(); }

/**
 * Finds IN rows tapped at/after LATE_IN_HOUR_THRESHOLD local time -- no shift
 * in SHIFTS starts this late, so this is almost certainly a mis-tap where
 * someone forgot to switch from IN to OUT when leaving for the day (e.g.
 * NUY on Aug 5-6). Shows what it found and asks for one confirmation before
 * converting all of them to OUT at once. Whole AttendanceLog history, not
 * just the current month, since the sheet is small enough to scan in full.
 *
 * Excludes rows whose own recorded Shift is a Special shift genuinely
 * starting at/after LATE_IN_HOUR_THRESHOLD (e.g. a closing/night-shift
 * employee entered via "Add Backdated Check-in/Check-out") -- caught in
 * review 2026-10-21: without this check, approving the batch to fix real
 * mis-taps would also silently flip that legitimate late-starting IN to
 * OUT, since the confirm below is all-or-nothing and this function has no
 * other way to tell a mis-tap from a correctly-recorded night shift.
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
    if (ts.getHours() < LATE_IN_HOUR_THRESHOLD) continue;

    // A Special shift's own start time can legitimately fall at/after the
    // threshold (night/closing shifts) -- see the function doc comment
    // above. Trust the row's own recorded Shift over the blanket "no shift
    // starts this late" assumption rather than flagging it as a mis-tap.
    var shiftValue = values[i][shiftCol];
    if (isSpecialShift_(shiftValue)) {
      var shiftStart = getShiftStartTime_(shiftValue);
      if (shiftStart && (shiftStart.hour * 60 + shiftStart.minute) >= LATE_IN_HOUR_THRESHOLD * 60) continue;
    }

    flagged.push({ rowIndex: i, timestamp: ts, employeeId: String(values[i][idCol]), name: values[i][nameCol], department: values[i][deptCol] });
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

  // Reused for every flagged entry below via findStintStartInLog_
  // (Attendance.gs) -- that's the SAME stint-aware pairing recordAttendance_/
  // recordOfflineSyncedAttendance_/recordBackdatedAttendance_ already use
  // (earliest IN since the most recent prior OUT, never the earliest IN of
  // the whole day, and never a candidate at/after the reference timestamp).
  // This function used to have its own third, independent copy of that same
  // pairing logic with neither bound -- caught in review, 2026-10-06: it
  // could pair against a legitimate morning IN straight through a real
  // lunch OUT/IN (inflating duration by the whole lunch gap, the exact bug
  // findStintStartInLog_'s own doc comment says was already caught and
  // fixed ONCE elsewhere), and had no "must be strictly before this OUT"
  // bound at all, so a duplicate IN that synced out of order could still
  // get picked and produce a negative DurationMinutes.
  //
  // findStintStartInLog_ itself scans its ENTIRE `log.rows` (filtering by
  // employee row-by-row, not pre-filtered) -- fine for its usual callers
  // (one employee, one live/offline-sync request), but calling it once per
  // FLAGGED entry against the whole `values` array, as a first version of
  // this fix did, turned an O(rows) scan into O(flagged x rows): with
  // AttendanceLog holding months of multi-branch history and mis-taps
  // "potentially numbering in the dozens" (see the batching comment just
  // below, written for the exact same concern), that regressed real work
  // the old per-employee-date index had avoided. Pre-grouping rows by
  // employee here, once, keeps the fix (still the one tested, shared
  // pairing helper, not a second parallel implementation) while restoring
  // the bound: each flagged entry's call now only scans ITS OWN employee's
  // rows, not the whole sheet.
  var rowsByEmployee = {};
  for (var r = 1; r < values.length; r++) {
    var empId = String(values[r][idCol]);
    if (!rowsByEmployee[empId]) rowsByEmployee[empId] = [];
    rowsByEmployee[empId].push(values[r]);
  }

  // Batch-fetch each month's Schedule sheet once instead of re-reading it
  // per flagged entry -- getScheduledShift_ does a full sheet read on every
  // call, and mis-taps can span many months (this scans the whole
  // AttendanceLog, not just the current month -- see doc comment above), so
  // calling it per-entry could mean the same Schedule sheet gets read
  // dozens of times over.
  var scheduledShiftsByMonth = {};
  var scheduledShiftFor_ = function (employeeId, timestamp) {
    var monthKey = timestamp.getFullYear() + '-' + (timestamp.getMonth() + 1);
    if (!scheduledShiftsByMonth[monthKey]) {
      scheduledShiftsByMonth[monthKey] = getScheduledShiftsForMonth_(timestamp.getFullYear(), timestamp.getMonth() + 1);
    }
    var byDay = scheduledShiftsByMonth[monthKey][employeeId];
    return byDay ? (byDay[timestamp.getDate()] || '') : '';
  };

  flagged.forEach(function (f) {
    // Pair with the IN that actually opened THIS stint (same logic the main
    // IN/OUT recording path uses) -- if this mis-tap is the only IN that
    // day, or every other IN that day already belongs to an earlier,
    // already-closed stint, there's no real clock-in to pair with, so skip
    // rather than guess at a duration. Scoped to just this employee's own
    // rows (rowsByEmployee, built once above) -- see that comment for why,
    // rather than handing findStintStartInLog_ the whole sheet every time.
    var employeeLog = { headers: headers, rows: rowsByEmployee[f.employeeId] || [] };
    var realIn = findStintStartInLog_(f.employeeId, f.timestamp, employeeLog);

    if (!realIn) {
      skipped.push(f.name + ' (' + Utilities.formatDate(f.timestamp, tz, 'dd/MM HH:mm') + ' -- no earlier IN that day to pair with)');
      return;
    }

    var durationMinutes = Math.round((f.timestamp.getTime() - realIn.timestamp.getTime()) / 60000);
    var scheduledShift = scheduledShiftFor_(f.employeeId, f.timestamp);
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
 * ("Create / Update Schedule + Salary Sheet..." adds them to both this
 * month's Schedule and Salary sheets in one pass, or edit the Employees
 * row directly for OTMaxMinutes).
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

  appendRow_('Employees', {
    EmployeeID: newId,
    Name: name,
    Department: department,
    Active: true,
    Branch: branch,
    KioskPIN: newPin,
    CreatedAt: new Date(),
    OTEligible: true
  });

  // Force plain-text format on the PIN cell and re-set the value -- setting
  // the format on the row *before* appendRow_ wrote to it didn't reliably
  // stick (appendRow_ writes the whole row through Sheet.appendRow(), a
  // different code path than Range.setValue(), and it could still
  // auto-convert e.g. "0422" to the number 422, silently dropping the
  // leading zero). Formatting the cell that already holds the value, then
  // writing it again, is the same proven approach assignMissingKioskPins_
  // uses.
  var newRow = sheet.getLastRow();
  sheet.getRange(newRow, pinCol + 1).setNumberFormat('@').setValue(newPin);

  invalidateEmployeesCache_();

  ui.alert(
    'Done',
    name + ' added.\n\nEmployeeID: ' + newId + '\nKiosk PIN: ' + newPin + '\n\n' +
    'Give them the Kiosk PIN to check in/out. Add them to this month\'s Schedule and Salary sheets via "Create / Update Schedule + Salary Sheet..." to set their shifts.',
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

/**
 * Combines what used to be two separate menu items ("Create / Update
 * Schedule Sheet" and "Create / Update Salary Sheet") into one -- merged
 * 2026-10-21 per request, since an admin needing one for a given month
 * always needs the other too (a new employee needs a row in both; a new
 * month needs both sheets built before Report/Summary/Print can price it).
 * Builds Schedule then Salary for the resolved month; each builder is
 * independently idempotent (never overwrites a cell an admin already
 * filled in), so re-running this for an already-built month just tops up
 * whatever's missing in either sheet. See buildScheduleSheet_ and
 * buildSalarySheet_'s own doc comments (Report.gs) for what each sheet is
 * for.
 *
 * The "All" (whole fiscal year in one execution) option that used to live
 * here was REMOVED 2026-11-11 -- each month's pair of builder calls could
 * individually hit "Service Spreadsheets timed out" (a real, not-uncommon
 * Google-side hiccup, not a bug in either builder -- retryTransientSheetsError_
 * already retries each call 3x, but a sustained hiccup can still exhaust
 * that), and chaining 12 months of these calls back-to-back in ONE
 * execution only multiplied the chances of hitting it somewhere in the
 * middle AND made the failure harder to see (buried in a 12-month batch
 * rather than obviously tied to the one month just run). One month per
 * click is simpler to reason about when this happens: the admin sees
 * exactly which month failed and just re-runs that same menu item for it
 * -- both builders are already safe to re-run from scratch for a given
 * month, so nothing is lost by requiring one click per month instead of
 * batching.
 */
function menuCreateScheduleAndSalarySheets_() {
  var ui = SpreadsheetApp.getUi();
  var title = 'Create / Update Schedule + Salary Sheet';
  var now = new Date();

  var yearResp = ui.prompt(title, 'Year (e.g. ' + now.getFullYear() + '):', ui.ButtonSet.OK_CANCEL);
  if (yearResp.getSelectedButton() !== ui.Button.OK) return;
  var year = Number(yearResp.getResponseText().trim());
  if (!year) {
    ui.alert('Enter a valid year.');
    return;
  }

  var monthResp = ui.prompt(title, 'Month (1-12):', ui.ButtonSet.OK_CANCEL);
  if (monthResp.getSelectedButton() !== ui.Button.OK) return;
  var monthText = monthResp.getResponseText().trim();

  var month = Number(monthText);
  if (!month || month < 1 || month > 12) {
    ui.alert('Enter a valid month between 1 and 12.');
    return;
  }

  // Caught here, not left to surface as Apps Script's own raw exception
  // dialog, so a sustained "Service Spreadsheets timed out" (rare, but
  // retryTransientSheetsError_'s 3 attempts can still all lose to it) tells
  // the admin plainly what happened and what to do, instead of a bare
  // Google-internal error message with no next step. Both builders are
  // safe to re-run from scratch -- see their own doc comments -- so the
  // fix is always just "run this same menu item again for this month".
  try {
    var scheduleSheetName = retryTransientSheetsError_(function () { return buildScheduleSheet_(year, month); });
    var salarySheetName = retryTransientSheetsError_(function () { return buildSalarySheet_(year, month); });
  } catch (e) {
    // Short and actionable, not Apps Script's own raw exception dialog --
    // both builders are safe to re-run from scratch (see their own doc
    // comments), so there's never more to say than "try again".
    ui.alert(title, 'Temporary Google Sheets error -- please try again.', ui.ButtonSet.OK);
    return;
  }
  ui.alert('Success', '"' + scheduleSheetName + '" and "' + salarySheetName + '" are ready.', ui.ButtonSet.OK);
}

/**
 * Recomputes Late/OT for ONE chosen month -- the only way to run this now (an
 * "all months at once" variant used to exist too, removed since it went
 * unused; run this once per month instead).
 */
function menuRecomputeLateOtOneMonth_() {
  var ui = SpreadsheetApp.getUi();
  var title = 'Recompute Late/OT for One Month';
  var now = new Date();

  var yearResp = ui.prompt(title, 'Year (e.g. ' + now.getFullYear() + '):', ui.ButtonSet.OK_CANCEL);
  if (yearResp.getSelectedButton() !== ui.Button.OK) return;
  var year = Number(yearResp.getResponseText().trim());

  var monthResp = ui.prompt(title, 'Month (1-12):', ui.ButtonSet.OK_CANCEL);
  if (monthResp.getSelectedButton() !== ui.Button.OK) return;
  var month = Number(monthResp.getResponseText().trim());

  if (!year || !month || month < 1 || month > 12) {
    ui.alert('Enter a valid year and a month between 1 and 12.');
    return;
  }

  var sheetName = 'Schedule ' + year + '-' + (month < 10 ? '0' + month : month);
  var scheduleSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!scheduleSheet) {
    ui.alert('No "' + sheetName + '" sheet found -- nothing to recompute against.');
    return;
  }

  var confirm = ui.alert(title, 'Recompute Late/OT for ' + sheetName + '?', ui.ButtonSet.YES_NO);
  if (confirm !== ui.Button.YES) return;

  var daysInMonth = new Date(year, month, 0).getDate();
  var preview = previewRecomputeLateAndOt_(year, month, 1, daysInMonth);

  // Second confirm, only when something's actually at risk: a row whose OT
  // is already real and non-zero would drop to 0 under the newly-resolved
  // shift (see previewRecomputeLateAndOt_'s own doc comment -- the Half Day
  // Leave fix is the main cause, but this catches any cause). Declining
  // reverts ONLY those specific rows' OT columns back to what they already
  // were, in memory, before the write below -- everything else this month
  // (every IN row's Shift/Late, every other OUT row's OT) still recomputes
  // normally either way.
  var skippedCount = 0;
  if (preview.otRegressions.length > 0) {
    var regressionLines = preview.otRegressions.map(function (reg) {
      var oldAmount = reg.department === 'Japanese' ? reg.originalOtMinutes + ' min' : reg.originalOtQuarters + ' quarter(s)';
      return reg.name + ', day ' + reg.day + ': currently has ' + oldAmount + ' OT recorded -- would become 0 under this recompute.';
    });
    var otResp = ui.alert(
      title,
      'The following ' + preview.otRegressions.length + ' row(s) currently have real OT recorded, but the Schedule now shown for that day computes 0 OT instead (e.g. a Half Day Leave cell with no matching work hours):\n\n' +
      regressionLines.join('\n') +
      '\n\nOverwrite these with 0 anyway? Choose No to leave just these specific row(s)\' OT untouched while everything else this month still recomputes normally.',
      ui.ButtonSet.YES_NO
    );
    if (otResp !== ui.Button.YES) {
      preview.otRegressions.forEach(function (reg) {
        preview.sliceValues[reg.rowIndex][preview.cols.otMinCol] = reg.originalOtMinutes;
        preview.sliceValues[reg.rowIndex][preview.cols.otCol] = reg.originalOtFlag;
        if (preview.cols.otQCol !== -1) preview.sliceValues[reg.rowIndex][preview.cols.otQCol] = reg.originalOtQuarters;
      });
      skippedCount = preview.otRegressions.length;
    }
  }

  commitRecomputeResult_(preview);

  // Report/Summary only pull fresh data when their Year/Month dropdown is
  // edited (see onEdit in Report.gs) -- refresh both here too so whatever
  // month they're currently showing reflects the recompute immediately,
  // without the admin having to flip the dropdown back and forth.
  refreshLiveReportSheet_();
  refreshLiveSummarySheet_();

  // Same "scheduled but no check-in at all" check Health Check runs, for
  // the month just recomputed -- surfaces forgotten punches / days that
  // should have been marked Leave right here, instead of waiting for a
  // separate Health Check run to notice.
  var activeEmployees = getAllEmployees_().filter(function (emp) { return isTrue_(emp.Active); });
  var missingFindings = [];
  checkMissingAttendance_(missingFindings, activeEmployees, year, month);

  var message = 'Recomputed ' + sheetName + ':\n\n' +
    preview.inRowsUpdated + ' IN row(s), ' + preview.outRowsUpdated + ' OUT row(s) updated ' +
    '(OT -- Japanese: minutes, Thai/other: quarters, only where OT was already TRUE).\n\n' +
    'Report and Summary tabs have been refreshed to match (whichever month each is currently showing).';

  if (skippedCount > 0) {
    message += '\n\n' + skippedCount + ' row(s) left unchanged at your request, to avoid losing existing OT.';
  }

  if (missingFindings.length > 0) {
    var missingLines = missingFindings.map(function (f, i) { return (i + 1) + '. ' + f.message; });
    message += '\n\n⚠ ' + missingFindings.length + ' day(s) scheduled with no check-in at all:\n\n' + missingLines.join('\n');
  }

  ui.alert('Done', message, ui.ButtonSet.OK);
}

/**
 * Generates one employee's report for one month as a PDF -- picks the
 * person by name/ID (same lookup as Add Backdated Check-in/Check-out),
 * then Year and Month, builds the report on a throwaway sheet (same table/
 * colors/borders as the full Report sheet, via writeMonthlyReportData_'s
 * onlyEmployeeId option), exports that sheet to PDF, saves it into an
 * "Attendance Reports" Drive folder, then deletes the throwaway sheet --
 * see generateEmployeeReportPdf_ below for the export/cleanup details.
 * Nothing new is left behind in the spreadsheet itself, on purpose: no tab
 * to remember to delete afterward (and risk deleting the wrong one).
 */
function menuPrintEmployeeReport_() {
  var ui = SpreadsheetApp.getUi();
  var title = 'Print Employee Report';

  var employeeResp = ui.prompt(title, 'Employee name or ID:', ui.ButtonSet.OK_CANCEL);
  if (employeeResp.getSelectedButton() !== ui.Button.OK) return;
  var employee = findEmployeeByNameOrId_(employeeResp.getResponseText().trim());
  if (!employee) {
    ui.alert(title, 'No employee found matching "' + employeeResp.getResponseText().trim() + '"', ui.ButtonSet.OK);
    return;
  }

  // Same extra confirmation step menuAddBackdatedAttendance_ uses -- a
  // partial-name match could resolve to the wrong person.
  var confirmEmployee = ui.alert(title, 'Found: ' + employee.Name + ' (' + employee.EmployeeID + '). Is this the right person?', ui.ButtonSet.YES_NO);
  if (confirmEmployee !== ui.Button.YES) return;

  var now = new Date();
  var yearResp = ui.prompt(title, 'Year (e.g. ' + now.getFullYear() + '):', ui.ButtonSet.OK_CANCEL);
  if (yearResp.getSelectedButton() !== ui.Button.OK) return;
  var year = Number(yearResp.getResponseText().trim());

  var monthResp = ui.prompt(title, 'Month (1-12):', ui.ButtonSet.OK_CANCEL);
  if (monthResp.getSelectedButton() !== ui.Button.OK) return;
  var month = Number(monthResp.getResponseText().trim());

  if (!year || !month || month < 1 || month > 12) {
    ui.alert(title, 'Enter a valid year and a month between 1 and 12.', ui.ButtonSet.OK);
    return;
  }

  var pdfFile;
  try {
    pdfFile = generateEmployeeReportPdf_(employee, year, month);
  } catch (err) {
    ui.alert(title, 'Could not generate the PDF: ' + err.message, ui.ButtonSet.OK);
    return;
  }

  var html = HtmlService.createHtmlOutput(
    '<div style="font-family:Arial,sans-serif;padding:6px;">' +
    '<p>PDF is ready!</p>' +
    '<p><a href="' + pdfFile.getUrl() + '" target="_blank" style="font-size:16px;">📄 Open / Download PDF</a></p>' +
    '<p style="color:#666;font-size:12px;">Anyone with this link can open it -- feel free to forward it to the employee or anyone else.</p>' +
    '</div>'
  ).setWidth(340).setHeight(160);
  ui.showModalDialog(html, title);
}

/**
 * Same idea as menuPrintEmployeeReport_ above, but for the whole roster at
 * once -- one Year/Month prompt (no name lookup needed), one ZIP containing
 * every employee's own correctly-paginated PDF (same "Active, or has data
 * this month" roster the live Report sheet uses -- getSortedReportEmployees_,
 * Report.gs).
 *
 * This only STARTS the job (startAllEmployeesReportJob_, Report.gs) -- it
 * does not wait for it. Generating 50-59 individual PDFs always takes
 * longer than Apps Script's one execution can run for, confirmed by three
 * different approaches all failing against the real roster (see
 * startAllEmployeesReportJob_'s own doc comment for the full history), so
 * the work is spread across several background executions a time-based
 * trigger chains together instead. There's no link to hand back here --
 * nothing is ready yet -- just a "started, check back later" dialog.
 */
function menuPrintAllEmployeeReports_() {
  var ui = SpreadsheetApp.getUi();
  var title = 'Print Employee Report - All Employees';

  var now = new Date();
  var yearResp = ui.prompt(title, 'Year (e.g. ' + now.getFullYear() + '):', ui.ButtonSet.OK_CANCEL);
  if (yearResp.getSelectedButton() !== ui.Button.OK) return;
  var year = Number(yearResp.getResponseText().trim());

  var monthResp = ui.prompt(title, 'Month (1-12):', ui.ButtonSet.OK_CANCEL);
  if (monthResp.getSelectedButton() !== ui.Button.OK) return;
  var month = Number(monthResp.getResponseText().trim());

  if (!year || !month || month < 1 || month > 12) {
    ui.alert(title, 'Enter a valid year and a month between 1 and 12.', ui.ButtonSet.OK);
    return;
  }

  // Same roster the PDF itself will use (getSortedReportEmployees_), counted
  // here first just so the confirmation step below can say how many people
  // are about to be included -- startAllEmployeesReportJob_ re-counts this
  // same way internally too (it has to, to start the job), but counting it
  // here first gives a chance to back out (or see "no one to include") on
  // this prompt before committing to a background job at all.
  var logsByEmployee = getMonthLogsByEmployee_(year, month);
  var employeeCount = getSortedReportEmployees_(logsByEmployee, undefined).length;
  if (employeeCount === 0) {
    ui.alert(title, 'No employees to include for that month (none are Active and none have any data).', ui.ButtonSet.OK);
    return;
  }
  var confirm = ui.alert(
    title,
    'This will generate a ZIP file containing ' + employeeCount + ' individual PDF(s), one per employee, for ' +
      Utilities.formatDate(new Date(year, month - 1, 1), Session.getScriptTimeZone(), 'MMMM yyyy') +
      '. This runs in the background in small batches and can take 10-15 minutes in total -- you will NOT get a link right away. Continue?',
    ui.ButtonSet.YES_NO
  );
  if (confirm !== ui.Button.YES) return;

  var result;
  try {
    // logsByEmployee was already read above for the roster count -- passed
    // through so startAllEmployeesReportJob_ doesn't read the whole
    // AttendanceLog sheet a second time right after this.
    result = startAllEmployeesReportJob_(year, month, logsByEmployee);
  } catch (err) {
    ui.alert(title, 'Could not start the job: ' + err.message, ui.ButtonSet.OK);
    return;
  }

  if (!result.started) {
    ui.alert(title, result.message, ui.ButtonSet.OK);
    return;
  }

  ui.alert(
    title,
    'Started -- generating ' + result.totalCount + ' individual PDF(s) in the background, in small batches.\n\n' +
      'Check the "Attendance Reports" Drive folder in about 10-15 minutes for "All Employee Reports - ' +
      Utilities.formatDate(new Date(year, month - 1, 1), Session.getScriptTimeZone(), 'yyyy-MM') + '.zip".',
    ui.ButtonSet.OK
  );
}

/**
 * Builds one employee's report for one month and saves it into an
 * "Attendance Reports" Drive folder (see getOrCreateDriveFolder_) -- the
 * actual throwaway-sheet/export/cleanup work is buildEmployeeReportPdfBlob_
 * (Report.gs), shared with continueAllEmployeesReportBatch_'s per-batch
 * loop. Returns the Drive File, shared as "anyone with the link can view"
 * -- a fresh Drive file is owner-only by default, which the admin running
 * this from the shared spreadsheet would not expect (the report used to
 * live as a sheet inside that already-shared spreadsheet); this keeps the
 * resulting link usable for whoever it gets forwarded to, same as the
 * QR-code APK links this project already shares the same way.
 */
function generateEmployeeReportPdf_(employee, year, month) {
  var tz = Session.getScriptTimeZone();
  var blob = buildEmployeeReportPdfBlob_(employee, year, month);
  var fileName = 'Report - ' + employee.Name + ' - ' +
    Utilities.formatDate(new Date(year, month - 1, 1), tz, 'yyyy-MM') + '.pdf';
  blob.setName(fileName);

  // Always a brand new file -- reprinting the same employee/month (e.g.
  // after fixing a backdated punch) keeps the earlier PDF around too,
  // rather than trashing it, so there's a paper trail of what a report
  // looked like at each point instead of only ever the latest version.
  var folder = getOrCreateDriveFolder_('Attendance Reports');
  var file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return file;
}

/** Shared by generateEmployeeReportPdf_ and Backup.gs's getOrCreateBackupFolder_ -- same get-or-create-by-name pattern, one Drive folder per purpose. */
function getOrCreateDriveFolder_(name) {
  var folders = DriveApp.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(name);
}

/**
 * Backfills a missed IN and/or OUT (e.g. someone forgot to tap the kiosk, or
 * worked off-site all day and never touched it) with the same
 * Shift/Late/Duration/OT computation a live check-in would use. Both can be
 * entered together in one pass -- one employee, one date, then IN and OUT
 * are each asked for separately with "leave blank to skip", so a
 * worked-off-site day only needs one trip through this menu item instead of
 * two. IN is always recorded before OUT when both are given, because OUT's
 * duration/OT calculation (recordBackdatedAttendance_ ->
 * findStintStartInForDate_) looks up the matching IN row -- recording OUT
 * first would silently come out with no duration and no OT.
 *
 * Uses a chain of native ui.prompt()/ui.alert() calls rather than an
 * HtmlService dialog with IN/OUT/OT as actual form fields -- an earlier
 * version used a dialog with a dropdown and a date picker, but
 * google.script.run inside that dialog only worked for the file's owner,
 * not for other Editors (Apps Script couldn't complete the authorization
 * flow for them there). Plain prompts run through Sheets' own UI directly,
 * no separate authorization step, so every Editor can use this.
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

  var dateResp = ui.prompt(title, 'Date (DD/MM/YYYY), e.g. 24/07/2026 -- used for both IN and OUT below:', ui.ButtonSet.OK_CANCEL);
  if (dateResp.getSelectedButton() !== ui.Button.OK) return;
  var dateParts = dateResp.getResponseText().trim().split('/');
  if (dateParts.length !== 3) { ui.alert('Enter the date as DD/MM/YYYY.'); return; }
  var day = Number(dateParts[0]), month = Number(dateParts[1]), year = Number(dateParts[2]);

  // Order matters: IN asked (and, below, recorded) before OUT -- see this
  // function's doc comment for why.
  var entries = []; // { type: 'IN' | 'OUT', timestamp: Date }
  var types = ['IN', 'OUT'];
  for (var i = 0; i < types.length; i++) {
    var type = types[i];
    var timeResp = ui.prompt(
      title,
      employee.Name + ' -- ' + type + ' time (24-hour HH:MM), e.g. 08:30. Leave blank to skip:',
      ui.ButtonSet.OK_CANCEL
    );
    if (timeResp.getSelectedButton() !== ui.Button.OK) return;
    var timeText = timeResp.getResponseText().trim();
    if (!timeText) continue;

    var timeParts = timeText.split(':');
    if (timeParts.length !== 2) { ui.alert('Enter the time as HH:MM.'); return; }
    var timestamp = new Date(year, month - 1, day, Number(timeParts[0]), Number(timeParts[1]), 0);
    if (isNaN(timestamp.getTime())) {
      ui.alert('That date/time did not parse -- double check the values.');
      return;
    }
    entries.push({ type: type, timestamp: timestamp });
  }

  if (entries.length === 0) {
    ui.alert('Enter a time for at least one of IN or OUT.');
    return;
  }

  var inEntry = entries.find(function (e) { return e.type === 'IN'; });
  var outEntry = entries.find(function (e) { return e.type === 'OUT'; });
  if (inEntry && outEntry && outEntry.timestamp.getTime() <= inEntry.timestamp.getTime()) {
    ui.alert('OUT time must be after IN time.');
    return;
  }

  var ot = false;
  if (outEntry) {
    var otResp = ui.alert(title, 'Was the OUT overtime (OT)?', ui.ButtonSet.YES_NO);
    ot = otResp === ui.Button.YES;
  }

  var warnings = [];
  entries.forEach(function (e) {
    if (e.timestamp.getTime() > Date.now()) {
      warnings.push(e.type + ' is in the future.');
    }
    var existing = findLogEntryForDate_(employee.EmployeeID, e.type, e.timestamp);
    if (existing) {
      warnings.push(
        employee.Name + ' already has a ' + e.type + ' recorded that day (at ' +
        Utilities.formatDate(existing.timestamp, Session.getScriptTimeZone(), 'HH:mm') + ').'
      );
    }
  });
  if (warnings.length > 0) {
    var confirmResp = ui.alert(title, warnings.join('\n') + '\n\nAdd anyway?', ui.ButtonSet.YES_NO);
    if (confirmResp !== ui.Button.YES) return;
  }

  var tz = Session.getScriptTimeZone();
  var summaryLines = [];
  // entries is already IN-before-OUT (the types loop above pushes in that
  // fixed order) -- OUT's duration/OT lookup needs the IN row to exist
  // already, so this order is load-bearing, not cosmetic.
  entries.forEach(function (e) {
    var result = recordBackdatedAttendance_(employee.EmployeeID, e.type, e.timestamp, ot);
    var line = e.type + (e.type === 'OUT' && ot ? ' OT' : '') + ' @ ' + Utilities.formatDate(e.timestamp, tz, 'dd-MM-yyyy HH:mm');
    if (e.type === 'IN') {
      line += '\n  Shift: ' + (result.shift || '(none found in Schedule for that date)') + ', Late: ' + result.late;
    } else {
      line += '\n  Duration: ' + (result.durationMinutes !== '' ? result.durationMinutes + ' min' : '(no matching IN found that date)');
      line += result.department === 'Japanese'
        ? ', OT: ' + (result.otMinutes || 0) + ' min'
        : ', OT: ' + (result.otQuarters || 0) + ' quarter(s)';
    }
    summaryLines.push(line);
  });

  ui.alert('Done', employee.Name + '\n' + summaryLines.join('\n'), ui.ButtonSet.OK);
}

/**
 * Corrects the specific mistake this was built for (admin request,
 * 2026-11-12): an employee -- Thai/other in practice, since Japanese OUT/
 * OUT OT are equivalent and always auto-computed -- presses "OUT OT" on a
 * day that should carry no OT at all. There's no menu item that already
 * covers this: "Fix Mis-tapped IN After 16:00" is a different mistake (wrong
 * Type, not a wrong OT flag) and "⭐ Recompute Late/OT for One Month"
 * deliberately leaves an already-OT=TRUE Thai row alone unless the day's
 * Schedule shift says Event/Special/Holiday or the employee's global
 * OTEligible is off (see its own doc comment in Attendance.gs) -- neither
 * is true here, so Recompute cannot undo this by itself. The only real fix
 * is editing the stored OT/OTQuarters cells directly, which is exactly what
 * this does, with the same employee-lookup/confirm pattern as "Add
 * Backdated Check-in/Check-out" above.
 *
 * Finds every OUT row that day via findAllOutRowsForDate_ (Attendance.gs)
 * rather than assuming there's only one -- aggregateMonthLogs_ (Report.gs)
 * always takes whichever OUT row has the latest timestamp as the one that
 * feeds Summary/Dashboard/Kiosk My Schedule, so if more than one exists
 * (e.g. a past "Add Backdated..." correction left an extra row), only the
 * latest one can actually be carrying the live OT value -- the admin is
 * told this explicitly rather than the tool silently guessing.
 */
function menuCancelOtForOneDay_() {
  var ui = SpreadsheetApp.getUi();
  var title = 'Cancel Wrong OT for One Day';

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

  var dateResp = ui.prompt(title, 'Date (DD/MM/YYYY), e.g. 24/07/2026 -- the day OUT OT was tapped by mistake:', ui.ButtonSet.OK_CANCEL);
  if (dateResp.getSelectedButton() !== ui.Button.OK) return;
  var dateParts = dateResp.getResponseText().trim().split('/');
  if (dateParts.length !== 3) { ui.alert('Enter the date as DD/MM/YYYY.'); return; }
  var day = Number(dateParts[0]), month = Number(dateParts[1]), year = Number(dateParts[2]);
  var date = new Date(year, month - 1, day);
  if (isNaN(date.getTime())) { ui.alert('That date did not parse -- double check the values.'); return; }

  var tz = Session.getScriptTimeZone();
  var outRows = findAllOutRowsForDate_(employee.EmployeeID, date);
  if (outRows.length === 0) {
    ui.alert(title, 'No OUT record found for ' + employee.Name + ' on that date.', ui.ButtonSet.OK);
    return;
  }

  // findAllOutRowsForDate_ already returns these latest-first, matching
  // aggregateMonthLogs_'s own "latest OUT wins" rule -- see its doc comment.
  var target = outRows[0];
  if (outRows.length > 1) {
    var multiWarn = ui.alert(
      title,
      employee.Name + ' has ' + outRows.length + ' OUT records on that date. Only the latest one (' +
      Utilities.formatDate(target.timestamp, tz, 'HH:mm') +
      ') is the one that actually counts toward OT/Duration everywhere -- continue with that one?',
      ui.ButtonSet.YES_NO
    );
    if (multiWarn !== ui.Button.YES) return;
  }

  if (!target.ot) {
    ui.alert(
      title,
      employee.Name + '\'s OUT at ' + Utilities.formatDate(target.timestamp, tz, 'HH:mm') + ' on that date already has no OT -- nothing to cancel.',
      ui.ButtonSet.OK
    );
    return;
  }

  var otAmountText = target.department === 'Japanese'
    ? (target.otMinutes || 0) + ' min'
    : (target.otQuarters || 0) + ' quarter(s)';
  var confirmCancel = ui.alert(
    title,
    'Cancel OT (' + otAmountText + ') for ' + employee.Name + ' on ' +
    Utilities.formatDate(target.timestamp, tz, 'dd-MM-yyyy') + ' (OUT at ' +
    Utilities.formatDate(target.timestamp, tz, 'HH:mm') + ')?',
    ui.ButtonSet.YES_NO
  );
  if (confirmCancel !== ui.Button.YES) return;

  cancelOtOnLogRow_(target.rowIndex, target.department);

  ui.alert('Success', 'OT cancelled for ' + employee.Name + ' on ' + Utilities.formatDate(target.timestamp, tz, 'dd-MM-yyyy') + '.', ui.ButtonSet.OK);
}

/**
 * Shared Year/Month prompt + validation for menuAddSpecialAllowance_ below
 * -- same two ui.prompt() calls and the same "thisYear-1..thisYear+3, both
 * whole numbers" sanity check, factored out so it stays in exactly one
 * place.
 *
 * Same "thisYear-1 .. thisYear+3" sane range the Report/Summary sheets'
 * own Year dropdown uses (setupLiveReportSheet/setupLiveSummarySheet,
 * above) -- without a range check here, a typo like "20226" or "-2026"
 * passes the bare !year check (a truthy, non-NaN number) and silently
 * writes a row nobody will ever see on any real Summary/Report view for
 * that year/month, looking to the admin like the entry "didn't save".
 * Also requires both to be whole numbers -- every reader
 * (getAllowancesForMonth_/aggregateSpecialAllowancesForYear_, Allowances.gs)
 * matches Year/Month by exact equality against integers it's given, so a
 * non-integer typo like "6.5" would pass a range-only check, get written as
 * Month=6.5, and then never be matched by any Summary total or PDF print --
 * permanently invisible despite the "Added" alert firing.
 *
 * Returns {year, month} on success, or null if the admin cancelled or the
 * input didn't pass validation -- an ui.alert has already been shown in
 * that case, so the caller just needs to `return` without its own message.
 */
function promptForAllowanceYearMonth_(ui, title) {
  var now = new Date();
  var yearResp = ui.prompt(title, 'Year (e.g. ' + now.getFullYear() + '):', ui.ButtonSet.OK_CANCEL);
  if (yearResp.getSelectedButton() !== ui.Button.OK) return null;
  var year = Number(yearResp.getResponseText().trim());

  var monthResp = ui.prompt(title, 'Month (1-12):', ui.ButtonSet.OK_CANCEL);
  if (monthResp.getSelectedButton() !== ui.Button.OK) return null;
  var month = Number(monthResp.getResponseText().trim());

  if (!year || !month || !Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12 ||
      year < now.getFullYear() - 1 || year > now.getFullYear() + 3) {
    ui.alert(title, 'Enter a valid whole-number year (around ' + now.getFullYear() + ') and a whole-number month between 1 and 12.', ui.ButtonSet.OK);
    return null;
  }

  return { year: year, month: month };
}

/**
 * Records one or more Special Allowance entries -- a flexible, admin-named
 * monthly money amount (e.g. "ค่าข้าว" rice allowance, a one-off tip bonus,
 * "Lunch") kept in its own "Allowances" sheet (Allowances.gs) and
 * deliberately never touching computeOtPay_ or anything OT-related, so this
 * can never get mixed into the OT Pay figure.
 *
 * Takes a comma-separated list of employee names/IDs -- one name works just
 * as well as several, so this single menu item covers both "give one person
 * a bonus" and "give the same Lunch allowance to everyone on this shift" in
 * one flow, instead of keeping two near-identical dialogs (an earlier
 * version of this feature had a separate single-employee item; it was
 * folded into this one once it became clear the comma-separated flow
 * already handles a list of exactly one name with no extra friction). Every
 * included employee gets the exact same label/amount/year/month -- this is
 * deliberately not a per-person-value tool; for different amounts per
 * person, run this again with a different list.
 *
 * One employee can have more than one entry in the same month (e.g. rice
 * allowance AND a tip bonus together) -- running this menu item again for
 * the same person/month just adds another row rather than overwriting the
 * last one. A mistaken entry is fixed by editing/deleting its row directly
 * in the Allowances sheet -- no separate "remove" menu item, same as how a
 * bad AttendanceLog row is already corrected by hand today.
 *
 * Same chained ui.prompt()/ui.alert() pattern as menuAddBackdatedAttendance_
 * above -- see that function's doc comment for why this project never uses
 * an HtmlService form for Admin input. Same split this project's other bulk
 * action (menuBulkMarkAttendance_, above) uses between "the shared part"
 * and "who's included": there, the group is auto-computed from the Schedule
 * sheet and the admin only types exceptions; here there's no such natural
 * group to start from (an allowance isn't tied to who was scheduled), so
 * the admin instead types the whole list up front, comma-separated, the
 * same way menuBulkMarkAttendance_'s own absent/late override prompts
 * already ask for names -- not a new input shape for this project's admins
 * to learn.
 */
function menuAddSpecialAllowance_() {
  var ui = SpreadsheetApp.getUi();
  var title = 'Allowancer'; // matches the "Allowancer" menu label (onOpen above) -- every dialog in this flow shares this one title string

  var namesResp = ui.prompt(title, 'Employee names or IDs, comma-separated (e.g. SHUNYA, EMP025, AYAMI):', ui.ButtonSet.OK_CANCEL);
  if (namesResp.getSelectedButton() !== ui.Button.OK) return;
  var queries = namesResp.getResponseText().split(',')
    .map(function (s) { return s.trim(); })
    .filter(String);
  if (queries.length === 0) {
    ui.alert(title, 'Enter at least one employee name or ID.', ui.ButtonSet.OK);
    return;
  }

  // Resolve every query, then dedupe by EmployeeID -- two different typed
  // queries (e.g. a name and that same person's ID) resolving to the same
  // employee would otherwise silently double their allowance for this
  // batch, which is almost certainly not what typing both was meant to do.
  var matched = []; // array of resolved employee row objects (one per unique EmployeeID)
  var matchedIds = {}; // EmployeeID -> true, dedupe tracker for the loop below -- not stored on `matched` itself
  var unmatchedQueries = [];
  queries.forEach(function (query) {
    var employee = findEmployeeByNameOrId_(query);
    if (!employee) {
      unmatchedQueries.push(query);
      return;
    }
    if (!matchedIds[employee.EmployeeID]) {
      matchedIds[employee.EmployeeID] = true;
      matched.push(employee);
    }
  });

  // Checked BEFORE the unmatched-continue prompt below -- with zero matches,
  // "Continue with the 0 employee(s) that WERE found?" is a nonsensical
  // question that invites a reflexive YES misread as "continue with
  // everyone" when there is nothing to continue with at all.
  if (matched.length === 0) {
    ui.alert(title, 'No employees matched "' + unmatchedQueries.join(', ') + '" -- nothing to add.', ui.ButtonSet.OK);
    return;
  }

  if (unmatchedQueries.length > 0) {
    var continueResp = ui.alert(
      title,
      'Could not find: ' + unmatchedQueries.join(', ') + '.\n\n' +
      'Continue with the ' + matched.length + ' employee(s) that WERE found?',
      ui.ButtonSet.YES_NO
    );
    if (continueResp !== ui.Button.YES) return;
  }

  // Same "Found: ... Is this the right person?" confirmation reasoning as
  // menuAddBackdatedAttendance_ above -- a partial-name match could resolve
  // to the wrong person, and showing the whole resolved list up front (not
  // just each name in isolation) also makes it easy to spot a
  // duplicate/unintended match before any real payroll data gets written.
  var namesList = matched.map(function (e) { return e.Name + ' (' + e.EmployeeID + ')'; }).join('\n');
  var confirmList = ui.alert(title, 'Found ' + matched.length + ' employee(s):\n' + namesList + '\n\nIs this list correct?', ui.ButtonSet.YES_NO);
  if (confirmList !== ui.Button.YES) return;

  var yearMonth = promptForAllowanceYearMonth_(ui, title);
  if (!yearMonth) return;
  var year = yearMonth.year, month = yearMonth.month;

  var labelResp = ui.prompt(title, 'Name this allowance (e.g. Lunch, ค่าข้าว):', ui.ButtonSet.OK_CANCEL);
  if (labelResp.getSelectedButton() !== ui.Button.OK) return;
  var label = labelResp.getResponseText().trim();
  if (!label) {
    ui.alert(title, 'Enter a name for this allowance.', ui.ButtonSet.OK);
    return;
  }

  var amountResp = ui.prompt(title, 'Amount per employee (Baht):', ui.ButtonSet.OK_CANCEL);
  if (amountResp.getSelectedButton() !== ui.Button.OK) return;
  var amount = Number(amountResp.getResponseText().trim());
  if (!(amount > 0)) {
    ui.alert(title, 'Enter a positive number for the amount.', ui.ButtonSet.OK);
    return;
  }

  var confirmWrite = ui.alert(
    title,
    matched.length + ' employee(s) -- ' + label + ': ' + amount + ' Baht each, for ' + month + '/' + year +
    // Round the PER-ENTRY amount first, then multiply by count -- not
    // round2_(count * amount) -- matching the "round each stored row, then
    // sum" order writeMonthlySummaryData_/aggregateSpecialAllowancesForYear_
    // (Report.gs/Allowances.gs) already use, so this preview total can
    // never disagree by a cent with what those later reports compute for
    // this same batch.
    ' (total ' + round2_(round2_(amount) * matched.length) + ' Baht).\n\nAdd this?',
    ui.ButtonSet.YES_NO
  );
  if (confirmWrite !== ui.Button.YES) return;

  // getActiveUser().getEmail() can come back blank (or throw, on some
  // domain setups) if this Editor hasn't granted the script permission to
  // see their email -- AddedBy is an audit nice-to-have, never worth
  // blocking the actual allowance write over.
  var addedBy = '';
  try {
    addedBy = Session.getActiveUser().getEmail();
  } catch (e) {}

  // Resolve the sheet once and pass it through, instead of every one of
  // (possibly dozens of) appendSpecialAllowance_ calls below re-acquiring
  // the script lock and re-doing getSheetByName for a sheet that's already
  // guaranteed to exist after the very first row.
  var sheet = getOrCreateAllowancesSheet_();

  // Per-employee try/catch, same as menuBulkMarkAttendance_'s own write
  // loop above -- one employee's write failing (e.g. a transient Sheets
  // error) must not silently abort the rest of the batch or leave the
  // admin facing a raw script error with no idea which of the N people
  // actually got paid (and re-running blind would double-pay whoever
  // already succeeded).
  var addedNames = [];
  var failures = [];
  matched.forEach(function (employee) {
    try {
      appendSpecialAllowance_(employee.EmployeeID, employee.Name, year, month, label, amount, '', addedBy, sheet);
      addedNames.push(employee.Name);
    } catch (e) {
      failures.push(employee.Name + ': ' + (e && e.message ? e.message : String(e)));
    }
  });

  var summary = 'Added ' + addedNames.length + ' entries (' + label + ': ' + amount + ' Baht each, ' + month + '/' + year + '):\n' +
    addedNames.join(', ');
  if (failures.length > 0) {
    summary += '\n\nFailed (' + failures.length + ') -- these were NOT added, try again for just these:\n' + failures.join('\n');
  }
  ui.alert(title, summary, ui.ButtonSet.OK);
}

/**
 * Seeds one blank row per Active employee into the "Historical Summary"
 * sheet (HistoricalSummary.gs) for an admin-chosen Year/Month -- the record
 * for months BEFORE this system went live and started tracking real
 * AttendanceLog/Schedule/Salary data, typed in by hand from whatever old
 * record the admin already has instead of computed from logs. See
 * HistoricalSummary.gs's own top-of-file comment for the full reasoning,
 * but the short version: once filled in, these numbers DO appear on the
 * Dashboard/Summary/"All"/Print Report -- but only for an employee/month
 * with no real AttendanceLog/Schedule data at all; real data always wins.
 *
 * This menu item only SEEDS the rows (EmployeeID/Name/Department filled in,
 * every number blank) -- the admin still has to open the sheet afterward
 * and type the actual Days Worked/Late/OT/Leave numbers in by hand, same as
 * correcting any other sheet in this project directly. Safe to run again
 * for a month already started (e.g. after adding a new employee) --
 * seedHistoricalSummaryRows_ skips anyone who already has a row for that
 * exact Year/Month rather than duplicating it.
 *
 * Reuses promptForAllowanceYearMonth_ (above) for the Year/Month prompt --
 * despite its name, it's already generic (just takes `ui`/`title`), so
 * there's no reason for this to duplicate the same two prompts and the same
 * validation rules.
 */
function menuAddHistoricalSummaryRows_() {
  var ui = SpreadsheetApp.getUi();
  var title = 'Add Historical Summary Month'; // matches the menu label (onOpen above) -- every dialog in this flow shares this one title string

  var yearMonth = promptForAllowanceYearMonth_(ui, title);
  if (!yearMonth) return;
  var year = yearMonth.year, month = yearMonth.month;

  var result = seedHistoricalSummaryRows_(year, month);

  var summary = 'Historical Summary for ' + month + '/' + year + ':\n' +
    'Added ' + result.added.length + ' new row(s)' + (result.added.length > 0 ? ' (' + result.added.join(', ') + ')' : '') + '.';
  if (result.skipped.length > 0) {
    summary += '\nSkipped ' + result.skipped.length + ' who already had a row for this month.';
  }
  // Explicit about Special Allowance being the one column that stays
  // reference-only -- this is exactly the kind of silent mismatch that
  // caused real confusion the first time this feature was tested (an admin
  // typed a number expecting it to show up and it didn't). OT (min)/
  // OT (Quarter) DO show up alongside everything else (see
  // getEffectiveMonthTotals_'s own doc comment, HistoricalSummary.gs) --
  // only Special Allowance is excluded, since the Allowances sheet already
  // owns that figure for any month, backfilled or not. Worth repeating
  // here every time, not just in a code comment nobody but a developer
  // will ever read.
  summary += '\n\nOpen the "Historical Summary" sheet and type in each employee\'s numbers by hand -- nothing is calculated automatically for this sheet. Days Worked/Late/Over/OT (min)/OT (Quarter)/OT Pay (Baht)/Leave columns all show up on the Dashboard/Summary/Print Report for a month with no real data -- OT Pay (Baht) is the figure that actually counts for pay, OT (min)/OT (Quarter) are shown alongside it for reference. "Special Allowance (Baht)" is the one column that never shows up anywhere live -- for a real backdated allowance, use the Allowancer menu item instead.';
  ui.alert(title, summary, ui.ButtonSet.OK);
}

/**
 * Faster companion to Health Check's missing-IN/missing-checkout findings
 * (checkMissingAttendance_/checkMissingCheckouts_) for the common weekly
 * task of catching up a handful of forgotten punches: scans this month
 * (every day before today, same "today may not be over yet" rule as Health
 * Check) for every Active employee missing an IN, an OUT, or both on a day
 * there's a reason to think something should be there -- either a real
 * scheduled shift (not blank, not a full day off -- see
 * FULL_DAY_OFF_SHIFTS -- "Half Day Annual/Sick Leave" still counts), OR,
 * even with no shift set at all, a real punch already on record with its
 * other half missing (e.g. someone genuinely forgot to tap OUT on a day
 * nobody got around to scheduling yet -- a blank Schedule cell alone,
 * with nothing punched either, still isn't enough to flag on its own).
 * Walks through each finding as its own prompt so an admin can type the
 * missing time(s) right there instead of separately looking each case up
 * and re-opening Add Backdated Check-in/Check-out for every single one.
 * Leave a time blank to skip just that punch; Cancel stops the whole run
 * (whatever was already entered stays saved). No OT prompt here on
 * purpose -- this tool is for completing an ordinary forgotten punch, not
 * for backdating an OT claim; use Add Backdated Check-in/Check-out for that.
 *
 * An overnight Special Shift's IN-today/OUT-tomorrow split is never
 * flagged as two separate missing punches -- see
 * overnightSpecialShiftPairSatisfies_ (Attendance.gs).
 */
function menuFillMissedPunches_() {
  var ui = SpreadsheetApp.getUi();
  var title = 'Fill Missed Punches';
  var now = new Date();
  var year = now.getFullYear();
  var month = now.getMonth() + 1;
  var lastDayToCheck = now.getDate() - 1;
  var daysInMonth = new Date(year, month, 0).getDate(); // the WHOLE month, not lastDayToCheck -- needed so overnightSpecialShiftPairSatisfies_ can check a day's own adjacent day even when that adjacent day is today (not yet "yesterday")

  if (lastDayToCheck < 1) {
    ui.alert(title, 'No days have passed yet this month to check.', ui.ButtonSet.OK);
    return;
  }

  var sheetName = 'Schedule ' + year + '-' + (month < 10 ? '0' + month : month);
  if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName)) {
    ui.alert(title, 'No "' + sheetName + '" sheet found.', ui.ButtonSet.OK);
    return;
  }

  var scheduledShiftsForMonth = getScheduledShiftsForMonth_(year, month);
  var activeEmployees = getAllEmployees_().filter(function (emp) { return isTrue_(emp.Active); });

  var logSheet = getSheet_('AttendanceLog');
  var logValues = logSheet.getDataRange().getValues();
  var logHeaders = logValues[0];
  var tsCol = logHeaders.indexOf('Timestamp');
  var idCol = logHeaders.indexOf('EmployeeID');
  var typeCol = logHeaders.indexOf('Type');

  var hasInByKey = {};
  var hasOutByKey = {};
  for (var i = 1; i < logValues.length; i++) {
    var ts = new Date(logValues[i][tsCol]);
    if (ts.getFullYear() !== year || ts.getMonth() + 1 !== month) continue;
    var key = String(logValues[i][idCol]) + '|' + ts.getDate();
    if (logValues[i][typeCol] === 'IN') hasInByKey[key] = true;
    else if (logValues[i][typeCol] === 'OUT') hasOutByKey[key] = true;
  }

  // Flags a day when something's missing AND there's a reason to think it
  // shouldn't be: either a real scheduled shift that day (the original
  // rule), OR -- even with no shift set at all -- a real punch already sitting
  // there with its other half missing (e.g. a genuine forgotten OUT on a day
  // nobody got around to scheduling yet). A day with neither a shift nor any
  // punch at all stays excluded either way -- nothing to go on. An explicit
  // full day off (Leave/Holiday -- see FULL_DAY_OFF_SHIFTS) is excluded
  // unconditionally, even with a stray punch sitting there: filling in the
  // "missing" half would write a real timed OUT row with that Leave/Holiday
  // label as its Shift, fabricating a full workday on someone's day off --
  // a stray tap on a day off is a different problem to fix by hand, not
  // something this tool should offer to complete. An "Event ..." shift is
  // excluded the same unconditional way -- it's designed to count as a full
  // day worked with no real punch needed at all (see isEventShift_).
  var findings = [];
  activeEmployees.forEach(function (emp) {
    var shiftsByDay = scheduledShiftsForMonth[emp.EmployeeID] || {};
    for (var day = 1; day <= lastDayToCheck; day++) {
      var shift = shiftsByDay[day] || '';
      if (FULL_DAY_OFF_SHIFTS.indexOf(shift) !== -1) continue;
      if (isEventShift_(shift)) continue; // designed to need no real punch at all -- offering to "fill in" one here would fabricate a punch for a day that's already complete by design (see isEventShift_/eventShiftOverrideTimestamp_)

      var key = emp.EmployeeID + '|' + day;
      var hasIn = !!hasInByKey[key];
      var hasOut = !!hasOutByKey[key];
      var missingIn = !hasIn;
      var missingOut = !hasOut;
      // Overnight Special Shift (IN today, OUT tomorrow, or vice versa) --
      // see overnightSpecialShiftPairSatisfies_'s own doc comment. Checked
      // before the "already complete" short-circuit below so a day that's
      // ONLY missing-by-this-false-positive gets skipped entirely, same as
      // a genuinely complete day.
      if (missingOut && overnightSpecialShiftPairSatisfies_(emp.EmployeeID, shiftsByDay, hasInByKey, hasOutByKey, day, daysInMonth, 'OUT')) missingOut = false;
      if (missingIn && overnightSpecialShiftPairSatisfies_(emp.EmployeeID, shiftsByDay, hasInByKey, hasOutByKey, day, daysInMonth, 'IN')) missingIn = false;
      if (!missingIn && !missingOut) continue; // already complete (directly, or via an overnight Special Shift pairing with the adjacent day)

      var isRealShiftDay = !!shift;
      if (!isRealShiftDay && !hasIn && !hasOut) continue; // no shift and nothing punched -- no evidence this was a workday

      findings.push({ employeeId: emp.EmployeeID, name: emp.Name, day: day, shift: shift, missingIn: missingIn, missingOut: missingOut });
    }
  });

  if (findings.length === 0) {
    ui.alert(title, 'No missed punches found this month (through yesterday).', ui.ButtonSet.OK);
    return;
  }

  var filled = 0, skipped = 0, stopped = false;
  var dateLabelFor = function (day) { return (day < 10 ? '0' + day : day) + '/' + (month < 10 ? '0' + month : month) + '/' + year; };

  outer:
  for (var f = 0; f < findings.length; f++) {
    var finding = findings[f];
    var dateLabel = dateLabelFor(finding.day);
    var progress = '(' + (f + 1) + '/' + findings.length + ') ' + finding.name;
    var dayStart = new Date(year, month - 1, finding.day);
    var enteredInTimestamp = null; // set below if IN gets typed this same finding, so OUT can be checked against it

    var punchTypes = [];
    if (finding.missingIn) punchTypes.push('IN');
    if (finding.missingOut) punchTypes.push('OUT');

    for (var p = 0; p < punchTypes.length; p++) {
      var type = punchTypes[p];
      var resp = ui.prompt(
        progress,
        dateLabel + ' -- Shift: ' + (finding.shift || '(not scheduled)') + '\nMissing: ' + type +
        '\n\nEnter ' + (type === 'IN' ? 'check-in' : 'check-out') + ' time (HH:MM), or leave blank to skip:',
        ui.ButtonSet.OK_CANCEL
      );
      if (resp.getSelectedButton() !== ui.Button.OK) { stopped = true; break outer; }

      var text = resp.getResponseText().trim();
      if (!text) { skipped++; continue; }

      var timeParts = text.split(':');
      var hour = timeParts.length === 2 ? Number(timeParts[0]) : NaN;
      var minute = timeParts.length === 2 ? Number(timeParts[1]) : NaN;
      var validRange = !isNaN(hour) && !isNaN(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
      if (!validRange) {
        ui.alert(title, 'Invalid time format ("' + text + '") -- must be HH:MM, hour 00-23, minute 00-59 -- skipping ' + type + ' for ' + finding.name + ' on ' + dateLabel, ui.ButtonSet.OK);
        skipped++;
        continue;
      }
      var timestamp = new Date(year, month - 1, finding.day, hour, minute, 0);

      // Someone else may have added this exact punch since the scan ran at
      // the top of this function (a long interactive session, another
      // editor active) -- re-check right before writing, same safety net
      // menuAddBackdatedAttendance_ already has, instead of silently
      // appending a duplicate row.
      var existing = findLogEntryForDate_(finding.employeeId, type, dayStart);
      if (existing) {
        ui.alert(title, finding.name + ' already has a ' + type + ' recorded (at ' +
          Utilities.formatDate(existing.timestamp, Session.getScriptTimeZone(), 'HH:mm') +
          ') on ' + dateLabel + ' -- skipping', ui.ButtonSet.OK);
        skipped++;
        if (type === 'IN') enteredInTimestamp = existing.timestamp;
        continue;
      }

      // OUT must land after IN -- whichever IN applies (just typed above in
      // this same finding, or already on record from before this run).
      if (type === 'OUT') {
        var inTimestamp = enteredInTimestamp || (findLogEntryForDate_(finding.employeeId, 'IN', dayStart) || {}).timestamp;
        if (inTimestamp && timestamp.getTime() <= inTimestamp.getTime()) {
          ui.alert(title, 'OUT time (' + text + ') must be after IN time (' +
            Utilities.formatDate(inTimestamp, Session.getScriptTimeZone(), 'HH:mm') +
            ') -- skipping OUT for ' + finding.name + ' on ' + dateLabel, ui.ButtonSet.OK);
          skipped++;
          continue;
        }
      }

      recordBackdatedAttendance_(finding.employeeId, type, timestamp, false, finding.shift);
      if (type === 'IN') enteredInTimestamp = timestamp;
      filled++;
    }
  }

  refreshLiveReportSheet_();
  refreshLiveSummarySheet_();

  ui.alert(
    title + ' Done',
    'Filled ' + filled + ' entry(ies), skipped ' + skipped + (stopped ? ' (stopped partway via Cancel -- whatever was already filled in is still saved)' : ''),
    ui.ButtonSet.OK
  );
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
    .filter(function (s) { return s.shift && FULL_DAY_OFF_SHIFTS.indexOf(s.shift) === -1; }); // Leave/Holiday mean intentionally off, not "not scheduled yet" -- exclude from this list ("Half Day Annual/Sick Leave" stays in -- still expected in for half the day)

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

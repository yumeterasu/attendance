/**
 * Employees are added directly in the Employees sheet (Name/Department/Active,
 * then "Generate Kiosk Codes for Everyone" assigns their KioskPIN) -- no setup
 * code needed, since regular employees never log into the app. Setup codes are
 * still used, but only for pairing an admin account onto a device
 * (handleAdminResetCode_). migrateToPairingAuth is a one-off, run manually once
 * from the editor, to add the columns this auth model needs and bootstrap the
 * first admin.
 */

/**
 * One-off cleanup: updates AttendanceLog's Department column on every row to
 * match each employee's *current* Employees sheet Department, wherever they
 * differ (e.g. an old row still says "Japanese Staff" from before Department
 * was standardized to just "Japanese"/"Thai"). Purely cosmetic/audit-trail --
 * Report, Summary, and the OT recompute tool all read the current Employees
 * data directly, never this column, so this has no effect on any
 * calculation. Safe to run repeatedly. Select syncAttendanceLogDepartments
 * in the editor's toolbar dropdown and Run. Check View > Logs for a summary.
 */
function syncAttendanceLogDepartments() {
  var sheet = getSheet_('AttendanceLog');
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idCol = headers.indexOf('EmployeeID');
  var deptCol = headers.indexOf('Department');

  var updated = 0;
  for (var i = 1; i < values.length; i++) {
    var employeeId = String(values[i][idCol]);
    var found = findEmployeeRow_(employeeId);
    if (!found) continue;
    var currentDept = found.row.Department;
    if (values[i][deptCol] !== currentDept) {
      sheet.getRange(i + 1, deptCol + 1).setValue(currentDept);
      updated++;
    }
  }
  Logger.log('Updated Department on ' + updated + ' row(s).');
}

/**
 * One-off: sets AttendanceLog's Timestamp column to display as
 * dd/mm/yyyy hh:mm:ss (matching the Report sheet's dd/MM/yyyy Date column),
 * instead of whatever locale-default format (e.g. M/D/YYYY) it had before.
 * This only changes how the existing Date values are *displayed* -- the
 * underlying timestamps, and anything that reads them (Late/OT calculations,
 * sorting, Report/Summary), are untouched, since they read the real Date
 * value, not its display text. Covers 100,000 rows, well beyond any
 * realistic row count, so future check-ins inherit the format automatically
 * too. Safe to run repeatedly. Select fixAttendanceLogTimestampFormat in the
 * editor's toolbar dropdown and Run.
 */
function fixAttendanceLogTimestampFormat() {
  var sheet = getSheet_('AttendanceLog');
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var tsCol = headers.indexOf('Timestamp');
  sheet.getRange(2, tsCol + 1, 100000, 1).setNumberFormat('dd/mm/yyyy hh:mm:ss');
  Logger.log('Timestamp column formatted as dd/mm/yyyy hh:mm:ss.');
}

/**
 * Scheduled deactivation sweep: for every employee still Active with a
 * LastWorkingDay before today, flips Active to FALSE. Time-driven trigger
 * target (see setupDailyDeactivationTrigger), so it can't use
 * SpreadsheetApp.getUi() -- logs a summary to View > Logs instead. Also
 * called directly by menuDeactivateEmployee_ right after saving a date, so a
 * past/today date takes effect immediately instead of waiting for tomorrow's
 * run.
 */
function applyScheduledDeactivations_() {
  ensureColumns_('Employees', ['LastWorkingDay']);
  var sheet = getSheet_('Employees');
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var activeCol = headers.indexOf('Active');
  var lastDayCol = headers.indexOf('LastWorkingDay');
  var nameCol = headers.indexOf('Name');

  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  var deactivated = [];
  for (var i = 1; i < values.length; i++) {
    if (!isTrue_(values[i][activeCol])) continue;
    var lastDayRaw = values[i][lastDayCol];
    if (!lastDayRaw) continue;
    var lastDay = new Date(lastDayRaw);
    if (isNaN(lastDay.getTime())) continue;
    var lastDayOnly = new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate());
    if (lastDayOnly.getTime() < today.getTime()) {
      sheet.getRange(i + 1, activeCol + 1).setValue(false);
      deactivated.push(values[i][nameCol]);
    }
  }

  if (deactivated.length > 0) {
    invalidateEmployeesCache_();
    Logger.log('Deactivated ' + deactivated.length + ' employee(s) past their last working day: ' + deactivated.join(', '));
  }
  return deactivated;
}

/**
 * One-off: installs a daily trigger that runs applyScheduledDeactivations_
 * every morning. Safe to run more than once -- clears any existing trigger
 * for the same function first. Run once from the editor: select
 * setupDailyDeactivationTrigger in the toolbar dropdown, click Run.
 */
function setupDailyDeactivationTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'applyScheduledDeactivations_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('applyScheduledDeactivations_')
    .timeBased()
    .everyDays(1)
    .atHour(2)
    .create();
  Logger.log('Daily deactivation trigger created -- runs every day around 2am, deactivating anyone past their LastWorkingDay.');
}

function handleAdminResetCode_(params) {
  if (!checkApiKey_(params.apiKey)) return fail_('unauthorized', 'Invalid API key');
  var admin = requireAdmin_(params.sessionToken);
  if (!admin.ok) return admin.response;

  if (!params.employeeId) return fail_('bad_request', 'employeeId is required');
  var found = findEmployeeRow_(params.employeeId);
  if (!found) return fail_('not_found', 'Username not found');

  var setupCode = randomSetupCode_();
  var salt = randomSalt_();
  var hash = sha256Hex_(setupCode + salt);
  updateEmployeeFields_(found.rowNumber, {
    SetupCodeHash: hash,
    SetupCodeSalt: salt,
    SetupCodeUsed: false
  });
  return ok_({ employeeId: params.employeeId, setupCode: setupCode });
}

/**
 * Kiosk PINs: every employee gets a unique 4-digit code typed on the shared
 * tablet's keypad to check in/out -- no login, no QR. Safe to call anytime;
 * only fills in PINs for rows that don't have one yet. View codes directly in
 * the Employees sheet's KioskPIN column. Triggered from the "Attendance
 * Admin" Google Sheets menu (see Menu.gs), not from the app.
 */
function assignMissingKioskPins_() {
  ensureColumns_('Employees', ['KioskPIN']);

  var sheet = getSheet_('Employees');
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var pinCol = headers.indexOf('KioskPIN');
  var idCol = headers.indexOf('EmployeeID');

  // Force plain-text format first, otherwise Sheets auto-converts "0422" to
  // the number 422 and silently drops the leading zero.
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, pinCol + 1, lastRow - 1, 1).setNumberFormat('@');
  }

  var values = sheet.getDataRange().getValues();

  var used = {};
  for (var i = 1; i < values.length; i++) {
    var existing = String(values[i][pinCol] || '').trim();
    if (existing) used[pad4_(existing)] = true;
  }

  var assigned = 0;
  for (var i = 1; i < values.length; i++) {
    if (!values[i][idCol]) continue;
    var raw = values[i][pinCol];
    var existing = String(raw || '').trim();

    if (existing) {
      var padded = pad4_(existing);
      if (padded !== existing) {
        sheet.getRange(i + 1, pinCol + 1).setValue(padded); // repair a leading zero Sheets stripped earlier
      }
      continue;
    }

    var pin;
    do {
      pin = randomKioskPin_();
    } while (used[pin]);
    used[pin] = true;

    sheet.getRange(i + 1, pinCol + 1).setValue(pin);
    assigned++;
  }
  invalidateEmployeesCache_();
  return assigned;
}

/**
 * One-off: sets the permanent Kiosk Exit PIN. The in-app "Save Exit PIN" field
 * was removed since this is a fixed value now -- run this once from the
 * editor (select setKioskExitPinPermanently, click Run) whenever it needs to
 * change.
 */
function setKioskExitPinPermanently() {
  PropertiesService.getScriptProperties().setProperty('KIOSK_EXIT_PIN', '1357');
  Logger.log('Kiosk exit PIN set to 1357');
}

/** One-off: deletes the old auto-generated "Kiosk PINs" sheet -- no longer created, view codes in Employees instead. */
function deleteKioskPinsSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Kiosk PINs');
  if (!sheet) {
    Logger.log('No "Kiosk PINs" sheet found -- nothing to delete.');
    return;
  }
  ss.deleteSheet(sheet);
  Logger.log('Deleted "Kiosk PINs" sheet.');
}

/**
 * One-off: issue a fresh setup code for a locked-out employee (e.g. lost/reset
 * device with no admin session to use the in-app "Lost Device" flow). Run
 * manually from the editor: select issueSetupCodeForLockedOutEmployee in the
 * toolbar dropdown, click Run, then check View > Execution log for the code.
 */
function issueSetupCodeForLockedOutEmployee() {
  var employeeId = 'EMP001';
  var found = findEmployeeRow_(employeeId);
  if (!found) throw new Error('Employee not found: ' + employeeId);

  var setupCode = randomSetupCode_();
  var salt = randomSalt_();
  updateEmployeeFields_(found.rowNumber, {
    SetupCodeHash: sha256Hex_(setupCode + salt),
    SetupCodeSalt: salt,
    SetupCodeUsed: false
  });

  Logger.log('New setup code for ' + employeeId + ': ' + setupCode);
}

/**
 * Sets the script's API key / session secret / QR value. Already run once at
 * project setup -- the real values now live only in Script Properties (Project
 * Settings > Script Properties in the editor), not in source. To rotate a
 * value later: temporarily paste real arguments into a throwaway call to this
 * function, run it once from the editor, then delete that call again before
 * pushing -- never commit real secrets into this file.
 */
function setupScriptProperties(apiKey, sessionSecret, qrValue) {
  PropertiesService.getScriptProperties().setProperties({
    APP_API_KEY: apiKey,
    SESSION_SECRET: sessionSecret,
    EXPECTED_QR_VALUE: qrValue
  });
  Logger.log('Script properties set.');
}

/**
 * One-off migration: adds the columns the setup-code pairing model needs and
 * turns the existing EMP001 test row into the first admin. Run once, from the
 * editor's toolbar dropdown (select migrateToPairingAuth, click Run), after
 * deploying the new Auth.gs/Admin.gs/Code.gs. Logs the setup code to use for
 * EMP001's first pairing -- check View > Logs (or the execution log) after running.
 */
function migrateToPairingAuth() {
  ensureColumns_('Employees', ['SetupCodeHash', 'SetupCodeSalt', 'SetupCodeUsed', 'IsAdmin']);

  var found = findEmployeeRow_('EMP001');
  if (!found) throw new Error('EMP001 not found -- nothing to bootstrap as admin');

  var setupCode = randomSetupCode_();
  var salt = randomSalt_();
  var hash = sha256Hex_(setupCode + salt);
  updateEmployeeFields_(found.rowNumber, {
    SetupCodeHash: hash,
    SetupCodeSalt: salt,
    SetupCodeUsed: false,
    IsAdmin: true
  });

  Logger.log('Bootstrap admin ready. Username: EMP001, setup code: ' + setupCode);
}

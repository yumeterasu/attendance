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
    .addItem('Create / Update Schedule Sheet...', 'menuCreateScheduleSheet_')
    .addItem('Recompute Late/OT for Date Range...', 'menuRecomputeLateOt_')
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
 * No prompts -- reads the year/month straight off whichever "Schedule
 * YYYY-MM" tab is open when this is clicked, and recomputes that whole
 * month. Safe to run on days that don't need fixing (idempotent), so
 * defaulting to the full month instead of asking for a day range is fine.
 */
function menuRecomputeLateOt_() {
  var ui = SpreadsheetApp.getUi();
  var activeSheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var match = activeSheet.getName().match(/^Schedule (\d{4})-(\d{2})$/);
  if (!match) {
    ui.alert('Open the Schedule tab for the month you want to recompute first (e.g. "Schedule 2026-07"), then run this again.');
    return;
  }

  var year = Number(match[1]);
  var month = Number(match[2]);
  var daysInMonth = new Date(year, month, 0).getDate();

  var result = recomputeLateAndOt_(year, month, 1, daysInMonth);
  ui.alert(
    'Done',
    'Recomputed ' + activeSheet.getName() + ': updated ' + result.inRowsUpdated + ' IN row(s) (Shift/Late) and ' +
    result.outRowsUpdated + ' OUT row(s) (Japanese OT).\n\n' +
    'Thai/non-Japanese OT was left untouched -- it can only be trusted from the moment it was recorded, not recomputed after the fact.',
    ui.ButtonSet.OK
  );
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

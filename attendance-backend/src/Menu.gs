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

function menuRecomputeLateOt_() {
  var ui = SpreadsheetApp.getUi();
  var now = new Date();

  var yearResp = ui.prompt('Recompute Late/OT', 'Year (e.g. ' + now.getFullYear() + '):', ui.ButtonSet.OK_CANCEL);
  if (yearResp.getSelectedButton() !== ui.Button.OK) return;
  var year = Number(yearResp.getResponseText().trim());

  var monthResp = ui.prompt('Recompute Late/OT', 'Month (1-12):', ui.ButtonSet.OK_CANCEL);
  if (monthResp.getSelectedButton() !== ui.Button.OK) return;
  var month = Number(monthResp.getResponseText().trim());

  var daysInMonth = year && month >= 1 && month <= 12 ? new Date(year, month, 0).getDate() : 31;

  var startResp = ui.prompt('Recompute Late/OT', 'Start day (1-' + daysInMonth + '):', ui.ButtonSet.OK_CANCEL);
  if (startResp.getSelectedButton() !== ui.Button.OK) return;
  var startDay = Number(startResp.getResponseText().trim());

  var endResp = ui.prompt('Recompute Late/OT', 'End day (1-' + daysInMonth + ', same as start day for just one day):', ui.ButtonSet.OK_CANCEL);
  if (endResp.getSelectedButton() !== ui.Button.OK) return;
  var endDay = Number(endResp.getResponseText().trim());

  if (
    !year || !month || month < 1 || month > 12 ||
    !startDay || !endDay || startDay < 1 || endDay > daysInMonth || startDay > endDay
  ) {
    ui.alert('Enter a valid year, month, and day range.');
    return;
  }

  var result = recomputeLateAndOt_(year, month, startDay, endDay);
  ui.alert(
    'Done',
    'Updated ' + result.inRowsUpdated + ' IN row(s) (Shift/Late) and ' + result.outRowsUpdated + ' OUT row(s) (Japanese OT).\n\n' +
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

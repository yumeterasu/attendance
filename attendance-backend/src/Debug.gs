/**
 * Temporary diagnostics, run manually from the editor when something looks
 * wrong -- not called from anywhere else. Safe to delete once done with them.
 */

/**
 * Dumps every Japanese employee's IN/OUT rows for one date, plus what's
 * currently in that month's Schedule sheet for the same day, so you can
 * compare the Shift value that was frozen into AttendanceLog at IN time
 * against what the Schedule sheet shows now. Edit YEAR/MONTH/DAY below, then
 * select debugJapaneseOtForDate in the editor's toolbar dropdown and Run.
 * Check View > Logs (or Executions) for the output.
 */
function debugJapaneseOtForDate() {
  var YEAR = 2026, MONTH = 7, DAY = 17; // <-- edit as needed

  var sheet = getSheet_('AttendanceLog');
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var tsCol = headers.indexOf('Timestamp');
  var idCol = headers.indexOf('EmployeeID');
  var nameCol = headers.indexOf('Name');
  var deptCol = headers.indexOf('Department');
  var typeCol = headers.indexOf('Type');
  var shiftCol = headers.indexOf('Shift');
  var otMinCol = headers.indexOf('OTMinutes');
  var tz = Session.getScriptTimeZone();

  Logger.log('--- AttendanceLog rows for ' + YEAR + '-' + MONTH + '-' + DAY + ' (Japanese only) ---');
  var found = false;
  for (var i = 1; i < values.length; i++) {
    var ts = new Date(values[i][tsCol]);
    if (ts.getFullYear() !== YEAR || ts.getMonth() + 1 !== MONTH || ts.getDate() !== DAY) continue;
    if (values[i][deptCol] !== 'Japanese') continue;
    found = true;
    Logger.log(
      values[i][nameCol] + ' (' + values[i][idCol] + ') | ' +
      values[i][typeCol] + ' @ ' + Utilities.formatDate(ts, tz, 'HH:mm:ss') +
      ' | Shift="' + values[i][shiftCol] + '"' +
      ' | OTMinutes=' + values[i][otMinCol]
    );
  }
  if (!found) Logger.log('(no Japanese rows found on that date)');

  var scheduleSheetName = 'Schedule ' + YEAR + '-' + (MONTH < 10 ? '0' + MONTH : MONTH);
  var scheduleSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(scheduleSheetName);
  Logger.log('--- Schedule sheet "' + scheduleSheetName + '", day ' + DAY + ' column (current values) ---');
  if (!scheduleSheet) {
    Logger.log('No sheet named "' + scheduleSheetName + '" found.');
    return;
  }
  var schedValues = scheduleSheet.getDataRange().getValues();
  var schedHeaders = schedValues[0];
  var schedIdCol = schedHeaders.indexOf('EmployeeID');
  var schedNameCol = schedHeaders.indexOf('Name');
  var dayCol = schedHeaders.indexOf(DAY);
  if (dayCol === -1) {
    Logger.log('No column for day ' + DAY + ' found on that sheet.');
    return;
  }
  for (var j = 1; j < schedValues.length; j++) {
    Logger.log(schedValues[j][schedNameCol] + ' (' + schedValues[j][schedIdCol] + ') day ' + DAY + ' = "' + schedValues[j][dayCol] + '"');
  }
}

/**
 * Dumps one employee's every IN/OUT row for a whole month -- Shift/Late/OT as
 * recorded in AttendanceLog -- so you can see exactly which days have OT and
 * which don't, without needing to already know which day to check. Edit
 * NAME_OR_ID/YEAR/MONTH below (NAME_OR_ID matches Name or EmployeeID,
 * case-insensitive substring), then select debugEmployeeMonth in the
 * editor's toolbar dropdown and Run. Check View > Logs for the output.
 */
function debugEmployeeMonth() {
  var NAME_OR_ID = 'Kahana', YEAR = 2026, MONTH = 7; // <-- edit as needed

  var sheet = getSheet_('AttendanceLog');
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var tsCol = headers.indexOf('Timestamp');
  var idCol = headers.indexOf('EmployeeID');
  var nameCol = headers.indexOf('Name');
  var deptCol = headers.indexOf('Department');
  var typeCol = headers.indexOf('Type');
  var shiftCol = headers.indexOf('Shift');
  var lateCol = headers.indexOf('Late');
  var otMinCol = headers.indexOf('OTMinutes');
  var otQuarterCol = headers.indexOf('OTQuarters');
  var tz = Session.getScriptTimeZone();
  var needle = String(NAME_OR_ID).toLowerCase();

  Logger.log('--- ' + NAME_OR_ID + ', ' + YEAR + '-' + MONTH + ' ---');
  var found = false;
  for (var i = 1; i < values.length; i++) {
    var ts = new Date(values[i][tsCol]);
    if (ts.getFullYear() !== YEAR || ts.getMonth() + 1 !== MONTH) continue;
    var name = String(values[i][nameCol] || '');
    var empId = String(values[i][idCol] || '');
    if (name.toLowerCase().indexOf(needle) === -1 && empId.toLowerCase().indexOf(needle) === -1) continue;

    found = true;
    Logger.log(
      Utilities.formatDate(ts, tz, 'MM-dd') + ' ' + values[i][typeCol] + ' @ ' + Utilities.formatDate(ts, tz, 'HH:mm:ss') +
      ' | Dept=' + values[i][deptCol] +
      ' | Shift="' + values[i][shiftCol] + '"' +
      ' | Late=' + values[i][lateCol] +
      ' | OTMinutes=' + values[i][otMinCol] +
      ' | OTQuarters=' + values[i][otQuarterCol]
    );
  }
  if (!found) Logger.log('(no rows found -- check the name/ID spelling and year/month)');
}

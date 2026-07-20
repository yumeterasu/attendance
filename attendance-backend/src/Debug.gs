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

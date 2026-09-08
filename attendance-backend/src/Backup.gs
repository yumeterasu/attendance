/**
 * Monthly full copy of the entire spreadsheet into a "Attendance Backups"
 * Drive folder, as insurance against an accidental delete/overwrite in the
 * live sheet. Independent of git, which only tracks the Apps Script source
 * code, not the actual Employees/AttendanceLog/Schedule data.
 */

function backupSpreadsheetToDrive_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = Session.getScriptTimeZone();
  var stamp = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var file = DriveApp.getFileById(ss.getId());
  var folder = getOrCreateBackupFolder_();
  file.makeCopy(ss.getName() + ' backup ' + stamp, folder);
}

function getOrCreateBackupFolder_() {
  // Shared get-or-create-by-name helper -- see Menu.gs's getOrCreateDriveFolder_
  // (originally written here first, generalized when generateEmployeeReportPdf_
  // needed the same pattern for its own "Attendance Reports" folder).
  return getOrCreateDriveFolder_('Attendance Backups');
}

/**
 * One-off: installs a trigger that runs backupSpreadsheetToDrive_ on the 1st
 * of every month. Safe to run more than once -- clears any existing trigger
 * for the same function first. Run once from the editor: select
 * setupMonthlyBackupTrigger in the toolbar dropdown, click Run (you'll be
 * asked to authorize Drive access the first time).
 */
function setupMonthlyBackupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'backupSpreadsheetToDrive_') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('backupSpreadsheetToDrive_')
    .timeBased()
    .onMonthDay(1)
    .atHour(3)
    .create();
  Logger.log('Monthly backup trigger created -- runs on the 1st around 3am, copies the sheet into a "Attendance Backups" Drive folder.');
}

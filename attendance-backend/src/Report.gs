/**
 * Monthly attendance report. The app-driven "generate a new Report YYYY-MM
 * tab" flow was replaced by the permanent live "Report" sheet (Year/Month
 * dropdowns, see setupLiveReportSheet / refreshLiveReportSheet_ below), which
 * both share writeMonthlyReportData_ for the actual table-building.
 */

/**
 * Writes the report table (employee blocks, colors, borders) into `sheet`
 * starting at `startRow`, column 1. Shared by the one-off "Report YYYY-MM"
 * generator and the permanent live "Report" sheet (see refreshLiveReportSheet_).
 */
function writeMonthlyReportData_(sheet, startRow, year, month) {
  var tz = Session.getScriptTimeZone();
  var daysInMonth = new Date(year, month, 0).getDate();
  var logsByEmployee = getMonthLogsByEmployee_(year, month);

  // Show an employee if they're currently Active, or they have any
  // attendance data this month (e.g. someone who left mid-month still needs
  // to show up for the month they actually worked) -- otherwise a departed
  // employee would clutter every future month's report forever.
  var employees = getAllEmployees_().filter(function (emp) {
    return isTrue_(emp.Active) || !!logsByEmployee[emp.EmployeeID];
  });

  // Order: Japanese staff first, then Thai staff who did any OT this month,
  // then everyone else -- Employee ID order within each group.
  employees = employees.slice().sort(function (a, b) {
    var groupA = reportSortGroup_(a, logsByEmployee[a.EmployeeID]);
    var groupB = reportSortGroup_(b, logsByEmployee[b.EmployeeID]);
    if (groupA !== groupB) return groupA - groupB;
    return String(a.EmployeeID).localeCompare(String(b.EmployeeID));
  });

  var COLS = 8; // Date, Day, Time In, Time Out, Shift, Late, OT (min), OT (Quarter)
  var rows = [];
  var backgrounds = [];
  var fontColors = [];
  var fontWeights = [];
  var blankRowColors = new Array(COLS).fill(null);
  var headerRowColors = new Array(COLS).fill('#d5a6bd'); // name row + column-title row of each employee block
  var nameRowBackgrounds = headerRowColors.slice();
  nameRowBackgrounds[0] = '#ffffff'; // Name
  nameRowBackgrounds[1] = '#ffffff'; // Department
  var nameRowFontWeights = blankRowColors.slice();
  nameRowFontWeights[0] = 'bold'; // Name
  nameRowFontWeights[1] = 'bold'; // Department
  var employeeBlocks = []; // {startRow, endRow}, 1-indexed sheet rows, for the grid border

  employees.forEach(function (emp) {
    var blockStartRow = startRow + rows.length;

    rows.push([emp.Name + ' (' + emp.EmployeeID + ')', emp.Department, '', '', '', '', '', '']);
    backgrounds.push(nameRowBackgrounds.slice());
    fontColors.push(blankRowColors.slice());
    fontWeights.push(nameRowFontWeights.slice());
    rows.push(['Date', 'Day', 'Time In', 'Time Out', 'Shift', 'Late', 'OT (min)', 'OT (Quarter)']);
    backgrounds.push(headerRowColors.slice());
    fontColors.push(blankRowColors.slice());
    fontWeights.push(blankRowColors.slice());

    var dayLogs = logsByEmployee[emp.EmployeeID] || {};
    for (var d = 1; d <= daysInMonth; d++) {
      var date = new Date(year, month - 1, d);
      var dayEntry = dayLogs[d];
      var timeIn = dayEntry && dayEntry.timeIn ? Utilities.formatDate(dayEntry.timeIn, tz, 'HH:mm') : '';
      var timeOut = dayEntry && dayEntry.timeOut ? Utilities.formatDate(dayEntry.timeOut, tz, 'HH:mm') : '';
      var shift = dayEntry ? dayEntry.shift : '';
      var isLateDay = !!(dayEntry && dayEntry.late);
      var late = isLateDay ? 'Late' : '';
      var otMinutes = dayEntry && dayEntry.otMinutes ? dayEntry.otMinutes : '';
      var otQuarters = dayEntry && dayEntry.otQuarters ? dayEntry.otQuarters : '';
      rows.push([
        Utilities.formatDate(date, tz, 'yyyy-MM-dd'),
        Utilities.formatDate(date, tz, 'EEEE'),
        timeIn,
        timeOut,
        shift,
        late,
        otMinutes,
        otQuarters
      ]);

      // Same weekend tint as the Schedule sheet: Saturday #cfe2f3, Sunday #f4cccc.
      var dayOfWeek = date.getDay(); // 0 = Sunday, 6 = Saturday
      var rowColor = dayOfWeek === 6 ? '#cfe2f3' : dayOfWeek === 0 ? '#f4cccc' : null;
      var rowBg = new Array(COLS).fill(rowColor);
      var rowFont = new Array(COLS).fill(null);
      if (isLateDay) {
        // Late (column F) stands out red-on-white regardless of weekend tint.
        rowBg[5] = '#c0392b';
        rowFont[5] = '#ffffff';
      }
      backgrounds.push(rowBg);
      fontColors.push(rowFont);
      fontWeights.push(blankRowColors.slice());
    }

    employeeBlocks.push({ startRow: blockStartRow, endRow: startRow + rows.length - 1 });

    rows.push(new Array(COLS).fill(''));
    backgrounds.push(blankRowColors.slice());
    fontColors.push(blankRowColors.slice());
    fontWeights.push(blankRowColors.slice());
  });

  if (rows.length > 0) {
    sheet.getRange(startRow, 1, rows.length, COLS).setValues(rows);
    sheet.getRange(startRow, 1, rows.length, COLS).setBackgrounds(backgrounds);
    sheet.getRange(startRow, 1, rows.length, COLS).setFontColors(fontColors);
    sheet.getRange(startRow, 1, rows.length, COLS).setFontWeights(fontWeights);

    // Full grid border around each employee's block (name/dept header, column
    // header, and every day row) -- matches the border the admin drew by hand.
    employeeBlocks.forEach(function (block) {
      sheet
        .getRange(block.startRow, 1, block.endRow - block.startRow + 1, COLS)
        .setBorder(true, true, true, true, true, true, 'black', SpreadsheetApp.BorderStyle.SOLID);
    });
  }
  sheet.autoResizeColumns(1, COLS);
}

/** Report ordering group: 0 = Japanese, 1 = non-Japanese with any OT quarters this month, 2 = everyone else. */
function reportSortGroup_(emp, dayLogs) {
  if (emp.Department === 'Japanese') return 0;
  for (var day in dayLogs) {
    if (dayLogs[day].otQuarters) return 1;
  }
  return 2;
}

/**
 * Permanent "Report" sheet: pick Year (B1) / Month (B2) from the dropdowns
 * and the table below refreshes immediately, pulled fresh from AttendanceLog
 * -- no need to go through the app. Separate from the one-off "Report
 * YYYY-MM" tabs the app's "Generate Report" button still makes; both can
 * coexist.
 */
var LIVE_REPORT_SHEET_NAME = 'Report';
var LIVE_REPORT_DATA_START_ROW = 4;

/**
 * One-off: creates (or re-links) the permanent "Report" sheet and its
 * Year/Month dropdowns. Run once from the editor: select setupLiveReportSheet
 * in the toolbar dropdown, click Run.
 */
function setupLiveReportSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LIVE_REPORT_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(LIVE_REPORT_SHEET_NAME);

  sheet.getRange('A1').setValue('Year:');
  sheet.getRange('A2').setValue('Month:');
  sheet.getRange('A1:A2').setBackground('#ffff00');
  sheet.getRange('B1:B2').setBackground('#ff6d01');

  var thisYear = new Date().getFullYear();
  var years = [];
  for (var y = thisYear - 1; y <= thisYear + 3; y++) years.push(y);
  var yearRule = SpreadsheetApp.newDataValidation().requireValueInList(years, true).build();
  var yearCell = sheet.getRange('B1');
  yearCell.setDataValidation(yearRule);
  if (!yearCell.getValue()) yearCell.setValue(thisYear);

  var months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  var monthRule = SpreadsheetApp.newDataValidation().requireValueInList(months, true).build();
  var monthCell = sheet.getRange('B2');
  monthCell.setDataValidation(monthRule);
  if (!monthCell.getValue()) monthCell.setValue(new Date().getMonth() + 1);

  sheet.setFrozenRows(LIVE_REPORT_DATA_START_ROW - 1);

  refreshLiveReportSheet_();
  Logger.log('Live Report sheet ready. Change the Year or Month dropdown at the top to refresh it.');
}

/**
 * One-off: strips any leftover Format > Alternating colors banding from the
 * live Report sheet (e.g. from manual formatting before the sheet was
 * automated). Our own coloring -- weekend tint, Late highlight, employee
 * header rows -- is all applied directly via setBackgrounds, not banding, so
 * this is safe to run anytime and never touches cell values. Run once from
 * the editor: select removeReportBandings in the toolbar dropdown, click Run.
 */
function removeReportBandings() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LIVE_REPORT_SHEET_NAME);
  if (!sheet) {
    Logger.log('No "Report" sheet found.');
    return;
  }

  var bandings = sheet.getBandings();
  bandings.forEach(function (b) { b.remove(); });
  Logger.log('Removed ' + bandings.length + ' banding range(s) from the Report sheet.');
}

/** Rereads the Year/Month dropdowns and rewrites the data area below them. */
function refreshLiveReportSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LIVE_REPORT_SHEET_NAME);
  if (!sheet) return;

  var year = Number(sheet.getRange('B1').getValue());
  var month = Number(sheet.getRange('B2').getValue());
  if (!year || !month || month < 1 || month > 12) return;

  var maxRows = sheet.getMaxRows();
  if (maxRows >= LIVE_REPORT_DATA_START_ROW) {
    var clearRange = sheet.getRange(LIVE_REPORT_DATA_START_ROW, 1, maxRows - LIVE_REPORT_DATA_START_ROW + 1, sheet.getMaxColumns());
    clearRange.clearContent();
    clearRange.setBackground(null);
    clearRange.setFontColor(null);
    clearRange.setFontWeight(null);
    clearRange.setBorder(false, false, false, false, false, false);
  }

  writeMonthlyReportData_(sheet, LIVE_REPORT_DATA_START_ROW, year, month);
}

/**
 * Simple trigger: fires on every manual edit anywhere in the spreadsheet.
 * Only reacts when the edit is the Year or Month dropdown on the live
 * "Report" or "Summary" sheet -- everything else is ignored.
 */
function onEdit(e) {
  var sheet = e.range.getSheet();
  if (e.range.getColumn() !== 2 || e.range.getRow() > 2) return; // only B1 (Year) or B2 (Month)

  if (sheet.getName() === LIVE_REPORT_SHEET_NAME) {
    refreshLiveReportSheet_();
  } else if (sheet.getName() === LIVE_SUMMARY_SHEET_NAME) {
    refreshLiveSummarySheet_();
  }
}

/**
 * Permanent "Summary" sheet: one condensed row per employee (days worked,
 * late count, OT total) instead of Report's full daily breakdown. Same
 * Year/Month dropdown + auto-refresh pattern as the live "Report" sheet,
 * pulled fresh from AttendanceLog every time the dropdown changes.
 */
var LIVE_SUMMARY_SHEET_NAME = 'Summary';
var LIVE_SUMMARY_DATA_START_ROW = 4;

/**
 * One-off: creates (or re-links) the permanent "Summary" sheet and its
 * Year/Month dropdowns. Run once from the editor: select setupLiveSummarySheet
 * in the toolbar dropdown, click Run.
 */
function setupLiveSummarySheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LIVE_SUMMARY_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(LIVE_SUMMARY_SHEET_NAME);

  sheet.getRange('A1').setValue('Year:');
  sheet.getRange('A2').setValue('Month:');
  sheet.getRange('A1:A2').setBackground('#ffff00');

  var thisYear = new Date().getFullYear();
  var years = [];
  for (var y = thisYear - 1; y <= thisYear + 3; y++) years.push(y);
  var yearRule = SpreadsheetApp.newDataValidation().requireValueInList(years, true).build();
  var yearCell = sheet.getRange('B1');
  yearCell.setDataValidation(yearRule);
  if (!yearCell.getValue()) yearCell.setValue(thisYear);

  var months = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  var monthRule = SpreadsheetApp.newDataValidation().requireValueInList(months, true).build();
  var monthCell = sheet.getRange('B2');
  monthCell.setDataValidation(monthRule);
  if (!monthCell.getValue()) monthCell.setValue(new Date().getMonth() + 1);

  sheet.setFrozenRows(LIVE_SUMMARY_DATA_START_ROW - 1);

  refreshLiveSummarySheet_();
  Logger.log('Live Summary sheet ready. Change the Year or Month dropdown at the top to refresh it.');
}

/** Rereads the Year/Month dropdowns and rewrites the totals table below them. */
function refreshLiveSummarySheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LIVE_SUMMARY_SHEET_NAME);
  if (!sheet) return;

  var year = Number(sheet.getRange('B1').getValue());
  var month = Number(sheet.getRange('B2').getValue());
  if (!year || !month || month < 1 || month > 12) return;

  var maxRows = sheet.getMaxRows();
  if (maxRows >= LIVE_SUMMARY_DATA_START_ROW) {
    var clearRange = sheet.getRange(LIVE_SUMMARY_DATA_START_ROW, 1, maxRows - LIVE_SUMMARY_DATA_START_ROW + 1, sheet.getMaxColumns());
    clearRange.clearContent();
    clearRange.setBackground(null);
    clearRange.setFontColor(null);
    clearRange.setFontWeight(null);
  }

  writeMonthlySummaryData_(sheet, LIVE_SUMMARY_DATA_START_ROW, year, month);
}

/**
 * Writes one condensed totals row per employee (days worked, late count, OT
 * totals) into `sheet` starting at `startRow`. Same sort order as the Report
 * sheet (Japanese first, then Thai staff with any OT this month, then the
 * rest, Employee ID order within each group).
 */
function writeMonthlySummaryData_(sheet, startRow, year, month) {
  var logsByEmployee = getMonthLogsByEmployee_(year, month);

  // Same rule as the Report sheet: Active, or has data this month.
  var employees = getAllEmployees_().filter(function (emp) {
    return isTrue_(emp.Active) || !!logsByEmployee[emp.EmployeeID];
  });

  employees = employees.slice().sort(function (a, b) {
    var groupA = reportSortGroup_(a, logsByEmployee[a.EmployeeID]);
    var groupB = reportSortGroup_(b, logsByEmployee[b.EmployeeID]);
    if (groupA !== groupB) return groupA - groupB;
    return String(a.EmployeeID).localeCompare(String(b.EmployeeID));
  });

  var COLS = 6; // Employee, Department, Days Worked, Late Count, OT (min), OT (Quarter)
  var rows = [['Employee', 'Department', 'Days Worked', 'Late Count', 'OT (min)', 'OT (Quarter)']];

  employees.forEach(function (emp) {
    var dayLogs = logsByEmployee[emp.EmployeeID] || {};
    var daysWorked = 0;
    var lateCount = 0;
    var otMinutesTotal = 0;
    var otQuartersTotal = 0;
    for (var day in dayLogs) {
      var entry = dayLogs[day];
      if (entry.timeIn) daysWorked++;
      if (entry.late) lateCount++;
      otMinutesTotal += entry.otMinutes || 0;
      otQuartersTotal += entry.otQuarters || 0;
    }
    rows.push([emp.Name + ' (' + emp.EmployeeID + ')', emp.Department, daysWorked, lateCount, otMinutesTotal, otQuartersTotal]);
  });

  sheet.getRange(startRow, 1, rows.length, COLS).setValues(rows);
  sheet.getRange(startRow, 1, 1, COLS).setFontWeight('bold').setBackground('#ffe6dd');
  sheet.autoResizeColumns(1, COLS);
}

/**
 * Monthly shift schedule: admin fills this sheet in ahead of time (one row per
 * employee, one column per day, each cell picked from a dropdown of SHIFTS).
 * getScheduledShift_ reads it back at check-in time to auto-apply the shift
 * and compute lateness, so employees no longer pick their own shift.
 */
/**
 * Safe to call anytime -- never wipes cells the admin already filled in, only
 * adds rows for employees who are Active and not already on the sheet. So an
 * employee who joins (or is reactivated) mid-month just needs Create/Update
 * Schedule Sheet run again for that month -- their row gets added at that
 * point, with earlier days blank since there's nothing to schedule for them
 * before they existed. Employees who go inactive mid-month keep whatever row
 * they already have -- rows are never removed, only skipped when adding new
 * ones for a future run.
 */
function buildScheduleSheet_(year, month) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetName = 'Schedule ' + year + '-' + (month < 10 ? '0' + month : String(month));
  var daysInMonth = new Date(year, month, 0).getDate();
  var employees = getAllEmployees_().filter(function (emp) { return isTrue_(emp.Active); });

  var existing = ss.getSheetByName(sheetName);
  if (existing) {
    var values = existing.getDataRange().getValues();
    var headers = values[0];
    var idCol = headers.indexOf('EmployeeID');
    var existingIds = {};
    for (var i = 1; i < values.length; i++) existingIds[String(values[i][idCol])] = true;

    var newRows = employees
      .filter(function (emp) { return !existingIds[emp.EmployeeID]; })
      .map(function (emp) {
        var row = [emp.EmployeeID, emp.Name];
        for (var d = 1; d <= daysInMonth; d++) row.push('');
        return row;
      });
    if (newRows.length > 0) {
      var startRow = existing.getLastRow() + 1;
      existing.getRange(startRow, 1, newRows.length, headers.length).setValues(newRows);
    }
    // Colors and the dropdown list are cosmetic/validation only -- safe to
    // refresh across the whole sheet every time. Never touches any shift
    // value already filled in, so a sheet made before "Event" was added to
    // SHIFTS picks up the new option too.
    if (existing.getLastRow() > 1) {
      var refreshedRule = SpreadsheetApp.newDataValidation().requireValueInList(SHIFTS, true).setAllowInvalid(true).build();
      existing.getRange(2, 3, existing.getLastRow() - 1, daysInMonth).setDataValidation(refreshedRule);
    }
    applyWeekendColors_(existing, 1, existing.getLastRow(), year, month, daysInMonth);
    return sheetName;
  }

  var header = ['EmployeeID', 'Name'];
  for (var d = 1; d <= daysInMonth; d++) header.push(d);

  var rows = [header];
  employees.forEach(function (emp) {
    var row = [emp.EmployeeID, emp.Name];
    for (var d = 1; d <= daysInMonth; d++) row.push('');
    rows.push(row);
  });

  var sheet = ss.insertSheet(sheetName);
  sheet.getRange(1, 1, rows.length, header.length).setValues(rows);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(2);

  if (rows.length > 1) {
    var rule = SpreadsheetApp.newDataValidation().requireValueInList(SHIFTS, true).setAllowInvalid(true).build();
    sheet.getRange(2, 3, rows.length - 1, daysInMonth).setDataValidation(rule);
  }

  applyWeekendColors_(sheet, 1, rows.length, year, month, daysInMonth);

  sheet.autoResizeColumns(1, 2);
  return sheetName;
}

/** Tints Saturday (#cfe2f3) / Sunday (#f4cccc) day-columns, matching the admin's own coloring, across the given rows. */
function applyWeekendColors_(sheet, startRow, numRows, year, month, daysInMonth) {
  if (numRows <= 0) return;
  for (var d = 1; d <= daysInMonth; d++) {
    var dayOfWeek = new Date(year, month - 1, d).getDay(); // 0 = Sunday, 6 = Saturday
    var color = dayOfWeek === 6 ? '#cfe2f3' : dayOfWeek === 0 ? '#f4cccc' : null;
    if (color) {
      sheet.getRange(startRow, 2 + d, numRows, 1).setBackground(color);
    }
  }
}

/** Returns the scheduled shift string for an employee on a given date, or '' if none is set. */
function getScheduledShift_(employeeId, date) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var year = date.getFullYear();
  var month = date.getMonth() + 1;
  var sheetName = 'Schedule ' + year + '-' + (month < 10 ? '0' + month : String(month));
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return '';

  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idCol = headers.indexOf('EmployeeID');
  var dayCol = headers.indexOf(date.getDate());
  if (idCol === -1 || dayCol === -1) return '';

  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idCol]) === String(employeeId)) {
      return String(values[i][dayCol] || '').trim();
    }
  }
  return '';
}

function getAllEmployees_() {
  var sheet = getSheet_('Employees');
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var list = [];
  for (var i = 1; i < values.length; i++) {
    var record = {};
    headers.forEach(function (h, c) { record[h] = values[i][c]; });
    list.push(record);
  }
  list.sort(function (a, b) { return String(a.Name).localeCompare(String(b.Name)); });
  return list;
}

/** Returns { [employeeId]: { [dayOfMonth]: { timeIn, timeOut, shift, late, otMinutes, otQuarters } } } for the given month. */
function getMonthLogsByEmployee_(year, month) {
  var sheet = getSheet_('AttendanceLog');
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var tsCol = headers.indexOf('Timestamp');
  var idCol = headers.indexOf('EmployeeID');
  var typeCol = headers.indexOf('Type');
  var shiftCol = headers.indexOf('Shift');
  var lateCol = headers.indexOf('Late');
  var otMinutesCol = headers.indexOf('OTMinutes');
  var otQuartersCol = headers.indexOf('OTQuarters');

  var result = {};
  for (var i = 1; i < values.length; i++) {
    var ts = new Date(values[i][tsCol]);
    if (ts.getFullYear() !== year || ts.getMonth() + 1 !== month) continue;

    var employeeId = String(values[i][idCol]);
    var type = values[i][typeCol];
    var day = ts.getDate();

    if (!result[employeeId]) result[employeeId] = {};
    if (!result[employeeId][day]) {
      result[employeeId][day] = { timeIn: null, timeOut: null, shift: '', late: false, otMinutes: 0, otQuarters: 0 };
    }

    if (type === 'IN') {
      if (!result[employeeId][day].timeIn || ts < result[employeeId][day].timeIn) {
        result[employeeId][day].timeIn = ts;
        result[employeeId][day].shift = shiftCol !== -1 ? String(values[i][shiftCol] || '') : '';
        result[employeeId][day].late = lateCol !== -1 ? isTrue_(values[i][lateCol]) : false;
      }
    } else if (type === 'OUT') {
      if (!result[employeeId][day].timeOut || ts > result[employeeId][day].timeOut) {
        result[employeeId][day].timeOut = ts;
        result[employeeId][day].otMinutes = otMinutesCol !== -1 ? Number(values[i][otMinutesCol]) || 0 : 0;
        result[employeeId][day].otQuarters = otQuartersCol !== -1 ? Number(values[i][otQuartersCol]) || 0 : 0;
      }
    }
  }
  return result;
}

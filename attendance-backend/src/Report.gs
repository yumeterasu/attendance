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
  // Someone on Leave (or a company Holiday) never taps IN, so there's no
  // AttendanceLog row for that day and the Shift column would otherwise sit
  // blank -- indistinguishable from a genuinely forgotten clock-in. Read the
  // Schedule sheet once so those days can show "Leave"/"Holiday" instead
  // (see FULL_DAY_OFF_SHIFTS); every other blank day (no AttendanceLog row
  // and not scheduled as a full day off -- including "Half Day Annual
  // Leave"/"Half Day Sick Leave", which still expect a real clock-in for
  // the other half) is left blank
  // as before, on purpose, so a real missed clock-in still stands out.
  var scheduledShiftsForMonth = getScheduledShiftsForMonth_(year, month);

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
      if (!dayEntry) {
        var scheduledShift = scheduledShiftsForMonth[emp.EmployeeID] && scheduledShiftsForMonth[emp.EmployeeID][d];
        if (FULL_DAY_OFF_SHIFTS.indexOf(scheduledShift) !== -1) shift = scheduledShift;
      }
      var isLateDay = !!(dayEntry && dayEntry.late);
      var late = isLateDay ? 'Late' : '';
      var otMinutes = dayEntry && dayEntry.otMinutes ? dayEntry.otMinutes : '';
      var otQuarters = dayEntry && dayEntry.otQuarters ? dayEntry.otQuarters : '';
      rows.push([
        Utilities.formatDate(date, tz, 'dd/MM/yyyy'),
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
    // Force column A to plain text before writing -- otherwise Sheets
    // auto-parses date-like strings such as "05/07/2026" as an actual date
    // (ambiguous day<=12 could be read as month) and re-displays it in its
    // own default format, while "13/07/2026" can't be misread as a month so
    // it's left as literal text -- the exact same class of bug as Kiosk PINs
    // losing a leading zero. Plain text stops Sheets from ever touching it.
    sheet.getRange(startRow, 1, rows.length, 1).setNumberFormat('@');
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

// OT pay rates for the Summary sheet's "OT Pay (Baht)" column.
var JP_OT_BAHT_PER_MIN = 8.33; // Japanese: flat baht per OT minute, salary-independent.
// Thai: baht per OT quarter (15 min) = Salary / 640, i.e.
//   Salary /30 days /8 work-hours /4 quarters-per-hour, then x1.5 OT multiplier
//   = Salary / (30*8*4) * 1.5 = Salary / 640.
// So a Thai employee needs a Salary in the Employees sheet to earn OT pay; blank
// Salary leaves their OT Pay blank (not eligible).
var THAI_OT_QUARTER_DIVISOR = 640;

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

  ensureColumns_('Employees', ['Salary']); // adds the header if missing so Thai OT Pay can work without a manual setup step

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

  var COLS = 7; // Employee, Department, Days Worked, Late Count, OT (min), OT (Quarter), OT Pay (Baht)
  var LATE_COUNT_COL = 4;
  var OT_PAY_COL = 7;
  var rows = [['Employee', 'Department', 'Days Worked', 'Late Count', 'OT (min)', 'OT (Quarter)', 'OT Pay (Baht)']];
  var lateHighlightRows = []; // sheet row numbers (1-indexed) where Late Count > 0, for the red highlight below
  var otPayHighlightRows = []; // sheet row numbers (1-indexed) where OT Pay > 0, for the light-green highlight below

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

    var otPay = computeOtPay_(emp, otMinutesTotal, otQuartersTotal);
    rows.push([emp.Name + ' (' + emp.EmployeeID + ')', emp.Department, daysWorked, lateCount, otMinutesTotal, otQuartersTotal, otPay]);
    if (lateCount > 0) lateHighlightRows.push(startRow + rows.length - 1);
    if (otPay > 0) otPayHighlightRows.push(startRow + rows.length - 1);
  });

  sheet.getRange(startRow, 1, rows.length, COLS).setValues(rows);
  sheet.getRange(startRow, 1, 1, COLS).setFontWeight('bold').setBackground('#ffe6dd');

  if (lateHighlightRows.length > 0) {
    var lateA1Notations = lateHighlightRows.map(function (r) { return sheet.getRange(r, LATE_COUNT_COL).getA1Notation(); });
    var lateRangeList = sheet.getRangeList(lateA1Notations);
    lateRangeList.setBackground('#c0392b');
    lateRangeList.setFontColor('#ffffff');
  }

  if (otPayHighlightRows.length > 0) {
    var a1Notations = otPayHighlightRows.map(function (r) { return sheet.getRange(r, OT_PAY_COL).getA1Notation(); });
    sheet.getRangeList(a1Notations).setBackground('#d9ead3');
  }

  sheet.autoResizeColumns(1, COLS);
}

/**
 * OT pay in baht for one employee's month (Summary sheet's "OT Pay (Baht)").
 * - Japanese: OT minutes x JP_OT_BAHT_PER_MIN -- flat rate, no Salary needed,
 *   so always a number (0 when they had no OT).
 * - Everyone else (Thai): OT quarters x (Salary / THAI_OT_QUARTER_DIVISOR).
 *   Requires a Salary in the Employees sheet; a blank Salary returns '' so the
 *   cell stays empty (not eligible) rather than showing 0.
 * Salary tolerates a comma-formatted value like "20,000".
 */
function computeOtPay_(emp, otMinutesTotal, otQuartersTotal) {
  if (emp.Department === 'Japanese') {
    return round2_(otMinutesTotal * JP_OT_BAHT_PER_MIN);
  }
  var salary = Number(String(emp.Salary == null ? '' : emp.Salary).replace(/,/g, '').trim());
  if (!(salary > 0)) return ''; // no Salary on file -> not eligible for OT pay
  return round2_(otQuartersTotal * (salary / THAI_OT_QUARTER_DIVISOR));
}

function round2_(n) {
  return Math.round(n * 100) / 100;
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
var BRANCH_DEPT_COLORS = {
  'PP|Japanese': '#00ff00',
  'PP|Thai': '#ffff00',
  'TL|Japanese': '#b4a7d6',
  'TL|Thai': '#ead1dc'
};

/**
 * Colors columns A (EmployeeID) and B (Name) by Branch+Department, one row
 * at a time so it works regardless of row order. Header row (row 1) is
 * never touched. Employees with a Branch/Department combo not in
 * BRANCH_DEPT_COLORS (blank Branch, etc.) are left uncolored.
 */
function applyBranchDeptColors_(sheet, values, headers) {
  var idCol = headers.indexOf('EmployeeID');
  if (idCol === -1) return;

  var employeesById = {};
  getAllEmployees_().forEach(function (emp) { employeesById[String(emp.EmployeeID)] = emp; });

  var rangesByColor = {};
  for (var i = 1; i < values.length; i++) {
    var emp = employeesById[String(values[i][idCol])];
    if (!emp) continue;
    var color = BRANCH_DEPT_COLORS[emp.Branch + '|' + emp.Department];
    if (!color) continue;
    if (!rangesByColor[color]) rangesByColor[color] = [];
    rangesByColor[color].push('A' + (i + 1) + ':B' + (i + 1));
  }

  Object.keys(rangesByColor).forEach(function (color) {
    sheet.getRangeList(rangesByColor[color]).setBackground(color);
  });
}

/**
 * Sort key for a Schedule row's employee: [branchIndex, deptIndex] --
 * Branch in BRANCHES order (unrecognized/blank last), then Japanese before
 * Thai within each branch. Employee ID is the final tiebreaker wherever this
 * is used. Shared by buildScheduleSheet_'s new-sheet path and its
 * existing-sheet re-sort, so the two orderings can never drift apart.
 */
function scheduleSortKey_(emp) {
  var branchIndex = emp ? BRANCHES.indexOf(emp.Branch) : -1;
  if (branchIndex === -1) branchIndex = BRANCHES.length;
  var deptIndex = emp && emp.Department === 'Japanese' ? 0 : emp && emp.Department === 'Thai' ? 1 : 2;
  return [branchIndex, deptIndex];
}

function buildScheduleSheet_(year, month) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetName = 'Schedule ' + year + '-' + (month < 10 ? '0' + month : String(month));
  var daysInMonth = new Date(year, month, 0).getDate();
  var employees = getAllEmployees_().filter(function (emp) { return isTrue_(emp.Active); });

  // Row order: Branch (BRANCHES order, unrecognized/blank last), then
  // Japanese before Thai within each branch, then Employee ID.
  employees = employees.slice().sort(function (a, b) {
    var keyA = scheduleSortKey_(a), keyB = scheduleSortKey_(b);
    if (keyA[0] !== keyB[0]) return keyA[0] - keyB[0];
    if (keyA[1] !== keyB[1]) return keyA[1] - keyB[1];
    return String(a.EmployeeID).localeCompare(String(b.EmployeeID));
  });

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

    // Re-sort the whole sheet (existing rows + whatever just got appended)
    // into Branch/Department/EmployeeID order every time this runs -- moves
    // each employee's whole row (every day's shift together) as one unit, so
    // nothing gets mismatched. Used to be a separate "Reorder Schedule by
    // Branch/Department" menu item; folded in here since re-running this
    // command is already the normal way to add someone mid-month, so the
    // sheet may as well always come out sorted instead of needing a second
    // manual step afterward.
    var employeesById = {};
    getAllEmployees_().forEach(function (emp) { employeesById[String(emp.EmployeeID)] = emp; });
    var freshValues = existing.getDataRange().getValues();
    var dataRows = freshValues.slice(1);
    if (dataRows.length > 0) {
      dataRows.sort(function (rowA, rowB) {
        var keyA = scheduleSortKey_(employeesById[String(rowA[idCol])]);
        var keyB = scheduleSortKey_(employeesById[String(rowB[idCol])]);
        if (keyA[0] !== keyB[0]) return keyA[0] - keyB[0];
        if (keyA[1] !== keyB[1]) return keyA[1] - keyB[1];
        return String(rowA[idCol]).localeCompare(String(rowB[idCol]));
      });
      existing.getRange(2, 1, dataRows.length, headers.length).setValues(dataRows);
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
    if (existing.getLastRow() > 1) {
      applyBranchDeptColors_(existing, existing.getDataRange().getValues(), headers);
      applyLeaveHolidayConditionalFormat_(existing, 2, existing.getLastRow() - 1, daysInMonth);
    }
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
  if (rows.length > 1) {
    applyBranchDeptColors_(sheet, rows, header);
    applyLeaveHolidayConditionalFormat_(sheet, 2, rows.length - 1, daysInMonth);
  }

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

/**
 * Live conditional-format rule for the day-columns, not a one-time paint
 * like applyWeekendColors_ -- so a cell picks up the light-orange treatment
 * the moment someone picks a Leave/Holiday shift from the dropdown, without
 * needing to re-run Create/Refresh Schedule Sheet afterward. Matches the
 * same "Leave" substring / "Holiday" exact-match rule the Kiosk app's My
 * Schedule calendar uses, so a new option (e.g. a future "Bereavement
 * Leave") is covered automatically the moment it's added to SHIFTS --
 * nothing here needs to change for it.
 */
function applyLeaveHolidayConditionalFormat_(sheet, startRow, numRows, daysInMonth) {
  if (numRows <= 0) return;
  var range = sheet.getRange(startRow, 3, numRows, daysInMonth);
  var anchor = range.getCell(1, 1).getA1Notation(); // top-left cell -- the formula below is relative to this, same as typing it directly into that cell

  // Drop any earlier rule scoped to this exact range first, so re-running
  // Create/Refresh Schedule Sheet doesn't pile up duplicate rules.
  var rangeA1 = range.getA1Notation();
  var rules = sheet.getConditionalFormatRules().filter(function (rule) {
    return !rule.getRanges().some(function (r) { return r.getA1Notation() === rangeA1; });
  });

  rules.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=OR(REGEXMATCH(' + anchor + ', "Leave"), ' + anchor + '="Holiday")')
      .setBackground('#FFF3E0')
      .setRanges([range])
      .build()
  );
  sheet.setConditionalFormatRules(rules);
}

// Cells this far or more off the scheduled shift's start time, where some
// other shift option matches the actual check-in better, get highlighted --
// see highlightShiftMismatches_.
var SHIFT_MISMATCH_MINUTES_THRESHOLD = 15;
var SHIFT_MISMATCH_COLOR = '#f9a825';

/** First "H:MM" found in a shift/event string, as minutes since midnight. Null for blank/Leave/Holiday/Half Day Annual Leave/anything unparseable. Same "first match = start" rule as isLate_. */
function getShiftStartMinutes_(shiftOrEvent) {
  var match = String(shiftOrEvent || '').match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function minutesToHHMM_(totalMinutes) {
  var h = Math.floor(totalMinutes / 60);
  var m = totalMinutes % 60;
  return (h < 10 ? '0' + h : h) + ':' + (m < 10 ? '0' + m : m);
}

/**
 * Highlights Schedule cells where the actual recorded check-in is a
 * noticeably better match for a DIFFERENT shift option than the one
 * currently entered -- usually means the real agreed shift changed but this
 * particular cell never got updated, so what looks like "Late" is really
 * just a stale schedule entry. A cell is flagged when the actual check-in is
 * more than SHIFT_MISMATCH_MINUTES_THRESHOLD minutes off the scheduled
 * shift's start AND some other SHIFTS option (with a real time -- Leave/
 * Holiday/Half Day Annual Leave never match anything) is closer to the actual time
 * than the one currently scheduled. Event shifts (e.g. "Event 8:00-17:00")
 * are skipped entirely, both as a day to check and as a candidate "closer"
 * match -- they're one-off/irregular by nature, not a stale entry that
 * should get flagged or "corrected" back into the normal rotation.
 *
 * Snapshot check, not live -- resets every day-cell background (then
 * re-applies the weekend tint) before highlighting, so a mismatch fixed
 * since the last run doesn't stay highlighted forever.
 */
function highlightShiftMismatches_(sheet, year, month) {
  var daysInMonth = new Date(year, month, 0).getDate();
  // Event shifts are excluded both as a scheduled value to check (see the
  // loop below) and as a candidate "did you mean this instead" match here --
  // a one-off event isn't part of the normal shift rotation a stale entry
  // would actually get corrected to.
  var timedShifts = SHIFTS.filter(function (s) { return getShiftStartMinutes_(s) !== null && !/^Event\b/.test(s); });

  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idCol = headers.indexOf('EmployeeID');
  var nameCol = headers.indexOf('Name');
  var lastRow = sheet.getLastRow();
  var numDataRows = lastRow - 1;

  if (numDataRows > 0) {
    sheet.getRange(2, 3, numDataRows, daysInMonth).setBackground(null);
  }
  applyWeekendColors_(sheet, 1, lastRow, year, month, daysInMonth);

  // Actual IN time (local minutes-since-midnight) per employeeId|day, read
  // once instead of once per cell. Earliest IN wins on a day with more than
  // one (offline-sync duplicate, etc.) -- same rule getMonthLogsByEmployee_
  // already uses.
  var logSheet = getSheet_('AttendanceLog');
  var logValues = logSheet.getDataRange().getValues();
  var logHeaders = logValues[0];
  var logIdCol = logHeaders.indexOf('EmployeeID');
  var logTsCol = logHeaders.indexOf('Timestamp');
  var logTypeCol = logHeaders.indexOf('Type');
  var actualInMinutesByKey = {};
  for (var i = 1; i < logValues.length; i++) {
    if (logValues[i][logTypeCol] !== 'IN') continue;
    var ts = new Date(logValues[i][logTsCol]);
    if (ts.getFullYear() !== year || ts.getMonth() + 1 !== month) continue;
    var key = String(logValues[i][logIdCol]) + '|' + ts.getDate();
    var minutes = ts.getHours() * 60 + ts.getMinutes();
    if (!(key in actualInMinutesByKey) || minutes < actualInMinutesByKey[key]) {
      actualInMinutesByKey[key] = minutes;
    }
  }

  var flaggedA1 = [];
  var lines = [];
  for (var r = 1; r < values.length; r++) {
    var employeeId = String(values[r][idCol]);
    for (var d = 1; d <= daysInMonth; d++) {
      var dayCol = headers.indexOf(d);
      if (dayCol === -1) continue;
      var scheduledShift = String(values[r][dayCol] || '').trim();
      if (/^Event\b/.test(scheduledShift)) continue; // one-off/irregular by nature -- not a normal recurring shift to flag as "wrong"
      var scheduledStart = getShiftStartMinutes_(scheduledShift);
      if (scheduledStart === null) continue; // blank, Leave, Holiday, Half Day Annual Leave, or unparseable -- nothing to compare

      var key = employeeId + '|' + d;
      if (!(key in actualInMinutesByKey)) continue; // no check-in that day -- a different concern (see checkMissingAttendance_)
      var actualMinutes = actualInMinutesByKey[key];

      // Arriving early never causes a false Late flag (isLate_ only fires
      // when actual > scheduled start), so it's never worth flagging here --
      // only look at check-ins AFTER the scheduled start, which is exactly
      // what a stale (too-early) schedule entry would cause.
      var currentDistance = actualMinutes - scheduledStart;
      if (currentDistance <= SHIFT_MISMATCH_MINUTES_THRESHOLD) continue;

      // Only compare against LATER shift options -- the question is "does a
      // later shift explain this as on-time," not "is some earlier shift
      // numerically closer" (that would just re-flag ordinary early
      // arrivals relative to a later shift, the same false-positive noise
      // this guards against).
      var closerShift = null;
      var closerDistance = currentDistance;
      timedShifts.forEach(function (s) {
        var start = getShiftStartMinutes_(s);
        if (start <= scheduledStart) return;
        var dist = Math.abs(actualMinutes - start);
        if (dist < closerDistance) { closerDistance = dist; closerShift = s; }
      });
      if (!closerShift) continue; // no later shift fits better -- genuinely late, not a wrong entry

      flaggedA1.push(sheet.getRange(r + 1, dayCol + 1).getA1Notation());
      lines.push(
        values[r][nameCol] + ', day ' + d + ': scheduled "' + scheduledShift + '" but checked in ' +
        minutesToHHMM_(actualMinutes) + ' -- closer to "' + closerShift + '"'
      );
    }
  }

  if (flaggedA1.length > 0) {
    sheet.getRangeList(flaggedA1).setBackground(SHIFT_MISMATCH_COLOR);
  }

  return { flaggedCount: flaggedA1.length, lines: lines };
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
/** Full-history scan -- fine for Report/Recompute, which run from the menu with minutes of budget and need to reach arbitrary past months. See getRecentMonthLogsByEmployee_ for the Kiosk's bounded-cost equivalent. */
function getMonthLogsByEmployee_(year, month) {
  var sheet = getSheet_('AttendanceLog');
  var values = sheet.getDataRange().getValues();
  return aggregateMonthLogs_(values, year, month);
}

// My Schedule on the Kiosk only ever asks for the CURRENT month (see
// handleKioskMyAttendance_), so unlike getMonthLogsByEmployee_ this reads
// only a bounded recent tail instead of the whole AttendanceLog history --
// keeps My Schedule fast no matter how many months of history pile up,
// instead of slowly regressing the same way Recompute Late/OT and friends
// once did. Sized generously past one month's worth of activity for the
// whole staff (including backdated entries, which land at the bottom
// regardless of which date they're actually for -- see
// recordBackdatedAttendance_ -- so they're always within this tail too).
var MONTHLY_LOG_TAIL_ROWS = 8000;

function getRecentMonthLogsByEmployee_(year, month) {
  var sheet = getSheet_('AttendanceLog');
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2) return {};

  var headerRow = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var startRow = Math.max(2, lastRow - MONTHLY_LOG_TAIL_ROWS + 1);
  var dataRows = sheet.getRange(startRow, 1, lastRow - startRow + 1, lastCol).getValues();
  return aggregateMonthLogs_([headerRow].concat(dataRows), year, month);
}

/** Shared by getMonthLogsByEmployee_ and getRecentMonthLogsByEmployee_ -- values[0] must be the header row. */
function aggregateMonthLogs_(values, year, month) {
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

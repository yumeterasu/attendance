/**
 * Special Allowances: a flexible, admin-named monthly money amount per
 * employee (e.g. a "ค่าข้าว" rice allowance, a one-off tip bonus) that is
 * tracked completely separately from OT pay (computeOtPay_, Report.gs) --
 * its own sheet, its own total, so it can never get folded into or confused
 * with the OT calculation. One row per entry (not one column per label),
 * since the label itself is free text chosen by the admin each time and one
 * employee can have more than one entry in the same month (e.g. a rice
 * allowance AND a tip bonus together) -- same "log, not a fixed-column
 * table" shape as AttendanceLog, for the same reason: the set of possible
 * labels isn't known ahead of time.
 */
var ALLOWANCES_SHEET_NAME = 'Allowances';
var ALLOWANCES_HEADERS = ['Timestamp', 'EmployeeID', 'Name', 'Year', 'Month', 'Label', 'Amount', 'Note', 'AddedBy'];

/**
 * Creates the Allowances sheet with its header row the first time it's
 * needed, so there's no separate one-off "run this once from the editor"
 * setup step the way the Report/Summary sheets have -- the very first "Add
 * Special Allowance" from the menu just works. Lock-protected the same way
 * ensureColumns_ (Utils.gs) is: this only ever runs from a manual,
 * one-admin-at-a-time menu action, so the contention risk is low, but a
 * short tryLock is cheap insurance against two people opening the Sheet and
 * clicking the menu item at the same moment before the sheet exists yet.
 */
function getOrCreateAllowancesSheet_() {
  var lock = LockService.getScriptLock();
  var haveLock = false;
  try {
    haveLock = lock.tryLock(1000);
  } catch (e) {}

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(ALLOWANCES_SHEET_NAME);
    if (!sheet) {
      try {
        sheet = ss.insertSheet(ALLOWANCES_SHEET_NAME);
        sheet.getRange(1, 1, 1, ALLOWANCES_HEADERS.length).setValues([ALLOWANCES_HEADERS]);
        sheet.setFrozenRows(1);
      } catch (e) {
        // Only reachable if tryLock above missed the lock (contended) AND
        // another call's insertSheet landed in between this one's
        // getSheetByName check and its own insertSheet -- insertSheet then
        // throws "a sheet with this name already exists" instead of
        // quietly reusing it. Self-heals by just reading back what the
        // other call created, rather than surfacing a confusing error to
        // whichever admin's click lost the race.
        sheet = ss.getSheetByName(ALLOWANCES_SHEET_NAME);
        if (!sheet) throw e; // genuinely something else went wrong -- don't swallow that
      }
    }
    return sheet;
  } finally {
    if (haveLock) lock.releaseLock();
  }
}

/**
 * Appends one Special Allowance entry. Called from menuAddSpecialAllowance_
 * (Menu.gs), looped once per employee for however many names/IDs the admin
 * typed into that one comma-separated prompt (one name or several) -- kept
 * as its own function (rather than inlined there) so the reading side just
 * below and the writing side agree on the exact column layout in exactly
 * one place.
 *
 * `sheet` (optional) lets that caller resolve the sheet via
 * getOrCreateAllowancesSheet_ ONCE before its loop and pass it through,
 * instead of this function re-acquiring the script lock and re-doing
 * getSheetByName on every single row of the same batch. Omitted, it
 * resolves the sheet itself.
 */
function appendSpecialAllowance_(employeeId, name, year, month, label, amount, note, addedBy, sheet) {
  sheet = sheet || getOrCreateAllowancesSheet_();
  var row = ALLOWANCES_HEADERS.map(function (h) {
    switch (h) {
      case 'Timestamp': return new Date();
      case 'EmployeeID': return employeeId;
      case 'Name': return name;
      case 'Year': return year;
      case 'Month': return month;
      case 'Label': return label;
      case 'Amount': return amount;
      case 'Note': return note || '';
      case 'AddedBy': return addedBy || '';
      default: return '';
    }
  });
  sheet.appendRow(row);
}

/**
 * Reads the whole Allowances sheet exactly once into plain row objects
 * ({employeeId, year, month, label, amount}). Every other function in this
 * file builds on this single reader instead of each re-doing its own
 * header-index lookup -- so if the sheet's columns ever change, there is
 * exactly one place to update, not several independent copies that could
 * silently drift out of sync with each other. Returns [] (not an error)
 * when the sheet doesn't exist yet (nobody has ever added an allowance), so
 * every caller can use this unconditionally without its own existence check.
 */
function readAllowanceRows_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(ALLOWANCES_SHEET_NAME);
  if (!sheet) return [];

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var idCol = headers.indexOf('EmployeeID');
  var yearCol = headers.indexOf('Year');
  var monthCol = headers.indexOf('Month');
  var labelCol = headers.indexOf('Label');
  var amountCol = headers.indexOf('Amount');

  var data = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return data.map(function (row) {
    return {
      employeeId: String(row[idCol]),
      year: Number(row[yearCol]),
      month: Number(row[monthCol]),
      label: String(row[labelCol]),
      amount: Number(row[amountCol]) || 0
    };
  });
}

/**
 * Every Special Allowance entry for ONE calendar Year/Month, for every
 * employee who has one, keyed by EmployeeID -- backs the monthly Summary
 * sheet's total column (writeMonthlySummaryData_, Report.gs) AND that same
 * function's "Active, or has data this month" employee filter (a
 * deactivated employee with nothing but a late allowance entry must still
 * show up on the Summary for that month, same reasoning as an attendance
 * row keeping them visible). One read of the whole sheet covers every
 * employee at once, instead of writeMonthlySummaryData_ calling a
 * per-employee lookup (and re-reading the whole sheet) once per roster row.
 */
function getAllowancesForMonth_(year, month) {
  var byEmployee = {};
  readAllowanceRows_().forEach(function (entry) {
    if (entry.year === Number(year) && entry.month === Number(month)) {
      if (!byEmployee[entry.employeeId]) byEmployee[entry.employeeId] = [];
      byEmployee[entry.employeeId].push({ label: entry.label, amount: entry.amount });
    }
  });
  return byEmployee;
}

/**
 * Sums a list of {label, amount} entries (as getAllowancesForMonth_/
 * getAllowancesForEmployeeMonth_ return) into one Baht total, rounding EACH
 * entry first and only then summing -- the one place this "round each, then
 * sum" rule lives, instead of the same reduce expression being copy-pasted
 * at every call site (writeMonthlySummaryData_ and getDashboardSummaryData_
 * in Report.gs both call this instead of reimplementing it). Keeping the
 * rule in one function is what actually guarantees the Summary sheet, the
 * Dashboard, and the PDF can never quietly disagree by a cent on the same
 * employee/month -- copy-pasted math is exactly the kind of thing that
 * drifts the next time someone touches only one of the copies.
 */
function sumRoundedAllowances_(entries) {
  return round2_((entries || []).reduce(function (sum, a) { return sum + round2_(a.amount); }, 0));
}

/**
 * Every Special Allowance entry for ONE employee in ONE calendar Year/Month
 * -- backs the Print Employee Report PDF's itemized lines
 * (writeMonthlyReportData_, Report.gs), which only ever needs a single
 * employee's entries for a single print run, so reading the whole sheet
 * once per print is the simplest correct thing (not worth threading a
 * shared per-month map through for a one-off admin action).
 */
function getAllowancesForEmployeeMonth_(employeeId, year, month) {
  return getAllowancesForMonth_(year, month)[String(employeeId)] || [];
}

/**
 * Whole-fiscal-year totals for the Summary sheet's "All" Month option
 * (writeYearlySummaryData_, Report.gs), keyed by EmployeeID -- same fiscal
 * year boundary (FISCAL_YEAR_START_MONTH, Report.gs) aggregateYearSummary_
 * uses for the other yearly totals on that same sheet, so this column lines
 * up with the same 12 months "Days Worked"/"OT Pay" etc. are summed over,
 * not a plain Jan-Dec calendar year. Also backs that same function's
 * employee filter, for the same "a deactivated employee with only a late
 * allowance entry must still show up" reason getAllowancesForMonth_'s doc
 * comment explains for the monthly path.
 *
 * One read of the whole sheet (via readAllowanceRows_) covers every
 * employee's whole-year total at once, instead of writeYearlySummaryData_
 * calling a per-employee, per-month lookup 12x per roster row.
 */
function aggregateSpecialAllowancesForYear_(year) {
  var fiscalStart = new Date(year, FISCAL_YEAR_START_MONTH, 1);
  var fiscalEndExclusive = new Date(year + 1, FISCAL_YEAR_START_MONTH, 1);

  var entriesByEmployee = {};
  readAllowanceRows_().forEach(function (entry) {
    // Each row's own Year/Month (the month the admin picked for it when
    // adding it), not the Timestamp it was entered at -- an allowance added
    // late for a prior month must still count toward THAT month's fiscal
    // year, not the one it happened to be typed in during.
    var entryDate = new Date(entry.year, entry.month - 1, 1);
    if (entryDate >= fiscalStart && entryDate < fiscalEndExclusive) {
      if (!entriesByEmployee[entry.employeeId]) entriesByEmployee[entry.employeeId] = [];
      entriesByEmployee[entry.employeeId].push(entry);
    }
  });

  // sumRoundedAllowances_ owns the "round each entry, then sum" rule in
  // exactly one place (see its own doc comment) -- grouping by employee
  // first, then summing each group through that one shared function, is
  // what keeps this yearly total from ever being able to drift from the
  // monthly Summary/Dashboard/PDF figures the same rule governs there.
  var totals = {};
  Object.keys(entriesByEmployee).forEach(function (employeeId) {
    totals[employeeId] = sumRoundedAllowances_(entriesByEmployee[employeeId]);
  });
  return totals;
}

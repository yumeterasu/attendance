/**
 * Historical Summary: an admin-typed record of the months BEFORE this
 * system went live and started tracking real AttendanceLog/Schedule/Salary
 * data -- there's nothing to compute those months' Days Worked/Late/OT/
 * Leave numbers FROM, so unlike every other report in this codebase, these
 * values are typed in directly from whatever record the admin already has
 * (an old spreadsheet, paper records, etc.), not derived from logs.
 *
 * Originally built (2026-11-06) as a totally standalone sheet, never read
 * by any live view. Extended (2026-11-09), after the admin tried it and
 * expected the numbers to actually show up on the Dashboard, into a
 * fallback source: `getEffectiveMonthTotals_`/`getEffectiveYearTotals_`
 * below feed a Historical Summary row into `writeMonthlySummaryData_`,
 * `writeYearlySummaryData_`, `getDashboardSummaryData_` (both branches),
 * and `buildEmployeeReportSummaryLine_` (the Print Employee Report PDF's
 * summary line) -- but ONLY for an employee/month that has no real
 * AttendanceLog/Schedule data at all; real data always wins. See those two
 * functions' own doc comments for the exact precedence rule. Deliberately
 * NOT wired into `getDashboardCalendarData_` (OT/Special Calendar) or the
 * Daily view -- outside the scope the admin asked for; if a future change
 * wants this data to feed into those too, that's a deliberate product
 * decision to make then, not something to extend quietly here.
 *
 * Special Allowance is the one column that stays reference-only even after
 * this extension: the `Allowances` sheet already supports backdating an
 * allowance to any Year/Month with no Schedule/AttendanceLog tab required
 * (`getAllowanceEntriesForYear_`/`getAllowancesForMonth_`, Allowances.gs,
 * have no tab-existence gate), so a real pre-launch allowance belongs there
 * via the Allowancer menu item, not here -- typing a value into this
 * sheet's "Special Allowance (Baht)" column does NOT make it appear
 * anywhere live. Likewise "OT (min)"/"OT (Quarter)" stay reference-only;
 * the authoritative figure for a historical month is always the
 * directly-typed "OT Pay (Baht)" cell (blank = not eligible, matching
 * computeOtPay_'s own convention -- never recomputed from quarters ×
 * salary, since a historical month has no guaranteed "Salary YYYY-MM" tab
 * to price against).
 *
 * Column shape mirrors the live monthly Summary tab's row exactly
 * (writeMonthlySummaryData_, Report.gs) -- Year/Month/EmployeeID/Name/
 * Department up front to identify the row (this is one flat sheet covering
 * every backfilled month, not one tab per month the way Schedule/Salary
 * work, per the admin's explicit request), then the same Days
 * Worked/Late/Over/OT/OT Pay/Special Allowance/leave-type columns an admin
 * copying numbers off an old Summary printout would already recognize.
 * Reuses LEAVE_COUNT_TYPES (Report.gs) directly as the leave column headers
 * so they can never drift out of sync with what the live Summary tab calls
 * them.
 */
var HISTORICAL_SUMMARY_SHEET_NAME = 'Historical Summary';

/**
 * Built as a function, not a top-level `var ... .concat(LEAVE_COUNT_TYPES)`
 * -- Apps Script runs every file's top-level statements once, in file order,
 * before any function runs, and this file sorts alphabetically BEFORE
 * Report.gs (where LEAVE_COUNT_TYPES lives). A top-level concat here would
 * silently capture `undefined` instead of the real leave-type list. Same
 * reason writeMonthlySummaryData_ (Report.gs) itself builds its header row
 * with LEAVE_COUNT_TYPES inline inside the function rather than as a
 * top-level constant -- calling this function is always safe since, by the
 * time anything actually calls it, every file's top-level code (including
 * Report.gs's) has already finished running.
 */
function getHistoricalSummaryHeaders_() {
  return ['Year', 'Month', 'EmployeeID', 'Name', 'Department',
    'Days Worked', 'Late Count', 'Over Count', 'OT (min)', 'OT (Quarter)', 'OT Pay (Baht)', 'Special Allowance (Baht)']
    .concat(LEAVE_COUNT_TYPES)
    .concat(['Note']);
}

/**
 * Creates the Historical Summary sheet with its header row the first time
 * it's needed -- same lazy-create, lock-protected shape as
 * getOrCreateAllowancesSheet_ (Allowances.gs), including the same
 * self-healing fallback for the rare case two admins both trigger the first
 * creation at once. See that function's own doc comment for why a short
 * tryLock is cheap insurance here even though this only ever runs from a
 * manual, one-admin-at-a-time menu action.
 */
function getOrCreateHistoricalSummarySheet_() {
  var lock = LockService.getScriptLock();
  var haveLock = false;
  try {
    haveLock = lock.tryLock(1000);
  } catch (e) {}

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(HISTORICAL_SUMMARY_SHEET_NAME);
    if (!sheet) {
      try {
        sheet = ss.insertSheet(HISTORICAL_SUMMARY_SHEET_NAME);
        var headers = getHistoricalSummaryHeaders_();
        sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
        sheet.setFrozenRows(1);
      } catch (e) {
        sheet = ss.getSheetByName(HISTORICAL_SUMMARY_SHEET_NAME);
        if (!sheet) throw e; // genuinely something else went wrong -- don't swallow that
      }
    }
    return sheet;
  } finally {
    if (haveLock) lock.releaseLock();
  }
}

/**
 * EmployeeIDs that already have a row for this exact Year/Month, so
 * seedHistoricalSummaryRows_ below never appends a duplicate row for an
 * employee it's already seeded -- re-running the menu item for a month
 * already started (e.g. to pick up a newly added employee) is always safe.
 */
function existingHistoricalSummaryEmployeeIds_(sheet, year, month) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};

  var headers = getHistoricalSummaryHeaders_();
  var yearCol = headers.indexOf('Year');
  var monthCol = headers.indexOf('Month');
  var idCol = headers.indexOf('EmployeeID');

  var data = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var ids = {};
  data.forEach(function (row) {
    if (Number(row[yearCol]) === Number(year) && Number(row[monthCol]) === Number(month)) {
      ids[String(row[idCol])] = true;
    }
  });
  return ids;
}

/**
 * Seeds one blank row per employee for the given Year/Month -- EmployeeID/
 * Name/Department filled in, every numeric/leave column left blank for the
 * admin to type over by hand. Same "Active, employees it makes sense to
 * show" filter as every other admin-facing employee list in this codebase;
 * unlike writeMonthlySummaryData_'s filter (Report.gs), there's no
 * logs/allowances presence check to also pull in here since, by definition,
 * a backfilled month has neither -- an admin who needs a row for someone not
 * currently Active (e.g. someone who left since) can just add it by hand,
 * same as any other correction to this sheet.
 *
 * Idempotent: an employee who already has a row for this exact Year/Month
 * (existingHistoricalSummaryEmployeeIds_ above) is skipped, not duplicated.
 * Returns {added: [names], skipped: [names]} for the menu's confirmation
 * alert.
 */
function seedHistoricalSummaryRows_(year, month) {
  var sheet = getOrCreateHistoricalSummarySheet_();
  var headers = getHistoricalSummaryHeaders_();
  var already = existingHistoricalSummaryEmployeeIds_(sheet, year, month);

  var employees = getAllEmployees_().filter(function (emp) { return isTrue_(emp.Active); });

  var added = [];
  var skipped = [];
  var rows = [];
  employees.forEach(function (emp) {
    if (already[String(emp.EmployeeID)]) {
      skipped.push(emp.Name);
      return;
    }
    var row = headers.map(function (h) {
      switch (h) {
        case 'Year': return year;
        case 'Month': return month;
        case 'EmployeeID': return emp.EmployeeID;
        case 'Name': return emp.Name;
        case 'Department': return emp.Department;
        default: return ''; // every numeric/leave/Note column -- left blank for the admin to fill in
      }
    });
    rows.push(row);
    added.push(emp.Name);
  });

  if (rows.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  }

  return { added: added, skipped: skipped };
}

/**
 * Every Historical Summary row for ONE calendar Year/Month, keyed by
 * EmployeeID -- {daysWorked, lateCount, overCount, otMinutesTotal,
 * otQuartersTotal, otPay, leaveCounts}. One read of the whole sheet covers
 * every employee at once, same "read once, not per employee" rule
 * getAllowancesForMonth_/getSalaryForMonth_ already follow. A blank
 * individual cell reads as 0, except "OT Pay (Baht)" which reads as '' when
 * blank -- matching computeOtPay_'s own "blank means not eligible"
 * convention, since a historical month's OT Pay is taken directly from this
 * column, never recomputed from OT (min)/OT (Quarter) (those two stay
 * reference-only -- a historical month has no guaranteed "Salary YYYY-MM"
 * tab to price them against). No "did the admin actually type something in"
 * guard -- every row for this Year/Month is used as-is, trusting whatever
 * is in it.
 */
function getHistoricalSummaryForMonth_(year, month) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(HISTORICAL_SUMMARY_SHEET_NAME);
  if (!sheet) return {};
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};

  var headers = getHistoricalSummaryHeaders_();
  var yearCol = headers.indexOf('Year');
  var monthCol = headers.indexOf('Month');
  var idCol = headers.indexOf('EmployeeID');
  var otPayCol = headers.indexOf('OT Pay (Baht)');

  var data = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  var byEmployee = {};
  data.forEach(function (row) {
    if (Number(row[yearCol]) !== Number(year) || Number(row[monthCol]) !== Number(month)) return;

    var get = function (name) { return row[headers.indexOf(name)]; };
    var num = function (name) { return Number(get(name)) || 0; };
    var leaveCounts = {};
    LEAVE_COUNT_TYPES.forEach(function (t) { leaveCounts[t] = num(t); });

    byEmployee[String(row[idCol])] = {
      daysWorked: num('Days Worked'),
      lateCount: num('Late Count'),
      overCount: num('Over Count'),
      otMinutesTotal: num('OT (min)'),
      otQuartersTotal: num('OT (Quarter)'),
      otPay: row[otPayCol] === '' ? '' : Number(row[otPayCol]) || 0,
      leaveCounts: leaveCounts
    };
  });
  return byEmployee;
}

/**
 * Effective totals for one employee's one calendar month: the real computed
 * numbers (sumMonthTotals_ + computeOtPay_ + countLeavesForEmployee_,
 * Report.gs) when this employee has any real AttendanceLog/Schedule data
 * this month ("has data" = dayLogsForEmployee or scheduledShiftsForEmployee
 * is non-empty), otherwise that employee's Historical Summary row for this
 * month if one exists (getHistoricalSummaryForMonth_ above), otherwise the
 * same real (all-zero/blank) numbers as before this feature existed.
 * Substitutes wholesale, never a partial per-field mix -- a month either
 * comes entirely from live logs or entirely from the backfilled record.
 *
 * historicalByEmployee: getHistoricalSummaryForMonth_(year, month)'s result
 * -- read ONCE per report/Dashboard load by the caller, not re-read here
 * per employee.
 */
function getEffectiveMonthTotals_(emp, dayLogsForEmployee, scheduledShiftsForEmployee, daysInMonth, salaryForMonth, scheduledShiftsForMonth, historicalByEmployee) {
  var hasRealData = (dayLogsForEmployee && Object.keys(dayLogsForEmployee).length > 0) ||
    (scheduledShiftsForEmployee && Object.keys(scheduledShiftsForEmployee).length > 0);

  var realTotals = sumMonthTotals_(dayLogsForEmployee || {}, scheduledShiftsForEmployee, daysInMonth);
  var realOtPay = computeOtPay_(emp, realTotals.otMinutesTotal, realTotals.otQuartersTotal, salaryForMonth);
  var realLeaveCounts = countLeavesForEmployee_(scheduledShiftsForMonth, emp.EmployeeID);

  if (hasRealData) {
    return {
      daysWorked: realTotals.daysWorked, lateCount: realTotals.lateCount, overCount: realTotals.overCount,
      otMinutesTotal: realTotals.otMinutesTotal, otQuartersTotal: realTotals.otQuartersTotal,
      otPay: realOtPay, leaveCounts: realLeaveCounts
    };
  }

  var historical = historicalByEmployee[emp.EmployeeID];
  if (!historical) {
    // Nothing real AND no Historical row either -- realTotals/realOtPay/
    // realLeaveCounts are already the correct all-zero/blank shape for
    // "nothing on file", so reusing them keeps this branch identical to
    // this feature's pre-existing output.
    return {
      daysWorked: realTotals.daysWorked, lateCount: realTotals.lateCount, overCount: realTotals.overCount,
      otMinutesTotal: realTotals.otMinutesTotal, otQuartersTotal: realTotals.otQuartersTotal,
      otPay: realOtPay, leaveCounts: realLeaveCounts
    };
  }

  return {
    daysWorked: historical.daysWorked, lateCount: historical.lateCount, overCount: historical.overCount,
    otMinutesTotal: historical.otMinutesTotal, otQuartersTotal: historical.otQuartersTotal,
    otPay: historical.otPay, leaveCounts: historical.leaveCounts
  };
}

/**
 * Whole-fiscal-year effective totals for one employee: real computed
 * numbers for any fiscal month this employee has real data in (per
 * monthsWithRealData, from the Historical-aware aggregateYearSummary_,
 * Report.gs), that employee's Historical Summary row for any month they
 * don't, summed across all 12 fiscal months. OT Pay sums each month's own
 * contribution rather than pricing one whole-year total -- a Thai real
 * month's contribution is computeOtPay_ priced off that month's own
 * otByMonth entry and Salary sheet, since a Thai salary can change
 * mid-year (Japanese is priced once from the summed real minutes instead,
 * see below); a
 * Historical-fallback month's contribution is that row's typed "OT Pay
 * (Baht)" value taken as-is. The total is blank only if the employee had
 * zero real-eligible months AND zero Historical-fallback months with any
 * OT Pay value all fiscal year -- otherwise it's a number, which may
 * legitimately be 0.
 *
 * employeeTotals: aggregated.totals[emp.EmployeeID] (aggregateYearSummary_'s
 * per-employee result entry, or undefined for an employee with zero real
 * activity all year -- every lookup below tolerates that).
 * monthsWithRealData: aggregated.monthsWithRealData (shared across every
 * employee, keyed '<employeeId>|<calYear>-<calMonth>').
 * historicalByMonth: { '<calYear>-<calMonth>':
 * getHistoricalSummaryForMonth_(calYear, calMonth) }, built once per call
 * by the caller (one Historical Summary read per fiscal month, not per
 * employee), same "read once" rule salaryCache already follows.
 */
function getEffectiveYearTotals_(emp, fiscalMonths, employeeTotals, monthsWithRealData, salaryCache, historicalByMonth) {
  var monthlyTotals = (employeeTotals && employeeTotals.monthlyTotals) || {};
  var otByMonth = (employeeTotals && employeeTotals.otByMonth) || {};
  // Japanese OT pay (flat per-minute rate, salary-independent) is priced
  // ONCE from the summed real minutes at the end, never per real month and
  // summed -- 12 independent round2_ calls can drift the total by a
  // fraction of a baht from what one whole-year computeOtPay_ call gives.
  // Historical-fallback months are unaffected by this -- their OT Pay is
  // already a single stored Baht value, not summed from minutes, so adding
  // them in per month is not a source of the same drift.
  var isJapanese = emp.Department === 'Japanese';
  var realOtMinutesForJp = 0;

  var daysWorked = 0, lateCount = 0, overCount = 0, otMinutesTotal = 0, otQuartersTotal = 0;
  var otPaySum = 0, anyOtEligible = false;

  fiscalMonths.forEach(function (fm) {
    var key = fm.calYear + '-' + fm.calMonth;

    if (monthsWithRealData[emp.EmployeeID + '|' + key]) {
      var mt = monthlyTotals[key] || { daysWorked: 0, lateCount: 0, overCount: 0 };
      daysWorked += mt.daysWorked;
      lateCount += mt.lateCount;
      overCount += mt.overCount;
      var monthOt = otByMonth[key] || { otMinutes: 0, otQuarters: 0 };
      otMinutesTotal += monthOt.otMinutes;
      otQuartersTotal += monthOt.otQuarters;
      if (isJapanese) {
        realOtMinutesForJp += monthOt.otMinutes;
      } else {
        var salaryForMonth = (salaryCache[key] || {})[emp.EmployeeID];
        var monthPay = computeOtPay_(emp, monthOt.otMinutes, monthOt.otQuarters, salaryForMonth);
        if (monthPay !== '') { otPaySum += monthPay; anyOtEligible = true; }
      }
      return;
    }

    var historical = (historicalByMonth[key] || {})[emp.EmployeeID];
    if (!historical) return;
    daysWorked += historical.daysWorked;
    lateCount += historical.lateCount;
    overCount += historical.overCount;
    otMinutesTotal += historical.otMinutesTotal;
    otQuartersTotal += historical.otQuartersTotal;
    if (historical.otPay !== '') { otPaySum += historical.otPay; anyOtEligible = true; }
  });

  if (isJapanese) {
    // computeOtPay_'s Japanese branch never returns '' (always a number,
    // 0 when there was no OT) -- matches that same "always eligible"
    // convention here.
    otPaySum += computeOtPay_(emp, realOtMinutesForJp, 0, undefined);
    anyOtEligible = true;
  }

  return {
    daysWorked: daysWorked, lateCount: lateCount, overCount: overCount,
    otMinutesTotal: otMinutesTotal, otQuartersTotal: otQuartersTotal,
    otPay: anyOtEligible ? round2_(otPaySum) : ''
  };
}

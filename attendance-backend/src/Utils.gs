/**
 * Shared helpers: sheet access, JSON responses, hashing.
 */

function getSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    throw new Error('Sheet not found: ' + name);
  }
  return sheet;
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function ok_(data) {
  var body = Object.assign({ success: true }, data || {});
  return jsonResponse_(body);
}

function fail_(error, message) {
  return jsonResponse_({ success: false, error: error, message: message || error });
}

function sha256Hex_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

function hmacHex_(text, secret) {
  var bytes = Utilities.computeHmacSha256Signature(text, secret, Utilities.Charset.UTF_8);
  return bytes.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

function randomSalt_() {
  return Utilities.getUuid();
}

/** 6-digit one-time setup code, easy to read aloud and type on a phone keypad. */
function randomSetupCode_() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** 4-digit kiosk check-in code. Not a secret credential -- just an identifier typed on a shared tablet keypad. */
function randomKioskPin_() {
  return pad4_(Math.floor(Math.random() * 10000));
}

/** Zero-pads to 4 digits. Sheets stores KioskPIN as text (see assignMissingKioskPins_), but this guards any stray numeric reads. */
function pad4_(value) {
  return String(value).trim().padStart(4, '0');
}

function isSameDay_(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function getProp_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

// Employees barely changes (an admin action here and there) but is read on
// every single check-in/out, so it's worth caching. Writers below clear the
// cache immediately, so edits still take effect on the very next request.
var EMPLOYEES_CACHE_KEY = 'employees_v1';
var EMPLOYEES_CACHE_SECONDS = 300;

/** Cached {headers, rows} for the whole Employees sheet. */
function getCachedEmployees_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(EMPLOYEES_CACHE_KEY);
  if (cached) return JSON.parse(cached);

  var sheet = getSheet_('Employees');
  var values = sheet.getDataRange().getValues();
  var data = { headers: values[0], rows: values.slice(1) };
  cache.put(EMPLOYEES_CACHE_KEY, JSON.stringify(data), EMPLOYEES_CACHE_SECONDS);
  return data;
}

/** Call after any write to the Employees sheet so the cache doesn't serve stale data. */
function invalidateEmployeesCache_() {
  CacheService.getScriptCache().remove(EMPLOYEES_CACHE_KEY);
}

/** Finds an employee row by EmployeeID. Returns {row, rowNumber} (1-based sheet row) or null. */
function findEmployeeRow_(employeeId) {
  var data = getCachedEmployees_();
  var idCol = data.headers.indexOf('EmployeeID');
  for (var i = 0; i < data.rows.length; i++) {
    if (String(data.rows[i][idCol]) === String(employeeId)) {
      var record = {};
      data.headers.forEach(function (h, c) { record[h] = data.rows[i][c]; });
      return { row: record, rowNumber: i + 2 };
    }
  }
  return null;
}

/** Finds an employee by exact EmployeeID first, falling back to a case-insensitive Name substring match. Returns the row object (no rowNumber) or null. */
function findEmployeeByNameOrId_(query) {
  var byId = findEmployeeRow_(query);
  if (byId) return byId.row;

  var data = getCachedEmployees_();
  var nameCol = data.headers.indexOf('Name');
  var needle = String(query).toLowerCase();
  for (var i = 0; i < data.rows.length; i++) {
    var name = String(data.rows[i][nameCol] || '');
    if (name.toLowerCase().indexOf(needle) !== -1) {
      var record = {};
      data.headers.forEach(function (h, c) { record[h] = data.rows[i][c]; });
      return record;
    }
  }
  return null;
}

/** Finds an employee row by KioskPIN. Returns {row, rowNumber} or null. */
function findEmployeeByKioskPin_(pin) {
  var data = getCachedEmployees_();
  var pinCol = data.headers.indexOf('KioskPIN');
  if (pinCol === -1) return null;
  for (var i = 0; i < data.rows.length; i++) {
    var value = String(data.rows[i][pinCol] || '');
    if (value && pad4_(value) === pad4_(pin)) {
      var record = {};
      data.headers.forEach(function (h, c) { record[h] = data.rows[i][c]; });
      return { row: record, rowNumber: i + 2 };
    }
  }
  return null;
}

// Check-in/out only ever needs today's (or the very latest) rows, never the
// full history, so capping the read window keeps it fast no matter how many
// months of AttendanceLog have piled up. 1000 rows is many days of buffer
// even for a full staff (each check-in/out is one row).
var RECENT_LOG_ROWS = 1000;

/**
 * Reads only the most recent RECENT_LOG_ROWS rows of AttendanceLog (plus the
 * header row) instead of the whole sheet. Share one call of this across a
 * single request instead of re-fetching per lookup.
 */
function getRecentAttendanceLog_() {
  var sheet = getSheet_('AttendanceLog');
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  if (lastRow < 2) return { headers: headers, rows: [] };

  var startRow = Math.max(2, lastRow - RECENT_LOG_ROWS + 1);
  var rows = sheet.getRange(startRow, 1, lastRow - startRow + 1, lastCol).getValues();
  return { headers: headers, rows: rows };
}

/** Returns the most recent AttendanceLog row for an employee, or null. Pass a pre-fetched `log` (see getRecentAttendanceLog_) to avoid re-reading the sheet. */
function findLastLogForEmployee_(employeeId, log) {
  log = log || getRecentAttendanceLog_();
  var idCol = log.headers.indexOf('EmployeeID');
  var last = null;
  for (var i = 0; i < log.rows.length; i++) {
    if (String(log.rows[i][idCol]) === String(employeeId)) {
      var record = {};
      log.headers.forEach(function (h, c) { record[h] = log.rows[i][c]; });
      if (!last || new Date(record.Timestamp) >= new Date(last.Timestamp)) {
        last = record;
      }
    }
  }
  return last;
}

/** Pass pre-fetched `headers` (e.g. from getRecentAttendanceLog_) to skip re-reading them. */
function appendRow_(sheetName, headerToValue, headers) {
  var sheet = getSheet_(sheetName);
  headers = headers || sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var row = headers.map(function (h) { return headerToValue.hasOwnProperty(h) ? headerToValue[h] : ''; });
  sheet.appendRow(row);
}

/** Updates specific columns (by header name) on an existing row. */
function updateEmployeeFields_(rowNumber, fields) {
  var sheet = getSheet_('Employees');
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  Object.keys(fields).forEach(function (key) {
    var col = headers.indexOf(key);
    if (col === -1) throw new Error('Unknown Employees column: ' + key);
    sheet.getRange(rowNumber, col + 1).setValue(fields[key]);
  });
  invalidateEmployeesCache_();
}

function markSetupCodeUsed_(employeeId) {
  var found = findEmployeeRow_(employeeId);
  if (!found) return;
  updateEmployeeFields_(found.rowNumber, { SetupCodeUsed: true });
}

/** Appends any of columnNames that don't already exist as headers on the sheet. */
function ensureColumns_(sheetName, columnNames) {
  var sheet = getSheet_(sheetName);
  var lastCol = sheet.getLastColumn();
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  columnNames.forEach(function (name) {
    if (headers.indexOf(name) === -1) {
      lastCol++;
      sheet.getRange(1, lastCol).setValue(name);
      headers.push(name);
    }
  });
}

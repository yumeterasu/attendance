/**
 * Pairing and session token issue/verify.
 * Session token: base64(employeeId|expiryEpochMs|hmacHex) -- stateless, no server-side session storage.
 *
 * Auth model: an admin creates an employee record with a one-time setup code.
 * The employee "pairs" their device once by submitting username + setup code,
 * which consumes the code and issues a long-lived session token. There is no
 * password -- re-entering just the username is never enough to get a session,
 * so a lost/wiped device requires the admin to issue a fresh setup code.
 */

var SESSION_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000; // ~10 years -- devices should stay signed in indefinitely

function checkApiKey_(apiKey) {
  var expected = getProp_('APP_API_KEY');
  return expected && apiKey === expected;
}

function issueSessionToken_(employeeId) {
  var secret = getProp_('SESSION_SECRET');
  var expiry = Date.now() + SESSION_TTL_MS;
  var payload = employeeId + '|' + expiry;
  var sig = hmacHex_(payload, secret);
  return Utilities.base64EncodeWebSafe(payload + '|' + sig);
}

/** Returns employeeId if the token is valid and unexpired, otherwise null. */
function verifySessionToken_(token) {
  try {
    var decoded = Utilities.newBlob(Utilities.base64DecodeWebSafe(token)).getDataAsString();
    var parts = decoded.split('|');
    if (parts.length !== 3) return null;
    var employeeId = parts[0], expiry = Number(parts[1]), sig = parts[2];
    if (Date.now() > expiry) return null;
    var secret = getProp_('SESSION_SECRET');
    var expectedSig = hmacHex_(employeeId + '|' + expiry, secret);
    if (expectedSig !== sig) return null;
    return employeeId;
  } catch (e) {
    return null;
  }
}

function isTrue_(value) {
  return value === true || value === 'TRUE';
}

function handlePair_(params) {
  if (!checkApiKey_(params.apiKey)) return fail_('unauthorized', 'Invalid API key');
  if (!params.username || !params.setupCode) {
    return fail_('bad_request', 'username and setupCode are required');
  }

  var found = findEmployeeRow_(params.username);
  if (!found) return fail_('not_found', 'Username not found');
  var emp = found.row;

  if (!isTrue_(emp.Active)) {
    return fail_('inactive', 'This account is not active');
  }
  if (isTrue_(emp.SetupCodeUsed)) {
    return fail_('code_used', 'This setup code was already used. Ask your admin for a new one.');
  }

  var computed = sha256Hex_(params.setupCode + emp.SetupCodeSalt);
  if (!emp.SetupCodeHash || computed !== emp.SetupCodeHash) {
    return fail_('invalid_code', 'Incorrect setup code');
  }

  markSetupCodeUsed_(emp.EmployeeID);

  var token = issueSessionToken_(emp.EmployeeID);
  return ok_({
    sessionToken: token,
    name: emp.Name,
    department: emp.Department,
    isAdmin: isTrue_(emp.IsAdmin)
  });
}

/** Verifies the session belongs to an active admin. Returns { ok, emp } or { ok: false, response }. */
function requireAdmin_(sessionToken) {
  var employeeId = verifySessionToken_(sessionToken);
  if (!employeeId) return { ok: false, response: fail_('session_expired', 'Please log in again') };

  var found = findEmployeeRow_(employeeId);
  if (!found || !isTrue_(found.row.Active)) {
    return { ok: false, response: fail_('not_found', 'Employee not found') };
  }
  if (!isTrue_(found.row.IsAdmin)) {
    return { ok: false, response: fail_('forbidden', 'Admin access required') };
  }
  return { ok: true, emp: found.row };
}

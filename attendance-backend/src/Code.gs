/**
 * Web app entry points. Every deployment exposes exactly one doGet/doPost pair,
 * so requests are dispatched on an `action` field.
 */

function doPost(e) {
  var params = parseBody_(e);
  switch (params.action) {
    case 'pair':
      return handlePair_(params);
    case 'kioskCheckin':
      return handleKioskCheckin_(params);
    case 'kioskLookupPin':
      return handleKioskLookupPin_(params);
    case 'kioskMyAttendance':
      return handleKioskMyAttendance_(params);
    case 'verifyKioskExitPin':
      return handleVerifyKioskExitPin_(params);
    case 'adminResetCode':
      return handleAdminResetCode_(params);
    default:
      return fail_('unknown_action', 'Unknown action: ' + params.action);
  }
}

function doGet(e) {
  var params = e.parameter || {};
  switch (params.action) {
    case 'ping':
      return ok_({ message: 'pong' });
    default:
      return fail_('unknown_action', 'Unknown action: ' + params.action);
  }
}

function parseBody_(e) {
  try {
    return JSON.parse(e.postData.contents);
  } catch (err) {
    return {};
  }
}

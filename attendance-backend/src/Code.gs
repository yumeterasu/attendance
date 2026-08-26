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
    case 'kioskDirectory':
      return handleKioskDirectory_(params);
    case 'kioskSyncOffline':
      return handleKioskSyncOffline_(params);
    case 'verifyKioskExitPin':
      return handleVerifyKioskExitPin_(params);
    case 'adminResetCode':
      return handleAdminResetCode_(params);
    default:
      return fail_('unknown_action', 'Unknown action: ' + params.action);
  }
}

// dashboardSummary and pair are also exposed here (not just POST above) on
// purpose -- the web Dashboard calls both from a browser via fetch(), and
// this Web App's OPTIONS preflight response carries no
// Access-Control-Allow-Origin header at all (confirmed directly -- curl -i
// -X OPTIONS against the deployed URL), so a browser blocks any POST with
// a JSON body before it ever reaches doPost. GET with query-string params
// sidesteps the preflight requirement entirely (its own response does
// carry the CORS header, also confirmed directly).
// handlePair_ just reads named fields off `params`, so it works the same
// whether they came from a POST body or a GET query string -- no
// duplicate handler needed. The setup code ends up in the URL this way,
// but it's already a short-lived, single-use credential an admin issues
// on demand (see Admin.gs's "Lost Device / New Setup Code"), not a
// long-term secret, so this is an acceptable tradeoff for a login flow
// that works from a browser.
function doGet(e) {
  var params = e.parameter || {};
  switch (params.action) {
    case 'ping':
      return ok_({ message: 'pong' });
    case 'pair':
      return handlePair_(params);
    case 'dashboardSummary':
      return handleDashboardSummary_(params);
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

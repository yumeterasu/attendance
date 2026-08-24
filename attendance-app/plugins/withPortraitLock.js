const { withAndroidManifest } = require('expo/config-plugins');

// Android 12+ "large screen" compatibility mode can silently OVERRIDE an
// app's screenOrientation="portrait" lock on tablets specifically -- Google's
// own docs: an app that restricts orientation but doesn't ALSO restrict
// resizability may have that restriction ignored on large screens, to avoid
// letterboxing phone-only apps. This is almost certainly why the Kiosk app
// (a shared TABLET at the front desk) kept rotating in the field even though
// android:screenOrientation="portrait" was already correctly set (see
// App.tsx's ScreenOrientation.lockAsync comment -- that JS-level lock was
// added for the same suspected reason and wasn't enough on its own either).
// Setting resizeableActivity="false" alongside the orientation lock opts the
// activity out of that large-screen compatibility override entirely.
function withPortraitLock(config) {
  return withAndroidManifest(config, (config) => {
    const mainApplication = config.modResults.manifest.application?.[0];
    const mainActivity = mainApplication?.activity?.find(
      (activity) => activity.$['android:name'] === '.MainActivity'
    );
    if (mainActivity) {
      mainActivity.$['android:resizeableActivity'] = 'false';
    }
    return config;
  });
}

module.exports = withPortraitLock;

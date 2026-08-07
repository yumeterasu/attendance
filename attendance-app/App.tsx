import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import * as ScreenOrientation from 'expo-screen-orientation';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SessionProvider } from './src/context/SessionContext';
import RootNavigator from './src/navigation/RootNavigator';

export default function App() {
  useEffect(() => {
    // Kiosk tablet: the "orientation: portrait" app.config.ts setting alone
    // doesn't reliably stop rotation on some Android tablets (large-screen
    // devices can ignore the manifest-level lock), so also lock it in JS
    // once the app is up. Deferred to a post-mount effect and wrapped in
    // try/catch, not called at module load -- see the expo-audio
    // crash-on-launch earlier this project for why that matters.
    (async () => {
      try {
        await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
      } catch {
        // If the native module isn't ready yet or the platform doesn't
        // support it, just leave orientation as whatever app.config.ts set.
      }
    })();
  }, []);

  return (
    <SafeAreaProvider>
      <SessionProvider>
        <StatusBar style="auto" />
        <RootNavigator />
      </SessionProvider>
    </SafeAreaProvider>
  );
}

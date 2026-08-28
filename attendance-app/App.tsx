import React, { useEffect } from 'react';
import { View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as ScreenOrientation from 'expo-screen-orientation';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  useFonts as useDisplayFonts,
  Baloo2_500Medium,
  Baloo2_600SemiBold,
  Baloo2_700Bold,
  Baloo2_800ExtraBold
} from '@expo-google-fonts/baloo-2';
import {
  useFonts as useBodyFonts,
  Nunito_500Medium,
  Nunito_600SemiBold,
  Nunito_700Bold,
  Nunito_800ExtraBold
} from '@expo-google-fonts/nunito';
import { SessionProvider } from './src/context/SessionContext';
import RootNavigator from './src/navigation/RootNavigator';

export default function App() {
  // Baloo 2 (rounded, friendly -- headings/buttons/labels) + Nunito (body
  // text/data) replaced Plus Jakarta Sans for the "Blossom" theme. Two
  // separate useFonts calls just because that's how each package exports
  // its hook; both need to resolve before the first frame.
  const [displayFontsLoaded] = useDisplayFonts({
    Baloo2_500Medium,
    Baloo2_600SemiBold,
    Baloo2_700Bold,
    Baloo2_800ExtraBold
  });
  const [bodyFontsLoaded] = useBodyFonts({
    Nunito_500Medium,
    Nunito_600SemiBold,
    Nunito_700Bold,
    Nunito_800ExtraBold
  });
  const fontsLoaded = displayFontsLoaded && bodyFontsLoaded;

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

  // Fonts are bundled (not downloaded), so this resolves almost instantly --
  // still gated so the very first frame doesn't flash the system font before
  // swapping to Baloo 2 / Nunito.
  if (!fontsLoaded) {
    return <View style={{ flex: 1, backgroundColor: '#EFF7FD' }} />;
  }

  return (
    <SafeAreaProvider>
      <SessionProvider>
        <StatusBar style="auto" />
        <RootNavigator />
      </SessionProvider>
    </SafeAreaProvider>
  );
}

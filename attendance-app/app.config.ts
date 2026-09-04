import { ExpoConfig, ConfigContext } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Attendance',
  slug: 'attendance-app',
  version: '1.6.15', // bump this with each meaningful feature build so Install page / device settings show something readable, not just a git hash
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  icon: './assets/icon.png',
  splash: {
    resizeMode: 'contain',
    backgroundColor: '#ffffff'
  },
  ios: {
    supportsTablet: true,
    infoPlist: {
      NSCameraUsageDescription: 'Camera access is needed to scan the check-in QR code.'
    }
  },
  android: {
    permissions: ['CAMERA'],
    package: 'com.attendance.app',
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#2C74AD'
    }
  },
  plugins: ['expo-font', 'expo-audio', './plugins/withPortraitLock'],
  extra: {
    eas: {
      projectId: '5c2b7471-09bb-4b56-b4d7-4db4f1f4a441'
    }
  },
  updates: {
    url: 'https://u.expo.dev/5c2b7471-09bb-4b56-b4d7-4db4f1f4a441'
  },
  runtimeVersion: '1.0.0'
});

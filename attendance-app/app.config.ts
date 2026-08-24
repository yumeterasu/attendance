import { ExpoConfig, ConfigContext } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Attendance',
  slug: 'attendance-app',
  version: '1.5.1', // bump this with each meaningful feature build so Install page / device settings show something readable, not just a git hash
  orientation: 'portrait',
  userInterfaceStyle: 'light',
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
    package: 'com.attendance.app'
  },
  plugins: ['expo-font', './plugins/withPortraitLock'],
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

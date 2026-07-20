import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ActivityIndicator, View } from 'react-native';
import { RootStackParamList } from './types';
import { useSession } from '../context/SessionContext';
import LoginScreen from '../screens/LoginScreen';
import AdminScreen from '../screens/AdminScreen';
import KioskScreen from '../screens/KioskScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function RootNavigator() {
  const { session, isLoading, kioskLocked } = useSession();

  if (isLoading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator />
      </View>
    );
  }

  // Only admins log in personally now (everyone else uses their Kiosk code,
  // no login at all) -- a non-admin session has nothing left to do, so it's
  // treated the same as no session.
  if (!session || !session.isAdmin) {
    return (
      <NavigationContainer>
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Login" component={LoginScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    );
  }

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {kioskLocked ? (
          // If the app process got killed while the tablet sat in Kiosk Mode
          // (screen off, OS memory pressure, etc.), relaunching must land
          // straight back on Kiosk -- otherwise it falls open to Admin
          // without ever going through the Exit PIN. Whichever screen is
          // listed first becomes the stack's initial route.
          <>
            <Stack.Screen name="Kiosk" component={KioskScreen} />
            <Stack.Screen name="Admin" component={AdminScreen} options={{ headerShown: true, title: 'Admin' }} />
          </>
        ) : (
          <>
            <Stack.Screen name="Admin" component={AdminScreen} options={{ headerShown: true, title: 'Admin' }} />
            <Stack.Screen name="Kiosk" component={KioskScreen} />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

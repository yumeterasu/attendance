import React, { createContext, useContext, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

const SESSION_KEY = 'attendance_session';
const KIOSK_LOCKED_KEY = 'attendance_kiosk_locked';

// expo-secure-store has no web implementation, so persist to localStorage there instead.
const storage = Platform.OS === 'web'
  ? {
      getItemAsync: async (key: string) => window.localStorage.getItem(key),
      setItemAsync: async (key: string, value: string) => window.localStorage.setItem(key, value),
      deleteItemAsync: async (key: string) => window.localStorage.removeItem(key)
    }
  : SecureStore;

type Session = { sessionToken: string; name: string; department: string; isAdmin: boolean };

type SessionContextValue = {
  session: Session | null;
  isLoading: boolean;
  signIn: (session: Session) => Promise<void>;
  signOut: () => Promise<void>;
  // Persisted so that if the OS kills the app while the tablet is sitting in
  // Kiosk Mode (screen off, low memory, etc.), the next launch re-locks
  // straight into Kiosk instead of dropping back to the normal admin-visible
  // screens without ever going through the Exit PIN.
  kioskLocked: boolean;
  setKioskLocked: (locked: boolean) => Promise<void>;
};

const SessionContext = createContext<SessionContextValue | undefined>(undefined);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [kioskLocked, setKioskLockedState] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    Promise.all([storage.getItemAsync(SESSION_KEY), storage.getItemAsync(KIOSK_LOCKED_KEY)])
      .then(([rawSession, rawLocked]) => {
        if (rawSession) setSession(JSON.parse(rawSession));
        if (rawLocked === 'true') setKioskLockedState(true);
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, []);

  const signIn = async (next: Session) => {
    await storage.setItemAsync(SESSION_KEY, JSON.stringify(next));
    setSession(next);
  };

  const signOut = async () => {
    await storage.deleteItemAsync(SESSION_KEY);
    setSession(null);
  };

  const setKioskLocked = async (locked: boolean) => {
    await storage.setItemAsync(KIOSK_LOCKED_KEY, locked ? 'true' : 'false');
    setKioskLockedState(locked);
  };

  return (
    <SessionContext.Provider value={{ session, isLoading, signIn, signOut, kioskLocked, setKioskLocked }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used within a SessionProvider');
  return ctx;
}

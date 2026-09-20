import React, { createContext, useContext, useEffect, useState } from "react";
import { User, onAuthStateChanged, signOut } from "firebase/auth";
import { auth } from "../firebase/firebaseConfig";
import { ensureUserDocument, getUserProfile, UserProfile } from "../firebase/dataLogger";
import { bleService } from "../functionality/BLEService";
import { signOutFromGoogle } from "./googleAuth";

type AuthContextType = {
  user: User | null;
  profile: UserProfile | null;
  loading: boolean;
  logout: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  initializing?: boolean;
};

const AuthContext = createContext<AuthContextType | null>(null);

import { View, ActivityIndicator } from 'react-native';

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [initializing, setInitializing] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshProfile = async () => {
    if (!user) return;
    const p = await getUserProfile(user.uid);
    setProfile(p);
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      try {
        console.log('[Auth] onAuthStateChanged:', firebaseUser ? `restored uid=${firebaseUser.uid}` : 'no user');
        setUser(firebaseUser);

        if (firebaseUser) {
          // Ensure top-level user doc exists (needed for Firestore security rules)
          await ensureUserDocument(firebaseUser.uid, firebaseUser.email);
          // Load cached profile
          const p = await getUserProfile(firebaseUser.uid);
          setProfile(p);
        } else {
          setProfile(null);
        }
      } catch (err) {
        console.warn('[Auth] State restore/profile fetch failed:', err);
      } finally {
        setLoading(false);
        if (initializing) setInitializing(false);
      }
    });
    return unsubscribe;
  }, [initializing]);

  // CRITICAL BLOCKER: Do NOT render children or the Login screen until initializing is false
  if (initializing) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" color="#0000ff" />
      </View>
    );
  }

  const logout = async () => {
    // Disconnect BLE before signing out so we don't leave the device paired
    // with a now-unauthenticated app instance, and so the sensor pipeline
    // stops writing to Firestore before the auth token is revoked.
    try {
      await bleService.disconnect();
    } catch (e) {
      // Not fatal - proceed with logout even if disconnect fails
    }
    // Clear the native Google session too. For email/password users this is a no-op.
    await signOutFromGoogle();

    await signOut(auth);
    setProfile(null);
  };

  return (
    <AuthContext.Provider value={{ user, profile, loading, logout, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used inside AuthProvider");
  }
  return ctx;
};

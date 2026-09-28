import { initializeApp } from "firebase/app";
import type { Auth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import AsyncStorage from "@react-native-async-storage/async-storage";

// Replaced with project-provided Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyAr-sbTxoPRwwbCcmIMUJU8_KoUA1zcfjk",
  authDomain: "audiostimulator-mhtech.firebaseapp.com",
  projectId: "audiostimulator-mhtech",
  storageBucket: "audiostimulator-mhtech.firebasestorage.app",
  messagingSenderId: "873726071761",
  appId: "1:873726071761:web:6ebc154fef6df8a47e06f0",
  measurementId: "G-BGTVFWR49H"
};

const app = initializeApp(firebaseConfig);

// Keep auth session persisted across app restarts on React Native.
// If auth was already initialized elsewhere (e.g., hot reload), fallback to getAuth.
export const auth: Auth = (() => {
  let authModule: any;
  try {
    // Prefer dedicated React Native auth runtime.
    authModule = require("firebase/auth/react-native");
  } catch {
    // Fallback for environments that only expose firebase/auth.
    authModule = require("firebase/auth");
  }

  const getAuth = authModule?.getAuth;
  const initializeAuth = authModule?.initializeAuth;
  const getReactNativePersistence = authModule?.getReactNativePersistence;

  try {
    if (typeof getAuth !== "function" || typeof initializeAuth !== "function") {
      throw new Error("firebase auth module missing getAuth/initializeAuth");
    }

    if (typeof getReactNativePersistence !== "function") {
      throw new Error("getReactNativePersistence unavailable in active auth module");
    }

    const instance = initializeAuth(app, {
      persistence: getReactNativePersistence(AsyncStorage),
    });
    console.log("[FirebaseAuth] RN persistence enabled");
    return instance;
  } catch (err: any) {
    console.warn("[FirebaseAuth] Persistent RN auth init failed; using fallback getAuth (may be non-persistent):", err?.message || err);
    return getAuth(app);
  }
})();

export const db = getFirestore(app);
export const storage = getStorage(app, "gs://audiostimulator-mhtech.firebasestorage.app");

// Export the initialized Firebase app in case other modules need it
export { app };

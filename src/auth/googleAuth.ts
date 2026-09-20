import {
  GoogleSignin,
} from '@react-native-google-signin/google-signin';
import {
  GoogleAuthProvider,
  signInWithCredential,
} from 'firebase/auth';

import { auth } from '../firebase/firebaseConfig';

const WEB_CLIENT_ID = '873726071761-fs20lur5koqamlelmr1jvs620befu8cr.apps.googleusercontent.com';

// Configure once when this module is loaded.
// IMPORTANT: WEB_CLIENT_ID must be the OAuth client whose type is "Web application".
GoogleSignin.configure({
  webClientId: WEB_CLIENT_ID,
  offlineAccess: false,
});

export async function signInWithGoogle(): Promise<'success' | 'cancelled'> {
  await GoogleSignin.hasPlayServices();

  const response = await GoogleSignin.signIn();

  if (response.type !== 'success') {
    return 'cancelled';
  }

  const idToken = response.data.idToken;

  if (!idToken) {
    throw new Error('Google Sign-In did not return an ID token.');
  }

  const firebaseCredential = GoogleAuthProvider.credential(idToken);
  await signInWithCredential(auth, firebaseCredential);

  return 'success';
}

export async function signOutFromGoogle(): Promise<void> {
  try {
    await GoogleSignin.signOut();
  } catch (error) {
    // Firebase logout must still proceed even if the native Google session
    // was not active or Google sign-out fails.
    console.warn('[Auth] Google sign-out warning:', error);
  }
}

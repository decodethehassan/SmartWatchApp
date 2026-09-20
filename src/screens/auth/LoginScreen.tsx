import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
} from 'firebase/auth';

import { auth } from '../../firebase/firebaseConfig';
import { signInWithGoogle } from '../../auth/googleAuth';
import type { RootStackParamList } from '../../navigation/RootNavigator';

type Props = NativeStackScreenProps<RootStackParamList, 'Login'>;

export default function LoginScreen({ navigation }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [language] = useState('English');
  const [isLoading, setIsLoading] = useState(false);
  const [isResettingPassword, setIsResettingPassword] = useState(false);
  const [isGoogleLoading, setIsGoogleLoading] = useState(false);

  const busy = isLoading || isResettingPassword || isGoogleLoading;

  const handleGetStarted = () => {
    navigation.navigate('BasicInfo');
  };

  const handleSignIn = async () => {
    const normalizedEmail = email.trim().toLowerCase();

    if (!normalizedEmail || !password) {
      Alert.alert('Error', 'Please enter your email and password.');
      return;
    }

    setIsLoading(true);
    try {
      await signInWithEmailAndPassword(auth, normalizedEmail, password);
      // Existing AuthContext / app navigation handles the authenticated user.
    } catch (err: any) {
      Alert.alert('Login Error', err?.message || 'Unable to sign in.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    const normalizedEmail = email.trim().toLowerCase();

    if (!normalizedEmail) {
      Alert.alert(
        'Enter your email',
        'Enter your account email above, then tap Forgot password? again.'
      );
      return;
    }

    setIsResettingPassword(true);
    try {
      await sendPasswordResetEmail(auth, normalizedEmail);
      Alert.alert(
        'Check your email',
        'If an account exists for this email, a password reset link has been sent.'
      );
    } catch (err: any) {
      if (err?.code === 'auth/invalid-email') {
        Alert.alert('Invalid email', 'Please enter a valid email address.');
      } else if (err?.code === 'auth/user-not-found') {
        // Keep the response non-enumerating.
        Alert.alert(
          'Check your email',
          'If an account exists for this email, a password reset link has been sent.'
        );
      } else {
        console.warn('[Auth] Password reset failed:', err);
        Alert.alert(
          'Password reset error',
          'We could not send the reset email right now. Please check your connection and try again.'
        );
      }
    } finally {
      setIsResettingPassword(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setIsGoogleLoading(true);

    try {
      const result = await signInWithGoogle();

      if (result === 'cancelled') {
        return;
      }

      // Existing AuthContext / app navigation handles the authenticated user.
    } catch (err: any) {
      console.warn('[Auth] Google Sign-In failed:', err);

      // A short delay makes the alert more reliable after Android closes
      // Google's native account-picker Activity.
      setTimeout(() => {
        Alert.alert(
          'Google Sign-In Error',
          err?.message || 'Unable to sign in with Google.'
        );
      }, 250);
    } finally {
      setIsGoogleLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <LinearGradient colors={['#A3D9F0', '#5DADE2']} style={styles.gradient}>
        <View style={styles.content}>
          <View style={styles.header}>
            <View style={styles.logoContainer}>
              <LinearGradient colors={['#3b82f6', '#2563eb']} style={styles.logoBg}>
                <Ionicons name="musical-notes" size={32} color="white" />
              </LinearGradient>
            </View>
            <Text style={styles.appTitle}>AudioStim Pro</Text>
            <Text style={styles.appSubtitle}>Professional Audio Stimulation Therapy</Text>
            <Text style={styles.tagline}>
              Advanced neurostimulation technology for medical professionals and researchers
            </Text>
          </View>

          <View style={styles.formSection}>
            <View style={styles.inputContainer}>
              <Ionicons name="mail-outline" size={20} color="#64748b" style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="Email"
                placeholderTextColor="#94a3b8"
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                autoComplete="email"
                editable={!busy}
              />
            </View>

            <View style={styles.inputContainer}>
              <Ionicons name="lock-closed-outline" size={20} color="#64748b" style={styles.inputIcon} />
              <TextInput
                style={styles.input}
                placeholder="Password"
                placeholderTextColor="#94a3b8"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoComplete="password"
                editable={!busy}
              />
            </View>

            <TouchableOpacity
              style={styles.forgotPasswordButton}
              onPress={handleForgotPassword}
              disabled={busy}>
              {isResettingPassword ? (
                <ActivityIndicator size="small" color="#1e293b" />
              ) : (
                <Text style={styles.forgotPasswordText}>Forgot password?</Text>
              )}
            </TouchableOpacity>
          </View>

          <View style={styles.buttonContainer}>
            <TouchableOpacity
              style={styles.getStartedButton}
              onPress={handleGetStarted}
              disabled={busy}>
              <Text style={styles.getStartedButtonText}>Get Started</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.signInButton}
              onPress={handleSignIn}
              disabled={busy}>
              <LinearGradient colors={['#3b82f6', '#2563eb']} style={styles.signInGradient}>
                {isLoading ? (
                  <ActivityIndicator color="white" />
                ) : (
                  <Text style={styles.signInButtonText}>Sign In</Text>
                )}
              </LinearGradient>
            </TouchableOpacity>

            <View style={styles.divider}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>OR</Text>
              <View style={styles.dividerLine} />
            </View>

            <TouchableOpacity
              style={styles.googleButton}
              onPress={handleGoogleSignIn}
              disabled={busy}>
              {isGoogleLoading ? (
                <ActivityIndicator color="#1e293b" />
              ) : (
                <>
                  <Ionicons name="logo-google" size={22} color="#1e293b" />
                  <Text style={styles.googleButtonText}>Continue with Google</Text>
                </>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.signupLink}
              onPress={() => navigation.navigate('Signup')}
              disabled={busy}>
              <Text style={styles.signupLinkText}>Don't have an account? Sign Up</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.footer}>
            <TouchableOpacity style={styles.footerLink}>
              <Ionicons name="document-text-outline" size={18} color="#1e293b" />
              <Text style={styles.footerLinkText}>Terms & Conditions</Text>
            </TouchableOpacity>

            <TouchableOpacity style={styles.languageSelector}>
              <Ionicons name="language-outline" size={18} color="#1e293b" />
              <Text style={styles.languageSelectorText}>{language}</Text>
              <Ionicons name="chevron-down-outline" size={16} color="#1e293b" />
            </TouchableOpacity>
          </View>
        </View>
      </LinearGradient>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#A3D9F0',
  },
  gradient: {
    flex: 1,
  },
  content: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 32,
    paddingBottom: 20,
  },
  header: {
    alignItems: 'center',
    marginBottom: 26,
  },
  logoContainer: {
    marginBottom: 12,
  },
  logoBg: {
    width: 72,
    height: 72,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  appTitle: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#1e293b',
    marginBottom: 6,
    textAlign: 'center',
  },
  appSubtitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#ffffff',
    textAlign: 'center',
    marginBottom: 6,
  },
  tagline: {
    fontSize: 13,
    color: '#1e293b',
    textAlign: 'center',
    paddingHorizontal: 20,
    lineHeight: 18,
  },
  formSection: {
    marginBottom: 14,
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'white',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 12,
  },
  inputIcon: {
    marginRight: 12,
  },
  input: {
    flex: 1,
    color: '#1e293b',
    fontSize: 16,
  },
  forgotPasswordButton: {
    alignSelf: 'flex-end',
    minHeight: 30,
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  forgotPasswordText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1e293b',
    textDecorationLine: 'underline',
  },
  buttonContainer: {
    marginBottom: 18,
  },
  getStartedButton: {
    backgroundColor: 'white',
    borderRadius: 12,
    paddingVertical: 14,
    marginBottom: 10,
    borderWidth: 2,
    borderColor: '#3b82f6',
  },
  getStartedButtonText: {
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '600',
    color: '#3b82f6',
  },
  signInButton: {
    borderRadius: 12,
    marginBottom: 10,
  },
  signInGradient: {
    paddingVertical: 15,
    borderRadius: 12,
    alignItems: 'center',
  },
  signInButtonText: {
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '600',
    color: 'white',
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 8,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: 'rgba(30, 41, 59, 0.22)',
  },
  dividerText: {
    paddingHorizontal: 12,
    fontSize: 12,
    fontWeight: '700',
    color: '#475569',
  },
  googleButton: {
    minHeight: 50,
    borderRadius: 12,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#dbeafe',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginBottom: 8,
  },
  googleButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1e293b',
  },
  signupLink: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  signupLinkText: {
    fontSize: 15,
    color: '#1e293b',
    fontWeight: '500',
  },
  footer: {
    marginTop: 'auto',
    gap: 8,
  },
  footerLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 8,
  },
  footerLinkText: {
    fontSize: 15,
    fontWeight: '500',
    color: '#1e293b',
  },
  languageSelector: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
    borderRadius: 8,
  },
  languageSelectorText: {
    fontSize: 15,
    fontWeight: '500',
    color: '#1e293b',
  },
});

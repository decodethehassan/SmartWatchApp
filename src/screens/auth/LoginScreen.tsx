import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Image,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
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
  const [showPassword, setShowPassword] = useState(false);
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
        <KeyboardAvoidingView
          style={styles.keyboardView}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.header}>
              <Image
                source={require('../../../assets/audiostim-brain-logo.png')}
                style={styles.logo}
                resizeMode="contain"
              />

              <Text style={styles.appTitle}>AudioStim Pro</Text>

              <Text style={styles.appSubtitle}>
                Professional Audio Stimulation Therapy
              </Text>

              <Text style={styles.tagline}>
                Advanced neurostimulation technology for medical professionals and researchers
              </Text>
            </View>

            <View style={styles.formSection}>
              <View style={styles.inputContainer}>
                <View style={styles.inputIconBox}>
                  <Ionicons name="mail-outline" size={22} color="#49658F" />
                </View>

                <TextInput
                  style={styles.input}
                  placeholder="Email"
                  placeholderTextColor="#7B91B0"
                  value={email}
                  onChangeText={setEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                  editable={!busy}
                />
              </View>

              <View style={styles.inputContainer}>
                <View style={styles.inputIconBox}>
                  <Ionicons name="lock-closed-outline" size={22} color="#49658F" />
                </View>

                <TextInput
                  style={styles.input}
                  placeholder="Password"
                  placeholderTextColor="#7B91B0"
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry={!showPassword}
                  autoComplete="password"
                  editable={!busy}
                />

                <TouchableOpacity
                  style={styles.passwordToggle}
                  onPress={() => setShowPassword((current) => !current)}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                >
                  <Ionicons
                    name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                    size={23}
                    color="#6B7F9E"
                  />
                </TouchableOpacity>
              </View>

              <TouchableOpacity
                style={styles.forgotPasswordButton}
                onPress={handleForgotPassword}
                disabled={busy}
              >
                {isResettingPassword ? (
                  <ActivityIndicator size="small" color="#0B63D8" />
                ) : (
                  <Text style={styles.forgotPasswordText}>Forgot password?</Text>
                )}
              </TouchableOpacity>
            </View>

            <View style={styles.buttonContainer}>
              <TouchableOpacity
                style={styles.getStartedButton}
                onPress={handleGetStarted}
                disabled={busy}
                activeOpacity={0.88}
              >
                <Ionicons name="arrow-forward" size={20} color="#0F6EEA" />
                <Text style={styles.getStartedButtonText}>Get Started</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.signInButton}
                onPress={handleSignIn}
                disabled={busy}
                activeOpacity={0.9}
              >
                <LinearGradient
                  colors={['#3185F5', '#1765E8']}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  style={styles.signInGradient}
                >
                  {isLoading ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <View style={styles.buttonContent}>
                      <Ionicons name="person" size={20} color="#FFFFFF" />
                      <Text style={styles.signInButtonText}>Sign In</Text>
                    </View>
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
                disabled={busy}
                activeOpacity={0.88}
              >
                {isGoogleLoading ? (
                  <ActivityIndicator color="#1E293B" />
                ) : (
                  <View style={styles.buttonContent}>
                    <Ionicons name="logo-google" size={24} color="#1E293B" />
                    <Text style={styles.googleButtonText}>Continue with Google</Text>
                  </View>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.signupLink}
                onPress={() => navigation.navigate('Signup')}
                disabled={busy}
              >
                <Text style={styles.signupLinkText}>
                  Don&apos;t have an account?{' '}
                  <Text style={styles.signupLinkStrong}>Sign Up</Text>
                </Text>
              </TouchableOpacity>
            </View>

            <View style={styles.footer}>
              <TouchableOpacity style={styles.footerLink}>
                <Ionicons name="document-text-outline" size={20} color="#21466F" />
                <Text style={styles.footerLinkText}>Terms & Conditions</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.languageSelector}>
                <Ionicons name="language-outline" size={18} color="#21466F" />
                <Text style={styles.languageSelectorText}>{language}</Text>
                <Ionicons name="chevron-down-outline" size={16} color="#21466F" />
              </TouchableOpacity>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
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
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 18,
  },

  header: {
    alignItems: 'center',
    marginBottom: 26,
  },
  logo: {
    width: 96,
    height: 96,
    marginBottom: 14,
  },
  appTitle: {
    fontSize: 30,
    fontWeight: '800',
    color: '#09274F',
    textAlign: 'center',
    letterSpacing: -0.5,
    marginBottom: 6,
  },
  appSubtitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#173D67',
    textAlign: 'center',
    marginBottom: 7,
  },
  tagline: {
    maxWidth: 350,
    paddingHorizontal: 10,
    fontSize: 13.5,
    lineHeight: 19,
    fontWeight: '500',
    color: '#365F87',
    textAlign: 'center',
  },

  formSection: {
    marginBottom: 14,
  },
  inputContainer: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    paddingHorizontal: 10,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.72)',
    shadowColor: '#174F7A',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 3,
  },
  inputIconBox: {
    width: 46,
    height: 46,
    borderRadius: 14,
    backgroundColor: '#F2F7FD',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
  },
  input: {
    flex: 1,
    height: 58,
    paddingHorizontal: 6,
    color: '#122B4B',
    fontSize: 16,
    fontWeight: '500',
  },
  passwordToggle: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  forgotPasswordButton: {
    alignSelf: 'flex-end',
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: 4,
    marginTop: -1,
  },
  forgotPasswordText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0B63D8',
    textDecorationLine: 'underline',
  },

  buttonContainer: {
    marginBottom: 14,
  },
  getStartedButton: {
    minHeight: 58,
    borderRadius: 18,
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: '#1771EC',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    marginBottom: 12,
    shadowColor: '#1765E8',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
    elevation: 2,
  },
  getStartedButtonText: {
    fontSize: 17,
    fontWeight: '800',
    color: '#0F6EEA',
  },

  signInButton: {
    minHeight: 58,
    borderRadius: 18,
    overflow: 'hidden',
    marginBottom: 12,
    shadowColor: '#145CD7',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.20,
    shadowRadius: 12,
    elevation: 4,
  },
  signInGradient: {
    minHeight: 58,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  signInButtonText: {
    fontSize: 18,
    fontWeight: '800',
    color: '#FFFFFF',
  },

  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 9,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: 'rgba(33,70,111,0.25)',
  },
  dividerText: {
    paddingHorizontal: 14,
    fontSize: 12,
    fontWeight: '800',
    color: '#4D6B8B',
  },

  googleButton: {
    minHeight: 58,
    borderRadius: 18,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#D9E7F5',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
    shadowColor: '#174F7A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.07,
    shadowRadius: 10,
    elevation: 2,
  },
  googleButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#102A4B',
  },

  signupLink: {
    alignItems: 'center',
    paddingVertical: 10,
  },
  signupLinkText: {
    fontSize: 15,
    fontWeight: '500',
    color: '#244968',
  },
  signupLinkStrong: {
    color: '#0B63D8',
    fontWeight: '800',
  },

  footer: {
    marginTop: 'auto',
    alignItems: 'center',
    gap: 4,
    paddingTop: 4,
  },
  footerLink: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  footerLinkText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#173D67',
    textDecorationLine: 'underline',
  },
  languageSelector: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
  languageSelectorText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#21466F',
  },
});

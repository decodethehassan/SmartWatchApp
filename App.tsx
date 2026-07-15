import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { AuthProvider, useAuth } from './src/auth/AuthContext';
import { BLEProvider } from './src/functionality/BLEContext';
import { DevModeProvider } from './src/functionality/DevModeContext';
import { SensorPipelineProvider } from './src/hooks/SensorPipelineContext';
import { ActivityIndicator, Text, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import RootNavigator from './src/navigation/RootNavigator';
import MainTabsNavigator from './src/navigation/MainTabsNavigator';
import { SensorErrorBoundary } from './src/components/SensorErrorBoundary';

/**
 * AppContent – rendered inside AuthProvider so it can call useAuth().
 *
 * Flow:
 *  loading  → splash
 *  no user  → RootNavigator (Login → Signup → Onboarding → MainTabs-screen)
 *  user     → MainTabsNavigator directly
 *
 * Note: during signup the auth state change fires immediately.
 * SignupScreen navigates to BasicInfo *before* React re-renders, so
 * the onboarding stack is only visible briefly. Once the questionnaire
 * marks onboardingComplete:true the user already has MainTabs.
 */
function AppContent() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <LinearGradient colors={['#1B4965', '#18A999']} style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#ffffff" />
        <Text style={styles.loadingText}>Loading…</Text>
      </LinearGradient>
    );
  }

  return user ? <MainTabsNavigator /> : <RootNavigator />;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SensorErrorBoundary>
        <StatusBar style="auto" />
        <AuthProvider>
          <BLEProvider>
            <DevModeProvider>
              <SensorPipelineProvider>
                <NavigationContainer>
                  <AppContent />
                </NavigationContainer>
              </SensorPipelineProvider>
            </DevModeProvider>
          </BLEProvider>
        </AuthProvider>
      </SensorErrorBoundary>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  loadingText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
});

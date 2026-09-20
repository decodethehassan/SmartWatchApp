import React, { useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  Switch,
  Modal,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { useAuth } from '../../auth/AuthContext';
import { useBLE } from '../../functionality/BLEContext';
import { BluetoothScanModal } from '../../components/BluetoothScanModal';
import {
  useDevMode,
  ALL_SENSOR_KEYS,
  SENSOR_LABELS,
  SensorKey,
} from '../../functionality/DevModeContext';
import type { SettingsStackParamList } from '../../navigation/SettingsStack';

const SENSOR_ICONS: Record<SensorKey, keyof typeof Ionicons.glyphMap> = {
  ppgGreen: 'heart',
  ppgIR: 'heart-half',
  ppgRed: 'heart-circle',
  accel: 'speedometer',
  gyro: 'compass',
  temp: 'thermometer',
  eda: 'flash',
};

type Props = NativeStackScreenProps<SettingsStackParamList, 'SettingsHome'>;

export default function SettingsScreen({ navigation }: Props) {
  const { user, logout } = useAuth();
  const { isConnected, connectedDeviceName } = useBLE();
  const {
    isDevMode,
    enableDevMode,
    disableDevMode,
    sensorToggles,
    toggleSensor,
    enabledSensorCount,
  } = useDevMode();

  const [bleModalVisible, setBleModalVisible] = useState(false);
  const [passwordModalVisible, setPasswordModalVisible] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');

  const handleLogout = () => {
    Alert.alert('Logout', 'Are you sure you want to logout?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Logout',
        style: 'destructive',
        onPress: async () => {
          try {
            await logout();
          } catch {
            Alert.alert('Error', 'Failed to logout');
          }
        },
      },
    ]);
  };

  const handleDevModeToggle = (value: boolean) => {
    if (value) {
      setPasswordInput('');
      setPasswordModalVisible(true);
    } else {
      disableDevMode();
    }
  };

  const handlePasswordSubmit = () => {
    const success = enableDevMode(passwordInput);
    setPasswordModalVisible(false);
    setPasswordInput('');
    if (success) {
      Alert.alert('Developer Mode', 'Developer mode enabled successfully.');
    } else {
      Alert.alert('Access Denied', 'Incorrect password. Developer mode was not enabled.');
    }
  };

  const handlePasswordCancel = () => {
    setPasswordModalVisible(false);
    setPasswordInput('');
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <BluetoothScanModal visible={bleModalVisible} onClose={() => setBleModalVisible(false)} />

      <Modal
        visible={passwordModalVisible}
        transparent
        animationType="fade"
        onRequestClose={handlePasswordCancel}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Enter Developer Password</Text>
            <Text style={styles.modalSubtitle}>A password is required to enable developer mode.</Text>
            <TextInput
              style={styles.modalInput}
              placeholder="Password"
              placeholderTextColor="#94a3b8"
              secureTextEntry
              value={passwordInput}
              onChangeText={setPasswordInput}
              autoFocus
              onSubmitEditing={handlePasswordSubmit}
            />
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.modalButtonCancel} onPress={handlePasswordCancel}>
                <Text style={styles.modalButtonCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.modalButtonConfirm} onPress={handlePasswordSubmit}>
                <Text style={styles.modalButtonConfirmText}>Confirm</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View style={styles.headerIcon}>
            <Ionicons name="settings" size={28} color="#1B4965" />
          </View>
          <Text style={styles.headerTitle}>Settings</Text>
          <Text style={styles.headerSubtitle}>Manage your preferences and wristband data</Text>
        </View>

        <View style={styles.content}>
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Profile</Text>
            <View style={styles.profileCard}>
              <View style={styles.profileAvatar}>
                <Ionicons name="person" size={32} color="#1B4965" />
              </View>
              <View style={styles.profileInfo}>
                <Text style={styles.profileName}>{user?.email?.split('@')[0] || 'User'}</Text>
                <Text style={styles.profileEmail}>{user?.email || ''}</Text>
              </View>
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Device Settings</Text>
            <View style={styles.settingsContainer}>
              <TouchableOpacity style={styles.settingItem} onPress={() => setBleModalVisible(true)}>
                <View style={styles.settingLeft}>
                  <Ionicons
                    name={isConnected ? 'bluetooth' : 'bluetooth-outline'}
                    size={24}
                    color={isConnected ? '#10b981' : '#1B4965'}
                  />
                  <View style={styles.settingText}>
                    <Text style={styles.settingTitle}>
                      {isConnected ? connectedDeviceName || 'Connected Device' : 'Pair / Connect Device'}
                    </Text>
                    <Text style={[styles.settingSubtitle, isConnected && { color: '#10b981' }]}>
                      {isConnected ? 'Tap to manage connection' : 'Scan for BLE wristband'}
                    </Text>
                  </View>
                </View>
                <Ionicons name="chevron-forward" size={20} color="#94a3b8" />
              </TouchableOpacity>

              <View style={styles.separator} />

              <TouchableOpacity
                style={styles.settingItem}
                onPress={() => navigation.navigate('WristbandDataMemory')}
              >
                <View style={styles.settingLeft}>
                  <Ionicons name="hardware-chip-outline" size={24} color="#18A999" />
                  <View style={styles.settingText}>
                    <Text style={styles.settingTitle}>Wristband Data & Memory</Text>
                    <Text style={styles.settingSubtitle}>
                      Sync minute results, raw BIN files and cloud recordings
                    </Text>
                  </View>
                </View>
                <Ionicons name="chevron-forward" size={20} color="#94a3b8" />
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Developer Mode</Text>
            <View style={styles.devModeCard}>
              <View style={styles.devModeRow}>
                <View style={styles.settingLeft}>
                  <Ionicons name="code-slash" size={24} color="#1B4965" />
                  <View style={styles.settingText}>
                    <Text style={styles.settingTitle}>Developer Mode</Text>
                    <Text style={styles.settingSubtitle}>Access raw sensor graphs</Text>
                  </View>
                </View>
                <Switch
                  value={isDevMode}
                  onValueChange={handleDevModeToggle}
                  trackColor={{ false: '#e2e8f0', true: '#18A999' }}
                  thumbColor="#ffffff"
                />
              </View>

              {isDevMode && (
                <View style={styles.sensorSection}>
                  <View style={styles.sensorSectionHeader}>
                    <Text style={styles.sensorSectionTitle}>Sensor Configuration</Text>
                    <Text style={styles.sensorSectionSubtitle}>{enabledSensorCount}/7 sensors enabled</Text>
                  </View>
                  {ALL_SENSOR_KEYS.map((key) => (
                    <View key={key} style={styles.sensorRow}>
                      <View style={styles.sensorLeft}>
                        <Ionicons
                          name={SENSOR_ICONS[key]}
                          size={20}
                          color={sensorToggles[key] ? '#18A999' : '#94a3b8'}
                        />
                        <Text style={[styles.sensorLabel, !sensorToggles[key] && styles.sensorLabelDisabled]}>
                          {SENSOR_LABELS[key]}
                        </Text>
                      </View>
                      <Switch
                        value={sensorToggles[key]}
                        onValueChange={() => toggleSensor(key)}
                        trackColor={{ false: '#e2e8f0', true: '#18A999' }}
                        thumbColor="#ffffff"
                      />
                    </View>
                  ))}
                </View>
              )}
            </View>
          </View>

          <View style={styles.section}>
            <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
              <Ionicons name="log-out" size={20} color="#dc2626" />
              <Text style={styles.logoutButtonText}>Logout</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#ffffff' },
  scrollView: { flex: 1 },
  header: { marginBottom: 24, alignItems: 'center', paddingHorizontal: 20, paddingTop: 20 },
  headerIcon: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#e0f2fe', justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  headerTitle: { fontSize: 28, fontWeight: 'bold', color: '#1e293b', marginBottom: 4 },
  headerSubtitle: { fontSize: 15, color: '#64748b', textAlign: 'center' },
  content: { paddingHorizontal: 20, paddingBottom: 32 },
  section: { marginBottom: 24 },
  sectionTitle: { fontSize: 20, fontWeight: '600', color: '#1e293b', marginBottom: 12 },
  profileCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f8fafc', borderRadius: 12, padding: 16 },
  profileAvatar: { width: 56, height: 56, borderRadius: 28, backgroundColor: '#e0f2fe', justifyContent: 'center', alignItems: 'center', marginRight: 16 },
  profileInfo: { flex: 1 },
  profileName: { fontSize: 18, fontWeight: '600', color: '#1e293b', marginBottom: 2 },
  profileEmail: { fontSize: 14, color: '#64748b' },
  settingsContainer: { backgroundColor: '#f8fafc', borderRadius: 12, padding: 16 },
  settingItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 2 },
  settingLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  settingText: { marginLeft: 12, flex: 1 },
  settingTitle: { fontSize: 16, fontWeight: '600', color: '#1e293b' },
  settingSubtitle: { fontSize: 13, lineHeight: 18, color: '#64748b', marginTop: 2 },
  separator: { height: 1, backgroundColor: '#e2e8f0', marginVertical: 14 },
  devModeCard: { backgroundColor: '#f8fafc', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: '#e2e8f0' },
  devModeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sensorSection: { marginTop: 16, borderTopWidth: 1, borderTopColor: '#e2e8f0', paddingTop: 16 },
  sensorSectionHeader: { marginBottom: 12 },
  sensorSectionTitle: { fontSize: 15, fontWeight: '600', color: '#1B4965', marginBottom: 2 },
  sensorSectionSubtitle: { fontSize: 13, color: '#64748b' },
  sensorRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 10 },
  sensorLeft: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  sensorLabel: { fontSize: 15, color: '#1e293b', marginLeft: 12 },
  sensorLabelDisabled: { color: '#94a3b8' },
  logoutButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: '#ffffff', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: '#fecaca' },
  logoutButtonText: { fontSize: 16, fontWeight: '600', color: '#dc2626' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: 24 },
  modalContent: { backgroundColor: '#ffffff', borderRadius: 16, padding: 24, width: '100%', maxWidth: 360 },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#1e293b', marginBottom: 6 },
  modalSubtitle: { fontSize: 14, color: '#64748b', marginBottom: 20 },
  modalInput: { borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 10, padding: 14, fontSize: 16, color: '#1e293b', backgroundColor: '#f8fafc', marginBottom: 20 },
  modalButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
  modalButtonCancel: { paddingVertical: 10, paddingHorizontal: 20, borderRadius: 8, backgroundColor: '#f1f5f9' },
  modalButtonCancelText: { fontSize: 15, fontWeight: '600', color: '#64748b' },
  modalButtonConfirm: { paddingVertical: 10, paddingHorizontal: 20, borderRadius: 8, backgroundColor: '#1B4965' },
  modalButtonConfirmText: { fontSize: 15, fontWeight: '600', color: '#ffffff' },
});

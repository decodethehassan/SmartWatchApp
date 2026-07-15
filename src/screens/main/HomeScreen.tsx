import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useBLE } from '../../functionality/BLEContext';
import { useAuth } from '../../auth/AuthContext';
import { useSharedSensorPipeline } from '../../hooks/SensorPipelineContext';
import { getRecentSessions, SessionSummary } from '../../firebase/dataLogger';
import { BluetoothScanModal } from '../../components/BluetoothScanModal';

export default function HomeScreen() {
  const [recentSessions, setRecentSessions] = useState<SessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [scanModalVisible, setScanModalVisible] = useState(false);

  const {
    isAnyDeviceConnected, activeDeviceName, connectedDeviceName,
    isConnected, isEarbudConnected,
    disconnectAll,
    disconnectDevice,
    disconnectEarbud,
    statusMessage
  } = useBLE();
  const { user, logout } = useAuth();
  const { live, session, startSession, stopSession } = useSharedSensorPipeline();

  const safe = (value: number | null | undefined, fallback = 0) => {
    if (value === null || value === undefined) return fallback;
    return Number.isFinite(value) ? value : fallback;
  };

  const hasFresh = (updatedAt: Date | null) => {
    if (!updatedAt) return false;
    const ts = updatedAt.getTime();
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < 15_000;
  };

  const loadSessions = useCallback(() => {
    if (!user) { setSessionsLoading(false); return; }
    setSessionsLoading(true);
    getRecentSessions(user.uid, 5)
      .then((s) => setRecentSessions(s))
      .catch((err) => console.error('[HomeScreen] sessions load error:', err))
      .finally(() => setSessionsLoading(false));
  }, [user]);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  useEffect(() => {
    if (isConnected && !session.isRecording && user) {
      startSession(`Session ${new Date().toLocaleString()}`);
    }
  }, [isConnected]);

  useEffect(() => {
    if (!session.isRecording && !isConnected) loadSessions();
  }, [session.isRecording, isConnected, loadSessions]);

  const handleLogout = () => {
    Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: () => logout() },
    ]);
  };

  const handleDisconnect = () => {
    Alert.alert('Disconnect', 'Stop recording and disconnect from all devices?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect', style: 'destructive',
        onPress: async () => {
          try {
            if (session.isRecording) await stopSession();
            await disconnectAll();
          } catch (e) {
            // Silent catch during manual disconnect
          }
        },
      },
    ]);
  };

  const handleStopSession = async () => { await stopSession(); loadSessions(); };

  const safeFormat = (val: number | null | undefined, decimals: number = 1): string => {
    if (val === null || val === undefined || !Number.isFinite(val)) return '--';
    return val.toFixed(decimals);
  };

  // Patient-friendly metric cards
  const getHealthMetricCards = () => {
    const heartRateFresh = hasFresh(live?.heartRate?.lastUpdated ?? null);
    const hrvFresh = hasFresh(live?.hrv?.lastUpdated ?? null);
    const accelFresh = hasFresh(live?.accel?.lastUpdated ?? null);

    return [
      {
        icon: 'heart' as const,
        value: heartRateFresh && live.heartRate.bpm > 0
          ? Math.round(live.heartRate.bpm) + ' bpm'
          : (isConnected ? 'Waiting' : '---'),
        label: 'Heart Rate',
        active: heartRateFresh,
      },
      {
        icon: 'pulse' as const,
        value: hrvFresh && live.hrv.rmssd_ms > 0
          ? live.hrv.rmssd_ms.toFixed(1) + ' ms'
          : (isConnected ? 'Waiting' : '---'),
        label: 'HRV',
        active: hrvFresh,
      },
      {
        icon: 'walk' as const,
        value: live.activity.state !== 'UNKNOWN'
          ? live.activity.state
          : (accelFresh ? Math.round(live.accel.magnitude) + ' mg' : (isConnected ? 'Waiting' : '---')),
        label: 'Activity',
        active: accelFresh,
      },
      {
        icon: 'moon' as const,
        value: live.activity.lastUpdated
          ? live.activity.sleepState
          : (isConnected ? 'Waiting' : '---'),
        label: 'Sleep',
        active: isConnected,
      },
    ];
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <BluetoothScanModal visible={scanModalVisible} onClose={() => setScanModalVisible(false)} />
      <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>

        {/* Header */}
        <LinearGradient colors={['#1B4965', '#18A999']} style={styles.header}>
          <View style={styles.headerRow}>
            <View>
              <Text style={styles.greeting}>Hello, {user?.email?.split('@')[0] || 'User'} 👋</Text>
              <Text style={styles.subtitle}>Smart Stim Dashboard</Text>
            </View>
            <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
              <Ionicons name="log-out-outline" size={22} color="#ffffff" />
            </TouchableOpacity>
          </View>
        </LinearGradient>

        {/* BLE Connection Card */}
        <View style={styles.section}>
          {isAnyDeviceConnected ? (
            <View style={styles.connectedCard}>
              <LinearGradient colors={['#f0fdf4', '#dcfce7']} style={styles.connectedGradient}>

                {/* Header row with status badge */}
                <View style={styles.connectedTopRow}>
                  <View style={styles.statusBadge}>
                    <View style={styles.statusBadgeDot} />
                    <Text style={styles.statusBadgeText}>
                      {session.isRecording ? 'RECORDING' : 'LIVE'}
                    </Text>
                  </View>
                  <Text style={styles.dataPointsText}>
                    {session.isRecording ? `${session.dataPointsSaved} pts saved` : 'Ready to record'}
                  </Text>
                </View>

                {/* Device pills */}
                <View style={styles.devicesList}>
                  {isConnected && (
                    <View style={styles.devicePill}>
                      <LinearGradient colors={['#ffffff', '#f0fdf4']} style={styles.devicePillGradient}>
                        <View style={styles.devicePillLeft}>
                          <View style={styles.devicePillIcon}>
                            <Ionicons name="watch" size={22} color="#10b981" />
                          </View>
                          <View style={styles.devicePillInfo}>
                            <View style={styles.deviceNameRow}>
                              <Text style={styles.deviceName}>Wristband</Text>
                            </View>
                            <Text style={styles.deviceModel}>
                              {session.isRecording ? 'Receiving sensor data' : 'Connected'}
                            </Text>
                          </View>
                        </View>
                        <View style={styles.devicePillRight}>
                          <View style={styles.batteryIndicator}>
                            <Ionicons name="battery-full" size={18} color="#10b981" />
                            <Text style={styles.batteryText}>78%</Text>
                          </View>
                          <View style={styles.signalDots}>
                            <View style={[styles.signalDot, styles.signalDotActive]} />
                            <View style={[styles.signalDot, styles.signalDotActive]} />
                            <View style={[styles.signalDot, styles.signalDotActive]} />
                          </View>
                          <TouchableOpacity
                            style={styles.individualDisconnectBtn}
                            onPress={() =>
                              Alert.alert('Disconnect Wristband', 'Disconnect the wristband only?', [
                                { text: 'Cancel', style: 'cancel' },
                                {
                                  text: 'Disconnect', style: 'destructive',
                                  onPress: async () => {
                                    try {
                                      if (session.isRecording) await stopSession();
                                      await disconnectDevice();
                                    } catch (e) {
                                      // Silent catch - disconnection handled
                                    }
                                  },
                                },
                              ])
                            }
                          >
                            <Ionicons name="close-circle" size={20} color="#dc2626" />
                          </TouchableOpacity>
                        </View>
                      </LinearGradient>
                    </View>
                  )}

                  {isEarbudConnected && (
                    <View style={[styles.devicePill, styles.devicePillEarbud]}>
                      <LinearGradient colors={['#ffffff', '#faf5ff']} style={styles.devicePillGradient}>
                        <View style={styles.devicePillLeft}>
                          <View style={[styles.devicePillIcon, styles.devicePillIconEarbud]}>
                            <Ionicons name="ear" size={22} color="#8b5cf6" />
                          </View>
                          <View style={styles.devicePillInfo}>
                            <View style={styles.deviceNameRow}>
                              <Text style={styles.deviceName}>Earbud</Text>
                            </View>
                            <Text style={styles.deviceModel}>Connected</Text>
                          </View>
                        </View>
                        <View style={styles.devicePillRight}>
                          <View style={styles.signalDots}>
                            <View style={[styles.signalDot, styles.signalDotActivePurple]} />
                            <View style={[styles.signalDot, styles.signalDotActivePurple]} />
                            <View style={[styles.signalDot, styles.signalDotActivePurple]} />
                          </View>
                          <TouchableOpacity
                            style={styles.individualDisconnectBtn}
                            onPress={() =>
                              Alert.alert('Disconnect Earbud', 'Disconnect the earbud only?', [
                                { text: 'Cancel', style: 'cancel' },
                                {
                                  text: 'Disconnect', style: 'destructive',
                                  onPress: async () => {
                                    try {
                                      await disconnectEarbud();
                                    } catch (e) {
                                      // Silent catch - disconnection handled
                                    }
                                  },
                                },
                              ])
                            }
                          >
                            <Ionicons name="close-circle" size={20} color="#dc2626" />
                          </TouchableOpacity>
                        </View>
                      </LinearGradient>
                    </View>
                  )}
                </View>

                {/* Session started time */}
                {session.startedAt && (
                  <View style={styles.sessionTimeRow}>
                    <Ionicons name="time-outline" size={13} color="#6b7280" />
                    <Text style={styles.sessionTimeText}>
                      Session started {session.startedAt.toLocaleTimeString()}
                    </Text>
                  </View>
                )}

                {/* Action buttons */}
                <View style={styles.actionRow}>
                  {session.isRecording ? (
                    <TouchableOpacity style={styles.stopSessionBtn} onPress={handleStopSession}>
                      <View style={styles.stopSessionDot} />
                      <Text style={styles.stopSessionText}>Stop Recording</Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity style={styles.startSessionBtn} onPress={() => startSession()}>
                      <Ionicons name="radio-button-on" size={18} color="#ffffff" />
                      <Text style={styles.startSessionText}>Start Recording</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity style={styles.addDeviceBtn} onPress={() => setScanModalVisible(true)}>
                    <Ionicons name="add" size={17} color="#1B4965" />
                    <Text style={styles.addDeviceBtnText}>Add</Text>
                  </TouchableOpacity>
                </View>

                {/* Divider + disconnect all */}
                <View style={styles.disconnectRow}>
                  <View style={styles.dividerLine} />
                  <TouchableOpacity style={styles.disconnectBtn} onPress={handleDisconnect}>
                    <Ionicons name="bluetooth-outline" size={16} color="#dc2626" />
                    <Text style={styles.disconnectBtnText}>
                      {isConnected && isEarbudConnected ? 'Disconnect All' : 'Disconnect'}
                    </Text>
                  </TouchableOpacity>
                  <View style={styles.dividerLine} />
                </View>

              </LinearGradient>
            </View>
          ) : (
            <View style={styles.disconnectedCard}>
              <View style={styles.disconnectedBody}>
                <View style={styles.bleIconWrap}>
                  <Ionicons name="bluetooth-outline" size={36} color="#1B4965" />
                </View>
                <View style={styles.disconnectedInfo}>
                  <Text style={styles.disconnectedTitle}>No Device Connected</Text>
                  <Text style={styles.disconnectedSub}>{statusMessage}</Text>
                </View>
              </View>
              <TouchableOpacity style={styles.connectBtn} onPress={() => setScanModalVisible(true)}>
                <LinearGradient colors={['#1B4965', '#18A999']} style={styles.connectBtnGradient}>
                  <Ionicons name="search" size={20} color="#ffffff" />
                  <Text style={styles.connectBtnText}>Scan & Connect</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Health Metrics - Connected */}
        {isConnected && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Health Metrics</Text>
              <View style={styles.liveHeaderRight}>
                <Text style={styles.refreshHint}>Live data</Text>
                {session.isRecording && (
                  <View style={styles.recordingBadge}>
                  <View style={styles.recordingDot} />
                  <Text style={styles.recordingBadgeText}>REC</Text>
                </View>
                )}
              </View>
            </View>
            <View style={styles.sensorGrid}>
              {getHealthMetricCards().map((card) => (
                <View key={card.label} style={[styles.sensorCard, card.active && styles.sensorCardActive]}>
                  <Ionicons name={card.icon as any} size={22} color={card.active ? '#18A999' : '#cbd5e1'} />
                  <Text style={[styles.sensorValue, !card.active && styles.sensorValueInactive]}>{card.value}</Text>
                  <Text style={styles.sensorLabel}>{card.label}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Health Metrics - Offline placeholder */}
        {!isConnected && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Health Metrics</Text>
            <View style={styles.sensorGrid}>
              {[
                { icon: 'heart' as const, label: 'Heart Rate' },
                { icon: 'pulse' as const, label: 'HRV' },
                { icon: 'walk' as const, label: 'Activity' },
                { icon: 'moon' as const, label: 'Sleep' },
              ].map((item) => (
                <View key={item.label} style={styles.sensorCard}>
                  <Ionicons name={item.icon as any} size={22} color="#e2e8f0" />
                  <Text style={[styles.sensorValue, styles.sensorValueInactive]}>---</Text>
                  <Text style={styles.sensorLabel}>{item.label}</Text>
                </View>
              ))}
            </View>
            <TouchableOpacity style={styles.connectPromptBanner} onPress={() => setScanModalVisible(true)}>
              <Ionicons name="bluetooth" size={18} color="#1B4965" />
              <Text style={styles.connectPromptText}>Connect your wristband to see live data</Text>
              <Ionicons name="chevron-forward" size={16} color="#1B4965" />
            </TouchableOpacity>
          </View>
        )}

        {/* Recent Sessions */}
        <View style={[styles.section, { paddingBottom: 32 }]}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Recent Sessions</Text>
            <TouchableOpacity onPress={loadSessions}>
              <Ionicons name="refresh-outline" size={20} color="#1B4965" />
            </TouchableOpacity>
          </View>
          {sessionsLoading ? (
            <ActivityIndicator color="#1B4965" style={{ marginTop: 16 }} />
          ) : recentSessions.length === 0 ? (
            <View style={styles.emptySessionState}>
              <Ionicons name="time-outline" size={40} color="#e2e8f0" />
              <Text style={styles.emptySessionText}>No sessions yet</Text>
              <Text style={styles.emptySessionSub}>Connect your wristband and start recording</Text>
            </View>
          ) : (
            recentSessions.map((s) => (
              <View key={s.sessionId} style={styles.sessionCard}>
                <View style={styles.sessionIconWrap}>
                  <Ionicons name={s.isComplete ? 'checkmark-circle' : 'ellipse-outline'} size={24}
                    color={s.isComplete ? '#10b981' : '#f59e0b'} />
                </View>
                <View style={styles.sessionInfo}>
                  <Text style={styles.sessionName}>{s.sessionName}</Text>
                  <Text style={styles.sessionDate}>
                    {s.startTime ? s.startTime.toLocaleDateString() : 'Unknown'}
                    {s.deviceName ? ` · ${s.deviceName}` : ''}
                  </Text>
                </View>
                <View style={styles.sessionRight}>
                  <Text style={styles.sessionPts}>{s.dataPointCount} pts</Text>
                  <Text style={[styles.sessionStatus, { color: s.isComplete ? '#10b981' : '#f59e0b' }]}>
                    {s.isComplete ? 'Done' : 'Partial'}
                  </Text>
                </View>
              </View>
            ))
          )}
        </View>

      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#f8fafc' },
  container: { flex: 1 },
  header: { paddingHorizontal: 20, paddingVertical: 20 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  greeting: { fontSize: 22, fontWeight: '800', color: '#ffffff' },
  subtitle: { fontSize: 13, color: 'rgba(255,255,255,0.8)', marginTop: 2 },
  logoutBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.2)', justifyContent: 'center', alignItems: 'center' },
  section: { paddingHorizontal: 16, paddingTop: 20 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  liveHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionTitle: { fontSize: 17, fontWeight: '700', color: '#1e293b', marginBottom: 12 },
  refreshHint: { fontSize: 10, color: '#64748b', fontWeight: '600' },
  connectedCard: {
    borderRadius: 24,
    overflow: 'hidden',
    borderWidth: 1.5,
    borderColor: '#a7f3d0',
    shadowColor: '#10b981',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 8,
  },
  connectedGradient: {
    padding: 20,
    gap: 14,
  },
  connectedTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#dcfce7',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#a7f3d0',
  },
  statusBadgeDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#10b981',
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#059669',
    letterSpacing: 0.8,
  },
  dataPointsText: {
    fontSize: 12,
    color: '#6b7280',
    fontWeight: '500',
  },
  disconnectedCard: { backgroundColor: '#ffffff', borderRadius: 16, padding: 20, borderWidth: 1, borderColor: '#e2e8f0', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 6, elevation: 2 },
  disconnectedBody: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 16 },
  bleIconWrap: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#e0f2fe', justifyContent: 'center', alignItems: 'center' },
  disconnectedInfo: { flex: 1 },
  disconnectedTitle: { fontSize: 16, fontWeight: '700', color: '#1e293b' },
  disconnectedSub: { fontSize: 13, color: '#64748b', marginTop: 3 },
  connectBtn: { borderRadius: 12, overflow: 'hidden' },
  connectBtnGradient: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 14 },
  connectBtnText: { fontSize: 16, fontWeight: '700', color: '#ffffff' },
  recordingBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: '#fef2f2', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  recordingDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#ef4444' },
  recordingBadgeText: { fontSize: 12, fontWeight: '700', color: '#ef4444' },
  sensorGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  sensorCard: { width: '47%', backgroundColor: '#ffffff', padding: 16, borderRadius: 14, alignItems: 'center', borderWidth: 1, borderColor: '#e2e8f0', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 3, elevation: 1 },
  sensorCardActive: { borderColor: '#99e6dc', backgroundColor: '#f0fdfa' },
  sensorValue: { fontSize: 18, fontWeight: '700', color: '#1e293b', marginTop: 8, marginBottom: 3 },
  sensorValueInactive: { color: '#cbd5e1' },
  sensorLabel: { fontSize: 12, color: '#64748b', fontWeight: '600', textAlign: 'center' },
  connectPromptBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#e8f4f8', borderRadius: 12, padding: 14, marginTop: 12 },
  connectPromptText: { flex: 1, fontSize: 14, color: '#1B4965', fontWeight: '500' },
  emptySessionState: { alignItems: 'center', paddingVertical: 32, gap: 8 },
  emptySessionText: { fontSize: 16, fontWeight: '600', color: '#94a3b8' },
  emptySessionSub: { fontSize: 13, color: '#cbd5e1', textAlign: 'center' },
  sessionCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#ffffff', padding: 14, borderRadius: 12, marginBottom: 8, borderWidth: 1, borderColor: '#e2e8f0', shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 3, elevation: 1 },
  sessionIconWrap: { marginRight: 12 },
  sessionInfo: { flex: 1 },
  sessionName: { fontSize: 14, fontWeight: '600', color: '#1e293b', marginBottom: 2 },
  sessionDate: { fontSize: 12, color: '#64748b' },
  sessionRight: { alignItems: 'flex-end', gap: 3 },
  sessionPts: { fontSize: 14, fontWeight: '700', color: '#1e293b' },
  sessionStatus: { fontSize: 12, fontWeight: '600', color: '#f59e0b' },
  devicesList: {
    gap: 10,
  },
  devicePill: {
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1.5,
    borderColor: 'rgba(16,185,129,0.3)',
    shadowColor: '#10b981',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
    elevation: 2,
  },
  devicePillGradient: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 10,
  },
  devicePillLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 10,
  },
  devicePillIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#f0fdf4',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: 'rgba(16,185,129,0.2)',
  },
  devicePillInfo: {
    flex: 1,
    gap: 4,
  },
  deviceNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  deviceName: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1e293b',
  },
  deviceModel: {
    fontSize: 11,
    color: '#94a3b8',
    fontWeight: '500',
  },
  devicePillRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  batteryIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  batteryText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#10b981',
  },
  signalDots: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 3,
  },
  signalDot: {
    width: 3,
    height: 6,
    borderRadius: 1.5,
    backgroundColor: '#cbd5e1',
  },
  signalDotActive: {
    backgroundColor: '#10b981',
    height: 10,
  },
  signalDotActivePurple: {
    backgroundColor: '#8b5cf6',
  },
  devicePillEarbud: {
    borderColor: 'rgba(139,92,246,0.3)',
    shadowColor: '#8b5cf6',
  },
  devicePillIconEarbud: {
    backgroundColor: '#f5f3ff',
    borderColor: 'rgba(139,92,246,0.2)',
  },
  individualDisconnectBtn: {
    padding: 4,
    borderRadius: 12,
    backgroundColor: '#fef2f2',
  },
  sessionTimeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    gap: 4,
  },
  sessionTimeText: {
    fontSize: 12,
    color: '#64748b',
    fontWeight: '500',
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingHorizontal: 12,
  },
  startSessionBtn: {
    flex: 1,
    backgroundColor: '#10b981',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    shadowColor: '#10b981',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 4,
  },
  startSessionText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 14,
  },
  stopSessionBtn: {
    flex: 1,
    backgroundColor: '#fee2e2',
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1.5,
    borderColor: '#fca5a5',
  },
  stopSessionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#dc2626',
  },
  stopSessionText: {
    color: '#dc2626',
    fontWeight: '700',
    fontSize: 14,
  },
  addDeviceBtn: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: '#e8f4f8',
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#b3d9e8',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  addDeviceBtnText: {
    fontSize: 14,
    color: '#1B4965',
    fontWeight: '700',
  },
  disconnectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: 'rgba(16,185,129,0.1)',
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: 'rgba(16,185,129,0.2)',
  },
  disconnectBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#fef2f2',
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#fca5a5',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  disconnectBtnText: {
    color: '#dc2626',
    fontWeight: '700',
    fontSize: 13,
  },
});

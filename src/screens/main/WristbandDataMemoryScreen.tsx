import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Sharing from 'expo-sharing';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { useAuth } from '../../auth/AuthContext';
import { useBLE } from '../../functionality/BLEContext';
import { memorySyncService, type MemorySyncState } from '../../functionality/MemorySyncService';
import { rawMemorySyncService, type RawMemorySyncState } from '../../functionality/RawMemorySyncService';
import { getAllMinuteSummaries } from '../../firebase/dataLogger';
import type { SettingsStackParamList } from '../../navigation/SettingsStack';

const COLORS = {
  primary: '#1B4965',
  accent: '#18A999',
  background: '#f8fafc',
  surface: '#ffffff',
  text: '#1e293b',
  textSecondary: '#64748b',
  textLight: '#94a3b8',
  border: '#e2e8f0',
  success: '#10b981',
  error: '#dc2626',
};

type Props = NativeStackScreenProps<SettingsStackParamList, 'WristbandDataMemory'>;

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export default function WristbandDataMemoryScreen({ navigation }: Props) {
  const { user } = useAuth();
  const { isConnected, connectedDevice, connectedDeviceName } = useBLE();

  const [memorySync, setMemorySync] = useState<MemorySyncState>(memorySyncService.getState());
  const [rawMemorySync, setRawMemorySync] = useState<RawMemorySyncState>(rawMemorySyncService.getState());
  const [storedResultCount, setStoredResultCount] = useState(0);

  useEffect(() => memorySyncService.subscribe(setMemorySync), []);
  useEffect(() => rawMemorySyncService.subscribe(setRawMemorySync), []);

  useEffect(() => {
    let cancelled = false;
    if (!user?.uid) {
      setStoredResultCount(0);
      return () => { cancelled = true; };
    }

    void getAllMinuteSummaries(user.uid)
      .then((rows) => {
        if (!cancelled) setStoredResultCount(rows.length);
      })
      .catch((error) => console.warn('[WristbandDataMemory] Could not count synced results:', error));

    return () => { cancelled = true; };
  }, [user?.uid, memorySync.phase === 'complete' ? memorySync.lastSyncedIndex : -1]);

  const memoryBusy = ['checking', 'syncing', 'saving', 'stopping'].includes(memorySync.phase);
  const rawBusy = ['checking', 'syncing', 'stopping'].includes(rawMemorySync.phase);

  useEffect(() => {
    if (!isConnected && memoryBusy) void memorySyncService.handleDisconnected();
    if (!isConnected && rawBusy) void rawMemorySyncService.handleDisconnected();
  }, [isConnected, memoryBusy, rawBusy]);

  const handleMemorySync = async () => {
    if (!user?.uid || !isConnected) return;
    await memorySyncService.startSync({
      userId: user.uid,
      deviceId: connectedDevice?.id,
      deviceName: connectedDeviceName || undefined,
    });
  };

  const handleRawSync = async () => {
    if (!isConnected) return;
    await rawMemorySyncService.startSync({
      userId: user?.uid,
      deviceId: connectedDevice?.id,
      deviceName: connectedDeviceName || undefined,
    });
  };

  const handleShareRawBin = async () => {
    if (!rawMemorySync.fileUri) return;
    try {
      if (!(await Sharing.isAvailableAsync())) return;
      await Sharing.shareAsync(rawMemorySync.fileUri, {
        mimeType: 'application/octet-stream',
        dialogTitle: rawMemorySync.fileName || 'Wristband raw binary',
      });
    } catch (error) {
      console.warn('[WristbandDataMemory] Failed to share raw BIN:', error);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={24} color={COLORS.primary} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Wristband Data & Memory</Text>
          <Text style={styles.headerSubtitle}>
            {isConnected ? `${connectedDeviceName || 'Wristband'} connected` : 'Wristband not connected'}
          </Text>
        </View>
        <View style={[styles.statusDot, { backgroundColor: isConnected ? COLORS.success : COLORS.error }]} />
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.card}>
          <View style={styles.cardTitleRow}>
            <View style={styles.iconCircle}><Ionicons name="sync" size={20} color={COLORS.primary} /></View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>Processed Memory</Text>
              <Text style={styles.cardSubtitle}>{memorySync.message}</Text>
            </View>
          </View>

          <View style={styles.metaRow}>
            <Text style={styles.metaText}>
              Stored: {memorySync.info ? `${memorySync.info.historyCount}/${memorySync.info.historyCapacity} min` : '--'}
            </Text>
            <Text style={styles.metaText}>Cloud results: {storedResultCount}</Text>
          </View>

          {(memoryBusy || memorySync.phase === 'complete') && (
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${Math.max(0, Math.min(100, memorySync.progress * 100))}%` }]} />
            </View>
          )}

          {memorySync.error ? <Text style={styles.errorText}>{memorySync.error}</Text> : null}

          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[styles.primaryButton, (!isConnected || !user || memoryBusy || rawBusy) && styles.disabledButton]}
              disabled={!isConnected || !user || memoryBusy || rawBusy}
              onPress={() => { void handleMemorySync(); }}
            >
              <Ionicons name="sync" size={16} color="#fff" />
              <Text style={styles.primaryButtonText}>
                {memoryBusy ? 'Syncing…' : memorySync.phase === 'complete' ? 'Sync New Data' : 'Sync Memory'}
              </Text>
            </TouchableOpacity>

            {memoryBusy ? (
              <TouchableOpacity style={styles.stopButton} onPress={() => { void memorySyncService.stopSync(); }}>
                <Text style={styles.stopButtonText}>Stop</Text>
              </TouchableOpacity>
            ) : null}
          </View>

          <TouchableOpacity
            style={styles.secondaryButton}
            onPress={() => navigation.navigate('SyncedMemoryResults')}
          >
            <Ionicons name="list-outline" size={17} color={COLORS.primary} />
            <Text style={styles.secondaryButtonText}>View Synced 1-Minute Results</Text>
            <Ionicons name="chevron-forward" size={17} color={COLORS.textLight} />
          </TouchableOpacity>

          <Text style={styles.footnote}>
            Sync Memory downloads stored 60-second Algorithm V0 summaries into Firestore. These historical results remain separate from the live Physical graphs.
          </Text>
        </View>

        <View style={styles.card}>
          <View style={styles.cardTitleRow}>
            <View style={[styles.iconCircle, { backgroundColor: COLORS.accent + '14' }]}>
              <Ionicons name="hardware-chip-outline" size={20} color={COLORS.accent} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>Raw Sensor Memory</Text>
              <Text style={styles.cardSubtitle}>{rawMemorySync.message}</Text>
            </View>
          </View>

          <View style={styles.metaRow}>
            <Text style={styles.metaText}>
              NAND: {rawMemorySync.info ? formatBytes(rawMemorySync.info.committedSpanBytes) : '--'}
            </Text>
            <Text style={styles.metaText}>Received: {formatBytes(rawMemorySync.currentOffset)}</Text>
          </View>

          {(rawBusy || rawMemorySync.phase === 'complete' || rawMemorySync.phase === 'stopped') && (
            <View style={styles.progressTrack}>
              <View style={[styles.rawProgressFill, { width: `${Math.max(0, Math.min(100, rawMemorySync.progress * 100))}%` }]} />
            </View>
          )}

          {rawMemorySync.fileName ? (
            <Text style={styles.fileText} numberOfLines={1}>File: {rawMemorySync.fileName}</Text>
          ) : null}

          {rawMemorySync.error ? <Text style={styles.errorText}>{rawMemorySync.error}</Text> : null}

          <View style={styles.actionRow}>
            <TouchableOpacity
              style={[styles.rawButton, (!isConnected || rawBusy || memoryBusy) && styles.disabledButton]}
              disabled={!isConnected || rawBusy || memoryBusy}
              onPress={() => { void handleRawSync(); }}
            >
              <Ionicons name="download-outline" size={16} color="#fff" />
              <Text style={styles.primaryButtonText}>
                {rawBusy
                  ? 'Downloading Raw…'
                  : rawMemorySync.phase === 'complete'
                    ? 'Sync Raw Again'
                    : rawMemorySync.phase === 'stopped'
                      ? 'Resume Raw Data'
                      : 'Sync Raw Data'}
              </Text>
            </TouchableOpacity>

            {rawBusy ? (
              <TouchableOpacity style={styles.stopButton} onPress={() => { void rawMemorySyncService.stopSync(); }}>
                <Text style={styles.stopButtonText}>Stop</Text>
              </TouchableOpacity>
            ) : null}
          </View>

          {rawMemorySync.phase === 'complete' && rawMemorySync.fileUri ? (
            <TouchableOpacity style={styles.secondaryButton} onPress={() => { void handleShareRawBin(); }}>
              <Ionicons name="share-outline" size={17} color={COLORS.primary} />
              <Text style={styles.secondaryButtonText}>Share / Save BIN</Text>
            </TouchableOpacity>
          ) : null}

          <Text style={styles.footnote}>
            Sync Raw Data downloads the complete binary NAND snapshot. The BIN is kept locally on the phone and can be shared/saved for analysis. Secure cloud backup is being integrated; local Share / Save BIN remains available.
          </Text>
        </View>

        <View style={{ height: 30 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: COLORS.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: COLORS.surface, paddingHorizontal: 14, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  backButton: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.primary + '10' },
  headerTitle: { fontSize: 19, fontWeight: '800', color: COLORS.text },
  headerSubtitle: { marginTop: 2, fontSize: 12, color: COLORS.textSecondary },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  content: { padding: 16 },
  card: { backgroundColor: COLORS.surface, borderRadius: 16, padding: 16, marginBottom: 14, borderWidth: 1, borderColor: COLORS.border },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconCircle: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.primary + '12' },
  cardTitle: { fontSize: 16, fontWeight: '800', color: COLORS.text },
  cardSubtitle: { marginTop: 2, fontSize: 11, lineHeight: 15, color: COLORS.textSecondary },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 10, marginTop: 14 },
  metaText: { flex: 1, fontSize: 11, color: COLORS.textSecondary },
  progressTrack: { height: 7, marginTop: 12, borderRadius: 4, backgroundColor: COLORS.border, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 4, backgroundColor: COLORS.accent },
  rawProgressFill: { height: '100%', borderRadius: 4, backgroundColor: COLORS.primary },
  cloudProgressFill: { height: '100%', borderRadius: 4, backgroundColor: '#2563eb' },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 },
  primaryButton: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingVertical: 12, borderRadius: 10, backgroundColor: COLORS.primary },
  rawButton: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingVertical: 12, borderRadius: 10, backgroundColor: COLORS.accent },
  cloudButton: { marginTop: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingVertical: 12, borderRadius: 10, backgroundColor: '#2563eb' },
  cloudCompleteButton: { backgroundColor: COLORS.success },
  disabledButton: { opacity: 0.45 },
  primaryButtonText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  stopButton: { paddingHorizontal: 15, paddingVertical: 11, borderRadius: 10, borderWidth: 1, borderColor: COLORS.error },
  stopButtonText: { color: COLORS.error, fontSize: 12, fontWeight: '700' },
  secondaryButton: { marginTop: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, paddingVertical: 11, paddingHorizontal: 10, borderRadius: 10, borderWidth: 1, borderColor: COLORS.primary + '45', backgroundColor: COLORS.primary + '07' },
  secondaryButtonText: { flex: 1, color: COLORS.primary, fontSize: 12, fontWeight: '700', textAlign: 'center' },
  fileText: { marginTop: 8, fontSize: 10, color: COLORS.textSecondary },
  errorText: { marginTop: 8, fontSize: 11, color: COLORS.error },
  footnote: { marginTop: 11, fontSize: 10, lineHeight: 15, color: COLORS.textLight },
  cloudStatus: { marginTop: 10, padding: 10, borderRadius: 10, backgroundColor: COLORS.background, borderWidth: 1, borderColor: COLORS.border },
  cloudControls: { flexDirection: 'row', gap: 8, marginTop: 8 },
  smallButton: { alignSelf: 'flex-start', marginTop: 8, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: COLORS.primary + '55', backgroundColor: COLORS.surface },
  smallButtonText: { color: COLORS.primary, fontSize: 11, fontWeight: '700' },
});

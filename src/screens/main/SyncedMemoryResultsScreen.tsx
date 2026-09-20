import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import { useAuth } from '../../auth/AuthContext';
import { getAllMinuteSummaries } from '../../firebase/dataLogger';
import type { MinuteSummaryReading } from '../../firebase/sensorTypes';
import type { SettingsStackParamList } from '../../navigation/SettingsStack';

const COLORS = {
  primary: '#1B4965',
  background: '#f8fafc',
  surface: '#ffffff',
  text: '#1e293b',
  textSecondary: '#64748b',
  textLight: '#94a3b8',
  border: '#e2e8f0',
  error: '#dc2626',
};

type Props = NativeStackScreenProps<SettingsStackParamList, 'SyncedMemoryResults'>;
type ResultRow = MinuteSummaryReading & { id: string };

const timestampToDate = (value: any): Date | null => {
  try {
    if (value?.toDate) return value.toDate();
    if (value instanceof Date) return value;
  } catch {}
  return null;
};

const formatResultTime = (record: MinuteSummaryReading): string => {
  if (record.timestampSource !== 'FIRMWARE_UNIX_MS') return 'Time unavailable';
  const date = timestampToDate(record.timestamp);
  if (!date) return 'Time unavailable';
  return date.toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const pct = (value: number): string =>
  Number.isFinite(value) ? `${Math.round(value * 100)}%` : '--';

const fixed = (value: number, digits = 1): string =>
  Number.isFinite(value) ? value.toFixed(digits) : '--';

const validMetric = (value: number, quality?: string): boolean =>
  Number.isFinite(value) && value >= 0 && String(quality || '').toUpperCase() !== 'INVALID';

export default function SyncedMemoryResultsScreen({ navigation }: Props) {
  const { user } = useAuth();
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibleRows, setVisibleRows] = useState(50);

  const load = useCallback(async () => {
    if (!user?.uid) {
      setRows([]);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await getAllMinuteSummaries(user.uid);
      setRows(result);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [user?.uid]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const newestFirst = useMemo(
    () => [...rows].sort((a, b) => {
      const indexDiff = (b.historyIndex ?? -1) - (a.historyIndex ?? -1);
      if (indexDiff !== 0) return indexDiff;
      return (timestampToDate(b.timestamp)?.getTime() ?? 0) - (timestampToDate(a.timestamp)?.getTime() ?? 0);
    }),
    [rows],
  );

  const visible = newestFirst.slice(0, visibleRows);

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={24} color={COLORS.primary} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>Synced Memory Results</Text>
          <Text style={styles.headerSubtitle}>{rows.length} stored 60-second Algorithm V0 result{rows.length === 1 ? '' : 's'}</Text>
        </View>
        <TouchableOpacity style={styles.refreshButton} onPress={() => { void load(); }} disabled={loading}>
          <Ionicons name="refresh" size={20} color={COLORS.primary} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.infoCard}>
          <Ionicons name="information-circle-outline" size={18} color={COLORS.primary} />
          <Text style={styles.infoText}>
            This table contains synchronized minute summaries. Live PPG, HR, HRV and Activity graphs remain independent on the Physical screen. Invalid temperature is shown as “--”, not as the firmware sentinel -1°C.
          </Text>
        </View>

        {loading && rows.length === 0 ? (
          <View style={styles.centerBox}>
            <ActivityIndicator size="large" color={COLORS.primary} />
            <Text style={styles.loadingText}>Loading synchronized results…</Text>
          </View>
        ) : error ? (
          <View style={styles.centerBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : rows.length === 0 ? (
          <View style={styles.centerBox}>
            <Ionicons name="documents-outline" size={40} color={COLORS.textLight} />
            <Text style={styles.emptyTitle}>No synchronized results yet</Text>
            <Text style={styles.loadingText}>Go back and tap Sync Memory.</Text>
          </View>
        ) : (
          <View style={styles.tableCard}>
            <ScrollView horizontal showsHorizontalScrollIndicator>
              <View>
                <View style={[styles.tableRow, styles.headerRow]}>
                  <Text style={[styles.cell, styles.timeCell, styles.headerText]}>Time</Text>
                  <Text style={[styles.cell, styles.smallCell, styles.headerText]}>Index</Text>
                  <Text style={[styles.cell, styles.smallCell, styles.headerText]}>HR</Text>
                  <Text style={[styles.cell, styles.qualityCell, styles.headerText]}>HR Q</Text>
                  <Text style={[styles.cell, styles.smallCell, styles.headerText]}>HRV</Text>
                  <Text style={[styles.cell, styles.qualityCell, styles.headerText]}>HRV Q</Text>
                  <Text style={[styles.cell, styles.activityCell, styles.headerText]}>Activity</Text>
                  <Text style={[styles.cell, styles.smallCell, styles.headerText]}>Act %</Text>
                  <Text style={[styles.cell, styles.smallCell, styles.headerText]}>Artifact</Text>
                  <Text style={[styles.cell, styles.smallCell, styles.headerText]}>EDA µS</Text>
                  <Text style={[styles.cell, styles.qualityCell, styles.headerText]}>EDA Q</Text>
                  <Text style={[styles.cell, styles.smallCell, styles.headerText]}>Temp °C</Text>
                  <Text style={[styles.cell, styles.qualityCell, styles.headerText]}>Temp Q</Text>
                  <Text style={[styles.cell, styles.smallCell, styles.headerText]}>Slope</Text>
                  <Text style={[styles.cell, styles.activityCell, styles.headerText]}>Sleep</Text>
                  <Text style={[styles.cell, styles.smallCell, styles.headerText]}>Sleep %</Text>
                </View>

                {visible.map((row, index) => (
                  <View key={row.id} style={[styles.tableRow, index % 2 === 1 && styles.altRow]}>
                    <Text style={[styles.cell, styles.timeCell]}>{formatResultTime(row)}</Text>
                    <Text style={[styles.cell, styles.smallCell]}>{row.historyIndex}</Text>
                    <Text style={[styles.cell, styles.smallCell]}>{validMetric(row.heartRate, row.hrQuality) && row.heartRate > 0 ? Math.round(row.heartRate) : '--'}</Text>
                    <Text style={[styles.cell, styles.qualityCell]}>{row.hrQuality || '--'}</Text>
                    <Text style={[styles.cell, styles.smallCell]}>{validMetric(row.hrvRmssdMs, row.hrvQuality) && row.hrvRmssdMs > 0 ? fixed(row.hrvRmssdMs, 1) : '--'}</Text>
                    <Text style={[styles.cell, styles.qualityCell]}>{row.hrvQuality || '--'}</Text>
                    <Text style={[styles.cell, styles.activityCell]}>{row.activity || '--'}</Text>
                    <Text style={[styles.cell, styles.smallCell]}>{pct(row.activityConfidence)}</Text>
                    <Text style={[styles.cell, styles.smallCell]}>{pct(row.artifactFraction)}</Text>
                    <Text style={[styles.cell, styles.smallCell]}>{validMetric(row.edaMuScl, row.edaQuality) ? fixed(row.edaMuScl, 2) : '--'}</Text>
                    <Text style={[styles.cell, styles.qualityCell]}>{row.edaQuality || '--'}</Text>
                    <Text style={[styles.cell, styles.smallCell]}>{validMetric(row.temperatureC, row.temperatureQuality) ? fixed(row.temperatureC, 2) : '--'}</Text>
                    <Text style={[styles.cell, styles.qualityCell]}>{row.temperatureQuality || '--'}</Text>
                    <Text style={[styles.cell, styles.smallCell]}>{validMetric(row.temperatureSlope5m, row.temperatureQuality) ? fixed(row.temperatureSlope5m, 3) : '--'}</Text>
                    <Text style={[styles.cell, styles.activityCell]}>{row.sleepState || '--'}</Text>
                    <Text style={[styles.cell, styles.smallCell]}>{pct(row.sleepConfidence)}</Text>
                  </View>
                ))}
              </View>
            </ScrollView>

            <View style={styles.footer}>
              <Text style={styles.footerText}>Showing {Math.min(visibleRows, rows.length)} of {rows.length}, newest first</Text>
              <View style={styles.footerButtons}>
                {visibleRows < rows.length ? (
                  <TouchableOpacity style={styles.footerButton} onPress={() => setVisibleRows((n) => Math.min(rows.length, n + 50))}>
                    <Text style={styles.footerButtonText}>Show 50 more</Text>
                  </TouchableOpacity>
                ) : null}
                {visibleRows < rows.length ? (
                  <TouchableOpacity style={styles.footerButton} onPress={() => setVisibleRows(rows.length)}>
                    <Text style={styles.footerButtonText}>Show all</Text>
                  </TouchableOpacity>
                ) : null}
                {visibleRows > 50 ? (
                  <TouchableOpacity style={styles.footerButton} onPress={() => setVisibleRows(50)}>
                    <Text style={styles.footerButtonText}>Collapse</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          </View>
        )}

        <View style={{ height: 30 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: COLORS.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: COLORS.surface, paddingHorizontal: 14, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  backButton: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.primary + '10' },
  refreshButton: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.primary + '10' },
  headerTitle: { fontSize: 19, fontWeight: '800', color: COLORS.text },
  headerSubtitle: { marginTop: 2, fontSize: 11, color: COLORS.textSecondary },
  content: { padding: 16 },
  infoCard: { flexDirection: 'row', gap: 8, backgroundColor: '#eff6ff', borderRadius: 12, padding: 12, marginBottom: 12, borderWidth: 1, borderColor: '#dbeafe' },
  infoText: { flex: 1, fontSize: 11, lineHeight: 16, color: COLORS.textSecondary },
  centerBox: { backgroundColor: COLORS.surface, borderRadius: 16, padding: 28, alignItems: 'center', borderWidth: 1, borderColor: COLORS.border },
  loadingText: { marginTop: 10, fontSize: 12, color: COLORS.textSecondary, textAlign: 'center' },
  errorText: { fontSize: 12, color: COLORS.error, textAlign: 'center' },
  emptyTitle: { marginTop: 10, fontSize: 16, fontWeight: '700', color: COLORS.text },
  tableCard: { backgroundColor: COLORS.surface, borderRadius: 14, borderWidth: 1, borderColor: COLORS.border, overflow: 'hidden' },
  tableRow: { flexDirection: 'row', minHeight: 40, alignItems: 'center', borderBottomWidth: 1, borderBottomColor: COLORS.border },
  headerRow: { backgroundColor: '#f1f5f9' },
  altRow: { backgroundColor: '#f8fafc' },
  cell: { paddingHorizontal: 7, fontSize: 10, color: COLORS.text, textAlign: 'center' },
  headerText: { fontWeight: '800', color: COLORS.primary },
  timeCell: { width: 132, textAlign: 'left' },
  smallCell: { width: 70 },
  qualityCell: { width: 82 },
  activityCell: { width: 92 },
  footer: { padding: 12 },
  footerText: { fontSize: 11, color: COLORS.textSecondary },
  footerButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  footerButton: { paddingHorizontal: 10, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: COLORS.primary + '45' },
  footerButtonText: { color: COLORS.primary, fontSize: 11, fontWeight: '700' },
});

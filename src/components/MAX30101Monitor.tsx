/**
 * MAX30101Monitor.tsx  — Firmware-Integrated PPG & Heart Rate Monitor
 *
 * Upgraded to use data from the Medical-Wristband-Firmware (algo_v0):
 *
 *   • Real-time PPG waveform from `PPG_STREAM` / `PV` BLE lines (filt signal)
 *   • Firmware-computed heart rate (not a client-side estimate)
 *   • Signal quality (SQI, artifact, qok) from `PV_WIN` 5-second windows
 *   • HRV (RMSSD) and activity from `V0_MIN` 1-minute summaries
 *   • Raw channel values (RED / IR / GREEN) from legacy `PPG OUT` lines
 *   • Cloud sync via Firebase (HR + PPG already handled in useSensorPipeline)
 *
 * Data flow:
 *   BLE  →  parseSensorLine  →  useSensorPipeline  →  LiveSensorState
 *                                                          ↓
 *                                                   MAX30101Monitor
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Dimensions,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSharedSensorPipeline } from '../hooks/SensorPipelineContext';
import { useBLE } from '../functionality/BLEContext';
import PPGWaveformCard from './PPGWaveformCard';
import { theme } from '../styles/theme';

const { width: SCREEN_W } = Dimensions.get('window');

// ─── sub-components ──────────────────────────────────────────────────────────

const MetricCard: React.FC<{
  label: string;
  value: string;
  unit?: string;
  accent?: string;
  note?: string;
}> = ({ label, value, unit, accent = '#1e293b', note }) => (
  <View style={styles.metricCard}>
    <Text style={styles.metricLabel}>{label}</Text>
    <View style={styles.metricValueRow}>
      <Text style={[styles.metricValue, { color: accent }]}>{value}</Text>
      {unit ? <Text style={styles.metricUnit}>{unit}</Text> : null}
    </View>
    {note ? <Text style={styles.metricNote}>{note}</Text> : null}
  </View>
);

const ChannelBar: React.FC<{
  label: string;
  value: number;
  max?: number;
  color: string;
}> = ({ label, value, max = 262143, color }) => {
  const pct = Math.min(1, Math.max(0, value / max));
  return (
    <View style={styles.channelRow}>
      <Text style={styles.channelLabel}>{label}</Text>
      <View style={styles.channelBarBg}>
        <View style={[styles.channelBarFill, { width: `${(pct * 100).toFixed(1)}%` as any, backgroundColor: color }]} />
      </View>
      <Text style={styles.channelValue}>{value > 0 ? value.toLocaleString() : '--'}</Text>
    </View>
  );
};

// ─── main component ───────────────────────────────────────────────────────────

export const MAX30101Monitor: React.FC = () => {
  const { live } = useSharedSensorPipeline();
  const { isConnected } = useBLE();
  const [activeTab, setActiveTab] = useState<'waveform' | 'stats' | 'quality'>('waveform');

  const { ppg, ppgStream, heartRate, ppgQuality, hrv, activity } = live;

  const hrValid = heartRate.bpm > 0 && heartRate.confidence !== 'invalid';

  // Determine activity icon
  const activityIcon =
    activity.state === 'VIG'  ? '🏃' :
    activity.state === 'WALK' ? '🚶' :
    activity.state === 'LOW'  ? '🧘' :
    activity.state === 'REST' ? '😴' : '⌚';

  const hrQualColor =
    heartRate.confidence === 'high'  ? '#10b981' :
    heartRate.confidence === 'low'   ? '#f59e0b' : '#94a3b8';

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {/* ── Header ── */}
      <LinearGradient
        colors={['#0f172a', '#1e293b']}
        style={styles.header}
      >
        <View style={styles.headerTop}>
          <View>
            <Text style={styles.headerTitle}>MAX30101 · PPG & Heart Rate</Text>
            <Text style={styles.headerSubtitle}>
              {isConnected ? '🟢  Live · Medical-Wristband-Firmware' : '🔴  Disconnected'}
            </Text>
          </View>
          {/* Big HR display in header */}
          <View style={styles.headerHR}>
            <Text style={[styles.headerHRValue, { color: hrQualColor }]}>
              {hrValid ? Math.round(heartRate.bpm) : '--'}
            </Text>
            <Text style={styles.headerHRUnit}>BPM</Text>
          </View>
        </View>

        {/* Firmware badge */}
        <View style={styles.firmwareBadge}>
          <Text style={styles.firmwareBadgeText}>
            algo_v0 · PPG_FULLFW_STREAM_ENABLE=1 · PPG_STREAM_DIV=2 (~50 Hz)
          </Text>
        </View>
      </LinearGradient>

      {/* ── Tab bar ── */}
      <View style={styles.tabBar}>
        {(['waveform', 'stats', 'quality'] as const).map(tab => (
          <TouchableOpacity
            key={tab}
            style={[styles.tab, activeTab === tab && styles.tabActive]}
            onPress={() => setActiveTab(tab)}
          >
            <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
              {tab === 'waveform' ? '📈 Waveform' : tab === 'stats' ? '📊 Stats' : '🔬 Quality'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ── Waveform Tab ── */}
      {activeTab === 'waveform' && (
        <View style={styles.tabContent}>
          <PPGWaveformCard
            filtSamples={ppgStream.filt}
            thSamples={ppgStream.th}
            peakFlags={ppgStream.peaks}
            hrBpm={heartRate.bpm}
            confidence={heartRate.confidence}
            sqi={ppgQuality.sqi}
            artifact={ppgQuality.artifact}
            qualityOk={ppgQuality.qualityOk}
            wearDetected={ppgQuality.wearDetected}
            ibi_ms={heartRate.ibi_ms}
          />

          {/* Raw channels */}
          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>Raw ADC Channels</Text>
            <Text style={styles.sectionSub}>
              18-bit · 0–262,143 · Wear threshold: &gt;50k
            </Text>
            <View style={{ marginTop: 12, gap: 10 }}>
              <ChannelBar label="GREEN" value={ppg.green} color="#10b981" />
              <ChannelBar label="IR"    value={ppg.ir}    color="#8b5cf6" />
              <ChannelBar label="RED"   value={ppg.red}   color="#ef4444" />
            </View>
          </View>
        </View>
      )}

      {/* ── Stats Tab ── */}
      {activeTab === 'stats' && (
        <View style={styles.tabContent}>
          {/* HR metrics */}
          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>Heart Rate — Firmware Computed</Text>
            <Text style={styles.sectionSub}>
              Source: algo_v0 IBI peak detection + SQI gating
            </Text>
            <View style={styles.metricsGrid}>
              <MetricCard
                label="Heart Rate"
                value={hrValid ? String(Math.round(heartRate.bpm)) : '--'}
                unit="BPM"
                accent={hrQualColor}
                note={heartRate.confidence === 'high' ? 'High confidence' : heartRate.confidence === 'low' ? 'Low confidence' : 'No valid reading'}
              />
              <MetricCard
                label="IBI"
                value={heartRate.ibi_ms > 0 ? String(heartRate.ibi_ms) : '--'}
                unit="ms"
                accent="#1B4965"
                note="Inter-beat interval"
              />
              <MetricCard
                label="HRV RMSSD"
                value={hrv.rmssd_ms > 0 ? hrv.rmssd_ms.toFixed(1) : '--'}
                unit="ms"
                accent={hrv.quality === 'OK' ? '#10b981' : '#94a3b8'}
                note={`Quality: ${hrv.quality}`}
              />
            </View>
          </View>

          {/* Activity */}
          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>Activity & Sleep</Text>
            <Text style={styles.sectionSub}>
              From V0_MIN 1-minute summaries
            </Text>
            <View style={styles.metricsGrid}>
              <MetricCard
                label="Activity"
                value={`${activityIcon} ${activity.state}`}
                accent="#1B4965"
                note={`Conf: ${(activity.confidence * 100).toFixed(0)}%`}
              />
              <MetricCard
                label="Sleep State"
                value={activity.sleepState === 'SLEEP' ? '😴 Sleep' : '👁 Wake'}
                accent={activity.sleepState === 'SLEEP' ? '#8b5cf6' : '#1B4965'}
                note={`Conf: ${(activity.sleepConf * 100).toFixed(0)}%`}
              />
            </View>
          </View>

          {/* Raw channels detail */}
          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>PPG Channels</Text>
            <Text style={styles.sectionSub}>Raw ADC counts from MAX30101</Text>
            <View style={styles.metricsGrid}>
              <MetricCard
                label="GREEN"
                value={ppg.green > 0 ? ppg.green.toLocaleString() : '--'}
                accent="#10b981"
                note="Primary channel"
              />
              <MetricCard
                label="IR"
                value={ppg.ir > 0 ? ppg.ir.toLocaleString() : '--'}
                accent="#8b5cf6"
                note="SpO2 / Wear"
              />
              <MetricCard
                label="RED"
                value={ppg.red > 0 ? ppg.red.toLocaleString() : '--'}
                accent="#ef4444"
                note="SpO2"
              />
            </View>
          </View>
        </View>
      )}

      {/* ── Quality Tab ── */}
      {activeTab === 'quality' && (
        <View style={styles.tabContent}>
          <View style={styles.sectionCard}>
            <Text style={styles.sectionTitle}>Signal Quality (5-sec windows)</Text>
            <Text style={styles.sectionSub}>
              Source: PV_WIN from algo_v0 — updated every 5 seconds
            </Text>

            <View style={[styles.qualityBlock, { borderColor: ppgQuality.qualityOk ? '#10b981' : '#f59e0b' }]}>
              <View style={styles.qualityBlockHeader}>
                <View style={[styles.qualityIndicator, { backgroundColor: ppgQuality.qualityOk ? '#10b981' : '#f59e0b' }]} />
                <Text style={[styles.qualityBlockTitle, { color: ppgQuality.qualityOk ? '#10b981' : '#f59e0b' }]}>
                  {ppgQuality.qualityOk ? 'Signal Quality: GOOD' : 'Signal Quality: DEGRADED'}
                </Text>
              </View>

              <View style={styles.qualityRows}>
                <QualityRow label="SQI" value={`${(ppgQuality.sqi * 100).toFixed(0)}%`} good={ppgQuality.sqi >= 0.5} />
                <QualityRow label="Motion Artifact" value={ppgQuality.artifact ? 'Detected' : 'None'} good={!ppgQuality.artifact} />
                <QualityRow label="Wear Detection" value={ppgQuality.wearDetected ? 'Worn' : 'Not worn'} good={ppgQuality.wearDetected} />
                <QualityRow label="Quality Gate (qok)" value={ppgQuality.qualityOk ? 'OPEN' : 'CLOSED'} good={ppgQuality.qualityOk} />
                <QualityRow
                  label="HR Confidence"
                  value={heartRate.confidence.toUpperCase()}
                  good={heartRate.confidence === 'high'}
                />
              </View>
            </View>
          </View>

          {/* Explanation */}
          <View style={[styles.sectionCard, { backgroundColor: '#f8fafc' }]}>
            <Text style={styles.sectionTitle}>How it works</Text>
            <Text style={styles.sectionSub}>Medical-Wristband-Firmware algo_v0</Text>
            <Text style={styles.explainText}>
              The firmware runs a high-pass filter + adaptive peak detector on the GREEN channel at 100 Hz.
              Every sample is streamed over BLE as {`PPG_STREAM,t=…,filt=…,th=…,peak=…,hr=…`}.{'\n\n'}
              Every 5 seconds the firmware evaluates SQI (spectral quality index), motion artifacts, and saturation to decide if the `qok` quality gate opens.{'\n\n'}
              Heart rate is only reported when `qok=1` — no quality gate = no reading, preventing false HR values.{'\n\n'}
              Every 60 seconds, `V0_MIN` sends a definitive HR + HRV (RMSSD) for cloud storage.
            </Text>
          </View>
        </View>
      )}

      <View style={{ height: 32 }} />
    </ScrollView>
  );
};

// ─── QualityRow helper ────────────────────────────────────────────────────────
const QualityRow: React.FC<{ label: string; value: string; good: boolean }> = ({
  label, value, good
}) => (
  <View style={styles.qualityRowItem}>
    <Text style={styles.qualityRowLabel}>{label}</Text>
    <View style={[styles.qualityRowBadge, { backgroundColor: good ? '#d1fae5' : '#fee2e2' }]}>
      <Text style={[styles.qualityRowValue, { color: good ? '#065f46' : '#991b1b' }]}>{value}</Text>
    </View>
  </View>
);

// ─── styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f1f5f9',
  },
  content: {
    paddingBottom: 32,
  },
  header: {
    paddingTop: 16,
    paddingBottom: 20,
    paddingHorizontal: 20,
    borderBottomLeftRadius: 24,
    borderBottomRightRadius: 24,
    marginBottom: 12,
  },
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '800',
    color: '#f8fafc',
    letterSpacing: -0.3,
  },
  headerSubtitle: {
    fontSize: 12,
    color: '#94a3b8',
    marginTop: 3,
  },
  headerHR: {
    alignItems: 'center',
  },
  headerHRValue: {
    fontSize: 44,
    fontWeight: '900',
    letterSpacing: -2,
    lineHeight: 48,
  },
  headerHRUnit: {
    fontSize: 11,
    color: '#64748b',
    fontWeight: '700',
    letterSpacing: 1.5,
    textAlign: 'center',
  },
  firmwareBadge: {
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    alignSelf: 'flex-start',
  },
  firmwareBadgeText: {
    fontSize: 9,
    color: '#64748b',
    fontFamily: 'monospace',
    letterSpacing: 0.3,
  },
  tabBar: {
    flexDirection: 'row',
    marginHorizontal: 16,
    backgroundColor: '#e2e8f0',
    borderRadius: 12,
    padding: 4,
    marginBottom: 12,
  },
  tab: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 9,
    alignItems: 'center',
  },
  tabActive: {
    backgroundColor: '#ffffff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
    elevation: 2,
  },
  tabText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
  },
  tabTextActive: {
    color: '#0f172a',
    fontWeight: '700',
  },
  tabContent: {
    paddingHorizontal: 16,
    gap: 14,
  },
  sectionCard: {
    backgroundColor: '#ffffff',
    borderRadius: 20,
    padding: 18,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0f172a',
    letterSpacing: -0.2,
  },
  sectionSub: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 3,
    marginBottom: 4,
  },
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 12,
  },
  metricCard: {
    flex: 1,
    minWidth: 90,
    backgroundColor: '#f8fafc',
    borderRadius: 14,
    padding: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  metricLabel: {
    fontSize: 10,
    color: '#64748b',
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  metricValueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 3,
  },
  metricValue: {
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  metricUnit: {
    fontSize: 11,
    color: '#64748b',
    fontWeight: '600',
  },
  metricNote: {
    fontSize: 10,
    color: '#94a3b8',
    marginTop: 4,
  },
  channelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  channelLabel: {
    width: 48,
    fontSize: 11,
    fontWeight: '700',
    color: '#475569',
    textAlign: 'right',
  },
  channelBarBg: {
    flex: 1,
    height: 8,
    backgroundColor: '#f1f5f9',
    borderRadius: 4,
    overflow: 'hidden',
  },
  channelBarFill: {
    height: '100%',
    borderRadius: 4,
  },
  channelValue: {
    width: 72,
    fontSize: 11,
    fontWeight: '600',
    color: '#475569',
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  qualityBlock: {
    borderWidth: 1.5,
    borderRadius: 14,
    padding: 14,
    marginTop: 12,
  },
  qualityBlockHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  qualityIndicator: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  qualityBlockTitle: {
    fontSize: 14,
    fontWeight: '700',
  },
  qualityRows: {
    gap: 8,
  },
  qualityRowItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  qualityRowLabel: {
    fontSize: 13,
    color: '#475569',
    fontWeight: '500',
  },
  qualityRowBadge: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 8,
  },
  qualityRowValue: {
    fontSize: 12,
    fontWeight: '700',
  },
  explainText: {
    fontSize: 12.5,
    color: '#475569',
    lineHeight: 19,
    marginTop: 10,
  },
});

export default MAX30101Monitor;

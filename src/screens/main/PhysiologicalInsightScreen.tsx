import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Dimensions, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LineChart } from 'react-native-chart-kit';

import { useSharedSensorPipeline } from '../../hooks/SensorPipelineContext';
import { useBLE } from '../../functionality/BLEContext';
import PPGWaveformCard from '../../components/PPGWaveformCard';

const SCREEN_WIDTH = Dimensions.get('window').width;
const CHART_WIDTH = SCREEN_WIDTH - 64;
const LIVE_HISTORY_SIZE = 60;

const COLORS = {
  primary: '#1B4965',
  accent: '#18A999',
  error: '#DC2626',
  background: '#f8fafc',
  surface: '#ffffff',
  text: '#1e293b',
  textSecondary: '#64748b',
  textLight: '#94a3b8',
  border: '#e2e8f0',
  success: '#10b981',
};

type LiveHistory = {
  heartRate: number[];
  hrv: number[];
};

const EMPTY_HISTORY: LiveHistory = {
  heartRate: [],
  hrv: [],
};

const appendLive = (values: number[], value: number) =>
  [...values, Number.isFinite(value) ? value : 0].slice(-LIVE_HISTORY_SIZE);

const displaySeries = (values: number[], fallback: number[]) => {
  if (values.length > 1) return values;
  if (values.length === 1) return [values[0], values[0]];
  return fallback;
};

const liveLabels = (count: number) =>
  Array.from({ length: Math.max(count, 2) }, (_, index) =>
    index === Math.max(count, 2) - 1 ? 'Now' : '',
  );

function makeChartConfig(color: string, decimalPlaces = 1) {
  return {
    backgroundGradientFrom: COLORS.surface,
    backgroundGradientTo: COLORS.surface,
    decimalPlaces,
    color: (opacity = 1) => color,
    labelColor: () => COLORS.textSecondary,
    propsForDots: {
      r: '4',
      strokeWidth: '2',
      stroke: color,
      fill: COLORS.surface,
    },
    propsForBackgroundLines: {
      strokeDasharray: '4 4',
      stroke: COLORS.border,
      strokeWidth: 1,
    },
    style: { borderRadius: 12 },
  };
}

const PhysioChart = React.memo(({
  data,
  chartConfig,
  width,
  height,
  bezier,
}: {
  data: any;
  chartConfig: any;
  width: number;
  height: number;
  bezier?: boolean;
}) => (
  <LineChart
    data={data}
    width={width}
    height={height}
    chartConfig={chartConfig}
    bezier={bezier}
    style={styles.chart}
    withInnerLines
    withOuterLines
    withVerticalLines={false}
    withDots={false}
  />
));

function MetricCard({
  accent,
  icon,
  title,
  subtitle,
  description,
  children,
}: {
  accent: string;
  icon: string;
  title: string;
  subtitle: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={[styles.card, { borderLeftColor: accent }]}>
      <View style={styles.cardHeader}>
        <View style={[styles.cardIconCircle, { backgroundColor: accent + '18' }]}>
          <Ionicons name={icon as any} size={18} color={accent} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle}>{title}</Text>
          <Text style={styles.cardSubtitle}>{subtitle}</Text>
        </View>
      </View>
      {children}
      {description ? <Text style={styles.cardDescription}>{description}</Text> : null}
    </View>
  );
}

export default function PhysiologicalInsightScreen() {
  const [history, setHistory] = useState<LiveHistory>(EMPTY_HISTORY);
  const { live } = useSharedSensorPipeline();
  const { isConnected } = useBLE();

  const lastCaptured = useRef({
    heartRate: 0,
    hrv: 0,
  });

  useEffect(() => {
    const heartRateStamp = live.heartRate.lastUpdated?.getTime() ?? 0;
    const hrvStamp = live.hrv.lastUpdated?.getTime() ?? 0;

    const heartRateChanged =
      heartRateStamp > lastCaptured.current.heartRate && live.heartRate.bpm > 0;
    const hrvChanged = hrvStamp > lastCaptured.current.hrv && live.hrv.rmssd_ms > 0;

    if (!heartRateChanged && !hrvChanged) return;

    setHistory((prev) => ({
      heartRate: heartRateChanged
        ? appendLive(prev.heartRate, live.heartRate.bpm)
        : prev.heartRate,
      hrv: hrvChanged ? appendLive(prev.hrv, live.hrv.rmssd_ms) : prev.hrv,
    }));

    if (heartRateChanged) lastCaptured.current.heartRate = heartRateStamp;
    if (hrvChanged) lastCaptured.current.hrv = hrvStamp;
  }, [live.heartRate, live.hrv]);

  const hasFresh = (date: Date | null | undefined) =>
    Boolean(date && Date.now() - date.getTime() < 15000);

  const hrFresh = hasFresh(live.heartRate.lastUpdated);
  const hrvFresh = hasFresh(live.hrv.lastUpdated);

  const hrChartConfig = useMemo(() => makeChartConfig(COLORS.error, 0), []);
  const hrvChartConfig = useMemo(() => makeChartConfig('#f97316', 0), []);

  const hrChartData = useMemo(() => {
    const values = displaySeries(history.heartRate, [0, 0]);
    return { labels: liveLabels(values.length), datasets: [{ data: values }] };
  }, [history.heartRate]);

  const hrvChartData = useMemo(() => {
    const values = displaySeries(history.hrv, [0, 0]);
    return { labels: liveLabels(values.length), datasets: [{ data: values }] };
  }, [history.hrv]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <View style={styles.headerIconWrap}>
          <Ionicons name="stats-chart" size={22} color={COLORS.primary} />
        </View>
        <Text style={styles.headerTitle}>Physiological Insight</Text>
        <View style={[styles.connDot, { backgroundColor: isConnected ? COLORS.success : COLORS.error }]} />
      </View>

      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.liveModeBanner}>
          <View style={[styles.connDot, { backgroundColor: isConnected ? COLORS.success : COLORS.textLight }]} />
          <Text style={styles.liveModeText}>
            {isConnected ? 'Live physiological stream' : 'Connect wristband for live physiological data'}
          </Text>
        </View>

        <View style={{ paddingHorizontal: 16, marginBottom: 14 }}>
          <PPGWaveformCard
            cleanSamples={live.ppgStream.filt}
            timestamps={live.ppgStream.timestamps}
            peakFlags={live.ppgStream.peaks}
            qualityFlags={live.ppgStream.qualityFlags}
            artifactFlags={live.ppgStream.artifactFlags}
            contactFlags={live.ppgStream.contactFlags}
            hrBpm={live.heartRate.bpm}
            confidence={live.heartRate.confidence}
            sqi={live.ppgQuality.sqi}
            artifact={live.ppgQuality.artifact}
            qualityOk={live.ppgQuality.qualityOk}
            wearDetected={live.ppgQuality.wearDetected}
            ibi_ms={live.heartRate.ibi_ms}
            fsHz={live.ppgStream.fsHz}
            acdc={live.ppgStream.acdc}
            hrQuality={live.ppgStream.hrQuality}
            rmssdMs={live.ppgStream.rmssdMs}
            prvReady={live.ppgStream.prvReady}
            ibiCv={live.ppgStream.ibiCv}
          />
        </View>

        <MetricCard
          accent={COLORS.error}
          icon="heart"
          title="Heart Rate"
          subtitle={
            hrFresh && live.heartRate.bpm > 0
              ? `${Math.round(live.heartRate.bpm)} bpm (Live)`
              : 'Waiting for a quality-approved beat'
          }
          description="Live quality-approved heart rate from the wristband. Historical memory sync never replaces this graph."
        >
          <PhysioChart
            data={hrChartData}
            width={CHART_WIDTH}
            height={180}
            chartConfig={hrChartConfig}
            bezier
          />
        </MetricCard>

        <MetricCard
          accent="#f97316"
          icon="pulse"
          title="Heart Rate Variability"
          subtitle={
            hrvFresh && live.hrv.rmssd_ms > 0
              ? `${live.hrv.rmssd_ms.toFixed(1)} ms (Live)`
              : 'Waiting for enough accepted beat intervals'
          }
          description="Rolling firmware HRV/PRV updates as soon as enough clean accepted IBIs are available. Historical memory sync never replaces this graph."
        >
          <PhysioChart
            data={hrvChartData}
            width={CHART_WIDTH}
            height={180}
            chartConfig={hrvChartConfig}
            bezier
          />
        </MetricCard>

        <MetricCard
          accent={COLORS.accent}
          icon="fitness"
          title="Activity Insight"
          subtitle={
            live.activity.state !== 'UNKNOWN'
              ? `${live.activity.state} / ${Math.round(live.activity.confidence * 100)}% confidence (Live)`
              : 'Waiting for firmware activity summary'
          }
          description="Current Algorithm V0 activity classification. Stored minute classifications are available from Settings → Wristband Data & Memory."
        >
          <View style={styles.activityContainer}>
            <Text style={styles.liveActivityState}>
              {live.activity.state !== 'UNKNOWN' ? live.activity.state : '--'}
            </Text>
            <Text style={styles.cardDescription}>
              Confidence: {Number.isFinite(live.activity.confidence) ? `${Math.round(live.activity.confidence * 100)}%` : '--'}
            </Text>
            <Text style={styles.cardDescription}>
              Acceleration magnitude: {(live.accel.magnitude / 1000).toFixed(3)} g
            </Text>
            <Text style={styles.cardDescription}>
              Angular velocity magnitude: {(live.gyro.magnitude / 1000).toFixed(2)} dps
            </Text>
          </View>
        </MetricCard>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: COLORS.background },
  header: { flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.surface, paddingHorizontal: 16, paddingVertical: 14, gap: 12, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  headerIconWrap: { width: 40, height: 40, borderRadius: 20, backgroundColor: COLORS.primary + '12', justifyContent: 'center', alignItems: 'center' },
  headerTitle: { flex: 1, fontSize: 20, fontWeight: '800', color: COLORS.text },
  connDot: { width: 10, height: 10, borderRadius: 5 },
  scroll: { flex: 1 },
  liveModeBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, marginHorizontal: 16, marginTop: 16, marginBottom: 12, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 12, backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border },
  liveModeText: { fontSize: 12, color: COLORS.textSecondary, fontWeight: '600' },
  card: { backgroundColor: COLORS.surface, borderRadius: 16, marginHorizontal: 16, marginBottom: 14, padding: 18, borderLeftWidth: 4, ...Platform.select({ ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8 }, android: { elevation: 3 } }) },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 14, gap: 10 },
  cardIconCircle: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  cardTitle: { fontSize: 15, fontWeight: '700', color: COLORS.text },
  cardSubtitle: { fontSize: 12, fontWeight: '600', color: COLORS.textSecondary, marginTop: 1 },
  cardDescription: { fontSize: 11, color: COLORS.textLight, lineHeight: 16, marginTop: 10 },
  chart: { borderRadius: 12, marginLeft: -8 },
  activityContainer: { gap: 10 },
  liveActivityState: { fontSize: 30, fontWeight: '900', color: COLORS.accent },
});

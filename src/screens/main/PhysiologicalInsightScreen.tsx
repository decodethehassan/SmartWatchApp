import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, Dimensions, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LineChart } from 'react-native-chart-kit';

import { useSharedSensorPipeline } from '../../hooks/SensorPipelineContext';
import { useBLE } from '../../functionality/BLEContext';
import { useAuth } from '../../auth/AuthContext';
import { getMinuteSummariesForRange } from '../../firebase/dataLogger';
import { memorySyncService } from '../../functionality/MemorySyncService';
import type { MinuteSummaryReading } from '../../firebase/sensorTypes';

const SCREEN_WIDTH = Dimensions.get('window').width;
const CHART_WIDTH = SCREEN_WIDTH - 64;
const LIVE_HISTORY_SIZE = 60;
const SLEEP_LOOKBACK_HOURS = 24;
const MAX_SLEEP_RECORD_GAP_MS = 90_000;

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
  temperature: number[];
};

const EMPTY_HISTORY: LiveHistory = {
  heartRate: [],
  hrv: [],
  temperature: [],
};

const appendLive = (values: number[], value: number) =>
  [...values, Number.isFinite(value) ? value : 0].slice(-LIVE_HISTORY_SIZE);

const displaySeries = (values: number[], fallback: number[]) => {
  if (values.length > 1) return values;
  if (values.length === 1) return [values[0], values[0]];
  return fallback;
};

const fixedRangeDataset = (min: number, max: number) => ({
  data: [min, max],
  color: () => 'rgba(0,0,0,0)',
  strokeWidth: 0,
});

const liveLabels = (count: number) =>
  Array.from({ length: Math.max(count, 2) }, (_, index) =>
    index === Math.max(count, 2) - 1 ? 'Now' : '',
  );

const deriveLatestSleepEpisodeMinutes = (
  rows: Array<MinuteSummaryReading & { id: string }>,
): number | null => {
  const timedRows = rows
    .map((row) => ({
      row,
      timestampMs: row.timestamp?.toMillis() ?? Number.NaN,
    }))
    .filter((item) => Number.isFinite(item.timestampMs))
    .sort((a, b) => a.timestampMs - b.timestampMs);

  if (timedRows.length === 0) return null;

  let currentRunMinutes = 0;
  let latestRunMinutes = 0;
  let previousSleepTimestampMs = 0;

  for (const item of timedRows) {
    const sleepState = (item.row.sleepState || '').trim().toUpperCase();

    if (sleepState !== 'SLEEP') {
      currentRunMinutes = 0;
      previousSleepTimestampMs = 0;
      continue;
    }

    const gapMs = previousSleepTimestampMs > 0
      ? item.timestampMs - previousSleepTimestampMs
      : Number.POSITIVE_INFINITY;

    const continuesPreviousRun =
      currentRunMinutes > 0 && gapMs > 0 && gapMs <= MAX_SLEEP_RECORD_GAP_MS;

    currentRunMinutes = continuesPreviousRun ? currentRunMinutes + 1 : 1;
    latestRunMinutes = currentRunMinutes;
    previousSleepTimestampMs = item.timestampMs;
  }

  return latestRunMinutes;
};

const formatSleepDuration = (minutes: number | null): string => {
  if (minutes === null) return 'No sleep history yet';

  const safeMinutes = Math.max(0, Math.floor(minutes));
  const hours = Math.floor(safeMinutes / 60);
  const mins = safeMinutes % 60;
  return `${hours}Hr ${String(mins).padStart(2, '0')}min`;
};

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
  children,
}: {
  accent: string;
  icon: string;
  title: string;
  subtitle: string;
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
    </View>
  );
}

export default function PhysiologicalInsightScreen() {
  const [history, setHistory] = useState<LiveHistory>(EMPTY_HISTORY);
  const [sleepDurationMinutes, setSleepDurationMinutes] = useState<number | null>(null);
  const [sleepHistoryLoading, setSleepHistoryLoading] = useState(true);
  const [sleepHistoryUnavailable, setSleepHistoryUnavailable] = useState(false);

  const { live } = useSharedSensorPipeline();
  const { isConnected } = useBLE();
  const { user } = useAuth();

  const lastCaptured = useRef({
    heartRate: 0,
    hrv: 0,
    temperature: 0,
  });

  useEffect(() => {
    const heartRateStamp = live.heartRate.lastUpdated?.getTime() ?? 0;
    const hrvStamp = live.hrv.lastUpdated?.getTime() ?? 0;
    const temperatureStamp = live.temperature.lastUpdated?.getTime() ?? 0;

    const heartRateChanged =
      heartRateStamp > lastCaptured.current.heartRate && live.heartRate.bpm > 0;
    const hrvChanged = hrvStamp > lastCaptured.current.hrv && live.hrv.rmssd_ms > 0;
    const temperatureChanged =
      temperatureStamp > lastCaptured.current.temperature &&
      Number.isFinite(live.temperature.tempC) &&
      live.temperature.tempC > 0;

    if (!heartRateChanged && !hrvChanged && !temperatureChanged) return;

    setHistory((prev) => ({
      heartRate: heartRateChanged
        ? appendLive(prev.heartRate, live.heartRate.bpm)
        : prev.heartRate,
      hrv: hrvChanged ? appendLive(prev.hrv, live.hrv.rmssd_ms) : prev.hrv,
      temperature: temperatureChanged
        ? appendLive(prev.temperature, live.temperature.tempC)
        : prev.temperature,
    }));

    if (heartRateChanged) lastCaptured.current.heartRate = heartRateStamp;
    if (hrvChanged) lastCaptured.current.hrv = hrvStamp;
    if (temperatureChanged) lastCaptured.current.temperature = temperatureStamp;
  }, [live.heartRate, live.hrv, live.temperature]);

  const loadSleepDuration = useCallback(async () => {
    if (!user?.uid) {
      setSleepDurationMinutes(null);
      setSleepHistoryLoading(false);
      setSleepHistoryUnavailable(false);
      return;
    }

    setSleepHistoryLoading(true);
    setSleepHistoryUnavailable(false);

    try {
      const end = new Date();
      const start = new Date(end.getTime() - SLEEP_LOOKBACK_HOURS * 60 * 60 * 1000);
      const rows = await getMinuteSummariesForRange(user.uid, start, end);
      setSleepDurationMinutes(deriveLatestSleepEpisodeMinutes(rows));
    } catch (error) {
      console.warn('[Physio] Could not load Algorithm V0 sleep history:', error);
      setSleepHistoryUnavailable(true);
    } finally {
      setSleepHistoryLoading(false);
    }
  }, [user?.uid]);

  useEffect(() => {
    void loadSleepDuration();
  }, [loadSleepDuration]);

  useEffect(() => {
    let previousPhase = memorySyncService.getState().phase;

    return memorySyncService.subscribe((state) => {
      const completedNow = previousPhase !== 'complete' && state.phase === 'complete';
      previousPhase = state.phase;

      if (completedNow) {
        void loadSleepDuration();
      }
    });
  }, [loadSleepDuration]);

  const hasFresh = (date: Date | null | undefined) =>
    Boolean(date && Date.now() - date.getTime() < 15000);

  const hrFresh = hasFresh(live.heartRate.lastUpdated);
  const hrvFresh = hasFresh(live.hrv.lastUpdated);
  const tempFresh = hasFresh(live.temperature.lastUpdated);

  const hrChartConfig = useMemo(() => makeChartConfig(COLORS.error, 0), []);
  const hrvChartConfig = useMemo(() => makeChartConfig('#7c3aed', 0), []);
  const tempChartConfig = useMemo(() => makeChartConfig('#f97316', 1), []);

  const hrChartData = useMemo(() => {
    const values = displaySeries(history.heartRate, [30, 30]);
    return {
      labels: liveLabels(values.length),
      datasets: [{ data: values }, fixedRangeDataset(30, 220)],
    };
  }, [history.heartRate]);

  const hrvChartData = useMemo(() => {
    const values = displaySeries(history.hrv, [0, 0]);
    return { labels: liveLabels(values.length), datasets: [{ data: values }] };
  }, [history.hrv]);

  const tempChartData = useMemo(() => {
    const values = displaySeries(history.temperature, [33, 33]);
    return {
      labels: liveLabels(values.length),
      datasets: [{ data: values }, fixedRangeDataset(33, 44)],
    };
  }, [history.temperature]);

  const sleepSubtitle = sleepHistoryLoading
    ? 'Loading sleep history…'
    : sleepHistoryUnavailable
      ? 'Sleep history unavailable'
      : formatSleepDuration(sleepDurationMinutes);

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.headerIconWrap}>
          <Ionicons name="stats-chart" size={22} color={COLORS.primary} />
        </View>
        <Text style={styles.headerTitle}>Physiological Insight</Text>
        <View
          style={[
            styles.connDot,
            { backgroundColor: isConnected ? COLORS.success : COLORS.error },
          ]}
        />
      </View>

      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.liveModeBanner}>
          <View
            style={[
              styles.connDot,
              { backgroundColor: isConnected ? COLORS.success : COLORS.textLight },
            ]}
          />
          <Text style={styles.liveModeText}>
            {isConnected
              ? 'Live physiological stream'
              : 'Connect wristband for live physiological data'}
          </Text>
        </View>

        <MetricCard
          accent={COLORS.error}
          icon="heart"
          title="Heart Rate"
          subtitle={
            hrFresh && live.heartRate.bpm > 0
              ? `${Math.round(live.heartRate.bpm)} bpm`
              : 'Waiting for a quality-approved beat'
          }
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
          accent="#7c3aed"
          icon="pulse"
          title="Heart Rate Variability"
          subtitle={
            hrvFresh && live.hrv.rmssd_ms > 0
              ? `${live.hrv.rmssd_ms.toFixed(1)} ms`
              : 'Waiting for enough accepted beat intervals'
          }
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
              ? `${live.activity.state} · ${Math.round(live.activity.confidence * 100)}% confidence`
              : 'Waiting for activity data'
          }
        >
          <View style={styles.activityContainer}>
            <Text style={styles.liveActivityState}>
              {live.activity.state !== 'UNKNOWN' ? live.activity.state : '--'}
            </Text>
            <Text style={styles.activityConfidence}>
              {live.activity.state !== 'UNKNOWN'
                ? `${Math.round(live.activity.confidence * 100)}% confidence`
                : 'No current classification'}
            </Text>
          </View>
        </MetricCard>

        <MetricCard
          accent="#f97316"
          icon="thermometer"
          title="Skin Temperature"
          subtitle={
            tempFresh && live.temperature.tempC > 0
              ? `${live.temperature.tempC.toFixed(1)}°C`
              : 'Waiting for temperature data'
          }
        >
          <PhysioChart
            data={tempChartData}
            width={CHART_WIDTH}
            height={180}
            chartConfig={tempChartConfig}
            bezier
          />
        </MetricCard>

        <MetricCard
          accent="#4f46e5"
          icon="moon"
          title="Sleep"
          subtitle={sleepSubtitle}
        >
          <View style={styles.sleepFutureCard}>
            <View style={styles.sleepFutureHeader}>
              <Text style={styles.sleepFutureTitle}>Sleep stages</Text>
              <View style={styles.comingSoonBadge}>
                <Text style={styles.comingSoonText}>Coming Soon</Text>
              </View>
            </View>

            <View style={styles.sleepPreviewArea}>
              <View style={[styles.sleepPreviewLine, { width: '92%' }]} />
              <View style={[styles.sleepPreviewLine, { width: '68%' }]} />
              <View style={[styles.sleepPreviewLine, { width: '80%' }]} />
            </View>

            <View style={styles.sleepLegendRow}>
              <Text style={styles.sleepLegendItem}>Awake</Text>
              <Text style={styles.sleepLegendItem}>REM</Text>
              <Text style={styles.sleepLegendItem}>Light</Text>
              <Text style={styles.sleepLegendItem}>Deep</Text>
            </View>
          </View>
        </MetricCard>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: COLORS.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  headerIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: COLORS.primary + '12',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: { flex: 1, fontSize: 20, fontWeight: '800', color: COLORS.text },
  connDot: { width: 10, height: 10, borderRadius: 5 },
  scroll: { flex: 1 },
  liveModeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  liveModeText: { fontSize: 12, color: COLORS.textSecondary, fontWeight: '600' },
  card: {
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    marginHorizontal: 16,
    marginBottom: 14,
    padding: 18,
    borderLeftWidth: 4,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.06,
        shadowRadius: 8,
      },
      android: { elevation: 3 },
    }),
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
    gap: 10,
  },
  cardIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: { fontSize: 15, fontWeight: '700', color: COLORS.text },
  cardSubtitle: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textSecondary,
    marginTop: 1,
  },
  chart: { borderRadius: 12, marginLeft: -8 },
  activityContainer: {
    borderRadius: 12,
    backgroundColor: '#f0fdfa',
    paddingVertical: 18,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  liveActivityState: { fontSize: 30, fontWeight: '900', color: COLORS.accent },
  activityConfidence: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textSecondary,
    marginTop: 4,
  },
  sleepFutureCard: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#c7d2fe',
    backgroundColor: '#f8f8ff',
    padding: 14,
  },
  sleepFutureHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  sleepFutureTitle: { fontSize: 13, fontWeight: '700', color: COLORS.text },
  comingSoonBadge: {
    backgroundColor: '#eef2ff',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  comingSoonText: { fontSize: 11, fontWeight: '800', color: '#4f46e5' },
  sleepPreviewArea: {
    height: 90,
    justifyContent: 'space-evenly',
    paddingHorizontal: 4,
    opacity: 0.55,
  },
  sleepPreviewLine: {
    height: 12,
    borderRadius: 6,
    backgroundColor: '#c7d2fe',
  },
  sleepLegendRow: {
    marginTop: 8,
    flexDirection: 'row',
    justifyContent: 'space-between',
    opacity: 0.55,
  },
  sleepLegendItem: { fontSize: 10, fontWeight: '700', color: COLORS.textSecondary },
});

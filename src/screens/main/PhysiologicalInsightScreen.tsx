import React, { useEffect, useRef, useState, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LineChart } from 'react-native-chart-kit';
import { useSharedSensorPipeline } from '../../hooks/SensorPipelineContext';
import { useBLE } from '../../functionality/BLEContext';
import PPGWaveformCard from '../../components/PPGWaveformCard';

// ─── Memoized PhysioChart Component ───────────────────────────────────────────
const PhysioChart = React.memo(({ data, chartConfig, width, height, bezier }: {
  data: any;
  chartConfig: any;
  width: number;
  height: number;
  bezier?: boolean;
}) => {
  return (
    <LineChart
      data={data}
      width={width}
      height={height}
      chartConfig={chartConfig}
      bezier={bezier}
      style={styles.chart}
      withInnerLines={true}
      withOuterLines={true}
      withVerticalLines={false}
      withDots={false}
    />
  );
});

// ─── Constants ────────────────────────────────────────────────────────────────
const SCREEN_WIDTH = Dimensions.get('window').width;
const CHART_WIDTH = SCREEN_WIDTH - 64;
const LIVE_HISTORY_SIZE = 60;

type LiveHistory = {
  labels: string[];
  heartRate: number[];
  hrv: number[];
  temperature: number[];
  eda: number[];
  ppgGreen: number[];
  ppgIr: number[];
  ppgRed: number[];
  accelX: number[];
  accelY: number[];
  accelZ: number[];
  gyroX: number[];
  gyroY: number[];
  gyroZ: number[];
};

const EMPTY_HISTORY: LiveHistory = {
  labels: [],
  heartRate: [],
  hrv: [],
  temperature: [],
  eda: [],
  ppgGreen: [],
  ppgIr: [],
  ppgRed: [],
  accelX: [],
  accelY: [],
  accelZ: [],
  gyroX: [],
  gyroY: [],
  gyroZ: [],
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
  warning: '#f59e0b',
};

type TimeRange = 'Day' | 'Week' | 'Month' | 'Year';

// ─── Dummy Data Per Time Range ────────────────────────────────────────────────
const DUMMY_DATA: Record<TimeRange, {
  hr: number[];
  hrv: number[];
  temp: number[];
  eda: number[];
  hrLabels: string[];
  hrvLabels: string[];
  tempLabels: string[];
  edaLabels: string[];
}> = {
  Day: {
    hr: [68, 72, 75, 71, 69, 74, 78, 72],
    hrv: [40, 45, 42, 50, 47, 43],
    temp: [36.2, 36.5, 36.4, 36.6],
    eda: [2.1, 2.4, 2.3, 2.7],
    hrLabels: ['6a', '9a', '12p', '3p', '6p', '9p', '12a', '3a'],
    hrvLabels: ['6a', '10a', '2p', '6p', '10p', '2a'],
    tempLabels: ['Morning', 'Noon', 'Eve', 'Night'],
    edaLabels: ['Morning', 'Noon', 'Eve', 'Night'],
  },
  Week: {
    hr: [70, 73, 68, 75, 71, 74, 72],
    hrv: [42, 48, 39, 46, 51, 44, 47],
    temp: [36.3, 36.4, 36.5, 36.3, 36.6, 36.4, 36.5],
    eda: [2.2, 2.5, 2.1, 2.6, 2.3, 2.4, 2.2],
    hrLabels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    hrvLabels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    tempLabels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    edaLabels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  },
  Month: {
    hr: [71, 73, 70, 74],
    hrv: [44, 46, 43, 48],
    temp: [36.3, 36.5, 36.4, 36.4],
    eda: [2.2, 2.4, 2.3, 2.3],
    hrLabels: ['Wk1', 'Wk2', 'Wk3', 'Wk4'],
    hrvLabels: ['Wk1', 'Wk2', 'Wk3', 'Wk4'],
    tempLabels: ['Wk1', 'Wk2', 'Wk3', 'Wk4'],
    edaLabels: ['Wk1', 'Wk2', 'Wk3', 'Wk4'],
  },
  Year: {
    hr: [72, 71, 73, 70, 74, 72, 71, 73, 75, 72, 70, 71],
    hrv: [43, 45, 44, 46, 42, 48, 45, 44, 47, 43, 46, 45],
    temp: [36.3, 36.4, 36.5, 36.4, 36.3, 36.5, 36.6, 36.4, 36.3, 36.5, 36.4, 36.4],
    eda: [2.2, 2.3, 2.4, 2.3, 2.1, 2.5, 2.3, 2.2, 2.4, 2.3, 2.2, 2.3],
    hrLabels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    hrvLabels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    tempLabels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    edaLabels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  },
};

const ACTIVITY_DATA = [
  { label: 'Sedentary', duration: '5h 30min', fraction: 0.69, color: COLORS.textLight },
  { label: 'Light Active', duration: '1h 45min', fraction: 0.22, color: COLORS.accent },
  { label: 'Fair Active', duration: '0h 40min', fraction: 0.08, color: '#2B6E8F' },
  { label: 'Very Active', duration: '0h 15min', fraction: 0.02, color: COLORS.primary },
];

// ─── Shared Chart Config ──────────────────────────────────────────────────────
function makeChartConfig(color: string, decimalPlaces: number = 1) {
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
      strokeDasharray: '4 4', // clean, premium dashed grid lines
      stroke: COLORS.border,
      strokeWidth: 1,
    },
    style: {
      borderRadius: 12,
    },
  };
}

// ─── MetricCard ───────────────────────────────────────────────────────────────
interface MetricCardProps {
  accent: string;
  icon: string;
  title: string;
  subtitle: string;
  description?: string;
  children: React.ReactNode;
}

function MetricCard({ accent, icon, title, subtitle, description, children }: MetricCardProps) {
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
      {description ? (
        <Text style={styles.cardDescription}>{description}</Text>
      ) : null}
    </View>
  );
}

// ─── ComingSoonCard ───────────────────────────────────────────────────────────
function ComingSoonCard({ title, icon }: { title: string; icon: string }) {
  return (
    <View style={styles.comingSoonCard}>
      <View style={styles.comingSoonContent}>
        <View style={styles.comingSoonIconWrap}>
          <Ionicons name={icon as any} size={22} color={COLORS.textLight} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.comingSoonTitle}>{title}</Text>
          <View style={styles.comingSoonBadge}>
            <Ionicons name="lock-closed" size={11} color={COLORS.textLight} />
            <Text style={styles.comingSoonText}>Coming Soon</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

// ─── ActivityBar ──────────────────────────────────────────────────────────────
function ActivityBar({ label, duration, fraction, color }: {
  label: string;
  duration: string;
  fraction: number;
  color: string;
}) {
  return (
    <View style={styles.activityRow}>
      <Text style={styles.activityLabel}>{label}</Text>
      <View style={styles.activityTrack}>
        <View
          style={[
            styles.activityFill,
            { width: `${Math.max(fraction * 100, 3)}%`, backgroundColor: color },
          ]}
        />
      </View>
      <Text style={styles.activityDuration}>{duration}</Text>
    </View>
  );
}

// ─── Main Screen ──────────────────────────────────────────────────────────────
export default function PhysiologicalInsightScreen() {
  const [timeRange, setTimeRange] = useState<TimeRange>('Day');
  const [history, setHistory] = useState<LiveHistory>(EMPTY_HISTORY);
  const { live } = useSharedSensorPipeline();
  const { isConnected } = useBLE();
  const lastCaptured = useRef({
    ppg: 0,
    heartRate: 0,
    hrv: 0,
    temperature: 0,
    eda: 0,
    imu: 0,
  });

  const data = DUMMY_DATA[timeRange];

  // Capture each new device sample once. Histories are bounded, so the charts
  // remain responsive even when the wristband runs for hours.
  useEffect(() => {
    const stamps = {
      ppg: live.ppg.lastUpdated?.getTime() ?? 0,
      heartRate: live.heartRate.lastUpdated?.getTime() ?? 0,
      hrv: live.hrv.lastUpdated?.getTime() ?? 0,
      temperature: live.temperature.lastUpdated?.getTime() ?? 0,
      eda: live.eda.lastUpdated?.getTime() ?? 0,
      imu: Math.max(
        live.accel.lastUpdated?.getTime() ?? 0,
        live.gyro.lastUpdated?.getTime() ?? 0,
      ),
    };

    const changed = {
      ppg: stamps.ppg > lastCaptured.current.ppg,
      heartRate: stamps.heartRate > lastCaptured.current.heartRate && live.heartRate.bpm > 0,
      hrv: stamps.hrv > lastCaptured.current.hrv && live.hrv.rmssd_ms > 0,
      temperature: stamps.temperature > lastCaptured.current.temperature,
      eda: stamps.eda > lastCaptured.current.eda,
      imu: stamps.imu > lastCaptured.current.imu,
    };

    if (!Object.values(changed).some(Boolean)) return;

    setHistory(prev => {
      const next = { ...prev };
      if (changed.ppg) {
        next.ppgGreen = appendLive(prev.ppgGreen, live.ppg.green);
        next.ppgIr = appendLive(prev.ppgIr, live.ppg.ir);
        next.ppgRed = appendLive(prev.ppgRed, live.ppg.red);
      }
      if (changed.heartRate) next.heartRate = appendLive(prev.heartRate, live.heartRate.bpm);
      if (changed.hrv) next.hrv = appendLive(prev.hrv, live.hrv.rmssd_ms);
      if (changed.temperature) next.temperature = appendLive(prev.temperature, live.temperature.tempC);
      if (changed.eda) next.eda = appendLive(prev.eda, live.eda.conductance_uS);
      if (changed.imu) {
        next.accelX = appendLive(prev.accelX, live.accel.x);
        next.accelY = appendLive(prev.accelY, live.accel.y);
        next.accelZ = appendLive(prev.accelZ, live.accel.z);
        next.gyroX = appendLive(prev.gyroX, live.gyro.x);
        next.gyroY = appendLive(prev.gyroY, live.gyro.y);
        next.gyroZ = appendLive(prev.gyroZ, live.gyro.z);
      }
      return next;
    });

    (Object.keys(stamps) as Array<keyof typeof stamps>).forEach(key => {
      if (stamps[key] > lastCaptured.current[key]) {
        lastCaptured.current[key] = stamps[key];
      }
    });
  }, [live]);

  const hasFresh = (date: Date | null) => {
    if (!date) return false;
    return Date.now() - date.getTime() < 15000;
  };

  const ppgFresh = hasFresh(live?.ppg?.lastUpdated ?? null);
  const hrFresh = hasFresh(live?.heartRate?.lastUpdated ?? null);
  const tempFresh = hasFresh(live?.temperature?.lastUpdated ?? null);
  const edaFresh = hasFresh(live?.eda?.lastUpdated ?? null);

  const currentHR = hrFresh && live?.heartRate?.bpm && live.heartRate.bpm > 0
    ? `${Math.round(live.heartRate.bpm)} bpm`
    : '-- bpm';

  const isHrLive = Boolean(hrFresh && live?.heartRate?.bpm && live.heartRate.bpm > 0);

  // Memoized Chart Configs to prevent re-creation and CPU spikes
  const hrChartConfig = useMemo(() => makeChartConfig(COLORS.error, 0), []);
  const hrvChartConfig = useMemo(() => makeChartConfig('#f97316', 0), []);
  const tempChartConfig = useMemo(() => makeChartConfig('#f97316', 1), []);
  const edaChartConfig = useMemo(() => makeChartConfig(COLORS.accent, 1), []);
  const ppgChartConfig = useMemo(() => makeChartConfig('#10b981', 0), []);
  const imuChartConfig = useMemo(() => makeChartConfig('#2563eb', 0), []);
  const gyroChartConfig = useMemo(() => makeChartConfig('#7c3aed', 0), []);

  // Memoized Chart Data objects to avoid re-rendering
  const hrChartData = useMemo(() => ({
    labels: timeRange === 'Day'
      ? liveLabels(displaySeries(history.heartRate, [0, 0]).length)
      : data.hrLabels,
    datasets: [{ data: timeRange === 'Day' ? displaySeries(history.heartRate, [0, 0]) : data.hr }],
  }), [data.hrLabels, data.hr, history.heartRate, timeRange]);

  const hrvChartData = useMemo(() => ({
    labels: timeRange === 'Day'
      ? liveLabels(displaySeries(history.hrv, [0, 0]).length)
      : data.hrvLabels,
    datasets: [{ data: timeRange === 'Day' ? displaySeries(history.hrv, [0, 0]) : data.hrv }],
  }), [data.hrvLabels, data.hrv, history.hrv, timeRange]);

  const tempChartData = useMemo(() => ({
    labels: timeRange === 'Day'
      ? liveLabels(displaySeries(history.temperature, [0, 0]).length)
      : data.tempLabels,
    datasets: [{ data: timeRange === 'Day' ? displaySeries(history.temperature, [0, 0]) : data.temp }],
  }), [data.tempLabels, data.temp, history.temperature, timeRange]);

  const edaChartData = useMemo(() => ({
    labels: timeRange === 'Day'
      ? liveLabels(displaySeries(history.eda, [0, 0]).length)
      : data.edaLabels,
    datasets: [{ data: timeRange === 'Day' ? displaySeries(history.eda, [0, 0]) : data.eda }],
  }), [data.edaLabels, data.eda, history.eda, timeRange]);

  const ppgChartData = useMemo(() => {
    const green = displaySeries(history.ppgGreen, [0, 0]);
    const datasets = [{ data: green, color: () => '#10b981' }];
    const legend = ['Green'];
    if (history.ppgIr.some(value => value > 0)) {
      datasets.push({ data: displaySeries(history.ppgIr, [0, 0]), color: () => '#7c3aed' });
      legend.push('IR');
    }
    if (history.ppgRed.some(value => value > 0)) {
      datasets.push({ data: displaySeries(history.ppgRed, [0, 0]), color: () => '#ef4444' });
      legend.push('Red');
    }
    return {
      labels: liveLabels(green.length),
      datasets,
      legend,
    };
  }, [history.ppgGreen, history.ppgIr, history.ppgRed]);

  const accelChartData = useMemo(() => {
    const x = displaySeries(history.accelX, [0, 0]);
    return {
      labels: liveLabels(x.length),
      datasets: [
        { data: x, color: () => '#2563eb' },
        { data: displaySeries(history.accelY, [0, 0]), color: () => '#10b981' },
        { data: displaySeries(history.accelZ, [0, 0]), color: () => '#f59e0b' },
      ],
      legend: ['X', 'Y', 'Z'],
    };
  }, [history.accelX, history.accelY, history.accelZ]);

  const gyroChartData = useMemo(() => {
    const x = displaySeries(history.gyroX, [0, 0]);
    return {
      labels: liveLabels(x.length),
      datasets: [
        { data: x, color: () => '#2563eb' },
        { data: displaySeries(history.gyroY, [0, 0]), color: () => '#10b981' },
        { data: displaySeries(history.gyroZ, [0, 0]), color: () => '#f59e0b' },
      ],
      legend: ['X', 'Y', 'Z'],
    };
  }, [history.gyroX, history.gyroY, history.gyroZ]);

  return (
    <SafeAreaView style={styles.safeArea}>
      {/* Header */}
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
        {/* Time Range Tabs */}
        <View style={styles.timeTabsWrap}>
          {(['Day', 'Week', 'Month', 'Year'] as TimeRange[]).map((range) => {
            const active = timeRange === range;
            return (
              <TouchableOpacity
                key={range}
                style={[styles.timeTab, active && styles.timeTabActive]}
                onPress={() => setTimeRange(range)}
              >
                <Text
                  style={[styles.timeTabText, active && styles.timeTabTextActive]}
                >
                  {range}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ── Real-time PPG Waveform Display (New Feature) ── */}
        <View style={{ paddingHorizontal: 16, marginBottom: 14 }}>
          <PPGWaveformCard
            filtSamples={live.ppgStream.filt}
            thSamples={live.ppgStream.th}
            peakFlags={live.ppgStream.peaks}
            hrBpm={live.heartRate.bpm}
            confidence={live.heartRate.confidence}
            sqi={live.ppgQuality.sqi}
            artifact={live.ppgQuality.artifact}
            qualityOk={live.ppgQuality.qualityOk}
            wearDetected={live.ppgQuality.wearDetected}
            ibi_ms={live.heartRate.ibi_ms}
          />
        </View>

        {/* ── Heart Rate ─────────────────────────────────────────────────── */}
        <MetricCard
          accent="#10b981"
          icon="pulse"
          title="PPG Channels"
          subtitle={ppgFresh
            ? 'Green ' + Math.round(live.ppg.green).toLocaleString()
              + ' / IR ' + Math.round(live.ppg.ir).toLocaleString()
              + ' / Red ' + Math.round(live.ppg.red).toLocaleString()
            : 'Waiting for MAX30101 data'}
          description="Raw 18-bit MAX30101 channels. Green is present in the normal firmware stream; IR and red appear when those LEDs are enabled."
        >
          <PhysioChart
            data={ppgChartData}
            width={CHART_WIDTH}
            height={190}
            chartConfig={ppgChartConfig}
          />
        </MetricCard>

        <MetricCard
          accent={COLORS.error}
          icon="heart"
          title="Heart Rate"
          subtitle={isHrLive ? currentHR + ' (Live)' : 'Waiting for a quality-approved beat'}
          description="Average resting heart rate over the selected period."
        >
          <PhysioChart
            data={hrChartData}
            width={CHART_WIDTH}
            height={180}
            chartConfig={hrChartConfig}
            bezier
          />
        </MetricCard>

        {/* ── Heart Rate Variability ──────────────────────────────────────── */}
        <MetricCard
          accent="#f97316"
          icon="pulse"
          title="Heart Rate Variability"
          subtitle={live.hrv.rmssd_ms > 0 ? live.hrv.rmssd_ms.toFixed(1) + ' ms (Live)' : 'Waiting for 1-minute HRV summary'}
          description="Higher HRV generally indicates better cardiovascular fitness and stress resilience."
        >
          <PhysioChart
            data={hrvChartData}
            width={CHART_WIDTH}
            height={180}
            chartConfig={hrvChartConfig}
            bezier
          />
        </MetricCard>

        {/* ── Activity Insight ────────────────────────────────────────────── */}
        <MetricCard
          accent="#2563eb"
          icon="move"
          title="Accelerometer"
          subtitle={hasFresh(live.accel.lastUpdated)
            ? 'X ' + live.accel.x.toFixed(0) + ' / Y ' + live.accel.y.toFixed(0)
              + ' / Z ' + live.accel.z.toFixed(0) + ' mg'
            : 'Waiting for LSM6DSO data'}
          description="Live wrist acceleration in milli-g from the LSM6DSO."
        >
          <PhysioChart
            data={accelChartData}
            width={CHART_WIDTH}
            height={190}
            chartConfig={imuChartConfig}
          />
        </MetricCard>

        <MetricCard
          accent="#7c3aed"
          icon="sync"
          title="Gyroscope"
          subtitle={hasFresh(live.gyro.lastUpdated)
            ? 'X ' + live.gyro.x.toFixed(0) + ' / Y ' + live.gyro.y.toFixed(0)
              + ' / Z ' + live.gyro.z.toFixed(0) + ' mdps'
            : 'Waiting for LSM6DSO data'}
          description="Live angular velocity in milli-degrees per second from the LSM6DSO."
        >
          <PhysioChart
            data={gyroChartData}
            width={CHART_WIDTH}
            height={190}
            chartConfig={gyroChartConfig}
          />
        </MetricCard>

        <MetricCard
          accent={COLORS.accent}
          icon="fitness"
          title="Activity Insight"
          subtitle={live.activity.state !== 'UNKNOWN'
            ? live.activity.state + ' / ' + Math.round(live.activity.confidence * 100) + '% confidence'
            : 'Waiting for firmware activity summary'}
          description="Movement breakdown based on wristband accelerometer and gyroscope data."
        >
          <View style={styles.activityContainer}>
            <Text style={styles.cardDescription}>
              Acceleration magnitude: {live.accel.magnitude.toFixed(0)} mg
            </Text>
            <Text style={styles.cardDescription}>
              Angular velocity magnitude: {live.gyro.magnitude.toFixed(0)} mdps
            </Text>
          </View>
        </MetricCard>

        {/* ── Skin Temperature ────────────────────────────────────────────── */}
        <MetricCard
          accent="#f97316"
          icon="thermometer"
          title="Skin Temperature"
          subtitle={tempFresh ? live.temperature.tempC.toFixed(1) + '°C (Live)' : 'Waiting for temperature data'}
          description="Skin temperature trends can reveal circadian rhythm patterns and early signs of illness."
        >
          <PhysioChart
            data={tempChartData}
            width={CHART_WIDTH}
            height={180}
            chartConfig={tempChartConfig}
            bezier
          />
        </MetricCard>

        {/* ── Electrodermal Activity ──────────────────────────────────────── */}
        <MetricCard
          accent={COLORS.accent}
          icon="flash"
          title="Electrodermal Activity"
          subtitle={edaFresh ? live.eda.conductance_uS.toFixed(1) + ' µS (Live)' : 'Waiting for EDA data'}
          description="EDA reflects sympathetic nervous system arousal — useful for stress and emotional monitoring."
        >
          <PhysioChart
            data={edaChartData}
            width={CHART_WIDTH}
            height={180}
            chartConfig={edaChartConfig}
            bezier
          />
        </MetricCard>

        {/* ── Coming Soon Cards ───────────────────────────────────────────── */}
        <ComingSoonCard title="Blood Pressure & SpO2" icon="water" />
        <ComingSoonCard title="Sleep Insight" icon="moon" />

        {/* ── Overall Wellness Score ──────────────────────────────────────── */}
        <View style={styles.scoreCard}>
          <View style={styles.scoreCircle}>
            <Text style={styles.scoreValue}>74</Text>
            <Text style={styles.scoreDenom}>/100</Text>
          </View>
          <Text style={styles.scoreLabel}>Overall Wellness Score</Text>
          <Text style={styles.scoreDescription}>
            Based on heart rate, HRV, activity, temperature, and EDA trends.
          </Text>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.background,
  },

  // Header
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
  headerTitle: {
    flex: 1,
    fontSize: 20,
    fontWeight: '800',
    color: COLORS.text,
  },
  connDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },

  scroll: {
    flex: 1,
  },

  // Time Range Tabs
  timeTabsWrap: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 12,
    backgroundColor: COLORS.border,
    borderRadius: 12,
    padding: 4,
    gap: 4,
  },
  timeTab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timeTabActive: {
    backgroundColor: COLORS.surface,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08,
        shadowRadius: 4,
      },
      android: { elevation: 2 },
    }),
  },
  timeTabText: {
    fontSize: 13,
    color: COLORS.textSecondary,
    fontWeight: '600',
  },
  timeTabTextActive: {
    color: COLORS.primary,
    fontWeight: '800',
  },

  // Metric Card
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
  cardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.text,
  },
  cardSubtitle: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textSecondary,
    marginTop: 1,
  },
  cardDescription: {
    fontSize: 11,
    color: COLORS.textLight,
    lineHeight: 16,
    marginTop: 10,
  },

  // Chart
  chart: {
    borderRadius: 12,
    marginLeft: -8,
  },

  // Activity Insight
  activityContainer: {
    gap: 10,
  },
  activityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  activityLabel: {
    width: 90,
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.text,
  },
  activityTrack: {
    flex: 1,
    height: 10,
    backgroundColor: COLORS.border,
    borderRadius: 5,
    overflow: 'hidden',
  },
  activityFill: {
    height: '100%',
    borderRadius: 5,
  },
  activityDuration: {
    width: 72,
    fontSize: 11,
    fontWeight: '600',
    color: COLORS.textSecondary,
    textAlign: 'right',
  },

  // Coming Soon Card
  comingSoonCard: {
    marginHorizontal: 16,
    marginBottom: 14,
    borderRadius: 16,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface + 'AA',
    padding: 18,
    opacity: 0.65,
  },
  comingSoonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  comingSoonIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: COLORS.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  comingSoonTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: COLORS.textLight,
  },
  comingSoonBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 4,
  },
  comingSoonText: {
    fontSize: 12,
    fontWeight: '600',
    color: COLORS.textLight,
  },

  // Score Card
  scoreCard: {
    marginHorizontal: 16,
    marginBottom: 14,
    borderRadius: 16,
    backgroundColor: COLORS.surface,
    padding: 24,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: COLORS.accent,
    ...Platform.select({
      ios: {
        shadowColor: COLORS.accent,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.15,
        shadowRadius: 12,
      },
      android: { elevation: 4 },
    }),
  },
  scoreCircle: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginBottom: 8,
  },
  scoreValue: {
    fontSize: 56,
    fontWeight: '900',
    color: COLORS.accent,
    lineHeight: 64,
  },
  scoreDenom: {
    fontSize: 22,
    fontWeight: '700',
    color: COLORS.textLight,
    marginBottom: 8,
    lineHeight: 64,
  },
  scoreLabel: {
    fontSize: 16,
    fontWeight: '700',
    color: COLORS.text,
    marginBottom: 4,
  },
  scoreDescription: {
    fontSize: 12,
    color: COLORS.textSecondary,
    textAlign: 'center',
    lineHeight: 18,
  },
});

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Dimensions,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LineChart } from 'react-native-chart-kit';

import { useDevMode, SensorKey } from '../../functionality/DevModeContext';
import { useSharedSensorPipeline } from '../../hooks/SensorPipelineContext';
import { useBLE } from '../../functionality/BLEContext';

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
  ppgGreen: number[];
  ppgIr: number[];
  ppgRed: number[];
  accelX: number[];
  accelY: number[];
  accelZ: number[];
  gyroX: number[];
  gyroY: number[];
  gyroZ: number[];
  temperature: number[];
  eda: number[];
};

const EMPTY_HISTORY: LiveHistory = {
  ppgGreen: [],
  ppgIr: [],
  ppgRed: [],
  accelX: [],
  accelY: [],
  accelZ: [],
  gyroX: [],
  gyroY: [],
  gyroZ: [],
  temperature: [],
  eda: [],
};

const appendLive = (values: number[], value: number) =>
  [...values, Number.isFinite(value) ? value : 0].slice(-LIVE_HISTORY_SIZE);

const displaySeries = (values: number[], fallback: number[] = [0, 0]) => {
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
    style: {
      borderRadius: 12,
    },
  };
}

const PhysioChart = React.memo(({
  data,
  chartConfig,
  width,
  height,
}: {
  data: any;
  chartConfig: any;
  width: number;
  height: number;
}) => (
  <LineChart
    data={data}
    width={width}
    height={height}
    chartConfig={chartConfig}
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

      {description ? (
        <Text style={styles.cardDescription}>{description}</Text>
      ) : null}
    </View>
  );
}

export default function SensorTabScreen() {
  const { isDevMode, sensorToggles } = useDevMode();
  const { live } = useSharedSensorPipeline();
  const { isConnected } = useBLE();

  const [history, setHistory] = useState<LiveHistory>(EMPTY_HISTORY);

  const lastCaptured = useRef({
    ppg: 0,
    accel: 0,
    gyro: 0,
    temp: 0,
    eda: 0,
  });

  const hasFresh = useCallback((date: Date | null | undefined) => {
    if (!date) return false;
    return Date.now() - date.getTime() < 15_000;
  }, []);

  useEffect(() => {
    if (!isConnected) return;

    const ppgTs = live.ppg.lastUpdated?.getTime() ?? 0;
    const accelTs = live.accel.lastUpdated?.getTime() ?? 0;
    const gyroTs = live.gyro.lastUpdated?.getTime() ?? 0;
    const tempTs = live.temperature.lastUpdated?.getTime() ?? 0;
    const edaTs = live.eda.lastUpdated?.getTime() ?? 0;

    const ppgChanged = ppgTs > lastCaptured.current.ppg;
    const accelChanged = accelTs > lastCaptured.current.accel;
    const gyroChanged = gyroTs > lastCaptured.current.gyro;
    const tempChanged = tempTs > lastCaptured.current.temp;
    const edaChanged = edaTs > lastCaptured.current.eda;

    if (!ppgChanged && !accelChanged && !gyroChanged && !tempChanged && !edaChanged) {
      return;
    }

    setHistory((prev) => {
      const next = { ...prev };

      if (ppgChanged) {
        next.ppgGreen = appendLive(prev.ppgGreen, live.ppg.green);
        next.ppgIr = appendLive(prev.ppgIr, live.ppg.ir);
        next.ppgRed = appendLive(prev.ppgRed, live.ppg.red);
      }

      if (accelChanged) {
        if (live.imuStream.timestamps.length) {
          next.accelX = live.imuStream.ax_g.slice(-LIVE_HISTORY_SIZE);
          next.accelY = live.imuStream.ay_g.slice(-LIVE_HISTORY_SIZE);
          next.accelZ = live.imuStream.az_g.slice(-LIVE_HISTORY_SIZE);
        } else {
          next.accelX = appendLive(prev.accelX, live.accel.x / 1000);
          next.accelY = appendLive(prev.accelY, live.accel.y / 1000);
          next.accelZ = appendLive(prev.accelZ, live.accel.z / 1000);
        }
      }

      if (gyroChanged) {
        if (live.imuStream.timestamps.length) {
          next.gyroX = live.imuStream.gx_dps.slice(-LIVE_HISTORY_SIZE);
          next.gyroY = live.imuStream.gy_dps.slice(-LIVE_HISTORY_SIZE);
          next.gyroZ = live.imuStream.gz_dps.slice(-LIVE_HISTORY_SIZE);
        } else {
          next.gyroX = appendLive(prev.gyroX, live.gyro.x / 1000);
          next.gyroY = appendLive(prev.gyroY, live.gyro.y / 1000);
          next.gyroZ = appendLive(prev.gyroZ, live.gyro.z / 1000);
        }
      }

      if (tempChanged) {
        next.temperature = live.temperatureStream.values_c.length
          ? live.temperatureStream.values_c.slice(-LIVE_HISTORY_SIZE)
          : appendLive(prev.temperature, live.temperature.tempC);
      }

      if (edaChanged) {
        next.eda = live.edaStream.values_uS.length
          ? live.edaStream.values_uS.slice(-LIVE_HISTORY_SIZE)
          : appendLive(prev.eda, live.eda.conductance_uS);
      }

      return next;
    });

    if (ppgChanged) lastCaptured.current.ppg = ppgTs;
    if (accelChanged) lastCaptured.current.accel = accelTs;
    if (gyroChanged) lastCaptured.current.gyro = gyroTs;
    if (tempChanged) lastCaptured.current.temp = tempTs;
    if (edaChanged) lastCaptured.current.eda = edaTs;
  }, [isConnected, live]);

  const ppgChartConfig = useMemo(() => makeChartConfig('#10b981', 0), []);
  const accelChartConfig = useMemo(() => makeChartConfig('#2563eb', 3), []);
  const gyroChartConfig = useMemo(() => makeChartConfig('#7c3aed', 2), []);
  const tempChartConfig = useMemo(() => makeChartConfig('#f97316', 1), []);
  const edaChartConfig = useMemo(() => makeChartConfig(COLORS.accent, 1), []);

  const ppgChartData = useMemo(() => {
    const datasets: any[] = [];
    const legend: string[] = [];

    if (sensorToggles.ppgGreen) {
      datasets.push({
        data: displaySeries(history.ppgGreen),
        color: () => '#10b981',
      });
      legend.push('Green');
    }

    if (sensorToggles.ppgIR) {
      datasets.push({
        data: displaySeries(history.ppgIr),
        color: () => '#7c3aed',
      });
      legend.push('IR');
    }

    if (sensorToggles.ppgRed) {
      datasets.push({
        data: displaySeries(history.ppgRed),
        color: () => '#ef4444',
      });
      legend.push('Red');
    }

    const maxLen = Math.max(
      history.ppgGreen.length,
      history.ppgIr.length,
      history.ppgRed.length,
      2,
    );

    return {
      labels: liveLabels(maxLen),
      datasets: datasets.length ? datasets : [{ data: [0, 0] }],
      legend,
    };
  }, [
    history.ppgGreen,
    history.ppgIr,
    history.ppgRed,
    sensorToggles.ppgGreen,
    sensorToggles.ppgIR,
    sensorToggles.ppgRed,
  ]);

  const accelChartData = useMemo(() => {
    const x = displaySeries(history.accelX);
    return {
      labels: liveLabels(x.length),
      datasets: [
        { data: x, color: () => '#2563eb' },
        { data: displaySeries(history.accelY), color: () => '#10b981' },
        { data: displaySeries(history.accelZ), color: () => '#f59e0b' },
      ],
      legend: ['X', 'Y', 'Z'],
    };
  }, [history.accelX, history.accelY, history.accelZ]);

  const gyroChartData = useMemo(() => {
    const x = displaySeries(history.gyroX);
    return {
      labels: liveLabels(x.length),
      datasets: [
        { data: x, color: () => '#2563eb' },
        { data: displaySeries(history.gyroY), color: () => '#10b981' },
        { data: displaySeries(history.gyroZ), color: () => '#f59e0b' },
      ],
      legend: ['X', 'Y', 'Z'],
    };
  }, [history.gyroX, history.gyroY, history.gyroZ]);

  const tempChartData = useMemo(() => {
    const values = displaySeries(history.temperature);
    return {
      labels: liveLabels(values.length),
      datasets: [{ data: values }],
    };
  }, [history.temperature]);

  const edaChartData = useMemo(() => {
    const values = displaySeries(history.eda);
    return {
      labels: liveLabels(values.length),
      datasets: [{ data: values }],
    };
  }, [history.eda]);

  const anyPpgEnabled =
    sensorToggles.ppgGreen || sensorToggles.ppgIR || sensorToggles.ppgRed;

  if (!isDevMode) {
    return (
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <View style={styles.lockedContainer}>
          <Ionicons name="lock-closed-outline" size={48} color={COLORS.textLight} />
          <Text style={styles.lockedTitle}>Developer Mode Required</Text>
          <Text style={styles.lockedSubtitle}>
            Enable Developer Mode in Settings to access raw sensor graphs.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.header}>
        <View style={styles.headerTitleRow}>
          <Text style={styles.headerTitle}>Sensor Data</Text>
          <View style={styles.devBadge}>
            <Text style={styles.devBadgeText}>DEV</Text>
          </View>
        </View>

        <View style={styles.connectionRow}>
          <View
            style={[
              styles.connectionDot,
              { backgroundColor: isConnected ? COLORS.success : COLORS.textLight },
            ]}
          />
          <Text style={styles.connectionText}>
            {isConnected ? 'Wristband Connected' : 'Wristband Not Connected'}
          </Text>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {anyPpgEnabled && (
          <MetricCard
            accent="#10b981"
            icon="pulse"
            title="PPG Channels"
            subtitle={
              hasFresh(live.ppg.lastUpdated)
                ? `Green ${Math.round(live.ppg.green).toLocaleString()} / IR ${Math.round(
                    live.ppg.ir,
                  ).toLocaleString()} / Red ${Math.round(live.ppg.red).toLocaleString()}`
                : 'Waiting for MAX30101 data'
            }
            description="Raw MAX30101 PPG channels. Channel visibility follows Developer Settings."
          >
            <PhysioChart
              data={ppgChartData}
              width={CHART_WIDTH}
              height={190}
              chartConfig={ppgChartConfig}
            />
          </MetricCard>
        )}

        {sensorToggles.accel && (
          <MetricCard
            accent="#2563eb"
            icon="move"
            title="Accelerometer"
            subtitle={
              hasFresh(live.accel.lastUpdated)
                ? `X ${(live.accel.x / 1000).toFixed(3)} / Y ${(live.accel.y / 1000).toFixed(
                    3,
                  )} / Z ${(live.accel.z / 1000).toFixed(3)} g`
                : 'Waiting for LSM6DSO data'
            }
            description="Direct compact wrist acceleration in g, matching the previous Physiological developer graph."
          >
            <PhysioChart
              data={accelChartData}
              width={CHART_WIDTH}
              height={190}
              chartConfig={accelChartConfig}
            />
          </MetricCard>
        )}

        {sensorToggles.gyro && (
          <MetricCard
            accent="#7c3aed"
            icon="sync"
            title="Gyroscope"
            subtitle={
              hasFresh(live.gyro.lastUpdated)
                ? `X ${(live.gyro.x / 1000).toFixed(2)} / Y ${(live.gyro.y / 1000).toFixed(
                    2,
                  )} / Z ${(live.gyro.z / 1000).toFixed(2)} dps`
                : 'Waiting for LSM6DSO data'
            }
            description="Direct compact angular velocity in dps, matching the previous Physiological developer graph."
          >
            <PhysioChart
              data={gyroChartData}
              width={CHART_WIDTH}
              height={190}
              chartConfig={gyroChartConfig}
            />
          </MetricCard>
        )}

        {sensorToggles.temp && (
          <MetricCard
            accent="#f97316"
            icon="thermometer"
            title="Skin Temperature"
            subtitle={
              hasFresh(live.temperature.lastUpdated)
                ? `${live.temperature.tempC.toFixed(1)}°C (Live)`
                : 'Waiting for temperature data'
            }
            description="Live skin-temperature trend from the wristband."
          >
            <PhysioChart
              data={tempChartData}
              width={CHART_WIDTH}
              height={180}
              chartConfig={tempChartConfig}
            />
          </MetricCard>
        )}

        {sensorToggles.eda && (
          <MetricCard
            accent={COLORS.accent}
            icon="flash"
            title="Electrodermal Activity"
            subtitle={
              hasFresh(live.eda.lastUpdated)
                ? `${live.eda.conductance_uS.toFixed(1)} µS (Live)`
                : 'Waiting for EDA data'
            }
            description="Live EDA / skin-conductance trend from the wristband."
          >
            <PhysioChart
              data={edaChartData}
              width={CHART_WIDTH}
              height={180}
              chartConfig={edaChartConfig}
            />
          </MetricCard>
        )}

        <View style={{ height: 80 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  header: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 16,
  },
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 8,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: '#ffffff',
  },
  devBadge: {
    backgroundColor: '#f59e0b',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
  },
  devBadgeText: {
    fontSize: 11,
    fontWeight: '800',
    color: '#1e293b',
    letterSpacing: 0.5,
  },
  connectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  connectionDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  connectionText: {
    fontSize: 13,
    color: '#cbd5e1',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingTop: 16,
  },
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
      android: {
        elevation: 3,
      },
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
  chart: {
    borderRadius: 12,
    marginLeft: -8,
  },
  lockedContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  lockedTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: COLORS.text,
    marginTop: 14,
  },
  lockedSubtitle: {
    fontSize: 14,
    color: COLORS.textSecondary,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 20,
  },
});

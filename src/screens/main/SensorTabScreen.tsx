import React, { useRef, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useDevMode, SensorKey } from '../../functionality/DevModeContext';
import { useSharedSensorPipeline } from '../../hooks/SensorPipelineContext';
import { useBLE } from '../../functionality/BLEContext';

// ─── Constants ──────────────────────────────────────────────────────────────────

const SPARKLINE_BAR_COUNT = 20;
const FRESHNESS_THRESHOLD_MS = 15_000; // 15 seconds

const ACCENT_COLORS: Record<SensorKey, string> = {
  ppgGreen: '#DC2626',
  ppgIR: '#DC2626',
  ppgRed: '#DC2626',
  accel: '#2B6E8F',
  gyro: '#1B4965',
  temp: '#f97316',
  eda: '#18A999',
};

const SENSOR_ICONS: Record<SensorKey, keyof typeof Ionicons.glyphMap> = {
  ppgGreen: 'heart',
  ppgIR: 'heart',
  ppgRed: 'heart',
  accel: 'speedometer',
  gyro: 'navigate',
  temp: 'thermometer',
  eda: 'flash',
};

const SENSOR_DISPLAY_LABELS: Record<SensorKey, string> = {
  ppgGreen: 'PPG Green',
  ppgIR: 'PPG IR',
  ppgRed: 'PPG Red',
  accel: 'Accel X / Y / Z',
  gyro: 'Gyro X / Y / Z',
  temp: 'Skin Temp',
  eda: 'Electrodermal Activity',
};

const DUMMY_VALUES: Record<SensorKey, string> = {
  ppgGreen: '512',
  ppgIR: '1024',
  ppgRed: '768',
  accel: '0.12g / -0.05g / 9.81g',
  gyro: '0.3°/s / -0.1°/s / 0.0°/s',
  temp: '36.4°C',
  eda: '2.3 µS',
};

const SENSOR_ORDER: SensorKey[] = [
  'ppgGreen', 'ppgIR', 'ppgRed', 'accel', 'gyro', 'temp', 'eda',
];

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** Generate pseudo-random sparkline data for simulated mode */
function generateDummySparkline(base: number, variance: number): number[] {
  const data: number[] = [];
  let current = base;
  for (let i = 0; i < SPARKLINE_BAR_COUNT; i++) {
    current += (Math.random() - 0.5) * variance;
    current = Math.max(0, current);
    data.push(current);
  }
  return data;
}

/** Normalize an array of numbers to 0–1 range for bar rendering */
function normalizeData(data: number[]): number[] {
  if (data.length === 0) return [];
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  return data.map((v) => (v - min) / range);
}

// ─── Mini Sparkline Component ───────────────────────────────────────────────────

interface SparklineProps {
  data: number[];
  color: string;
  height?: number;
}

function MiniSparkline({ data, color, height = 40 }: SparklineProps) {
  const normalized = normalizeData(data);
  const barWidth = 100 / Math.max(normalized.length, 1);

  return (
    <View style={[sparkStyles.container, { height }]}>
      {normalized.map((value, index) => (
        <View
          key={index}
          style={[
            sparkStyles.bar,
            {
              height: Math.max(2, value * height),
              width: `${barWidth * 0.7}%`,
              marginHorizontal: `${barWidth * 0.15}%`,
              backgroundColor: color,
              opacity: 0.3 + value * 0.7,
            },
          ]}
        />
      ))}
    </View>
  );
}

const sparkStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    paddingHorizontal: 4,
    paddingBottom: 2,
    overflow: 'hidden',
  },
  bar: {
    borderRadius: 2,
  },
});

// ─── Sensor Card Component ──────────────────────────────────────────────────────

interface SensorCardProps {
  sensorKey: SensorKey;
  value: string;
  isLive: boolean;
  sparklineData: number[];
}

function SensorCard({ sensorKey, value, isLive, sparklineData }: SensorCardProps) {
  const accentColor = ACCENT_COLORS[sensorKey];
  const iconName = SENSOR_ICONS[sensorKey];
  const label = SENSOR_DISPLAY_LABELS[sensorKey];

  return (
    <View style={[cardStyles.card, { borderLeftColor: accentColor }]}>
      <View style={cardStyles.header}>
        <View style={cardStyles.headerLeft}>
          <View style={[cardStyles.iconCircle, { backgroundColor: accentColor + '18' }]}>
            <Ionicons name={iconName} size={18} color={accentColor} />
          </View>
          <Text style={cardStyles.label}>{label}</Text>
        </View>
        <View
          style={[
            cardStyles.badge,
            { backgroundColor: isLive ? '#10b981' : '#94a3b8' },
          ]}
        >
          <Text style={cardStyles.badgeText}>
            {isLive ? 'LIVE' : 'Simulated'}
          </Text>
        </View>
      </View>

      <Text style={[cardStyles.value, { color: accentColor }]}>{value}</Text>

      <MiniSparkline data={sparklineData} color={accentColor} />
    </View>
  );
}

const cardStyles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    borderLeftWidth: 4,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.06,
        shadowRadius: 8,
      },
      android: {
        elevation: 2,
      },
    }),
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  iconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1e293b',
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.3,
  },
  value: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 12,
    fontVariant: ['tabular-nums'],
  },
});

// ─── Main Screen ────────────────────────────────────────────────────────────────

export default function SensorTabScreen() {
  const { sensorToggles } = useDevMode();
  const { live } = useSharedSensorPipeline();
  const { isConnected } = useBLE();

  // Sparkline buffers (accumulate live data samples per sensor key)
  const sparkBuffers = useRef<Record<SensorKey, number[]>>({
    ppgGreen: generateDummySparkline(512, 100),
    ppgIR: generateDummySparkline(1024, 200),
    ppgRed: generateDummySparkline(768, 150),
    accel: generateDummySparkline(980, 50),
    gyro: generateDummySparkline(100, 80),
    temp: generateDummySparkline(36.4, 0.3),
    eda: generateDummySparkline(2.3, 0.5),
  });

  // Track freshness — is data actually streaming? (per sensor key)
  const lastLiveUpdates = useRef<Record<SensorKey, number>>({
    ppgGreen: 0,
    ppgIR: 0,
    ppgRed: 0,
    accel: 0,
    gyro: 0,
    temp: 0,
    eda: 0,
  });

  /** Push a new value into the sparkline ring buffer for a sensor */
  const pushSample = useCallback((key: SensorKey, value: number) => {
    const buf = sparkBuffers.current[key];
    if (buf.length >= SPARKLINE_BAR_COUNT) {
      buf.shift();
    }
    buf.push(value);
  }, []);

  // Ingest live pipeline values into sparkline buffers
  useEffect(() => {
    if (!isConnected) return;

    // PPG Green
    const greenTs = live.ppg.lastUpdated?.getTime() ?? 0;
    if (greenTs > lastLiveUpdates.current.ppgGreen) {
      lastLiveUpdates.current.ppgGreen = greenTs;
      if (live.ppg.green) pushSample('ppgGreen', live.ppg.green);
    }

    // PPG IR
    const irTs = live.ppg.lastUpdated?.getTime() ?? 0;
    if (irTs > lastLiveUpdates.current.ppgIR) {
      lastLiveUpdates.current.ppgIR = irTs;
      if (live.ppg.ir) pushSample('ppgIR', live.ppg.ir);
    }

    // PPG Red
    const redTs = live.ppg.lastUpdated?.getTime() ?? 0;
    if (redTs > lastLiveUpdates.current.ppgRed) {
      lastLiveUpdates.current.ppgRed = redTs;
      if (live.ppg.red) pushSample('ppgRed', live.ppg.red);
    }

    // Accel (magnitude)
    const accelTs = live.accel.lastUpdated?.getTime() ?? 0;
    if (accelTs > lastLiveUpdates.current.accel) {
      lastLiveUpdates.current.accel = accelTs;
      pushSample('accel', live.accel.magnitude / 1000);
    }

    // Gyro (magnitude)
    const gyroTs = live.gyro.lastUpdated?.getTime() ?? 0;
    if (gyroTs > lastLiveUpdates.current.gyro) {
      lastLiveUpdates.current.gyro = gyroTs;
      pushSample('gyro', live.gyro.magnitude / 1000);
    }

    // Temp
    const tempTs = live.temperature.lastUpdated?.getTime() ?? 0;
    if (tempTs > lastLiveUpdates.current.temp) {
      lastLiveUpdates.current.temp = tempTs;
      pushSample('temp', live.temperature.tempC);
    }

    // EDA
    const edaTs = live.eda.lastUpdated?.getTime() ?? 0;
    if (edaTs > lastLiveUpdates.current.eda) {
      lastLiveUpdates.current.eda = edaTs;
      pushSample('eda', live.eda.conductance_uS);
    }
  }, [isConnected, live, pushSample]);

  /** Determine if a particular sensor has fresh live data */
  const isSensorLive = useCallback(
    (key: SensorKey): boolean => {
      if (!isConnected) return false;

      const now = Date.now();
      let lastUpdated: Date | null = null;

      switch (key) {
        case 'ppgGreen':
        case 'ppgIR':
        case 'ppgRed':
          lastUpdated = live.ppg.lastUpdated;
          break;
        case 'accel':
          lastUpdated = live.accel.lastUpdated;
          break;
        case 'gyro':
          lastUpdated = live.gyro.lastUpdated;
          break;
        case 'temp':
          lastUpdated = live.temperature.lastUpdated;
          break;
        case 'eda':
          lastUpdated = live.eda.lastUpdated;
          break;
      }

      if (!lastUpdated) return false;
      return now - lastUpdated.getTime() < FRESHNESS_THRESHOLD_MS;
    },
    [isConnected, live],
  );

  /** Format the current display value for a sensor */
  const getDisplayValue = useCallback(
    (key: SensorKey): string => {
      const liveOk = isSensorLive(key);
      if (!liveOk) return DUMMY_VALUES[key];

      switch (key) {
        case 'ppgGreen':
          return `${live.ppg.green}`;
        case 'ppgIR':
          return `${live.ppg.ir}`;
        case 'ppgRed':
          return `${live.ppg.red}`;
        case 'accel': {
          const ax = (live.accel.x / 1000).toFixed(2);
          const ay = (live.accel.y / 1000).toFixed(2);
          const az = (live.accel.z / 1000).toFixed(2);
          return `${ax}g / ${ay}g / ${az}g`;
        }
        case 'gyro': {
          const gx = (live.gyro.x / 1000).toFixed(1);
          const gy = (live.gyro.y / 1000).toFixed(1);
          const gz = (live.gyro.z / 1000).toFixed(1);
          return `${gx}°/s / ${gy}°/s / ${gz}°/s`;
        }
        case 'temp':
          return `${live.temperature.tempC.toFixed(1)}°C`;
        case 'eda':
          return `${live.eda.conductance_uS.toFixed(1)} µS`;
        default:
          return DUMMY_VALUES[key];
      }
    },
    [isSensorLive, live],
  );

  // Build list of visible sensors (respecting toggles)
  const visibleSensors = SENSOR_ORDER.filter((key) => sensorToggles[key]);

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <Text style={styles.headerTitle}>Sensor Data</Text>
          <View style={styles.devBadge}>
            <Text style={styles.devBadgeText}>DEV</Text>
          </View>
        </View>
        <View style={styles.connectionRow}>
          <View
            style={[
              styles.connectionDot,
              { backgroundColor: isConnected ? '#10b981' : '#94a3b8' },
            ]}
          />
          <Text style={styles.connectionText}>
            {isConnected ? 'Wristband Connected' : 'Not Connected — Simulated Data'}
          </Text>
        </View>
      </View>

      {/* Sensor Cards */}
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {visibleSensors.length === 0 ? (
          <View style={styles.emptyContainer}>
            <Ionicons name="eye-off-outline" size={48} color="#94a3b8" />
            <Text style={styles.emptyTitle}>No Sensors Enabled</Text>
            <Text style={styles.emptySubtitle}>
              Enable sensors in Developer Settings to view their data.
            </Text>
          </View>
        ) : (
          visibleSensors.map((key) => (
            <SensorCard
              key={key}
              sensorKey={key}
              value={getDisplayValue(key)}
              isLive={isSensorLive(key)}
              sparklineData={sparkBuffers.current[key]}
            />
          ))
        )}

        {/* Bottom padding for tab bar */}
        <View style={styles.bottomSpacer} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#1B4965',
  },
  header: {
    backgroundColor: '#1B4965',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 16,
  },
  headerRow: {
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
  scrollView: {
    flex: 1,
    backgroundColor: '#f8fafc',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  scrollContent: {
    padding: 16,
    paddingTop: 20,
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1e293b',
    marginTop: 16,
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#64748b',
    textAlign: 'center',
    marginTop: 8,
    paddingHorizontal: 40,
  },
  bottomSpacer: {
    height: 100,
  },
});

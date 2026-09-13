import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Dimensions,
  Alert,
  Platform,
} from 'react-native';
import { LineChart } from 'react-native-chart-kit';
import { useBLE } from '../functionality/BLEContext';
import { useAuth } from '../auth/AuthContext';
import { saveSensorReading } from '../firebase/dataLogger';
import { useSharedSensorPipeline } from '../hooks/SensorPipelineContext';
import PPGWaveformCard from './PPGWaveformCard';

const WINDOW_SIZE = 100;
const UPDATE_INTERVAL = 100; // 100ms = 10Hz sampling

type SensorType = 'PPG_IR' | 'PPG_RED' | 'PPG_GREEN' | 'EDA' | 'GYRO_X' | 'GYRO_Y' | 'GYRO_Z' | 'ACC_X' | 'ACC_Y' | 'ACC_Z' | 'TEMP';

interface SensorData {
  type: SensorType;
  label: string;
  value: number;
  unit: string;
  color: string;
  buffer: number[];
}

type FilterType = 'none' | 'lowpass' | 'bandpass';

interface FilterConfig {
  type: FilterType;
  cutoffLow: number; // Hz
  cutoffHigh: number; // Hz
}

const sanitizeSensorValue = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return 0;
  if (value < min) return min;
  if (value > max) return max;
  return value;
};

export const WristbandSensorsPanel: React.FC = () => {
  const { isConnected, connectedDeviceName, bluetoothState, enableBluetooth } = useBLE();
  const { user } = useAuth();

  // Live sensor data from the BLE→Parse→Firebase pipeline
  const { live, session, startSession, stopSession } = useSharedSensorPipeline();

  const [isStreaming, setIsStreaming] = useState(false);
  const [useSyntheticData, setUseSyntheticData] = useState(false);
  const [showRawValues, setShowRawValues] = useState(true);
  const [enableFirebaseLogging, setEnableFirebaseLogging] = useState(true);

  // Filter settings
  const [filterType, setFilterType] = useState<FilterType>('none');
  const [lowPassCutoff, setLowPassCutoff] = useState(5); // Hz
  const [bandPassLow, setBandPassLow] = useState(0.5); // Hz
  const [bandPassHigh, setBandPassHigh] = useState(10); // Hz

  // Sensor data
  const [sensors, setSensors] = useState<Record<SensorType, SensorData>>({
    PPG_IR: { type: 'PPG_IR', label: 'PPG-IR', value: 0, unit: '', color: '#ef4444', buffer: Array(WINDOW_SIZE).fill(0) },
    PPG_RED: { type: 'PPG_RED', label: 'PPG-Red', value: 0, unit: '', color: '#dc2626', buffer: Array(WINDOW_SIZE).fill(0) },
    PPG_GREEN: { type: 'PPG_GREEN', label: 'PPG-Green', value: 0, unit: '', color: '#10b981', buffer: Array(WINDOW_SIZE).fill(0) },
    EDA: { type: 'EDA', label: 'EDA', value: 0, unit: 'µS', color: '#d97706', buffer: Array(WINDOW_SIZE).fill(0) },
    GYRO_X: { type: 'GYRO_X', label: 'Gyro-X', value: 0, unit: 'dps', color: '#8b5cf6', buffer: Array(WINDOW_SIZE).fill(0) },
    GYRO_Y: { type: 'GYRO_Y', label: 'Gyro-Y', value: 0, unit: 'dps', color: '#a855f7', buffer: Array(WINDOW_SIZE).fill(0) },
    GYRO_Z: { type: 'GYRO_Z', label: 'Gyro-Z', value: 0, unit: 'dps', color: '#c084fc', buffer: Array(WINDOW_SIZE).fill(0) },
    ACC_X: { type: 'ACC_X', label: 'Accel-X', value: 0, unit: 'g', color: '#06b6d4', buffer: Array(WINDOW_SIZE).fill(0) },
    ACC_Y: { type: 'ACC_Y', label: 'Accel-Y', value: 0, unit: 'g', color: '#0891b2', buffer: Array(WINDOW_SIZE).fill(0) },
    ACC_Z: { type: 'ACC_Z', label: 'Accel-Z', value: 0, unit: 'g', color: '#0e7490', buffer: Array(WINDOW_SIZE).fill(0) },
    TEMP: { type: 'TEMP', label: 'Temperature', value: 0, unit: '°C', color: '#e11d48', buffer: Array(WINDOW_SIZE).fill(0) },
  });

  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const timeRef = useRef(0);
  const firebaseLogCounterRef = useRef(0);
  const FIREBASE_LOG_INTERVAL = 50; // Log every 50th sample to avoid overwhelming Firestore

  // Simple low-pass filter implementation
  const applyLowPassFilter = (data: number[], cutoff: number): number[] => {
    const alpha = cutoff / (cutoff + (1 / (UPDATE_INTERVAL / 1000)));
    const filtered = [data[0]];

    for (let i = 1; i < data.length; i++) {
      filtered[i] = alpha * data[i] + (1 - alpha) * filtered[i - 1];
    }

    return filtered;
  };

  // Simple band-pass filter (high-pass + low-pass)
  const applyBandPassFilter = (data: number[], low: number, high: number): number[] => {
    // First apply high-pass (subtract low-pass)
    const lowPassResult = applyLowPassFilter(data, low);
    const highPassResult = data.map((val, idx) => val - lowPassResult[idx]);

    // Then apply low-pass to high-pass result
    return applyLowPassFilter(highPassResult, high);
  };

  // Get filtered data based on current filter settings
  const getFilteredData = (buffer: number[]): number[] => {
    switch (filterType) {
      case 'lowpass':
        return applyLowPassFilter(buffer, lowPassCutoff);
      case 'bandpass':
        return applyBandPassFilter(buffer, bandPassLow, bandPassHigh);
      default:
        return buffer;
    }
  };

  // Generate synthetic sensor data
  const generateSyntheticSensorData = useCallback(() => {
    const t = timeRef.current;
    const newSensors = { ...sensors };

    // PPG signals (simulate heartbeat ~60-80 BPM)
    const heartRate = 70;
    const ppgBase = 1000 + 200 * Math.sin(2 * Math.PI * (heartRate / 60) * t);
    newSensors.PPG_IR.value = 0;
    newSensors.PPG_RED.value = 0;
    newSensors.PPG_GREEN.value = ppgBase * 0.6 + Math.random() * 10;

    // EDA (slowly varying)
    newSensors.EDA.value = 5 + 2 * Math.sin(0.1 * t) + Math.random() * 0.5;

    // Gyroscope (simulate small movements)
    newSensors.GYRO_X.value = 10 * Math.sin(0.5 * t) + Math.random() * 5;
    newSensors.GYRO_Y.value = 8 * Math.cos(0.7 * t) + Math.random() * 4;
    newSensors.GYRO_Z.value = 5 * Math.sin(0.3 * t) + Math.random() * 3;

    // Accelerometer (simulate gravity + small movements)
    newSensors.ACC_X.value = 0.1 + 0.2 * Math.sin(0.4 * t) + Math.random() * 0.05;
    newSensors.ACC_Y.value = 0.05 + 0.15 * Math.cos(0.6 * t) + Math.random() * 0.03;
    newSensors.ACC_Z.value = 1.0 + 0.1 * Math.sin(0.2 * t) + Math.random() * 0.02; // Mostly gravity

    // Temperature (slowly varying body temp)
    newSensors.TEMP.value = 36.5 + 0.3 * Math.sin(0.05 * t) + Math.random() * 0.1;

    // Update buffers
    Object.keys(newSensors).forEach((key) => {
      const sensorKey = key as SensorType;
      const sensor = newSensors[sensorKey];
      sensor.buffer = [...sensor.buffer.slice(1), sensor.value];
    });

    setSensors(newSensors);
    timeRef.current += UPDATE_INTERVAL / 1000;

    // Optional Firebase logging (throttled)
    if (enableFirebaseLogging && user) {
      firebaseLogCounterRef.current++;
      if (firebaseLogCounterRef.current >= FIREBASE_LOG_INTERVAL) {
        firebaseLogCounterRef.current = 0;
        // Log key sensors to Firebase
        (['TEMP', 'EDA'] as SensorType[]).forEach(sensorType => {
          const sensor = newSensors[sensorType];
          saveSensorReading(user.uid, {
            sensorType,
            value: sensor.value,
            unit: sensor.unit,
            deviceName: connectedDeviceName || 'Synthetic',
          }).catch(err => console.error('[Firebase] Failed to log:', err));
        });
      }
    }
  }, [sensors, enableFirebaseLogging, user, connectedDeviceName]);

  // Sync the exact compact-stream arrays into the graphs. This avoids
  // resampling/duplicating values at the React render cadence.
  useEffect(() => {
    if (!isStreaming || useSyntheticData) return;

    const last10Seconds = (timestamps: number[], values: number[]): number[] => {
      if (!values.length) return [];
      if (!timestamps.length || timestamps.length !== values.length) return values.slice(-WINDOW_SIZE);
      const end = timestamps[timestamps.length - 1];
      const startIndex = Math.max(0, timestamps.findIndex(t => t >= end - 10_000));
      return values.slice(startIndex);
    };

    setSensors(prev => {
      const updated = { ...prev };

      if (live.temperatureStream.values_c.length) {
        const values = last10Seconds(live.temperatureStream.timestamps, live.temperatureStream.values_c);
        const value = values[values.length - 1] ?? live.temperature.tempC;
        updated.TEMP = { ...updated.TEMP, value, buffer: values };
      }

      if (live.ppg.lastUpdated) {
        const green = sanitizeSensorValue(live.ppg.green, 0, 400000);
        updated.PPG_GREEN = { ...updated.PPG_GREEN, value: green, buffer: [...updated.PPG_GREEN.buffer.slice(1), green] };
        updated.PPG_IR = { ...updated.PPG_IR, value: live.ppg.ir };
        updated.PPG_RED = { ...updated.PPG_RED, value: live.ppg.red };
      }

      const imu = live.imuStream;
      if (imu.timestamps.length) {
        const ax = last10Seconds(imu.timestamps, imu.ax_g);
        const ay = last10Seconds(imu.timestamps, imu.ay_g);
        const az = last10Seconds(imu.timestamps, imu.az_g);
        const gx = last10Seconds(imu.timestamps, imu.gx_dps);
        const gy = last10Seconds(imu.timestamps, imu.gy_dps);
        const gz = last10Seconds(imu.timestamps, imu.gz_dps);
        updated.ACC_X = { ...updated.ACC_X, value: ax[ax.length - 1] ?? 0, buffer: ax };
        updated.ACC_Y = { ...updated.ACC_Y, value: ay[ay.length - 1] ?? 0, buffer: ay };
        updated.ACC_Z = { ...updated.ACC_Z, value: az[az.length - 1] ?? 0, buffer: az };
        updated.GYRO_X = { ...updated.GYRO_X, value: gx[gx.length - 1] ?? 0, buffer: gx };
        updated.GYRO_Y = { ...updated.GYRO_Y, value: gy[gy.length - 1] ?? 0, buffer: gy };
        updated.GYRO_Z = { ...updated.GYRO_Z, value: gz[gz.length - 1] ?? 0, buffer: gz };
      }

      if (live.edaStream.values_uS.length) {
        const values = last10Seconds(live.edaStream.timestamps, live.edaStream.values_uS);
        updated.EDA = { ...updated.EDA, value: values[values.length - 1] ?? 0, buffer: values };
      }

      return updated;
    });
  }, [live, isStreaming, useSyntheticData]);

  // Start/stop streaming
  useEffect(() => {
    if (isStreaming && useSyntheticData) {
      timeRef.current = 0;

      intervalRef.current = setInterval(() => {
        generateSyntheticSensorData();
      }, UPDATE_INTERVAL);

      return () => {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      };
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }
  }, [isStreaming, useSyntheticData, generateSyntheticSensorData]);

  const handleStartStop = () => {
    if (!isConnected) {
      Alert.alert(
        'Not Connected',
        'Please connect to the SMARTWATCH device via the Devices tab before streaming.',
        [{ text: 'OK' }]
      );
      return;
    }

    const nextStreaming = !isStreaming;
    setIsStreaming(nextStreaming);

    // Always start / stop a Firestore recording session with streaming
    if (user) {
      if (nextStreaming) {
        startSession(`Wristband ${new Date().toLocaleString()}`);
      } else {
        stopSession();
      }
    }
  };

  const handleClear = () => {
    const clearedSensors = { ...sensors };
    Object.keys(clearedSensors).forEach((key) => {
      const sensorKey = key as SensorType;
      clearedSensors[sensorKey].buffer = Array(WINDOW_SIZE).fill(0);
      clearedSensors[sensorKey].value = 0;
    });
    setSensors(clearedSensors);
    timeRef.current = 0;
  };

  // Create chart data for multiple PPG sensors
  const createPPGChartData = () => {
    const ppgTypes: SensorType[] = ['PPG_IR', 'PPG_RED', 'PPG_GREEN'];
    return {
      labels: Array(WINDOW_SIZE).fill(''),
      datasets: ppgTypes.map((type) => {
        const sensor = sensors[type];
        const filteredData = getFilteredData(sensor.buffer);
        return {
          data: filteredData.length > 0 ? filteredData : [0],
          color: (opacity = 1) => sensor.color,
          strokeWidth: 2,
        };
      }),
      legend: ppgTypes.map((type) => sensors[type].label),
    };
  };

  const createMultiAxisChartData = (types: SensorType[]) => {
    const axisColours = ['#ef4444', '#22c55e', '#3b82f6']; // same X/Y/Z colours as PC GUI
    const filteredAxes = types.map(type => sensors[type].buffer); // direct compact I values; no phone-side filtering
    const maxLength = Math.max(2, ...filteredAxes.map(values => values.length));
    const isAccel = types[0]?.startsWith('ACC_');
    const magnitude = Array.from({ length: maxLength }, (_, index) =>
      Math.sqrt(filteredAxes.reduce((sum, values) => sum + Math.pow(values[index] ?? 0, 2), 0)),
    );

    return {
      labels: Array(maxLength).fill(''),
      datasets: [
        ...types.map((type, index) => ({
          data: filteredAxes[index].length > 0 ? filteredAxes[index] : [0],
          color: () => axisColours[index] ?? sensors[type].color,
          strokeWidth: 1.7,
        })),
        {
          data: magnitude,
          color: () => '#111827',
          strokeWidth: 1.4,
        },
      ],
      legend: ['X', 'Y', 'Z', isAccel ? '|a|' : '|gyro|'],
    };
  };

  // Create chart data for EDA
  const createEDAChartData = () => {
    const sensor = sensors.EDA;
    const directData = sensor.buffer; // direct compact E values
    return {
      labels: Array(Math.max(directData.length, 2)).fill(''),
      datasets: [{
        data: directData.length > 0 ? directData : [0],
        color: (opacity = 1) => sensor.color,
        strokeWidth: 2.5,
      }],
    };
  };

  // Create chart data for Temperature
  const createTempChartData = () => {
    const sensor = sensors.TEMP;
    const directData = sensor.buffer; // direct compact T values
    return {
      labels: Array(Math.max(directData.length, 2)).fill(''),
      datasets: [{
        data: directData.length > 0 ? directData : [0],
        color: (opacity = 1) => sensor.color,
        strokeWidth: 2.5,
      }],
    };
  };

  const screenWidth = Dimensions.get('window').width;

  // Group sensors by category
  const ppgSensors: SensorType[] = ['PPG_IR', 'PPG_RED', 'PPG_GREEN'];
  const imuSensors: SensorType[] = ['GYRO_X', 'GYRO_Y', 'GYRO_Z', 'ACC_X', 'ACC_Y', 'ACC_Z'];
  const bioSensors: SensorType[] = ['EDA', 'TEMP'];

  const renderSensorGrid = (sensorTypes: SensorType[], title: string) => (
    <View style={styles.sensorGroup}>
      <Text style={styles.groupTitle}>{title}</Text>
      <View style={styles.sensorGrid}>
        {sensorTypes.map((sensorType) => {
          const sensor = sensors[sensorType];

          const decimals = sensorType.startsWith('ACC_')
            ? 3
            : sensorType.startsWith('GYRO_')
              ? 2
              : sensorType === 'TEMP'
                ? 2
                : 3;

          return (
            <View
              key={sensorType}
              style={[
                styles.sensorCard,
                { borderLeftColor: sensor.color, borderLeftWidth: 4 }
              ]}
            >
              <Text style={styles.sensorLabel}>
                {sensor.label}
              </Text>
              <Text style={styles.sensorValue}>
                {sensor.value.toFixed(decimals)}
              </Text>
              {sensor.unit && (
                <Text style={styles.sensorUnit}>
                  {sensor.unit}
                </Text>
              )}
            </View>
          );
        })}
      </View>
    </View>
  );

  return (
    <ScrollView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>🌊 Wristband Sensors</Text>
        <View style={styles.statusBadge}>
          <View style={[styles.statusDot, isStreaming && styles.statusDotActive]} />
          <Text style={styles.statusText}>{isStreaming ? 'Streaming' : 'Stopped'}</Text>
        </View>
      </View>

      {/* Control Buttons */}
      <View style={styles.controlsCard}>
        <View style={styles.controlRow}>
          <TouchableOpacity
            style={[styles.controlButton, styles.primaryButton, isStreaming && styles.stopButton]}
            onPress={handleStartStop}
          >
            <Text style={styles.controlButtonText}>
              {isStreaming ? '⏸ Stop' : '▶ Start'}
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.controlButton, styles.secondaryButton]}
            onPress={handleClear}
            disabled={isStreaming}
          >
            <Text style={styles.controlButtonText}>🗑 Clear</Text>
          </TouchableOpacity>
        </View>

        {/* Connection & Firebase status */}
        {!isConnected && (
          <View style={[styles.settingRow, { marginTop: 4, flexDirection: 'column', alignItems: 'stretch' }]}>
            <Text style={{ fontSize: 13, color: '#ef4444', fontWeight: '600', textAlign: 'center', marginBottom: bluetoothState === 'PoweredOff' ? 8 : 0 }}>
              ⚠️  Not connected — go to Devices tab to pair SMARTWATCH
            </Text>
            {bluetoothState === 'PoweredOff' && (
              <TouchableOpacity
                style={[styles.controlButton, { backgroundColor: Platform.OS === 'android' ? '#3b82f6' : '#ef4444', width: '100%' }]}
                onPress={enableBluetooth}
              >
                <Text style={styles.controlButtonText}>
                  {Platform.OS === 'android' ? '🔵 Turn On Bluetooth' : '⚙️ Open Bluetooth Settings'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {session.isRecording && (
          <View style={[styles.settingRow, { marginTop: 10 }]}>
            <Text style={{ fontSize: 12, color: '#10b981', fontWeight: '600' }}>
              📡 Saving to Firebase • {session.dataPointsSaved} pts
            </Text>
          </View>
        )}
      </View>

      {/* ── FIRMWARE PPG WAVEFORM + HEART RATE (Top-priority section) ── */}
      <View style={{ paddingHorizontal: 16, marginBottom: 4 }}>
        <Text style={[styles.groupTitle, { fontSize: 13, color: '#64748b', marginBottom: 8, letterSpacing: 0.5, textTransform: 'uppercase' }]}>
          ❤️  Heart Rate &amp; PPG — Medical-Wristband-Firmware
        </Text>
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

      {/* Waveform Displays */}

      {/* PPG Waveforms - All 3 sensors */}
      <View style={styles.waveformCard}>
        <View style={styles.waveformHeader}>
          <Text style={styles.waveformTitle}>📊 PPG-IR Waveform</Text>
          <Text style={styles.filterBadge}>
            {filterType === 'none' ? 'Raw' :
              filterType === 'lowpass' ? `LP ${lowPassCutoff}Hz` :
                `BP ${bandPassLow}-${bandPassHigh}Hz`}
          </Text>
        </View>

        <View style={styles.chartContainer}>
          <LineChart
            data={createPPGChartData()}
            width={screenWidth - 48}
            height={220}
            chartConfig={{
              backgroundColor: '#ef4444',
              backgroundGradientFrom: '#ef4444',
              backgroundGradientTo: '#dc2626',
              decimalPlaces: 1,
              color: (opacity = 1) => `rgba(255, 255, 255, ${opacity})`,
              labelColor: (opacity = 1) => `rgba(255, 255, 255, ${0.7 * opacity})`,
              style: { borderRadius: 16 },
              propsForDots: { r: '0' },
              propsForBackgroundLines: {
                strokeDasharray: '',
                stroke: 'rgba(255, 255, 255, 0.15)',
                strokeWidth: 1,
              },
            }}
            bezier={false}
            style={styles.chart}
            withInnerLines={true}
            withOuterLines={false}
            withVerticalLabels={false}
            withHorizontalLabels={true}
            fromZero={false}
            segments={4}
          />
        </View>

        <View style={styles.waveformStats}>
          {ppgSensors.map((sensorType) => {
            const sensor = sensors[sensorType];
            return (
              <View key={sensorType} style={styles.stat}>
                <Text style={styles.statLabel}>{sensor.label}</Text>
                <Text style={[styles.statValue, { color: sensor.color }]}>
                  {sensor.value.toFixed(2)}
                </Text>
              </View>
            );
          })}
        </View>
      </View>

      {/* Accelerometer graph — exact compact I values in g */}
      <View style={styles.waveformCard}>
        <View style={styles.waveformHeader}>
          <Text style={styles.waveformTitle}>📊 Accelerometer X / Y / Z</Text>
          <Text style={styles.filterBadge}>g · compact I</Text>
        </View>
        <View style={styles.chartContainer}>
          <LineChart
            data={createMultiAxisChartData(['ACC_X', 'ACC_Y', 'ACC_Z'])}
            width={screenWidth - 48}
            height={220}
            chartConfig={{
              backgroundColor: '#f8fafc',
              backgroundGradientFrom: '#ffffff',
              backgroundGradientTo: '#f8fafc',
              decimalPlaces: 3,
              color: (opacity = 1) => `rgba(15, 23, 42, ${opacity})`,
              labelColor: (opacity = 1) => `rgba(51, 65, 85, ${opacity})`,
              style: { borderRadius: 16 },
              propsForDots: { r: '0' },
              propsForBackgroundLines: { strokeDasharray: '', stroke: 'rgba(148, 163, 184, 0.28)', strokeWidth: 1 },
            }}
            bezier={false}
            style={styles.chart}
            withInnerLines
            withOuterLines={false}
            withVerticalLabels={false}
            withHorizontalLabels
            fromZero={false}
            segments={4}
          />
        </View>
        <View style={styles.legendContainer}>
          {[['ax', '#ef4444'], ['ay', '#22c55e'], ['az', '#3b82f6'], ['|a|', '#111827']].map(([label, color]) => (
            <View key={label} style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: color }]} />
              <Text style={styles.legendText}>{label}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* Gyroscope graph — exact compact I values in dps */}
      <View style={styles.waveformCard}>
        <View style={styles.waveformHeader}>
          <Text style={styles.waveformTitle}>📊 Gyroscope X / Y / Z</Text>
          <Text style={styles.filterBadge}>dps · compact I</Text>
        </View>
        <View style={styles.chartContainer}>
          <LineChart
            data={createMultiAxisChartData(['GYRO_X', 'GYRO_Y', 'GYRO_Z'])}
            width={screenWidth - 48}
            height={220}
            chartConfig={{
              backgroundColor: '#f8fafc',
              backgroundGradientFrom: '#ffffff',
              backgroundGradientTo: '#f8fafc',
              decimalPlaces: 2,
              color: (opacity = 1) => `rgba(15, 23, 42, ${opacity})`,
              labelColor: (opacity = 1) => `rgba(51, 65, 85, ${opacity})`,
              style: { borderRadius: 16 },
              propsForDots: { r: '0' },
              propsForBackgroundLines: { strokeDasharray: '', stroke: 'rgba(148, 163, 184, 0.28)', strokeWidth: 1 },
            }}
            bezier={false}
            style={styles.chart}
            withInnerLines
            withOuterLines={false}
            withVerticalLabels={false}
            withHorizontalLabels
            fromZero={false}
            segments={4}
          />
        </View>
        <View style={styles.legendContainer}>
          {[['gx', '#ef4444'], ['gy', '#22c55e'], ['gz', '#3b82f6'], ['|gyro|', '#111827']].map(([label, color]) => (
            <View key={label} style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: color }]} />
              <Text style={styles.legendText}>{label}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* EDA Graph */}
      <View style={styles.waveformCard}>
        <View style={styles.waveformHeader}>
          <Text style={styles.waveformTitle}>📊 EDA</Text>
          <Text style={styles.filterBadge}>µS · compact E</Text>
        </View>

        <View style={styles.chartContainer}>
          <LineChart
            data={createEDAChartData()}
            width={screenWidth - 48}
            height={220}
            chartConfig={{
              backgroundColor: '#d97706',
              backgroundGradientFrom: '#d97706',
              backgroundGradientTo: '#b45309',
              decimalPlaces: 1,
              color: (opacity = 1) => `rgba(255, 255, 255, ${opacity})`,
              labelColor: (opacity = 1) => `rgba(255, 255, 255, ${0.7 * opacity})`,
              style: { borderRadius: 16 },
              propsForDots: { r: '0' },
              propsForBackgroundLines: {
                strokeDasharray: '',
                stroke: 'rgba(255, 255, 255, 0.15)',
                strokeWidth: 1,
              },
            }}
            bezier={false}
            style={styles.chart}
            withInnerLines={true}
            withOuterLines={false}
            withVerticalLabels={false}
            withHorizontalLabels={true}
            fromZero={false}
            segments={4}
          />
        </View>

        <View style={styles.waveformStats}>
          <View style={styles.stat}>
            <Text style={styles.statLabel}>Current</Text>
            <Text style={[styles.statValue, { color: sensors.EDA.color }]}>
              {sensors.EDA.value.toFixed(2)} {sensors.EDA.unit}
            </Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statLabel}>Max</Text>
            <Text style={[styles.statValue, { color: sensors.EDA.color }]}>
              {Math.max(...sensors.EDA.buffer).toFixed(2)}
            </Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statLabel}>Min</Text>
            <Text style={[styles.statValue, { color: sensors.EDA.color }]}>
              {Math.min(...sensors.EDA.buffer).toFixed(2)}
            </Text>
          </View>
        </View>
      </View>

      {/* Temperature Graph */}
      <View style={styles.waveformCard}>
        <View style={styles.waveformHeader}>
          <Text style={styles.waveformTitle}>📊 Temp</Text>
          <Text style={styles.filterBadge}>°C · compact T</Text>
        </View>

        <View style={styles.chartContainer}>
          <LineChart
            data={createTempChartData()}
            width={screenWidth - 48}
            height={220}
            chartConfig={{
              backgroundColor: '#e11d48',
              backgroundGradientFrom: '#e11d48',
              backgroundGradientTo: '#be123c',
              decimalPlaces: 1,
              color: (opacity = 1) => `rgba(255, 255, 255, ${opacity})`,
              labelColor: (opacity = 1) => `rgba(255, 255, 255, ${0.7 * opacity})`,
              style: { borderRadius: 16 },
              propsForDots: { r: '0' },
              propsForBackgroundLines: {
                strokeDasharray: '',
                stroke: 'rgba(255, 255, 255, 0.15)',
                strokeWidth: 1,
              },
            }}
            bezier={false}
            style={styles.chart}
            withInnerLines={true}
            withOuterLines={false}
            withVerticalLabels={false}
            withHorizontalLabels={true}
            fromZero={false}
            segments={4}
          />
        </View>

        <View style={styles.waveformStats}>
          <View style={styles.stat}>
            <Text style={styles.statLabel}>Current</Text>
            <Text style={[styles.statValue, { color: sensors.TEMP.color }]}>
              {sensors.TEMP.value.toFixed(2)} {sensors.TEMP.unit}
            </Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statLabel}>Max</Text>
            <Text style={[styles.statValue, { color: sensors.TEMP.color }]}>
              {Math.max(...sensors.TEMP.buffer).toFixed(2)}
            </Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statLabel}>Min</Text>
            <Text style={[styles.statValue, { color: sensors.TEMP.color }]}>
              {Math.min(...sensors.TEMP.buffer).toFixed(2)}
            </Text>
          </View>
        </View>
      </View>

      {/* Latest compact M 60-second summary — same fields as the PC GUI */}
      <View style={styles.minuteSummaryCard}>
        <Text style={styles.minuteSummaryTitle}>Latest 60-second summary</Text>
        <View style={styles.minuteSummaryGrid}>
          {[
            ['Activity', live.minuteSummary.activity],
            ['Activity confidence', live.minuteSummary.activityConfidence.toFixed(2)],
            ['Artifact fraction', live.minuteSummary.artifactFraction.toFixed(2)],
            ['HR 60s', live.minuteSummary.hrBpm > 0 ? `${live.minuteSummary.hrBpm.toFixed(1)} BPM` : 'NA'],
            ['HR coverage', `${live.minuteSummary.hrCoverageSec} s`],
            ['HR quality', live.minuteSummary.hrQuality],
            ['RMSSD 60s', live.minuteSummary.rmssdMs >= 0 ? `${live.minuteSummary.rmssdMs.toFixed(1)} ms` : 'NA'],
            ['HRV quality', live.minuteSummary.hrvQuality],
            ['EDA tonic / SCR', `${live.minuteSummary.edaMuScl.toFixed(3)} / ${live.minuteSummary.edaSigmaScr.toFixed(3)}`],
            ['EDA quality', `${live.minuteSummary.edaQuality} / ${live.minuteSummary.edaConfidence}`],
            ['Temperature 60s', live.minuteSummary.tempC >= 0 ? `${live.minuteSummary.tempC.toFixed(2)} °C` : 'NA'],
            ['Temp quality', live.minuteSummary.tempQuality],
            ['Temp slope', live.minuteSummary.tempSlope5m >= 0 ? live.minuteSummary.tempSlope5m.toFixed(4) : 'NA'],
            ['Sleep state', live.minuteSummary.sleepState],
            ['Sleep confidence', live.minuteSummary.sleepConfidence.toFixed(2)],
          ].map(([label, value]) => (
            <View key={label} style={styles.minuteSummaryItem}>
              <Text style={styles.minuteSummaryLabel}>{label}</Text>
              <Text style={styles.minuteSummaryValue}>{value}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* Filter Controls */}
      <View style={styles.filterCard}>
        <Text style={styles.filterTitle}>🔧 Signal Filtering</Text>

        <View style={styles.filterTypeRow}>
          <TouchableOpacity
            style={[styles.filterButton, filterType === 'none' && styles.filterButtonActive]}
            onPress={() => setFilterType('none')}
          >
            <Text style={[styles.filterButtonText, filterType === 'none' && styles.filterButtonTextActive]}>
              No Filter
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.filterButton, filterType === 'lowpass' && styles.filterButtonActive]}
            onPress={() => setFilterType('lowpass')}
          >
            <Text style={[styles.filterButtonText, filterType === 'lowpass' && styles.filterButtonTextActive]}>
              Low-Pass
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.filterButton, filterType === 'bandpass' && styles.filterButtonActive]}
            onPress={() => setFilterType('bandpass')}
          >
            <Text style={[styles.filterButtonText, filterType === 'bandpass' && styles.filterButtonTextActive]}>
              Band-Pass
            </Text>
          </TouchableOpacity>
        </View>

        {filterType === 'lowpass' && (
          <View style={styles.filterParams}>
            <View style={styles.paramRow}>
              <Text style={styles.paramLabel}>Cutoff: {lowPassCutoff} Hz</Text>
              <View style={styles.paramButtons}>
                <TouchableOpacity
                  style={styles.paramButton}
                  onPress={() => setLowPassCutoff(Math.max(1, lowPassCutoff - 1))}
                >
                  <Text style={styles.paramButtonText}>-</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.paramButton}
                  onPress={() => setLowPassCutoff(Math.min(20, lowPassCutoff + 1))}
                >
                  <Text style={styles.paramButtonText}>+</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}

        {filterType === 'bandpass' && (
          <View style={styles.filterParams}>
            <View style={styles.paramRow}>
              <Text style={styles.paramLabel}>Low: {bandPassLow} Hz</Text>
              <View style={styles.paramButtons}>
                <TouchableOpacity
                  style={styles.paramButton}
                  onPress={() => setBandPassLow(Math.max(0.1, bandPassLow - 0.5))}
                >
                  <Text style={styles.paramButtonText}>-</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.paramButton}
                  onPress={() => setBandPassLow(Math.min(bandPassHigh - 0.5, bandPassLow + 0.5))}
                >
                  <Text style={styles.paramButtonText}>+</Text>
                </TouchableOpacity>
              </View>
            </View>

            <View style={styles.paramRow}>
              <Text style={styles.paramLabel}>High: {bandPassHigh} Hz</Text>
              <View style={styles.paramButtons}>
                <TouchableOpacity
                  style={styles.paramButton}
                  onPress={() => setBandPassHigh(Math.max(bandPassLow + 0.5, bandPassHigh - 1))}
                >
                  <Text style={styles.paramButtonText}>-</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.paramButton}
                  onPress={() => setBandPassHigh(Math.min(30, bandPassHigh + 1))}
                >
                  <Text style={styles.paramButtonText}>+</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}
      </View>

      {/* Sensor Data Display */}
      {showRawValues && (
        <>
          {renderSensorGrid(ppgSensors, '❤️ PPG Sensors')}
          {renderSensorGrid(bioSensors, '🧬 Biometric Sensors')}
          {renderSensorGrid(imuSensors, '📐 9-Axis IMU')}
        </>
      )}

      {/* Info */}
      <View style={styles.infoCard}>
        <Text style={styles.infoTitle}>ℹ️ Sensor Information</Text>
        <Text style={styles.infoText}>
          • PPG: Photoplethysmography for heart rate{'\n'}
          • EDA: Electrodermal Activity (skin conductance){'\n'}
          • IMU: 9-axis motion tracking (gyro + accelerometer){'\n'}
          • Sampling Rate: {1000 / UPDATE_INTERVAL} Hz{'\n'}
          • Window: {WINDOW_SIZE} samples (~{(WINDOW_SIZE * UPDATE_INTERVAL / 1000).toFixed(1)}s)
        </Text>
      </View>
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    backgroundColor: '#6366f1',
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#94a3b8',
    marginRight: 6,
  },
  statusDotActive: {
    backgroundColor: '#22c55e',
  },
  statusText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#fff',
  },
  controlsCard: {
    backgroundColor: '#fff',
    padding: 16,
    marginTop: 16,
    marginHorizontal: 16,
    borderRadius: 12,
    elevation: 2,
  },
  controlRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  controlButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  primaryButton: {
    backgroundColor: '#22c55e',
  },
  stopButton: {
    backgroundColor: '#ef4444',
  },
  secondaryButton: {
    backgroundColor: '#64748b',
  },
  controlButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
  settingRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  settingLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1e293b',
  },
  waveformCard: {
    backgroundColor: '#fff',
    padding: 16,
    marginTop: 16,
    marginHorizontal: 16,
    borderRadius: 12,
    elevation: 2,
  },
  waveformHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  waveformTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1e293b',
  },
  filterBadge: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
    backgroundColor: '#f1f5f9',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  chartContainer: {
    alignItems: 'center',
    overflow: 'hidden',
    borderRadius: 12,
    marginBottom: 16,
  },
  chart: {
    borderRadius: 12,
  },
  waveformStats: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#f1f5f9',
  },
  stat: {
    alignItems: 'center',
  },
  statLabel: {
    fontSize: 11,
    color: '#94a3b8',
    marginBottom: 4,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  statValue: {
    fontSize: 16,
    fontWeight: '700',
  },
  filterCard: {
    backgroundColor: '#fff',
    padding: 16,
    marginTop: 16,
    marginHorizontal: 16,
    borderRadius: 12,
    elevation: 2,
  },
  filterTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1e293b',
    marginBottom: 16,
  },
  filterTypeRow: {
    flexDirection: 'row',
    gap: 8,
  },
  filterButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: '#f1f5f9',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#e2e8f0',
  },
  filterButtonActive: {
    backgroundColor: '#6366f1',
    borderColor: '#6366f1',
  },
  filterButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#64748b',
  },
  filterButtonTextActive: {
    color: '#fff',
  },
  filterParams: {
    marginTop: 16,
    padding: 12,
    backgroundColor: '#f8fafc',
    borderRadius: 8,
  },
  paramRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
  },
  paramLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1e293b',
  },
  paramButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  paramButton: {
    backgroundColor: '#3b82f6',
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  paramButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  sensorGroup: {
    backgroundColor: '#fff',
    padding: 16,
    marginTop: 16,
    marginHorizontal: 16,
    borderRadius: 12,
    elevation: 2,
  },
  groupTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1e293b',
    marginBottom: 12,
  },
  sensorGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  sensorCard: {
    flex: 1,
    minWidth: '30%',
    backgroundColor: '#f8fafc',
    padding: 12,
    borderRadius: 8,
    borderLeftWidth: 4,
  },
  sensorLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
    marginBottom: 4,
  },
  sensorValue: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1e293b',
  },
  sensorUnit: {
    fontSize: 11,
    color: '#94a3b8',
    marginTop: 2,
  },
  legendContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    paddingTop: 12,
    gap: 12,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  legendText: {
    fontSize: 11,
    color: '#64748b',
    fontWeight: '600',
  },
  minuteSummaryCard: {
    backgroundColor: '#0f172a',
    borderRadius: 16,
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 16,
  },
  minuteSummaryTitle: {
    color: '#f8fafc',
    fontSize: 16,
    fontWeight: '800',
    marginBottom: 12,
  },
  minuteSummaryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  minuteSummaryItem: {
    borderBottomColor: '#334155',
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 7,
    width: '50%',
  },
  minuteSummaryLabel: {
    color: '#94a3b8',
    fontSize: 9,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  minuteSummaryValue: {
    color: '#f8fafc',
    fontSize: 12,
    fontWeight: '800',
    marginTop: 2,
  },
  infoCard: {
    backgroundColor: '#f8fafc',
    padding: 16,
    margin: 16,
    marginBottom: 32,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  infoTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#1e293b',
    marginBottom: 8,
  },
  infoText: {
    fontSize: 13,
    color: '#64748b',
    lineHeight: 20,
  },
});

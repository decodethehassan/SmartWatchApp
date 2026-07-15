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
    EDA: { type: 'EDA', label: 'EDA', value: 0, unit: 'µS', color: '#3b82f6', buffer: Array(WINDOW_SIZE).fill(0) },
    GYRO_X: { type: 'GYRO_X', label: 'Gyro-X', value: 0, unit: 'mdps', color: '#8b5cf6', buffer: Array(WINDOW_SIZE).fill(0) },
    GYRO_Y: { type: 'GYRO_Y', label: 'Gyro-Y', value: 0, unit: 'mdps', color: '#a855f7', buffer: Array(WINDOW_SIZE).fill(0) },
    GYRO_Z: { type: 'GYRO_Z', label: 'Gyro-Z', value: 0, unit: 'mdps', color: '#c084fc', buffer: Array(WINDOW_SIZE).fill(0) },
    ACC_X: { type: 'ACC_X', label: 'Accel-X', value: 0, unit: 'mg', color: '#06b6d4', buffer: Array(WINDOW_SIZE).fill(0) },
    ACC_Y: { type: 'ACC_Y', label: 'Accel-Y', value: 0, unit: 'mg', color: '#0891b2', buffer: Array(WINDOW_SIZE).fill(0) },
    ACC_Z: { type: 'ACC_Z', label: 'Accel-Z', value: 0, unit: 'mg', color: '#0e7490', buffer: Array(WINDOW_SIZE).fill(0) },
    TEMP: { type: 'TEMP', label: 'Temperature', value: 0, unit: '°C', color: '#f59e0b', buffer: Array(WINDOW_SIZE).fill(0) },
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

  // Sync real BLE sensor data into the display buffers whenever live state changes.
  // Does NOT require isStreaming so values are always visible when connected.
  useEffect(() => {
    if (useSyntheticData) return;

    setSensors(prev => {
      const updated = { ...prev };

      // Temperature (AS6221)
      if (live.temperature.lastUpdated) {
        const temp = sanitizeSensorValue(live.temperature.tempC, -40, 125);
        updated.TEMP = {
          ...updated.TEMP,
          value: temp,
          buffer: [...updated.TEMP.buffer.slice(1), temp],
        };
      }

      // PPG (MAX30101)
      if (live.ppg.lastUpdated) {
        const ir = 0;
        const red = 0;
        const green = sanitizeSensorValue(live.ppg.green, 0, 400000);
        updated.PPG_IR = { ...updated.PPG_IR, value: ir, buffer: [...updated.PPG_IR.buffer.slice(1), ir] };
        updated.PPG_RED = { ...updated.PPG_RED, value: red, buffer: [...updated.PPG_RED.buffer.slice(1), red] };
        updated.PPG_GREEN = { ...updated.PPG_GREEN, value: green, buffer: [...updated.PPG_GREEN.buffer.slice(1), green] };
      }

      // Accelerometer (LSM6DSO) — in mg
      if (live.accel.lastUpdated) {
        const ax = sanitizeSensorValue(live.accel.x, -16000, 16000);
        const ay = sanitizeSensorValue(live.accel.y, -16000, 16000);
        const az = sanitizeSensorValue(live.accel.z, -16000, 16000);
        updated.ACC_X = { ...updated.ACC_X, value: ax, buffer: [...updated.ACC_X.buffer.slice(1), ax] };
        updated.ACC_Y = { ...updated.ACC_Y, value: ay, buffer: [...updated.ACC_Y.buffer.slice(1), ay] };
        updated.ACC_Z = { ...updated.ACC_Z, value: az, buffer: [...updated.ACC_Z.buffer.slice(1), az] };
      }

      // Gyroscope (LSM6DSO) — in mdps
      if (live.gyro.lastUpdated) {
        const gx = sanitizeSensorValue(live.gyro.x, -300000, 300000);
        const gy = sanitizeSensorValue(live.gyro.y, -300000, 300000);
        const gz = sanitizeSensorValue(live.gyro.z, -300000, 300000);
        updated.GYRO_X = { ...updated.GYRO_X, value: gx, buffer: [...updated.GYRO_X.buffer.slice(1), gx] };
        updated.GYRO_Y = { ...updated.GYRO_Y, value: gy, buffer: [...updated.GYRO_Y.buffer.slice(1), gy] };
        updated.GYRO_Z = { ...updated.GYRO_Z, value: gz, buffer: [...updated.GYRO_Z.buffer.slice(1), gz] };
      }

      // EDA (ADS1113)
      if (live.eda.lastUpdated) {
        const cond = sanitizeSensorValue(live.eda.conductance_uS, 0, 200);
        updated.EDA = { ...updated.EDA, value: cond, buffer: [...updated.EDA.buffer.slice(1), cond] };
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

  // Create chart data for Acc & Gyro (6 axes)
  const createAccGyroChartData = () => {
    const accGyroTypes: SensorType[] = ['GYRO_X', 'GYRO_Y', 'GYRO_Z', 'ACC_X', 'ACC_Y', 'ACC_Z'];
    return {
      labels: Array(WINDOW_SIZE).fill(''),
      datasets: accGyroTypes.map((type) => {
        const sensor = sensors[type];
        const filteredData = getFilteredData(sensor.buffer);
        return {
          data: filteredData.length > 0 ? filteredData : [0],
          color: (opacity = 1) => sensor.color,
          strokeWidth: 1.5,
        };
      }),
      legend: accGyroTypes.map((type) => sensors[type].label),
    };
  };

  // Create chart data for EDA
  const createEDAChartData = () => {
    const sensor = sensors.EDA;
    const filteredData = getFilteredData(sensor.buffer);
    return {
      labels: Array(WINDOW_SIZE).fill(''),
      datasets: [{
        data: filteredData.length > 0 ? filteredData : [0],
        color: (opacity = 1) => sensor.color,
        strokeWidth: 2.5,
      }],
    };
  };

  // Create chart data for Temperature
  const createTempChartData = () => {
    const sensor = sensors.TEMP;
    const filteredData = getFilteredData(sensor.buffer);
    return {
      labels: Array(WINDOW_SIZE).fill(''),
      datasets: [{
        data: filteredData.length > 0 ? filteredData : [0],
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

          // Format IMU values as integers (0 decimals), others with appropriate precision
          const isIMUData = sensorType.startsWith('GYRO_') || sensorType.startsWith('ACC_');
          const decimals = isIMUData ? 0 : 5;

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

      {/* Accelerometer & Gyroscope Graph */}
      <View style={styles.waveformCard}>
        <View style={styles.waveformHeader}>
          <Text style={styles.waveformTitle}>📊 Acc & Gyro</Text>
          <Text style={styles.filterBadge}>
            {filterType === 'none' ? 'Raw' :
              filterType === 'lowpass' ? `LP ${lowPassCutoff}Hz` :
                `BP ${bandPassLow}-${bandPassHigh}Hz`}
          </Text>
        </View>

        <View style={styles.chartContainer}>
          <LineChart
            data={createAccGyroChartData()}
            width={screenWidth - 48}
            height={220}
            chartConfig={{
              backgroundColor: '#8b5cf6',
              backgroundGradientFrom: '#8b5cf6',
              backgroundGradientTo: '#7c3aed',
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

        <View style={styles.legendContainer}>
          {imuSensors.map((sensorType) => {
            const sensor = sensors[sensorType];
            return (
              <View key={sensorType} style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: sensor.color }]} />
                <Text style={styles.legendText}>{sensor.label}</Text>
              </View>
            );
          })}
        </View>
      </View>

      {/* EDA Graph */}
      <View style={styles.waveformCard}>
        <View style={styles.waveformHeader}>
          <Text style={styles.waveformTitle}>📊 EDA</Text>
          <Text style={styles.filterBadge}>
            {filterType === 'none' ? 'Raw' :
              filterType === 'lowpass' ? `LP ${lowPassCutoff}Hz` :
                `BP ${bandPassLow}-${bandPassHigh}Hz`}
          </Text>
        </View>

        <View style={styles.chartContainer}>
          <LineChart
            data={createEDAChartData()}
            width={screenWidth - 48}
            height={220}
            chartConfig={{
              backgroundColor: '#3b82f6',
              backgroundGradientFrom: '#3b82f6',
              backgroundGradientTo: '#2563eb',
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
              {Math.max(...getFilteredData(sensors.EDA.buffer)).toFixed(2)}
            </Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statLabel}>Min</Text>
            <Text style={[styles.statValue, { color: sensors.EDA.color }]}>
              {Math.min(...getFilteredData(sensors.EDA.buffer)).toFixed(2)}
            </Text>
          </View>
        </View>
      </View>

      {/* Temperature Graph */}
      <View style={styles.waveformCard}>
        <View style={styles.waveformHeader}>
          <Text style={styles.waveformTitle}>📊 Temp</Text>
          <Text style={styles.filterBadge}>
            {filterType === 'none' ? 'Raw' :
              filterType === 'lowpass' ? `LP ${lowPassCutoff}Hz` :
                `BP ${bandPassLow}-${bandPassHigh}Hz`}
          </Text>
        </View>

        <View style={styles.chartContainer}>
          <LineChart
            data={createTempChartData()}
            width={screenWidth - 48}
            height={220}
            chartConfig={{
              backgroundColor: '#f59e0b',
              backgroundGradientFrom: '#f59e0b',
              backgroundGradientTo: '#d97706',
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
              {Math.max(...getFilteredData(sensors.TEMP.buffer)).toFixed(2)}
            </Text>
          </View>
          <View style={styles.stat}>
            <Text style={styles.statLabel}>Min</Text>
            <Text style={[styles.statValue, { color: sensors.TEMP.color }]}>
              {Math.min(...getFilteredData(sensors.TEMP.buffer)).toFixed(2)}
            </Text>
          </View>
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

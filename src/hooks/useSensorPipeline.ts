/**
 * useSensorPipeline.ts
 *
 * Unified hook that wires together the complete data pipeline:
 *
 *   BLE device  ──►  BLEContext (receivedMessages)
 *                         │
 *                         ▼
 *                   SensorParser       ← parse raw log lines
 *                         │
 *              ┌──────────┴──────────┐
 *              ▼                     ▼
 *       React state              Firebase
 *    (live sensor UI)         (Firestore storage)
 *
 * Usage:
 *   const { live, session, startSession, stopSession } = useSensorPipeline();
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { DeviceEventEmitter } from 'react-native';
import { useBLE } from '../functionality/BLEContext';
import { useAuth } from '../auth/AuthContext';
import { bleService } from '../functionality/BLEService';
import {
  parseSensorLine,
  edaMvToMicrosiemens,
  magnitude,
  celsiusToFahrenheit,
  estimateStressLevel,
  type ParsedSensorReading,
  type TemperatureParsed,
  type PPGParsed,
  type PPGStreamParsed,
  type PPGWindowParsed,
  type V0MinParsed,
  type IMUCombinedParsed,
  type EDAParsed,
} from '../functionality/SensorParser';
import {
  saveTemperatureReading,
  saveEDAReading,
  savePPGReading,
  saveHeartRateReading,
  saveAccelerometerReading,
  saveGyroscopeReading,
  saveIMUReading,
  startSession as fbStartSession,
  endSession as fbEndSession,
  saveDeviceInfo,
  stopDataLogger,
  startFirebaseWriteBatcher,
  stopFirebaseWriteBatcher,
  flushFirebaseWriteQueue,
} from '../firebase/dataLogger';
import { SensorType } from '../firebase/sensorTypes';

// ─────────────────────────────────────────────────────────────────────────────
// DEBOUNCED STATE UPDATES (Prevent Update Storms)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Custom hook: useDebouncedState
 * 
 * Prevents UI update storms when data arrives at >60fps (high-frequency IMU).
 * 
 * The Problem:
 *   LSM6DSO IMU streams 104 Hz → setState called 104 times/second
 *   Each setState triggers re-render → browser can't keep up
 *   App becomes unresponsive, battery drains fast
 * 
 * The Solution:
 *   Batch multiple setState calls into single update every 16ms (60fps target)
 *   requestAnimationFrame automatically syncs with browser refresh rate
 *   User sees smooth motion at 60fps instead of choppy 104 updates
 * 
 * Implementation:
 *   - setState queues new value
 *   - requestAnimationFrame triggers actual state update
 *   - If new value arrives before frame, only latest is processed
 *   - App stays responsive, battery usage drops
 * 
 * Usage:
 *   const [live, setLive] = useDebouncedState(initialLiveState, 16);
 *   // Now setState calls are batched and won't exceed 60fps
 */
export function useDebouncedState<T>(
  initialState: T,
  delayMs: number = 16 // 16ms ≈ 60fps
): [T, (newState: T | ((prev: T) => T)) => void] {
  const [state, setState] = useState<T>(initialState);
  const pendingStateRef = useRef<T | null>(null);
  const animFrameIdRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (animFrameIdRef.current) {
        cancelAnimationFrame(animFrameIdRef.current);
      }
    };
  }, []);

  const setDebouncedState = useCallback(
    (newState: T | ((prev: T) => T)) => {
      // Resolve functional updates
      const resolvedState =
        typeof newState === 'function'
          ? (newState as (prev: T) => T)(state)
          : newState;

      // Queue the state update
      pendingStateRef.current = resolvedState;

      // Cancel existing frame request if any
      if (animFrameIdRef.current) {
        cancelAnimationFrame(animFrameIdRef.current);
      }

      // Schedule state update on next animation frame
      animFrameIdRef.current = requestAnimationFrame(() => {
        if (isMountedRef.current && pendingStateRef.current !== null) {
          setState(pendingStateRef.current);
          pendingStateRef.current = null;
        }
        animFrameIdRef.current = null;
      });
    },
    [state]
  );

  return [state, setDebouncedState];
}

/**
 * Alternative: createDebouncedSetter (without hooks)
 * 
 * For use cases where you need debouncing but can't use hooks.
 * Returns a function that batches setState calls.
 * 
 * Usage:
 *   const setLiveFn = createDebouncedSetter(setLive);
 *   // Calls to setLiveFn will be batched at 16ms intervals
 */
export function createDebouncedSetter<T>(
  setter: (state: T) => void,
  delayMs: number = 16
): (newState: T | ((prev: T) => T)) => void {
  let pendingState: T | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let lastState: T | undefined;

  return (newState: T | ((prev: T) => T)) => {
    const resolvedState =
      typeof newState === 'function' && lastState !== undefined
        ? (newState as (prev: T) => T)(lastState)
        : newState;

    pendingState = resolvedState as T;
    lastState = resolvedState as T;

    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(() => {
      if (pendingState !== null) {
        setter(pendingState);
        pendingState = null;
      }
      timeoutId = null;
    }, delayMs);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Live (in-memory) sensor state - SIMPLIFIED
// ─────────────────────────────────────────────────────────────────────────────

export interface IMUReading {
  ax_mg: number;  // accelerometer x (mg)
  ay_mg: number;  // accelerometer y (mg)
  az_mg: number;  // accelerometer z (mg)
  gx_mdps: number;  // stabilized gyroscope x (mdps)
  gy_mdps: number;  // stabilized gyroscope y (mdps)
  gz_mdps: number;  // stabilized gyroscope z (mdps)
  raw_gx_mdps: number; // raw gyroscope x (mdps, Python-GUI style)
  raw_gy_mdps: number; // raw gyroscope y (mdps, Python-GUI style)
  raw_gz_mdps: number; // raw gyroscope z (mdps, Python-GUI style)
}

export interface SensorState {
  red: number | null;
  ir: number | null;
  green: number | null;
  imu: IMUReading | null;
  edaRaw: number | null;
  edaMv: number | null;
  edaUs: number | null;
  temp_c: number | null;
  lastUpdate: number;
  tempUpdated: number;
  ppgUpdated: number;
  imuUpdated: number;
  edaUpdated: number;
}

const initialSensorState: SensorState = {
  red: null,
  ir: null,
  green: null,
  imu: null,
  edaRaw: null,
  edaMv: null,
  edaUs: null,
  temp_c: null,
  lastUpdate: 0,
  tempUpdated: 0,
  ppgUpdated: 0,
  imuUpdated: 0,
  edaUpdated: 0,
};

/** Maximum number of PPG waveform samples kept in the rolling buffer. ~10s at 50Hz stream. */
export const PPG_WAVEFORM_BUFFER_SIZE = 512;

// Keep old LiveSensorState for compatibility with other parts of code
export interface LiveSensorState {
  /** AS6221 temperature sensor */
  temperature: {
    tempC: number;
    tempF: number;
    lastUpdated: Date | null;
  };
  /** MAX30101 PPG raw channel values */
  ppg: {
    red: number;
    ir: number;
    green: number;
    lastUpdated: Date | null;
  };
  /**
   * Firmware-filtered PPG waveform stream (from PPG_STREAM / PV BLE lines).
   * The `filt` array holds baseline-removed, high-passed PPG samples at ~50 Hz.
   * The `peaks` array holds booleans marking accepted beat positions.
   * Used to render the real-time PPG waveform in MAX30101Monitor.
   */
  ppgStream: {
    filt: number[];        // rolling waveform samples (firmware high-pass filtered)
    th: number[];          // adaptive threshold line
    peaks: boolean[];      // peak markers for beat annotations
    timestamps: number[];  // firmware t_ms values for each sample
    lastUpdated: Date | null;
  };
  /**
   * Firmware-computed heart rate and IBI.
   * Updated from PPG_STREAM peak events and V0_MIN 1-minute summaries.
   */
  heartRate: {
    /** Heart rate in BPM. -1 means no valid reading. */
    bpm: number;
    /** Most recent inter-beat interval in ms */
    ibi_ms: number;
    /** 'high' = qok+good, 'low' = qok but SQI borderline, 'invalid' = no valid reading */
    confidence: 'high' | 'low' | 'invalid';
    /** True when the firmware quality gate has passed (qok=1) */
    qualityOk: boolean;
    lastUpdated: Date | null;
  };
  /** Signal quality from the 5s PV_WIN windows */
  ppgQuality: {
    sqi: number;          // 0.0–1.0 signal quality index
    artifact: boolean;    // motion artifact flag
    qualityOk: boolean;   // combined quality gate
    wearDetected: boolean; // IR > wear threshold = skin contact
    lastUpdated: Date | null;
  };
  /** HRV from V0_MIN 1-minute summaries */
  hrv: {
    rmssd_ms: number;
    quality: string;
    lastUpdated: Date | null;
  };
  /** V0_MIN activity / sleep classification (1-minute cadence) */
  activity: {
    state: string;     // REST | LOW | WALK | VIG
    confidence: number;
    sleepState: string; // SLEEP | WAKE
    sleepConf: number;
    lastUpdated: Date | null;
  };
  /** LSM6DSO Accelerometer (mg) */
  accel: {
    x: number;
    y: number;
    z: number;
    magnitude: number;
    lastUpdated: Date | null;
  };
  /** LSM6DSO Gyroscope (mdps) */
  gyro: {
    x: number;      // stabilized
    y: number;      // stabilized
    z: number;      // stabilized
    rawX: number;   // raw value from STORED_RAW_IMU / parser
    rawY: number;
    rawZ: number;
    magnitude: number;
    lastUpdated: Date | null;
  };
  /** ADS1113 EDA/GSR */
  eda: {
    rawADC: number;
    mv: number;
    conductance_uS: number;
    stressLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH';
    lastUpdated: Date | null;
  };
}

const initialLiveState: LiveSensorState = {
  temperature: { tempC: 0, tempF: 0, lastUpdated: null },
  ppg: { red: 0, ir: 0, green: 0, lastUpdated: null },
  ppgStream: { filt: [], th: [], peaks: [], timestamps: [], lastUpdated: null },
  heartRate: { bpm: -1, ibi_ms: 0, confidence: 'invalid', qualityOk: false, lastUpdated: null },
  ppgQuality: { sqi: 0, artifact: false, qualityOk: false, wearDetected: false, lastUpdated: null },
  hrv: { rmssd_ms: -1, quality: 'INVALID', lastUpdated: null },
  activity: { state: 'UNKNOWN', confidence: 0, sleepState: 'WAKE', sleepConf: 0, lastUpdated: null },
  accel: { x: 0, y: 0, z: 0, magnitude: 0, lastUpdated: null },
  gyro: { x: 0, y: 0, z: 0, rawX: 0, rawY: 0, rawZ: 0, magnitude: 0, lastUpdated: null },
  eda: { rawADC: 0, mv: 0, conductance_uS: 0, stressLevel: 'LOW', lastUpdated: null },
};

// ─────────────────────────────────────────────────────────────────────────────
// Session state
// ─────────────────────────────────────────────────────────────────────────────

export interface PipelineSession {
  sessionId: string | null;
  isRecording: boolean;
  startedAt: Date | null;
  dataPointsSaved: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Firebase throttle config
// ─────────────────────────────────────────────────────────────────────────────

/** Minimum ms between Firebase writes per sensor type to avoid overwhelming Firestore */
const FB_MIN_INTERVAL_MS: Record<string, number> = {
  temperature: 5_000,  // every 5 s
  ppg: 2_000,  // every 2 s (PPG is high-frequency)
  eda: 3_000,  // every 3 s
  imu: 2_000,  // every 2 s
};

const MAX_MESSAGES_PER_TICK = 400;
const MAX_PARSE_ERRORS_PER_TICK = 20;
const ENABLE_VERBOSE_PIPELINE_LOGS = false;

// ─────────────────────────────────────────────────────────────────────────────
// Sensor bounds & rate-of-change validation (Per Firmware Specs)
// IMPORTANT: These are SPIKE thresholds (detecting errors/noise), not change thresholds.
// Legitimate small changes (HR increase, stress response, etc.) are 100x smaller than
// these thresholds and will always pass through to the app.
// ─────────────────────────────────────────────────────────────────────────────

// ── TEMPERATURE (AS6221) ──────────────────────────────────────────────────
/** Temperature sensor range: -40°C to +125°C; realistic wristband: 20-45°C */
const TEMP_MIN_C = -40;
const TEMP_MAX_C = 125;
const TEMP_WARN_MIN_C = 15;
const TEMP_WARN_MAX_C = 50;
/** Max temperature change per sample (4 Hz = 250ms) before treating as spike.
 *  Normal changes (e.g., exercise): ~0.003°C per sample.
 *  Threshold of 0.5°C = 150x above normal, catches only firmware errors.
 */
const TEMP_MAX_DELTA_C = 0.5;

// ── PPG (MAX30101) ────────────────────────────────────────────────────────
/** PPG 18-bit unsigned: 0–262,143. Wear detection: IR > 50,000 = worn */
const PPG_MAX_VALUE = 262_143;
const PPG_MIN_VALID = 0;
const PPG_WEAR_THRESHOLD = 50_000;
// NOTE: PPG has NO rate-of-change checking — heart rate changes
// (even small 70→75 bpm increases) will pass through immediately.

// ── GYROSCOPE (LSM6DSO ±250 dps config) ──────────────────────────────────
/** Gyroscope firmware range: ±250 dps (±250,000 mdps) */
const GYRO_MAX_MDPS = 250_000;
/** Max gyro delta per sample: 50,000 mdps/sample (~32 Hz firmware = ~30ms).
 *  Normal arm motion: ~5k mdps per sample. Threshold 50k = 10x above normal.
 *  Only rejects extreme spikes (aggressive shakes, sensor glitches).
 */
const GYRO_MAX_DELTA_MDPS = 50_000;
/** Deadband near 0 mdps to suppress sensor noise when device is still. */
const GYRO_STILL_DEADBAND_MDPS = 900;
/** EMA smoothing factor at rest (smaller = more smoothing). */
const GYRO_SMOOTH_ALPHA_REST = 0.18;
/** EMA smoothing factor while moving (larger = more responsive). */
const GYRO_SMOOTH_ALPHA_MOTION = 0.45;
/** Bias tracker learning rate when the device is still. */
const GYRO_BIAS_TRACK_ALPHA = 0.02;
/** Max bias magnitude we allow the tracker to learn. */
const GYRO_BIAS_MAX_MDPS = 4_000;
/** Gyro magnitude threshold considered still-ish for bias learning. */
const GYRO_STILL_MAG_MDPS = 2_500;

// ── ACCELEROMETER (LSM6DSO ±16g range) ────────────────────────────────────
/** Accelerometer firmware range: ±16 g (±16,000 mg) */
const ACCEL_MAX_MG = 16_000;
/** Max accel delta per sample: 2,000 mg/sample (~32 Hz firmware = ~30ms).
 *  Normal arm motion: ~200 mg per sample. Threshold 2k = 10x above normal.
 *  Only rejects extreme spikes (impact, sensor error).
 */
const ACCEL_MAX_DELTA_MG = 2_000;
/** Accel magnitude must be near 1g to consider device still. */
const ACCEL_STILL_TOL_MG = 150;

// ── EDA (ADS1113 16-bit signed) ───────────────────────────────────────────
/** EDA raw ADC range: -32,768 to +32,767 (16-bit signed) */
const EDA_MAX_RAW = 32_767;
const EDA_MIN_RAW = -32_768;
/** EDA mV range: ~-4,095 to +4,095 mV (raw * 125 / 1000) */
const EDA_MAX_MV = 4_095;
const EDA_MIN_MV = -4_095;
/** Max EDA delta per sample (4 Hz = 250ms) before treating as spike.
 *  Normal stress response: ~1-2 µS per second = ~0.25-0.5 µS per sample.
 *  Threshold 50 µS = 100x above normal, catches only firmware errors.
 */
const EDA_MAX_DELTA_US = 50.0; // microSiemens per sample

// ─────────────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────────────

export function useSensorPipeline() {
  const { receivedMessages, isConnected, connectedDevice, connectedDeviceName, isEarbudConnected } = useBLE();
  const { user } = useAuth();

  const [live, setLive] = useState<LiveSensorState>(initialLiveState);
  const [session, setSession] = useState<PipelineSession>({
    sessionId: null,
    isRecording: false,
    startedAt: null,
    dataPointsSaved: 0,
  });

  // Track last-processed message index so we don't re-process old messages
  const lastProcessedIdx = useRef<number>(0);
  const liveRef = useRef<LiveSensorState>(initialLiveState);
  const lastUiPublishRef = useRef(0);

  // ✅ UI STATE THROTTLING: Store latest readings in useRef, update UI at 33ms intervals
  // This prevents React from freezing when high-frequency sensors (100Hz IMU, 100Hz PPG)
  // try to update state on every packet.
  const latestReadingsRef = useRef<SensorState>(initialSensorState);

  // Firebase write throttle: track last write time per sensor type
  const lastFbWrite = useRef<Record<string, number>>({});
  const isMountedRef = useRef(true);
  const startInFlightRef = useRef(false);
  const stopInFlightRef = useRef(false);

  // CRITICAL: Keep user/session accessible to BLE listener without recreating it
  // This allows Firebase writes to continue even if dependencies change
  const userRef = useRef(user);
  const sessionRef = useRef(session);
  const connectedDeviceRef = useRef(connectedDevice);
  const connectedDeviceNameRef = useRef(connectedDeviceName);
  const isEarbudConnectedRef = useRef(isEarbudConnected);

  // Update refs whenever these change so BLE listener callback sees latest values
  useEffect(() => {
    userRef.current = user;
    sessionRef.current = session;
    connectedDeviceRef.current = connectedDevice;
    connectedDeviceNameRef.current = connectedDeviceName;
    isEarbudConnectedRef.current = isEarbudConnected;
  }, [user, session, connectedDevice, connectedDeviceName, isEarbudConnected]);

  // ─────────────────────────────────────────────────────────────────────────
  // Layer 3 & 4 Diagnostic Heartbeats
  // ─────────────────────────────────────────────────────────────────────────
  const layer3RejectionCountRef = useRef<number>(0);
  const layer3LastHeartbeatRef = useRef<number>(Date.now());
  const layer4LastHeartbeatRef = useRef<number>(Date.now());
  const layer4RenderCountRef = useRef<number>(0);

  // Track previous sensor values for rate-of-change validation
  const prevIMURef = useRef<{
    gyro: { x: number; y: number; z: number };
    accel: { x: number; y: number; z: number };
    tempC: number;
    ppgIr: number;
    edaUs: number;
  }>({
    gyro: { x: 0, y: 0, z: 0 },
    accel: { x: 0, y: 0, z: 0 },
    tempC: 25, // human body baseline
    ppgIr: 100_000, // reasonable PPG baseline
    edaUs: 5, // baseline conductance ~5 µS
  });

  const hasPrevRef = useRef<{
    gyro: { x: boolean; y: boolean; z: boolean };
    accel: { x: boolean; y: boolean; z: boolean };
    tempC: boolean;
    edaUs: boolean;
  }>({
    gyro: { x: false, y: false, z: false },
    accel: { x: false, y: false, z: false },
    tempC: false,
    edaUs: false,
  });

  // Per-axis gyro bias learned only while device is still.
  const gyroBiasRef = useRef<{ x: number; y: number; z: number }>({ x: 0, y: 0, z: 0 });

  const resetValidationState = useCallback(() => {
    prevIMURef.current = {
      gyro: { x: 0, y: 0, z: 0 },
      accel: { x: 0, y: 0, z: 0 },
      tempC: 25,
      ppgIr: 100_000,
      edaUs: 5,
    };
    hasPrevRef.current = {
      gyro: { x: false, y: false, z: false },
      accel: { x: false, y: false, z: false },
      tempC: false,
      edaUs: false,
    };
    gyroBiasRef.current = { x: 0, y: 0, z: 0 };
  }, []);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // ── helpers ───────────────────────────────────────────────────────────────

  const canWriteToFirebase = useCallback((sensorKey: string): boolean => {
    const now = Date.now();
    const last = lastFbWrite.current[sensorKey] ?? 0;
    const minGap = FB_MIN_INTERVAL_MS[sensorKey] ?? 2_000;
    return now - last > minGap;
  }, []);

  const markFbWrite = useCallback((sensorKey: string) => {
    lastFbWrite.current[sensorKey] = Date.now();
  }, []);

  const toFinite = useCallback((value: number, fallback = 0) => {
    return Number.isFinite(value) ? value : fallback;
  }, []);

  /**
   * Validate and clamp gyroscope value.
   * Checks bounds and rate-of-change to reject spikes.
   */
  const validateGyro = useCallback((axis: 'x' | 'y' | 'z', value: number): boolean => {
    const clamped = Math.max(-GYRO_MAX_MDPS, Math.min(GYRO_MAX_MDPS, value));
    if (!hasPrevRef.current.gyro[axis]) {
      prevIMURef.current.gyro[axis] = clamped;
      hasPrevRef.current.gyro[axis] = true;
      return true;
    }
    const prev = prevIMURef.current.gyro[axis];
    const delta = Math.abs(clamped - prev);
    if (delta > GYRO_MAX_DELTA_MDPS) {
      if (ENABLE_VERBOSE_PIPELINE_LOGS) {
        console.warn(`[Pipeline] GYRO-${axis} spike rejected: ${value} mdps (delta=${delta})`);
      }
      return false;
    }
    prevIMURef.current.gyro[axis] = clamped;
    return true;
  }, []);

  /**
   * Stabilize gyro per-axis with clamp + spike reject + deadband + EMA smoothing.
   * This reduces jitter at rest while keeping motion responsive.
   */
  const stabilizeGyroAxis = useCallback((axis: 'x' | 'y' | 'z', value: number): number => {
    const clamped = Math.max(-GYRO_MAX_MDPS, Math.min(GYRO_MAX_MDPS, toFinite(value, 0)));

    if (!hasPrevRef.current.gyro[axis]) {
      hasPrevRef.current.gyro[axis] = true;
      prevIMURef.current.gyro[axis] = Math.abs(clamped) < GYRO_STILL_DEADBAND_MDPS ? 0 : clamped;
      return prevIMURef.current.gyro[axis];
    }

    const prev = prevIMURef.current.gyro[axis];
    const delta = Math.abs(clamped - prev);

    // Reject impossible per-sample jumps.
    if (delta > GYRO_MAX_DELTA_MDPS) {
      if (ENABLE_VERBOSE_PIPELINE_LOGS) {
        console.warn(`[Pipeline] GYRO-${axis} spike rejected: ${clamped} mdps (delta=${delta})`);
      }
      return prev;
    }

    // Treat near-zero as stillness and snap to zero to suppress drift/noise.
    if (Math.abs(clamped) < GYRO_STILL_DEADBAND_MDPS && Math.abs(prev) < GYRO_STILL_DEADBAND_MDPS) {
      prevIMURef.current.gyro[axis] = 0;
      return 0;
    }

    const alpha = Math.abs(clamped) < (GYRO_STILL_DEADBAND_MDPS * 2)
      ? GYRO_SMOOTH_ALPHA_REST
      : GYRO_SMOOTH_ALPHA_MOTION;
    const smoothed = (alpha * clamped) + ((1 - alpha) * prev);

    // Final tiny-noise cleanup around zero after smoothing.
    const finalVal = Math.abs(smoothed) < (GYRO_STILL_DEADBAND_MDPS * 0.75) ? 0 : smoothed;
    prevIMURef.current.gyro[axis] = finalVal;
    return finalVal;
  }, [toFinite]);

  /**
   * Validate and clamp accelerometer value.
   * Checks bounds and rate-of-change to reject spikes.
   */
  const validateAccel = useCallback((axis: 'x' | 'y' | 'z', value: number): boolean => {
    const clamped = Math.max(-ACCEL_MAX_MG, Math.min(ACCEL_MAX_MG, value));
    if (!hasPrevRef.current.accel[axis]) {
      prevIMURef.current.accel[axis] = clamped;
      hasPrevRef.current.accel[axis] = true;
      return true;
    }
    const prev = prevIMURef.current.accel[axis];
    const delta = Math.abs(clamped - prev);
    if (delta > ACCEL_MAX_DELTA_MG) {
      if (ENABLE_VERBOSE_PIPELINE_LOGS) {
        console.warn(`[Pipeline] ACCEL-${axis} spike rejected: ${value} mg (delta=${delta})`);
      }
      return false;
    }
    prevIMURef.current.accel[axis] = clamped;
    return true;
  }, []);

  /**
   * Validate temperature: clamp to firmware bounds and check sanity.
   */
  const validateTemp = useCallback((value: number): number => {
    const clamped = Math.max(TEMP_MIN_C, Math.min(TEMP_MAX_C, value));
    if (!hasPrevRef.current.tempC) {
      prevIMURef.current.tempC = clamped;
      hasPrevRef.current.tempC = true;
      return clamped;
    }
    const prev = prevIMURef.current.tempC;
    const delta = Math.abs(clamped - prev);

    // If delta too large, use previous value to smooth spike
    if (delta > TEMP_MAX_DELTA_C) {
      if (ENABLE_VERBOSE_PIPELINE_LOGS) {
        console.warn(`[Pipeline] TEMP spike rejected: ${value}°C → ${prev}°C (delta=${delta})`);
      }
      return prev;
    }
    prevIMURef.current.tempC = clamped;
    return clamped;
  }, []);

  /**
   * Validate PPG value (per-channel): clamp to 18-bit range and require wear.
   */
  const validatePPG = useCallback((channel: 'red' | 'ir' | 'green', value: number): number => {
    const clamped = Math.max(PPG_MIN_VALID, Math.min(PPG_MAX_VALUE, toFinite(value, 0)));

    // PPG is less susceptible to spikes, but reject zeroes if IR (wear indicator)
    if (channel === 'ir' && clamped < PPG_WEAR_THRESHOLD) {
      // IR < wear threshold = sensor not in contact; zero it out
      if (ENABLE_VERBOSE_PIPELINE_LOGS) {
        console.warn(`[Pipeline] PPG ${channel} not-worn: ${clamped} (< ${PPG_WEAR_THRESHOLD})`);
      }
      return 0;
    }

    return clamped;
  }, []);

  /**
   * Validate EDA value: clamp to ADC range and check rate-of-change.
   */
  const validateEDA = useCallback((value_uS: number): number => {
    if (!Number.isFinite(value_uS)) {
      return prevIMURef.current.edaUs;
    }

    if (!hasPrevRef.current.edaUs) {
      prevIMURef.current.edaUs = value_uS;
      hasPrevRef.current.edaUs = true;
      return value_uS;
    }

    const prev = prevIMURef.current.edaUs;
    const delta = Math.abs(value_uS - prev);

    // If delta too large, use previous value to smooth spike
    if (delta > EDA_MAX_DELTA_US) {
      if (ENABLE_VERBOSE_PIPELINE_LOGS) {
        console.warn(`[Pipeline] EDA spike rejected: ${value_uS.toFixed(2)}µS → ${prev.toFixed(2)}µS (delta=${delta.toFixed(2)})`);
      }
      return prev;
    }

    prevIMURef.current.edaUs = value_uS;
    return value_uS;
  }, []);

  /** Increment saved data point counter */
  const incDataPoints = useCallback((by = 1) => {
    setSession(prev => ({ ...prev, dataPointsSaved: prev.dataPointsSaved + by }));
  }, []);

  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  // ── register device once connected ────────────────────────────────────────

  useEffect(() => {
    if (!user || !isConnected || !connectedDevice) return;

    saveDeviceInfo(user.uid, {
      deviceId: connectedDevice.id,
      deviceName: connectedDeviceName || 'Unknown',
      deviceType: 'NRF52840',
      isActive: true,
    }).catch(err => console.warn('[Pipeline] Device registration failed:', err));
  }, [user, isConnected, connectedDevice, connectedDeviceName]);

  // ── main message processor ────────────────────────────────────────────────
  // DISABLED: This old BLEContext path conflicts with the new bleService.setDataCallback path.
  // We now use ONLY the callback-based approach (Layer 3) for all BLE data ingestion.

  // ── FIX #2: BULLETPROOF DEVICEEVENTEMITTER LISTENER (Layer 3) ───────────────────
  // CRITICAL: Minimal dependency array to prevent listener recreation
  // Old: 7-item deps array → recreated on every user/session/device change → data loss
  // New: Just [isConnected] → listener persists → data streams continuously
  useEffect(() => {
    if (!isConnected) {
      return; // Don't listen when disconnected
    }

    const handleBLEDataLine = (rawLine: string) => {
      try {
        const reading = parseSensorLine(rawLine);
        if (!reading) {
          return;
        }

        const s = latestReadingsRef.current;
        const now = Date.now();

        // Dispatch based on SensorReadingType
        switch (reading.type) {
          case 'temperature': {
            const temp = reading as TemperatureParsed;
            latestReadingsRef.current = {
              ...latestReadingsRef.current,
              temp_c: temp.tempC ?? latestReadingsRef.current.temp_c,
              lastUpdate: now,
              tempUpdated: now,
            };
            // Save to Firebase (with throttling)
            if (userRef.current && sessionRef.current.sessionId && canWriteToFirebase('temperature')) {
              saveTemperatureReading(userRef.current.uid, {
                temperature: temp.tempC,
                temperatureFahrenheit: celsiusToFahrenheit(temp.tempC),
                deviceId: connectedDeviceRef.current?.id ?? (isEarbudConnectedRef.current ? '3C:0F:02:D7:2E:05' : undefined),
                deviceName: connectedDeviceNameRef.current || (isEarbudConnectedRef.current ? 'ESP_SIGNAL_CTRL' : undefined),
                sessionId: sessionRef.current.sessionId,
              }).catch(err => console.warn('[Pipeline] Failed to queue temp reading:', err));
              markFbWrite('temperature');
              incDataPoints();
            }
            break;
          }
          case 'ppg': {
            const ppg = reading as PPGParsed;
            const fallbackSignal = ppg.green || ppg.ir || ppg.red;
            latestReadingsRef.current = {
              ...latestReadingsRef.current,
              red: ppg.red ?? latestReadingsRef.current.red,
              ir: ppg.ir ?? latestReadingsRef.current.ir,
              green: ppg.green ?? latestReadingsRef.current.green,
              lastUpdate: now,
              ppgUpdated: now,
            };
            const ppgExt = latestReadingsRef.current as SensorState & {
              ppgFilt?: number[]; ppgTh?: number[]; ppgPeaks?: boolean[];
              ppgTs?: number[]; ppgWfUpdated?: number;
            };
            // Older firmware may only emit PPG OUT once per second. Keep a
            // usable raw fallback graph until the filtered stream appears.
            if (fallbackSignal > 0 && (!ppgExt.ppgWfUpdated || now - ppgExt.ppgWfUpdated > 1000)) {
              ppgExt.ppgFilt = [...(ppgExt.ppgFilt ?? []), fallbackSignal].slice(-PPG_WAVEFORM_BUFFER_SIZE);
              ppgExt.ppgTh = [...(ppgExt.ppgTh ?? []), fallbackSignal].slice(-PPG_WAVEFORM_BUFFER_SIZE);
              ppgExt.ppgPeaks = [...(ppgExt.ppgPeaks ?? []), false].slice(-PPG_WAVEFORM_BUFFER_SIZE);
              ppgExt.ppgTs = [...(ppgExt.ppgTs ?? []), now].slice(-PPG_WAVEFORM_BUFFER_SIZE);
              ppgExt.ppgWfUpdated = now;
            }
            // Save to Firebase (with throttling)
            if (userRef.current && sessionRef.current.sessionId && canWriteToFirebase('ppg')) {
              // Save IR channel
              savePPGReading(userRef.current.uid, {
                channel: 'IR',
                rawValue: ppg.ir ?? 0,
                signalQuality: ppg.ir > 50000 ? 85 : 30,
                skinContact: ppg.ir > 50000,
                deviceId: connectedDeviceRef.current?.id ?? (isEarbudConnectedRef.current ? '3C:0F:02:D7:2E:05' : undefined),
                deviceName: connectedDeviceNameRef.current || (isEarbudConnectedRef.current ? 'ESP_SIGNAL_CTRL' : undefined),
                sessionId: sessionRef.current.sessionId,
              }).catch(err => console.warn('[Pipeline] Failed to queue PPG IR reading:', err));

              // Save RED channel
              savePPGReading(userRef.current.uid, {
                channel: 'RED',
                rawValue: ppg.red ?? 0,
                signalQuality: ppg.red > 50000 ? 85 : 30,
                skinContact: ppg.red > 50000,
                deviceId: connectedDeviceRef.current?.id ?? (isEarbudConnectedRef.current ? '3C:0F:02:D7:2E:05' : undefined),
                deviceName: connectedDeviceNameRef.current || (isEarbudConnectedRef.current ? 'ESP_SIGNAL_CTRL' : undefined),
                sessionId: sessionRef.current.sessionId,
              }).catch(err => console.warn('[Pipeline] Failed to queue PPG RED reading:', err));

              // Save GREEN channel (live)
              savePPGReading(userRef.current.uid, {
                channel: 'GREEN',
                rawValue: ppg.green,
                signalQuality: ppg.green > 50000 ? 85 : 30, // Wear detection
                skinContact: ppg.green > 50000,
                deviceId: connectedDeviceRef.current?.id ?? (isEarbudConnectedRef.current ? '3C:0F:02:D7:2E:05' : undefined),
                deviceName: connectedDeviceNameRef.current || (isEarbudConnectedRef.current ? 'ESP_SIGNAL_CTRL' : undefined),
                sessionId: sessionRef.current.sessionId,
              }).catch(err => console.warn('[Pipeline] Failed to queue PPG GREEN reading:', err));

              markFbWrite('ppg');
              incDataPoints(3);
            }
            break;
          }
          case 'imu_combined': {
            const imu = reading as IMUCombinedParsed;

            // SURGICAL FIX: Bypass all stabilization filters - map DIRECTLY from parser to UI state
            // Do NOT apply bias correction, stillness filter, or deadband.
            // UI receives raw integer values straight from the device.

            // Map DIRECTLY to UI state - no stillness filter, no bias learning, no stabilization
            latestReadingsRef.current = {
              ...latestReadingsRef.current,
              imu: {
                ax_mg: imu.ax_mg,
                ay_mg: imu.ay_mg,
                az_mg: imu.az_mg,
                gx_mdps: imu.gx_mdps,
                gy_mdps: imu.gy_mdps,
                gz_mdps: imu.gz_mdps,
                raw_gx_mdps: imu.gx_mdps,
                raw_gy_mdps: imu.gy_mdps,
                raw_gz_mdps: imu.gz_mdps,
              },
              lastUpdate: now,
              imuUpdated: now,
            };
            // Save to Firebase (with throttling)
            if (userRef.current && sessionRef.current.sessionId && canWriteToFirebase('imu')) {
              // Save accel reading
              saveAccelerometerReading(userRef.current.uid, {
                x: imu.ax_mg,
                y: imu.ay_mg,
                z: imu.az_mg,
                deviceId: connectedDeviceRef.current?.id ?? (isEarbudConnectedRef.current ? '3C:0F:02:D7:2E:05' : undefined),
                deviceName: connectedDeviceNameRef.current || (isEarbudConnectedRef.current ? 'ESP_SIGNAL_CTRL' : undefined),
                sessionId: sessionRef.current.sessionId,
              }).catch(err => console.warn('[Pipeline] Failed to queue accel reading:', err));

              // Save gyro reading
              saveGyroscopeReading(userRef.current.uid, {
                x: imu.gx_mdps,
                y: imu.gy_mdps,
                z: imu.gz_mdps,
                deviceId: connectedDeviceRef.current?.id ?? (isEarbudConnectedRef.current ? '3C:0F:02:D7:2E:05' : undefined),
                deviceName: connectedDeviceNameRef.current || (isEarbudConnectedRef.current ? 'ESP_SIGNAL_CTRL' : undefined),
                sessionId: sessionRef.current.sessionId,
              }).catch(err => console.warn('[Pipeline] Failed to queue gyro reading:', err));

              markFbWrite('imu');
              incDataPoints(2); // Counted as 2 readings (accel + gyro)
            }
            break;
          }
          case 'eda': {
            const eda = reading as EDAParsed;
            latestReadingsRef.current = {
              ...latestReadingsRef.current,
              edaRaw: eda.rawADC ?? latestReadingsRef.current.edaRaw,
              edaMv: eda.mv ?? latestReadingsRef.current.edaMv,
              edaUs: eda.uS ?? Math.abs(eda.mv ?? 0) * 0.02,
              lastUpdate: now,
              edaUpdated: now,
            };
            // Save to Firebase (with throttling)
            if (userRef.current && sessionRef.current.sessionId && canWriteToFirebase('eda')) {
              // Calculate resistance from voltage
              const voltage = (eda.mv || 0) / 1000;
              const resistance = voltage > 0 ? (3.3 / voltage) : 100; // Default 100kΩ if invalid
              const conductance = eda.mv !== null ? edaMvToMicrosiemens(eda.mv) : 1;

              saveEDAReading(userRef.current.uid, {
                rawValue: eda.rawADC,
                voltage: voltage,
                resistance: Math.max(1, resistance), // Ensure positive
                conductance: Math.max(0, conductance),
                deviceId: connectedDeviceRef.current?.id ?? (isEarbudConnectedRef.current ? '3C:0F:02:D7:2E:05' : undefined),
                deviceName: connectedDeviceNameRef.current || (isEarbudConnectedRef.current ? 'ESP_SIGNAL_CTRL' : undefined),
                sessionId: sessionRef.current.sessionId,
              }).catch(err => console.warn('[Pipeline] Failed to queue EDA reading:', err));
              markFbWrite('eda');
              incDataPoints();
            }
            break;
          }
          case 'ppg_stream': {
            // Firmware-filtered PPG waveform + instantaneous HR from algo_v0
            const ps = reading as PPGStreamParsed;

            // Update rolling waveform buffer (refs — no setState inside callback)
            const wfRef = latestReadingsRef as React.MutableRefObject<SensorState & {
              ppgFilt?: number[]; ppgTh?: number[]; ppgPeaks?: boolean[];
              ppgTs?: number[]; ppgWfUpdated?: number;
              fwHrBpm?: number; fwHrIbi?: number; fwHrQok?: boolean;
              fwHrUpdated?: number;
              ppgSqi?: number; ppgArt?: boolean; ppgQok?: boolean;
              ppgWinUpdated?: number;
            }>;

            // Rolling buffer: append and trim to PPG_WAVEFORM_BUFFER_SIZE
            const prevFilt = wfRef.current.ppgFilt ?? [];
            const prevTh   = wfRef.current.ppgTh   ?? [];
            const prevPk   = wfRef.current.ppgPeaks ?? [];
            const prevTs   = wfRef.current.ppgTs    ?? [];

            const newFilt  = [...prevFilt, ps.filt].slice(-512);
            const newTh    = [...prevTh,   ps.th  ].slice(-512);
            const newPk    = [...prevPk,   ps.peak].slice(-512);
            const newTs    = [...prevTs,   ps.t_ms].slice(-512);

            wfRef.current.ppgFilt    = newFilt;
            wfRef.current.ppgTh      = newTh;
            wfRef.current.ppgPeaks   = newPk;
            wfRef.current.ppgTs      = newTs;
            wfRef.current.ppgWfUpdated = now;
            // PPG_STREAM is the reliable raw source even when debug logs are disabled.
            if (ps.green > 0) wfRef.current.green = ps.green;
            else if (ps.raw > 0) wfRef.current.green = ps.raw;
            wfRef.current.ppgUpdated = now;
            if (Number.isFinite(ps.sqi) && ps.sqi >= 0) wfRef.current.ppgSqi = ps.sqi;
            wfRef.current.ppgArt = ps.artifact;
            wfRef.current.ppgQok = ps.qok;
            wfRef.current.ppgWinUpdated = now;
            wfRef.current.lastUpdate = now;

            // Extract HR on every peak event when quality gate is open
            if (ps.hr > 0 && ps.qok) {
              wfRef.current.fwHrBpm     = ps.hr;
              wfRef.current.fwHrIbi     = ps.ibi_ms;
              wfRef.current.fwHrQok     = ps.qok;
              wfRef.current.fwHrUpdated = now;

              // Firebase: save firmware HR (throttled)
              if (userRef.current && canWriteToFirebase('heartRate')) {
                saveHeartRateReading(userRef.current.uid, {
                  heartRate: Math.round(ps.hr),
                  rrInterval: ps.ibi_ms > 0 ? ps.ibi_ms : undefined,
                  confidence: ps.qok ? 85 : 50,
                  derivedFrom: 'PPG_STREAM_FW',
                  deviceId: connectedDeviceRef.current?.id,
                  deviceName: connectedDeviceNameRef.current || undefined,
                  sessionId: sessionRef.current.sessionId ?? undefined,
                }).catch(err => console.warn('[Pipeline] Failed to queue HR reading:', err));
                markFbWrite('heartRate');
                incDataPoints();
              }
            }

            // Firebase: save PPG filtered waveform sample (throttled — every 2s)
            if (userRef.current && canWriteToFirebase('ppg_stream')) {
              savePPGReading(userRef.current.uid, {
                channel: 'GREEN_FILT',
                rawValue: Math.round(ps.filt * 1000), // store as integer
                signalQuality: Math.round(ps.sqi * 100),
                skinContact: !ps.artifact && ps.qok,
                deviceId: connectedDeviceRef.current?.id,
                deviceName: connectedDeviceNameRef.current || undefined,
                sessionId: sessionRef.current.sessionId ?? undefined,
              }).catch(err => console.warn('[Pipeline] Failed to queue PPG_FILT reading:', err));
              markFbWrite('ppg_stream');
            }
            break;
          }
          case 'ppg_window': {
            // 5-second signal quality window from algo_v0
            const pw = reading as PPGWindowParsed;
            const wfRef2 = latestReadingsRef as React.MutableRefObject<SensorState & {
              ppgSqi?: number; ppgArt?: boolean; ppgQok?: boolean;
              ppgSat?: boolean; ppgWinUpdated?: number;
            }>;
            wfRef2.current.ppgSqi        = pw.sqi;
            wfRef2.current.ppgArt        = pw.artifact;
            wfRef2.current.ppgQok        = pw.quality_ok;
            wfRef2.current.ppgSat        = pw.saturation;
            wfRef2.current.ppgWinUpdated = now;
            wfRef2.current.lastUpdate = now;
            break;
          }
          case 'v0_min': {
            // 1-minute summary: definitive HR, HRV, activity, sleep
            const vm = reading as V0MinParsed;
            const wfRef3 = latestReadingsRef as React.MutableRefObject<SensorState & {
              v0Hr?: number; v0HrQual?: string; v0HrCov?: number;
              v0Rmssd?: number; v0HrvQual?: string;
              v0Act?: string; v0ActConf?: number;
              v0Sleep?: string; v0SleepConf?: number;
              v0MinUpdated?: number;
            }>;
            if (vm.hr_bpm > 0) wfRef3.current.v0Hr    = vm.hr_bpm;
            wfRef3.current.v0HrQual    = vm.hr_quality;
            wfRef3.current.v0HrCov     = vm.hr_coverage_sec;
            if (vm.hrv_rmssd_ms > 0) wfRef3.current.v0Rmssd = vm.hrv_rmssd_ms;
            wfRef3.current.v0HrvQual   = vm.hrv_quality;
            wfRef3.current.v0Act       = vm.activity;
            wfRef3.current.v0ActConf   = vm.act_conf;
            wfRef3.current.v0Sleep     = vm.sleep_state;
            wfRef3.current.v0SleepConf = vm.sleep_conf;
            wfRef3.current.v0MinUpdated = now;
            if (vm.eda_muSCL >= 0) {
              wfRef3.current.edaUs = vm.eda_muSCL;
              wfRef3.current.edaUpdated = now;
            }
            wfRef3.current.lastUpdate = now;

            // Firebase: save definitive HR from 1-minute summary
            if (userRef.current && vm.hr_bpm > 0 && vm.hr_quality !== 'INVALID') {
              saveHeartRateReading(userRef.current.uid, {
                heartRate: Math.round(vm.hr_bpm),
                hrv: vm.hrv_rmssd_ms > 0 ? vm.hrv_rmssd_ms : undefined,
                confidence: vm.hr_quality === 'GOOD' ? 95 : 70,
                derivedFrom: 'V0_MIN_FW',
                deviceId: connectedDeviceRef.current?.id,
                deviceName: connectedDeviceNameRef.current || undefined,
                sessionId: sessionRef.current.sessionId ?? undefined,
              }).catch(err => console.warn('[Pipeline] Failed to queue V0_MIN HR:', err));
              incDataPoints();
            }
            break;
          }
        }
      } catch (e) {
        console.warn('[Pipeline] Data parsing error:', e);
      }
    };

    // Use singleton DeviceEventEmitter - never creates new instance
    const subscription = DeviceEventEmitter.addListener('BLE_DATA_LINE', handleBLEDataLine);

    return () => {
      subscription.remove();
    };
  }, [isConnected]); // CRITICAL: Only re-subscribe on connect/disconnect

  // ── FIX #3: UI RENDER THROTTLE (Layer 4: UI Heartbeat) ──────────────────────
  // Bulletproof 33ms interval that pushes latestReadingsRef to React state
  useEffect(() => {
    let uiTicks = 0;
    const intervalId = setInterval(() => {
      uiTicks++;
      const next = latestReadingsRef.current;

      // Atomically push latest readings to React state with explicit timestamp copy
      if (isMountedRef.current && next.lastUpdate > lastUiPublishRef.current) {
        lastUiPublishRef.current = next.lastUpdate;
        setLive(prev => {
          // Construct LiveSensorState directly from SensorState
          const now = new Date(next.lastUpdate);
          // Access firmware-specific extensions stored on the same ref object
          const ext = next as typeof next & {
            ppgFilt?: number[]; ppgTh?: number[]; ppgPeaks?: boolean[];
            ppgTs?: number[]; ppgWfUpdated?: number;
            fwHrBpm?: number; fwHrIbi?: number; fwHrQok?: boolean; fwHrUpdated?: number;
            ppgSqi?: number; ppgArt?: boolean; ppgQok?: boolean; ppgSat?: boolean;
            ppgWinUpdated?: number;
            v0Hr?: number; v0HrQual?: string; v0Rmssd?: number; v0HrvQual?: string;
            v0Act?: string; v0ActConf?: number; v0Sleep?: string; v0SleepConf?: number;
            v0MinUpdated?: number;
          };

          // Determine best HR source: prefer V0_MIN (most accurate), fallback to PPG_STREAM peak
          const hrBpm     = ext.v0Hr ?? ext.fwHrBpm ?? prev.heartRate.bpm;
          const hrQok     = ext.fwHrQok ?? false;
          const hrConf: 'high' | 'low' | 'invalid' =
            (ext.v0HrQual === 'GOOD') ? 'high' :
            (ext.v0HrQual === 'LOW' || hrQok) ? 'low' : 'invalid';
          const hrUpdated = Math.max(ext.fwHrUpdated ?? 0, ext.v0MinUpdated ?? 0);

          return {
            temperature: {
              tempC: next.temp_c ?? 0,
              tempF: next.temp_c !== null ? (next.temp_c * 9 / 5) + 32 : 0,
              lastUpdated: next.tempUpdated ? new Date(next.tempUpdated) : prev.temperature.lastUpdated,
            },
            ppg: {
              red: next.red ?? 0,
              ir: next.ir ?? 0,
              green: next.green ?? 0,
              lastUpdated: next.ppgUpdated ? new Date(next.ppgUpdated) : prev.ppg.lastUpdated,
            },
            ppgStream: {
              filt: ext.ppgFilt ?? prev.ppgStream.filt,
              th:   ext.ppgTh   ?? prev.ppgStream.th,
              peaks: ext.ppgPeaks ?? prev.ppgStream.peaks,
              timestamps: ext.ppgTs ?? prev.ppgStream.timestamps,
              lastUpdated: ext.ppgWfUpdated ? new Date(ext.ppgWfUpdated) : prev.ppgStream.lastUpdated,
            },
            heartRate: {
              bpm: hrBpm,
              ibi_ms: ext.fwHrIbi ?? prev.heartRate.ibi_ms,
              confidence: hrConf,
              qualityOk: hrQok,
              lastUpdated: hrUpdated ? new Date(hrUpdated) : prev.heartRate.lastUpdated,
            },
            ppgQuality: {
              sqi:         ext.ppgSqi ?? prev.ppgQuality.sqi,
              artifact:    ext.ppgArt ?? prev.ppgQuality.artifact,
              qualityOk:   ext.ppgQok ?? prev.ppgQuality.qualityOk,
              wearDetected: (next.ir ?? 0) > 8000 || (next.green ?? 0) > 8000,
              lastUpdated: ext.ppgWinUpdated ? new Date(ext.ppgWinUpdated) : prev.ppgQuality.lastUpdated,
            },
            hrv: {
              rmssd_ms: ext.v0Rmssd ?? prev.hrv.rmssd_ms,
              quality:  ext.v0HrvQual ?? prev.hrv.quality,
              lastUpdated: ext.v0MinUpdated ? new Date(ext.v0MinUpdated) : prev.hrv.lastUpdated,
            },
            activity: {
              state:      ext.v0Act      ?? prev.activity.state,
              confidence: ext.v0ActConf  ?? prev.activity.confidence,
              sleepState: ext.v0Sleep    ?? prev.activity.sleepState,
              sleepConf:  ext.v0SleepConf ?? prev.activity.sleepConf,
              lastUpdated: ext.v0MinUpdated ? new Date(ext.v0MinUpdated) : prev.activity.lastUpdated,
            },
            accel: {
              x: next.imu?.ax_mg ?? 0,
              y: next.imu?.ay_mg ?? 0,
              z: next.imu?.az_mg ?? 0,
              magnitude: next.imu ? Math.sqrt(
                Math.pow(next.imu.ax_mg, 2) +
                Math.pow(next.imu.ay_mg, 2) +
                Math.pow(next.imu.az_mg, 2)
              ) : 0,
              lastUpdated: next.imuUpdated ? new Date(next.imuUpdated) : prev.accel.lastUpdated,
            },
            gyro: {
              x: next.imu?.gx_mdps ?? 0,
              y: next.imu?.gy_mdps ?? 0,
              z: next.imu?.gz_mdps ?? 0,
              rawX: next.imu?.raw_gx_mdps ?? next.imu?.gx_mdps ?? 0,
              rawY: next.imu?.raw_gy_mdps ?? next.imu?.gy_mdps ?? 0,
              rawZ: next.imu?.raw_gz_mdps ?? next.imu?.gz_mdps ?? 0,
              magnitude: next.imu ? Math.sqrt(
                Math.pow(next.imu.gx_mdps, 2) +
                Math.pow(next.imu.gy_mdps, 2) +
                Math.pow(next.imu.gz_mdps, 2)
              ) : 0,
              lastUpdated: next.imuUpdated ? new Date(next.imuUpdated) : prev.gyro.lastUpdated,
            },
            eda: {
              rawADC: next.edaRaw ?? 0,
              mv: next.edaMv ?? 0,
              conductance_uS: next.edaUs ?? 0,
              stressLevel: next.edaUs !== null ? estimateStressLevel(next.edaUs) : 'LOW',
              lastUpdated: next.edaUpdated ? new Date(next.edaUpdated) : prev.eda.lastUpdated,
            },
          };
        });
      }
    }, 100); // 10 FPS is smooth for charts and avoids rebuilding SVG paths 30 times/sec

    return () => clearInterval(intervalId);
  }, []); // <-- EMPTY ARRAY (stable interval, doesn't depend on function identities)

  // ─────────────────────────────────────────────────────────────────────────
  // Session management
  // ─────────────────────────────────────────────────────────────────────────

  // ── FIX #3: SIMPLIFIED SESSION STATE MACHINE (No BLE Coupling) ──────────────
  // Pure session & Firebase management - no BLE service interaction
  const startSession = useCallback(
    async (sessionName?: string) => {
      // Guard: prevent double-starts
      if (startInFlightRef.current) return;
      if (session.isRecording) return;
      if (!user) {
        console.warn('[Session Action] Cannot start session – not logged in');
        return;
      }

      startInFlightRef.current = true;
      console.log('[Session Action] Starting Recording...');

      try {
        const name = sessionName || `Session ${new Date().toLocaleString()}`;

        // Initialize Firebase session (creates Firestore document)
        const sessionId = await fbStartSession(user.uid, {
          sessionName: name,
          deviceId: connectedDevice?.id ?? (isEarbudConnected ? '3C:0F:02:D7:2E:05' : undefined),
          deviceName: connectedDeviceName || (isEarbudConnected ? 'ESP_SIGNAL_CTRL' : undefined),
          activeSensors: [
            SensorType.TEMPERATURE,
            SensorType.PPG_IR,
            SensorType.PPG_RED,
            SensorType.PPG_GREEN,
            SensorType.ACCELEROMETER,
            SensorType.GYROSCOPE,
            SensorType.EDA,
          ],
        });

        // Start the Firebase write batcher to queue sensor data (3-second batches)
        startFirebaseWriteBatcher();

        // Update React state with new session
        setSession({
          sessionId,
          isRecording: true,
          startedAt: new Date(),
          dataPointsSaved: 0,
        });

        console.log('[Session Action] ✅ Recording started:', sessionId);
      } catch (err) {
        console.error('[Session Action] Failed to start session:', err);
      } finally {
        startInFlightRef.current = false;
      }
    },
    [user, connectedDevice, connectedDeviceName]
  );

  const stopSession = useCallback(async () => {
    // Guard: prevent double-stops (CRITICAL for avoiding race conditions)
    if (stopInFlightRef.current) {
      console.log('[Session Action] Stop already in progress, ignoring duplicate request');
      return;
    }
    if (!session.isRecording) {
      console.log('[Session Action] No active session to stop');
      return;
    }

    stopInFlightRef.current = true;
    console.log('[Session Action] 🔄 Graceful shutdown sequence started...');

    try {
      // Wrap entire shutdown in timeout to prevent infinite hangs
      await Promise.race([
        (async () => {
          // STEP 0: Add small initial delay to allow in-flight operations to settle
          // This prevents "flush while another write is happening" errors
          try {
            await new Promise(resolve => setTimeout(resolve, 100));
          } catch (delayErr) {
            // Ignore delay errors (shouldn't happen)
          }

          // STEP 1: Flush any remaining Firebase writes before ending session
          // This is the most critical step - must complete before Firestore session ends
          if (session.sessionId) {
            console.log('[Session Action] 📤 Flushing remaining Firebase writes...');
            try {
              await Promise.race([
                flushFirebaseWriteQueue(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Flush timeout')), 4000))
              ]);
              console.log('[Session Action] ✅ Firebase flush completed');
            } catch (flushErr: any) {
              console.warn('[Session Action] ⚠️  Firebase flush failed (non-critical):', flushErr?.message || flushErr);
              // DON'T crash - flush can fail if queue is empty or already flushing
              // Continue with session end to avoid hanging
            }
          }

          // STEP 2: Stop the Firebase write batcher
          // This prevents new writes from being queued while session is ending
          if (user?.uid) {
            console.log('[Session Action] 🛑 Stopping Firebase write batcher...');
            try {
              stopDataLogger(user.uid);
              console.log('[Session Action] ✅ Write batcher stopped');
            } catch (stopErr: any) {
              console.warn('[Session Action] ⚠️  stopDataLogger error (non-critical):', stopErr?.message || stopErr);
              // Continue - batcher stop failure won't crash session end
            }
          }

          // STEP 3: Add a small grace period for any async operations to complete
          try {
            await new Promise(resolve => setTimeout(resolve, 200));
          } catch (delayErr) {
            // Ignore
          }

          // STEP 4: End session on Firestore
          // This finalizes the session and prevents orphaned data
          if (user?.uid && session.sessionId) {
            console.log('[Session Action] 📋 Finalizing Firestore session...');
            try {
              await Promise.race([
                fbEndSession(user.uid, session.sessionId, { qualityScore: 80 }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Session end timeout')), 6000))
              ]);
              console.log('[Session Action] ✅ Session ended:', session.sessionId);
            } catch (endErr: any) {
              console.warn('[Session Action] ⚠️  Session end failed (non-critical):', endErr?.message || endErr);
              // Continue - session state will be cleared anyway
            }
          }

          console.log('[Session Action] ✅ Graceful shutdown completed successfully');
        })(),
        // Overall timeout: 12 seconds for entire shutdown
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Complete shutdown timeout')), 12000)
        )
      ]);
    } catch (err: any) {
      // Catch-all for unexpected errors during shutdown
      // This should NOT crash the app - just log and continue
      console.error('[Session Action] ❌ Shutdown error (proceeding anyway):', err?.message || err);
    } finally {
      // CRITICAL: Always clear session state to allow reconnection
      // This must happen even if any step failed, otherwise app will hang
      try {
        setSession({
          sessionId: null,
          isRecording: false,
          startedAt: null,
          dataPointsSaved: 0,
        });
        console.log('[Session Action] ✅ React state cleared, ready for reconnection');
      } catch (stateErr) {
        console.error('[Session Action] ❌ Failed to clear React state:', stateErr);
      }

      // Finally, allow new stop requests
      stopInFlightRef.current = false;
    }
  }, [user, session.sessionId, session.isRecording]);

  // Auto-stop session when device disconnects (SAFE: guarded by stopSession)
  useEffect(() => {
    if (!isConnected && session.isRecording) {
      console.log('[Session Action] Device disconnected – stopping active session');
      // Wrap in error boundary to prevent unhandled promise rejection crashes
      stopSession().catch((err: any) => {
        console.error('[Session Action] ❌ stopSession promise rejection (contained):', err?.message || err);
        // Force clear state as last resort
        try {
          setSession({
            sessionId: null,
            isRecording: false,
            startedAt: null,
            dataPointsSaved: 0,
          });
        } catch (stateErr) {
          console.error('[Session Action] ❌ Final state clear failed:', stateErr);
        }
      });
    }
  }, [isConnected, session.isRecording, stopSession]);

  // Clear live values after disconnect so UI does not keep stale readings.
  useEffect(() => {
    if (isConnected) return;
    setLive(initialLiveState);
    liveRef.current = initialLiveState;
    resetValidationState();
  }, [isConnected, resetValidationState]);

  // Auto-stop session when user logs out (SAFE: guarded by stopSession)
  // This prevents in-flight Firestore writes after auth token revoked
  useEffect(() => {
    if (!user && session.isRecording) {
      console.log('[Session Action] User logged out – stopping active session');
      // Wrap in error boundary to prevent unhandled promise rejection crashes
      stopSession().catch((err: any) => {
        console.error('[Session Action] ❌ stopSession promise rejection on logout (contained):', err?.message || err);
        // Force clear state as last resort
        try {
          setSession({
            sessionId: null,
            isRecording: false,
            startedAt: null,
            dataPointsSaved: 0,
          });
        } catch (stateErr) {
          console.error('[Session Action] ❌ Final state clear failed:', stateErr);
        }
      });
    }
  }, [user, session.isRecording, stopSession]);

  return {
    /** Latest parsed sensor values (live, in-memory) */
    live,
    /** Current recording session state */
    session,
    /** Start a Firestore recording session */
    startSession,
    /** End the active recording session */
    stopSession,
  };
}

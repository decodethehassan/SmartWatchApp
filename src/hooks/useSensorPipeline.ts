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

  // Compact production stream buffers (same values consumed by the PC HTML GUI)
  ppgFilt?: number[];
  ppgTh?: number[];
  ppgPeaks?: boolean[];
  ppgTs?: number[];
  ppgQokFlags?: boolean[];
  ppgArtifactFlags?: boolean[];
  ppgContactFlags?: boolean[];
  ppgWfUpdated?: number;
  fwHrBpm?: number;
  fwHrIbi?: number;
  fwHrQok?: boolean;
  fwHrQuality?: number;
  fwRmssd?: number;
  fwPrvReady?: boolean;
  fwIbiCv?: number;
  fwFsHz?: number;
  fwAcdc?: number;
  fwHrUpdated?: number;
  ppgSqi?: number;
  ppgArt?: boolean;
  ppgQok?: boolean;
  ppgContactArtifact?: boolean;
  ppgSat?: boolean;
  ppgWinUpdated?: number;

  imuTs?: number[];
  imuAxG?: number[];
  imuAyG?: number[];
  imuAzG?: number[];
  imuGxDps?: number[];
  imuGyDps?: number[];
  imuGzDps?: number[];

  edaTs?: number[];
  edaValuesUs?: number[];
  edaQualityFlags?: boolean[];
  edaQualityOk?: boolean;

  tempTs?: number[];
  tempValuesC?: number[];
  tempQualityFlags?: boolean[];
  tempQualityOk?: boolean;

  v0Hr?: number;
  v0Tms?: number;
  v0HrQual?: string;
  v0HrCov?: number;
  v0Rmssd?: number;
  v0HrvQual?: string;
  v0Act?: string;
  v0ActConf?: number;
  v0ArtFrac?: number;
  v0EdaMu?: number;
  v0EdaScr?: number;
  v0EdaQual?: string;
  v0EdaConf?: string;
  v0Temp?: number;
  v0TempQual?: string;
  v0TempSlope?: number;
  v0Sleep?: string;
  v0SleepConf?: number;
  v0MinUpdated?: number;
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

/** Compact C stream is ~25 Hz plus peak frames; 900 samples safely covers >30 s. */
export const PPG_WAVEFORM_BUFFER_SIZE = 900;
const AUX_STREAM_BUFFER_SIZE = 900;

// Keep old LiveSensorState for compatibility with other parts of code
export interface LiveSensorState {
  /** AS6221 temperature sensor */
  temperature: {
    tempC: number;
    tempF: number;
    qualityOk: boolean;
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
   * Firmware-filtered PPG waveform stream. Compact production firmware supplies
   * C.clean at ~25 Hz plus accepted peak frames; legacy PPG_STREAM/PV remains
   * supported as a fallback. The arrays stay index-aligned.
   * Used to render the real-time PPG waveform in MAX30101Monitor.
   */
  ppgStream: {
    filt: number[];        // rolling waveform samples (firmware high-pass filtered)
    th: number[];          // adaptive threshold line
    peaks: boolean[];      // peak markers for beat annotations
    timestamps: number[];  // firmware t_ms values for each sample
    qualityFlags: boolean[];
    artifactFlags: boolean[];
    contactFlags: boolean[];
    fsHz: number;
    acdc: number;
    hrQuality: number;
    rmssdMs: number;
    prvReady: boolean;
    ibiCv: number;
    lastUpdated: Date | null;
  };
  /**
   * Firmware-computed heart rate and IBI.
   * Updated from compact C records; legacy PPG_STREAM is retained as fallback.
   * The compact M record remains a separate 1-minute summary.
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
    contactArtifact: boolean;
    acdc: number;
    fsHz: number;
    hrQuality: number;
    prvReady: boolean;
    ibiCv: number;
    qokPercent: number;
    artifactPercent: number;
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
  /** Exact compact I records in the same units as the PC GUI. */
  imuStream: {
    timestamps: number[];
    ax_g: number[];
    ay_g: number[];
    az_g: number[];
    gx_dps: number[];
    gy_dps: number[];
    gz_dps: number[];
    lastUpdated: Date | null;
  };
  /** ADS1113 EDA/GSR */
  eda: {
    rawADC: number;
    mv: number;
    conductance_uS: number;
    stressLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH';
    qualityOk: boolean;
    lastUpdated: Date | null;
  };
  edaStream: {
    timestamps: number[];
    values_uS: number[];
    qualityFlags: boolean[];
    lastUpdated: Date | null;
  };
  temperatureStream: {
    timestamps: number[];
    values_c: number[];
    qualityFlags: boolean[];
    lastUpdated: Date | null;
  };
  minuteSummary: {
    t_ms: number;
    activity: string;
    activityConfidence: number;
    artifactFraction: number;
    hrBpm: number;
    hrCoverageSec: number;
    hrQuality: string;
    rmssdMs: number;
    hrvQuality: string;
    edaMuScl: number;
    edaSigmaScr: number;
    edaQuality: string;
    edaConfidence: string;
    tempC: number;
    tempQuality: string;
    tempSlope5m: number;
    sleepState: string;
    sleepConfidence: number;
    lastUpdated: Date | null;
  };
}

const initialLiveState: LiveSensorState = {
  temperature: { tempC: 0, tempF: 0, qualityOk: false, lastUpdated: null },
  ppg: { red: 0, ir: 0, green: 0, lastUpdated: null },
  ppgStream: {
    filt: [], th: [], peaks: [], timestamps: [], qualityFlags: [], artifactFlags: [], contactFlags: [],
    fsHz: -1, acdc: -1, hrQuality: 0, rmssdMs: -1, prvReady: false, ibiCv: -1,
    lastUpdated: null,
  },
  heartRate: { bpm: -1, ibi_ms: 0, confidence: 'invalid', qualityOk: false, lastUpdated: null },
  ppgQuality: {
    sqi: 0, artifact: false, qualityOk: false, wearDetected: false, contactArtifact: true,
    acdc: -1, fsHz: -1, hrQuality: 0, prvReady: false, ibiCv: -1,
    qokPercent: 0, artifactPercent: 0, lastUpdated: null,
  },
  hrv: { rmssd_ms: -1, quality: 'INVALID', lastUpdated: null },
  activity: { state: 'UNKNOWN', confidence: 0, sleepState: 'WAKE', sleepConf: 0, lastUpdated: null },
  accel: { x: 0, y: 0, z: 0, magnitude: 0, lastUpdated: null },
  gyro: { x: 0, y: 0, z: 0, rawX: 0, rawY: 0, rawZ: 0, magnitude: 0, lastUpdated: null },
  imuStream: { timestamps: [], ax_g: [], ay_g: [], az_g: [], gx_dps: [], gy_dps: [], gz_dps: [], lastUpdated: null },
  eda: { rawADC: 0, mv: 0, conductance_uS: 0, stressLevel: 'LOW', qualityOk: false, lastUpdated: null },
  edaStream: { timestamps: [], values_uS: [], qualityFlags: [], lastUpdated: null },
  temperatureStream: { timestamps: [], values_c: [], qualityFlags: [], lastUpdated: null },
  minuteSummary: {
    t_ms: 0, activity: 'NA', activityConfidence: 0, artifactFraction: 0,
    hrBpm: -1, hrCoverageSec: 0, hrQuality: 'NA', rmssdMs: -1, hrvQuality: 'NA',
    edaMuScl: -1, edaSigmaScr: -1, edaQuality: 'NA', edaConfidence: 'NA',
    tempC: -1, tempQuality: 'NA', tempSlope5m: -1,
    sleepState: 'NA', sleepConfidence: 0, lastUpdated: null,
  },
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
            const current = latestReadingsRef.current;
            latestReadingsRef.current = {
              ...current,
              temp_c: temp.tempC ?? latestReadingsRef.current.temp_c,
              tempTs: [...(current.tempTs ?? []), temp.uptimeMs].slice(-AUX_STREAM_BUFFER_SIZE),
              tempValuesC: [...(current.tempValuesC ?? []), temp.tempC].slice(-AUX_STREAM_BUFFER_SIZE),
              tempQualityFlags: [...(current.tempQualityFlags ?? []), temp.qualityOk ?? true].slice(-AUX_STREAM_BUFFER_SIZE),
              tempQualityOk: temp.qualityOk ?? true,
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

            const ax_g = imu.ax_g ?? imu.ax_mg / 1000;
            const ay_g = imu.ay_g ?? imu.ay_mg / 1000;
            const az_g = imu.az_g ?? imu.az_mg / 1000;
            const gx_dps = imu.gx_dps ?? imu.gx_mdps / 1000;
            const gy_dps = imu.gy_dps ?? imu.gy_mdps / 1000;
            const gz_dps = imu.gz_dps ?? imu.gz_mdps / 1000;
            const current = latestReadingsRef.current;

            // SURGICAL FIX: Bypass all stabilization filters - map DIRECTLY from parser to UI state
            // Do NOT apply bias correction, stillness filter, or deadband.
            // UI receives raw integer values straight from the device.

            // Map DIRECTLY to UI state - no stillness filter, no bias learning, no stabilization
            latestReadingsRef.current = {
              ...current,
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
              imuTs: [...(current.imuTs ?? []), imu.uptimeMs].slice(-AUX_STREAM_BUFFER_SIZE),
              imuAxG: [...(current.imuAxG ?? []), ax_g].slice(-AUX_STREAM_BUFFER_SIZE),
              imuAyG: [...(current.imuAyG ?? []), ay_g].slice(-AUX_STREAM_BUFFER_SIZE),
              imuAzG: [...(current.imuAzG ?? []), az_g].slice(-AUX_STREAM_BUFFER_SIZE),
              imuGxDps: [...(current.imuGxDps ?? []), gx_dps].slice(-AUX_STREAM_BUFFER_SIZE),
              imuGyDps: [...(current.imuGyDps ?? []), gy_dps].slice(-AUX_STREAM_BUFFER_SIZE),
              imuGzDps: [...(current.imuGzDps ?? []), gz_dps].slice(-AUX_STREAM_BUFFER_SIZE),
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
            const current = latestReadingsRef.current;
            const conductanceUs = eda.uS ?? Math.abs(eda.mv ?? 0) * 0.02;
            latestReadingsRef.current = {
              ...current,
              edaRaw: eda.rawADC ?? latestReadingsRef.current.edaRaw,
              edaMv: eda.mv ?? latestReadingsRef.current.edaMv,
              edaUs: conductanceUs,
              edaTs: [...(current.edaTs ?? []), eda.uptimeMs].slice(-AUX_STREAM_BUFFER_SIZE),
              edaValuesUs: [...(current.edaValuesUs ?? []), conductanceUs].slice(-AUX_STREAM_BUFFER_SIZE),
              edaQualityFlags: [...(current.edaQualityFlags ?? []), eda.qualityOk ?? true].slice(-AUX_STREAM_BUFFER_SIZE),
              edaQualityOk: eda.qualityOk ?? true,
              lastUpdate: now,
              edaUpdated: now,
            };
            // Save to Firebase (with throttling)
            if (userRef.current && sessionRef.current.sessionId && canWriteToFirebase('eda')) {
              // Calculate resistance from voltage
              const voltage = (eda.mv || 0) / 1000;
              const resistance = voltage > 0 ? (3.3 / voltage) : 100; // Default 100kΩ if invalid
              const conductance = eda.uS ?? (eda.mv !== null ? edaMvToMicrosiemens(eda.mv) : 1);

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
            // Compact C / legacy PPG_STREAM waveform + firmware metrics.
            const ps = reading as PPGStreamParsed;

            const current = latestReadingsRef.current;
            current.ppgFilt = [...(current.ppgFilt ?? []), ps.clean].slice(-PPG_WAVEFORM_BUFFER_SIZE);
            current.ppgTh = [...(current.ppgTh ?? []), ps.th].slice(-PPG_WAVEFORM_BUFFER_SIZE);
            current.ppgPeaks = [...(current.ppgPeaks ?? []), ps.peak].slice(-PPG_WAVEFORM_BUFFER_SIZE);
            current.ppgTs = [...(current.ppgTs ?? []), ps.t_ms].slice(-PPG_WAVEFORM_BUFFER_SIZE);
            current.ppgQokFlags = [...(current.ppgQokFlags ?? []), ps.qok].slice(-PPG_WAVEFORM_BUFFER_SIZE);
            current.ppgArtifactFlags = [...(current.ppgArtifactFlags ?? []), ps.artifact].slice(-PPG_WAVEFORM_BUFFER_SIZE);
            current.ppgContactFlags = [...(current.ppgContactFlags ?? []), ps.contactArtifact].slice(-PPG_WAVEFORM_BUFFER_SIZE);
            current.ppgWfUpdated = now;
            current.green = ps.green > 0 ? ps.green : ps.raw;
            current.ppgUpdated = now;
            current.ppgSqi = ps.sqi;
            current.ppgArt = ps.artifact;
            current.ppgQok = ps.qok;
            current.ppgContactArtifact = ps.contactArtifact;
            current.fwAcdc = ps.acdc;
            current.fwFsHz = ps.fs;
            current.fwHrQuality = ps.hr_quality;
            current.fwRmssd = ps.rmssd_ms;
            current.fwPrvReady = ps.prv_ready;
            current.fwIbiCv = ps.ibi_cv;
            current.fwHrBpm = ps.hr;
            current.fwHrIbi = ps.ibi_ms;
            current.fwHrQok = ps.qok;
            current.fwHrUpdated = now;
            current.ppgWinUpdated = now;
            current.lastUpdate = now;

            const activeSessionId = sessionRef.current.sessionId;

            // Save accepted live HR only after Firestore has created an active
            // recording session. Display state still follows every compact C
            // record, exactly like the desktop GUI.
            if (
              ps.hr > 0 &&
              ps.qok &&
              userRef.current &&
              activeSessionId &&
              canWriteToFirebase('heartRate')
            ) {
              saveHeartRateReading(userRef.current.uid, {
                heartRate: Math.round(ps.hr),
                rrInterval: ps.ibi_ms > 0 ? ps.ibi_ms : undefined,
                confidence: ps.qok ? 85 : 50,
                derivedFrom: 'PPG_STREAM_FW',
                deviceId: connectedDeviceRef.current?.id,
                deviceName: connectedDeviceNameRef.current || undefined,
                sessionId: activeSessionId,
              }).catch(err => console.warn('[Pipeline] Failed to queue HR reading:', err));
              markFbWrite('heartRate');
              incDataPoints();
            }

            // Save the same firmware-clean PPG signal shown by the GUI. This is
            // intentionally downsampled for Firestore; the live graph remains full rate.
            if (
              userRef.current &&
              activeSessionId &&
              canWriteToFirebase('ppg_stream')
            ) {
              savePPGReading(userRef.current.uid, {
                channel: 'GREEN_FILT',
                rawValue: Math.round(ps.clean * 1000),
                signalQuality: Math.round(ps.sqi * 100),
                skinContact: !ps.artifact && ps.qok,
                deviceId: connectedDeviceRef.current?.id,
                deviceName: connectedDeviceNameRef.current || undefined,
                sessionId: activeSessionId,
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
            const current = latestReadingsRef.current;
            current.v0Hr = vm.hr_bpm;
            current.v0Tms = vm.t_ms;
            current.v0HrQual = vm.hr_quality;
            current.v0HrCov = vm.hr_coverage_sec;
            current.v0Rmssd = vm.hrv_rmssd_ms;
            current.v0HrvQual = vm.hrv_quality;
            current.v0Act = vm.activity;
            current.v0ActConf = vm.act_conf;
            current.v0ArtFrac = vm.art_frac;
            current.v0EdaMu = vm.eda_muSCL;
            current.v0EdaScr = vm.eda_sigmaSCR;
            current.v0EdaQual = vm.eda_quality;
            current.v0EdaConf = vm.eda_confidence;
            current.v0Temp = vm.temp_c;
            current.v0TempQual = vm.temp_quality;
            current.v0TempSlope = vm.temp_slope_5m;
            current.v0Sleep = vm.sleep_state;
            current.v0SleepConf = vm.sleep_conf;
            current.v0MinUpdated = now;
            current.lastUpdate = now;

            // Save the definitive minute HR only when it can be linked to the
            // active Firestore recording session.
            const activeSessionId = sessionRef.current.sessionId;
            if (
              userRef.current &&
              activeSessionId &&
              vm.hr_bpm > 0 &&
              vm.hr_quality !== 'INVALID'
            ) {
              saveHeartRateReading(userRef.current.uid, {
                heartRate: Math.round(vm.hr_bpm),
                hrv: vm.hrv_rmssd_ms > 0 ? vm.hrv_rmssd_ms : undefined,
                confidence: vm.hr_quality === 'GOOD' ? 95 : 70,
                derivedFrom: 'V0_MIN_FW',
                deviceId: connectedDeviceRef.current?.id,
                deviceName: connectedDeviceNameRef.current || undefined,
                sessionId: activeSessionId,
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
  // 33ms UI heartbeat: publishes near 30 FPS while native PPG motion renders at ~60 FPS
  useEffect(() => {
    let uiTicks = 0;
    const intervalId = setInterval(() => {
      uiTicks++;
      const next = latestReadingsRef.current;

      // Atomically push latest readings to React state with explicit timestamp copy
      if (isMountedRef.current && next.lastUpdate > lastUiPublishRef.current) {
        lastUiPublishRef.current = next.lastUpdate;
        setLive(prev => {
          const ppgFilt = next.ppgFilt ?? prev.ppgStream.filt;
          const ppgTs = next.ppgTs ?? prev.ppgStream.timestamps;
          const ppgQokFlags = next.ppgQokFlags ?? prev.ppgStream.qualityFlags;
          const ppgArtifactFlags = next.ppgArtifactFlags ?? prev.ppgStream.artifactFlags;
          const ppgContactFlags = next.ppgContactFlags ?? prev.ppgStream.contactFlags;

          // Match the desktop GUI's default 10-second quality statistics.
          let qualityStart = 0;
          if (ppgTs.length > 0) {
            const cutoff = ppgTs[ppgTs.length - 1] - 10_000;
            qualityStart = ppgTs.findIndex(t => t >= cutoff);
            if (qualityStart < 0) qualityStart = 0;
          }
          const qokWindow = ppgQokFlags.slice(qualityStart);
          const artWindow = ppgArtifactFlags.slice(qualityStart);
          const contactWindow = ppgContactFlags.slice(qualityStart);
          const goodCount = qokWindow.reduce(
            (count, qok, index) => count + (qok && !artWindow[index] && !contactWindow[index] ? 1 : 0),
            0,
          );
          const qokPercent = qokWindow.length ? (100 * goodCount) / qokWindow.length : 0;
          const artifactPercent = artWindow.length
            ? (100 * artWindow.filter(Boolean).length) / artWindow.length
            : 0;

          // The PC GUI's live HR KPI follows the latest C record. M remains a
          // separate minute-summary source and must not overwrite the live value.
          const hrBpm = next.fwHrBpm ?? prev.heartRate.bpm;
          const hrQok = next.fwHrQok ?? false;
          const hrQuality = next.fwHrQuality ?? 0;
          const hrConf: 'high' | 'low' | 'invalid' =
            hrBpm <= 0 ? 'invalid' : hrQuality >= 3 ? 'high' : hrQuality >= 2 || hrQok ? 'low' : 'invalid';
          const hrUpdated = next.fwHrUpdated ?? 0;
          const minuteUpdated = next.v0MinUpdated ?? 0;

          return {
            temperature: {
              tempC: next.temp_c ?? 0,
              tempF: next.temp_c !== null ? (next.temp_c * 9 / 5) + 32 : 0,
              qualityOk: next.tempQualityOk ?? prev.temperature.qualityOk,
              lastUpdated: next.tempUpdated ? new Date(next.tempUpdated) : prev.temperature.lastUpdated,
            },
            ppg: {
              red: next.red ?? 0,
              ir: next.ir ?? 0,
              green: next.green ?? 0,
              lastUpdated: next.ppgUpdated ? new Date(next.ppgUpdated) : prev.ppg.lastUpdated,
            },
            ppgStream: {
              filt: ppgFilt,
              th: next.ppgTh ?? prev.ppgStream.th,
              peaks: next.ppgPeaks ?? prev.ppgStream.peaks,
              timestamps: ppgTs,
              qualityFlags: ppgQokFlags,
              artifactFlags: ppgArtifactFlags,
              contactFlags: ppgContactFlags,
              fsHz: next.fwFsHz ?? prev.ppgStream.fsHz,
              acdc: next.fwAcdc ?? prev.ppgStream.acdc,
              hrQuality: next.fwHrQuality ?? prev.ppgStream.hrQuality,
              rmssdMs: next.fwRmssd ?? prev.ppgStream.rmssdMs,
              prvReady: next.fwPrvReady ?? prev.ppgStream.prvReady,
              ibiCv: next.fwIbiCv ?? prev.ppgStream.ibiCv,
              lastUpdated: next.ppgWfUpdated ? new Date(next.ppgWfUpdated) : prev.ppgStream.lastUpdated,
            },
            heartRate: {
              bpm: hrBpm,
              ibi_ms: next.fwHrIbi ?? prev.heartRate.ibi_ms,
              confidence: hrConf,
              qualityOk: hrQok,
              lastUpdated: hrUpdated ? new Date(hrUpdated) : prev.heartRate.lastUpdated,
            },
            ppgQuality: {
              sqi: next.ppgSqi ?? prev.ppgQuality.sqi,
              artifact: next.ppgArt ?? prev.ppgQuality.artifact,
              qualityOk: next.ppgQok ?? prev.ppgQuality.qualityOk,
              wearDetected: !(next.ppgContactArtifact ?? prev.ppgQuality.contactArtifact),
              contactArtifact: next.ppgContactArtifact ?? prev.ppgQuality.contactArtifact,
              acdc: next.fwAcdc ?? prev.ppgQuality.acdc,
              fsHz: next.fwFsHz ?? prev.ppgQuality.fsHz,
              hrQuality,
              prvReady: next.fwPrvReady ?? prev.ppgQuality.prvReady,
              ibiCv: next.fwIbiCv ?? prev.ppgQuality.ibiCv,
              qokPercent,
              artifactPercent,
              lastUpdated: next.ppgWinUpdated ? new Date(next.ppgWinUpdated) : prev.ppgQuality.lastUpdated,
            },
            hrv: {
              rmssd_ms: (next.fwRmssd !== undefined && next.fwRmssd >= 0)
                ? next.fwRmssd
                : (next.v0Rmssd ?? prev.hrv.rmssd_ms),
              quality: next.fwPrvReady ? 'READY' : (next.v0HrvQual ?? prev.hrv.quality),
              lastUpdated: hrUpdated
                ? new Date(hrUpdated)
                : minuteUpdated ? new Date(minuteUpdated) : prev.hrv.lastUpdated,
            },
            activity: {
              state: next.v0Act ?? prev.activity.state,
              confidence: next.v0ActConf ?? prev.activity.confidence,
              sleepState: next.v0Sleep ?? prev.activity.sleepState,
              sleepConf: next.v0SleepConf ?? prev.activity.sleepConf,
              lastUpdated: minuteUpdated ? new Date(minuteUpdated) : prev.activity.lastUpdated,
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
            imuStream: {
              timestamps: next.imuTs ?? prev.imuStream.timestamps,
              ax_g: next.imuAxG ?? prev.imuStream.ax_g,
              ay_g: next.imuAyG ?? prev.imuStream.ay_g,
              az_g: next.imuAzG ?? prev.imuStream.az_g,
              gx_dps: next.imuGxDps ?? prev.imuStream.gx_dps,
              gy_dps: next.imuGyDps ?? prev.imuStream.gy_dps,
              gz_dps: next.imuGzDps ?? prev.imuStream.gz_dps,
              lastUpdated: next.imuUpdated ? new Date(next.imuUpdated) : prev.imuStream.lastUpdated,
            },
            eda: {
              rawADC: next.edaRaw ?? 0,
              mv: next.edaMv ?? 0,
              conductance_uS: next.edaUs ?? 0,
              stressLevel: next.edaUs !== null ? estimateStressLevel(next.edaUs) : 'LOW',
              qualityOk: next.edaQualityOk ?? prev.eda.qualityOk,
              lastUpdated: next.edaUpdated ? new Date(next.edaUpdated) : prev.eda.lastUpdated,
            },
            edaStream: {
              timestamps: next.edaTs ?? prev.edaStream.timestamps,
              values_uS: next.edaValuesUs ?? prev.edaStream.values_uS,
              qualityFlags: next.edaQualityFlags ?? prev.edaStream.qualityFlags,
              lastUpdated: next.edaUpdated ? new Date(next.edaUpdated) : prev.edaStream.lastUpdated,
            },
            temperatureStream: {
              timestamps: next.tempTs ?? prev.temperatureStream.timestamps,
              values_c: next.tempValuesC ?? prev.temperatureStream.values_c,
              qualityFlags: next.tempQualityFlags ?? prev.temperatureStream.qualityFlags,
              lastUpdated: next.tempUpdated ? new Date(next.tempUpdated) : prev.temperatureStream.lastUpdated,
            },
            minuteSummary: {
              t_ms: next.v0Tms ?? prev.minuteSummary.t_ms,
              activity: next.v0Act ?? prev.minuteSummary.activity,
              activityConfidence: next.v0ActConf ?? prev.minuteSummary.activityConfidence,
              artifactFraction: next.v0ArtFrac ?? prev.minuteSummary.artifactFraction,
              hrBpm: next.v0Hr ?? prev.minuteSummary.hrBpm,
              hrCoverageSec: next.v0HrCov ?? prev.minuteSummary.hrCoverageSec,
              hrQuality: next.v0HrQual ?? prev.minuteSummary.hrQuality,
              rmssdMs: next.v0Rmssd ?? prev.minuteSummary.rmssdMs,
              hrvQuality: next.v0HrvQual ?? prev.minuteSummary.hrvQuality,
              edaMuScl: next.v0EdaMu ?? prev.minuteSummary.edaMuScl,
              edaSigmaScr: next.v0EdaScr ?? prev.minuteSummary.edaSigmaScr,
              edaQuality: next.v0EdaQual ?? prev.minuteSummary.edaQuality,
              edaConfidence: next.v0EdaConf ?? prev.minuteSummary.edaConfidence,
              tempC: next.v0Temp ?? prev.minuteSummary.tempC,
              tempQuality: next.v0TempQual ?? prev.minuteSummary.tempQuality,
              tempSlope5m: next.v0TempSlope ?? prev.minuteSummary.tempSlope5m,
              sleepState: next.v0Sleep ?? prev.minuteSummary.sleepState,
              sleepConfidence: next.v0SleepConf ?? prev.minuteSummary.sleepConfidence,
              lastUpdated: minuteUpdated ? new Date(minuteUpdated) : prev.minuteSummary.lastUpdated,
            },
          };
        });
      }
    }, 33); // ~30 FPS data publication; native graph translation remains ~60 FPS

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

        const nextSession: PipelineSession = {
          sessionId,
          isRecording: true,
          startedAt: new Date(),
          dataPointsSaved: 0,
        };

        // BLE records can arrive before React completes another render. Update
        // the ref synchronously so every queued sensor record receives sessionId.
        sessionRef.current = nextSession;
        setSession(nextSession);

        // Start batching only after the active session is visible to the BLE listener.
        startFirebaseWriteBatcher();

        console.log('[Session Action] ✅ Recording started:', sessionId);
      } catch (err) {
        console.error('[Session Action] Failed to start session:', err);
      } finally {
        startInFlightRef.current = false;
      }
    },
    [user, connectedDevice, connectedDeviceName, isEarbudConnected]
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

    // Stop admitting new Firebase sensor writes immediately. The React state
    // still retains the original sessionId for the final flush/endSession calls.
    sessionRef.current = {
      ...sessionRef.current,
      sessionId: null,
      isRecording: false,
    };

    // Prevent the scheduled Firebase interval from starting another commit while
    // the shutdown flush is running. stopDataLogger later remains a safe no-op.
    stopFirebaseWriteBatcher();

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
        const clearedSession: PipelineSession = {
          sessionId: null,
          isRecording: false,
          startedAt: null,
          dataPointsSaved: 0,
        };
        sessionRef.current = clearedSession;
        setSession(clearedSession);
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
          const clearedSession: PipelineSession = {
            sessionId: null,
            isRecording: false,
            startedAt: null,
            dataPointsSaved: 0,
          };
          sessionRef.current = clearedSession;
          setSession(clearedSession);
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
    latestReadingsRef.current = { ...initialSensorState };
    lastUiPublishRef.current = 0;
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
          const clearedSession: PipelineSession = {
            sessionId: null,
            isRecording: false,
            startedAt: null,
            dataPointsSaved: 0,
          };
          sessionRef.current = clearedSession;
          setSession(clearedSession);
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

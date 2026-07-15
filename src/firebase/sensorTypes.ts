import { Timestamp } from 'firebase/firestore';

/**
 * Enhanced Sensor Data Types for Firebase Storage
 * 
 * Database Structure:
 * users/{userId}/
 *   ├── profile/                    # User profile and settings
 *   ├── devices/                    # Registered devices
 *   ├── sessions/                   # Recording sessions
 *   ├── sensor_data/                # All sensor readings
 *   │   ├── eda/                   # EDA/GSR readings
 *   │   ├── temperature/           # Temperature readings
 *   │   ├── ppg/                   # PPG/Heart rate readings
 *   │   ├── imu/                   # Accelerometer & Gyroscope
 *   │   └── raw_logs/              # Raw device logs
 *   ├── analytics/                  # Aggregated statistics
 *   └── stimulation_events/        # Stimulation therapy records
 */

// ============================================================================
// SENSOR TYPE ENUMS
// ============================================================================

export enum SensorType {
  EDA = 'EDA',
  TEMPERATURE = 'TEMPERATURE',
  PPG_RED = 'PPG_RED',
  PPG_IR = 'PPG_IR',
  PPG_GREEN = 'PPG_GREEN',
  HEART_RATE = 'HEART_RATE',
  SPO2 = 'SPO2',
  ACCELEROMETER = 'ACCELEROMETER',
  GYROSCOPE = 'GYROSCOPE',
}

export enum DataQuality {
  EXCELLENT = 'EXCELLENT',
  GOOD = 'GOOD',
  FAIR = 'FAIR',
  POOR = 'POOR',
  INVALID = 'INVALID',
}

// ============================================================================
// BASE INTERFACES
// ============================================================================

export interface BaseSensorReading {
  timestamp: Timestamp;
  deviceId?: string;
  deviceName?: string;
  sessionId?: string;
  quality?: DataQuality;
  metadata?: Record<string, any>;
}

// ============================================================================
// EDA/GSR SENSOR (ADS1113)
// ============================================================================

export interface EDAReading extends BaseSensorReading {
  sensorType: SensorType.EDA;
  rawValue: number;              // Raw ADC value
  voltage: number;               // In volts
  resistance: number;            // Skin resistance in kOhms
  conductance: number;           // Skin conductance in microSiemens
  stressLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH';
  arousalState?: 'CALM' | 'NORMAL' | 'AROUSED' | 'HIGHLY_AROUSED';
}

// ============================================================================
// TEMPERATURE SENSOR (AS6221)
// ============================================================================

export interface TemperatureReading extends BaseSensorReading {
  sensorType: SensorType.TEMPERATURE;
  temperature: number;           // In Celsius
  temperatureFahrenheit: number; // In Fahrenheit
  bodyLocation?: 'WRIST' | 'CHEST' | 'FOREHEAD' | 'OTHER';
  ambientTemp?: number;          // Optional ambient temperature
  skinContact?: boolean;         // Whether sensor has good skin contact
}

// ============================================================================
// PPG/HEART RATE SENSOR (MAX30101)
// ============================================================================

export interface PPGReading extends BaseSensorReading {
  sensorType: SensorType.PPG_RED | SensorType.PPG_IR | SensorType.PPG_GREEN;
  /** PPG channel. 'GREEN_FILT' is the firmware algo_v0 high-pass filtered waveform. */
  channel: 'RED' | 'IR' | 'GREEN' | 'GREEN_FILT';
  rawValue: number;              // Raw ADC value
  filtered?: number;             // Optional filtered value
  signalQuality?: number;        // 0-100 quality score
  skinContact?: boolean;
}

export interface HeartRateReading extends BaseSensorReading {
  sensorType: SensorType.HEART_RATE;
  heartRate: number;             // BPM
  rrInterval?: number;           // R-R interval in ms
  hrv?: number;                  // Heart rate variability (RMSSD ms)
  confidence?: number;           // 0-100 confidence score
  /**
   * Source of the HR measurement.
   * 'PPG_STREAM_FW' = per-beat from algo_v0 PPG_STREAM peak events
   * 'V0_MIN_FW'     = 1-minute summary from algo_v0 V0_MIN
   */
  derivedFrom?: 'PPG_IR' | 'PPG_RED' | 'ECG' | 'PPG_STREAM_FW' | 'V0_MIN_FW';
}

export interface SpO2Reading extends BaseSensorReading {
  sensorType: SensorType.SPO2;
  spO2: number;                  // Oxygen saturation percentage (0-100)
  perfusionIndex?: number;       // Perfusion index
  signalStrength?: number;       // Signal strength 0-100
  redValue: number;              // RED LED value used
  irValue: number;               // IR LED value used
}

// ============================================================================
// IMU SENSOR (LSM6DSO)
// ============================================================================

export interface AccelerometerReading extends BaseSensorReading {
  sensorType: SensorType.ACCELEROMETER;
  x: number;                     // mg (milligravity)
  y: number;
  z: number;
  magnitude?: number;            // Vector magnitude
  rawX?: number;                 // Raw ADC values
  rawY?: number;
  rawZ?: number;
}

export interface GyroscopeReading extends BaseSensorReading {
  sensorType: SensorType.GYROSCOPE;
  x: number;                     // mdps (milli-degrees per second)
  y: number;
  z: number;
  magnitude?: number;            // Angular velocity magnitude
  rawX?: number;                 // Raw ADC values
  rawY?: number;
  rawZ?: number;
}

export interface IMUReading extends BaseSensorReading {
  accelerometer: {
    x: number;
    y: number;
    z: number;
    magnitude?: number;
  };
  gyroscope: {
    x: number;
    y: number;
    z: number;
    magnitude?: number;
  };
  activity?: 'STILL' | 'WALKING' | 'RUNNING' | 'MOVING';
  orientation?: string;
}

// ============================================================================
// DEVICE & SESSION MANAGEMENT
// ============================================================================

export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  deviceType: 'NRF52840' | 'SMARTWATCH' | 'SMART_STIM' | 'OTHER';
  firmwareVersion?: string;
  hardwareVersion?: string;
  batteryLevel?: number;
  lastConnected: Timestamp;
  firstRegistered: Timestamp;
  totalSessions?: number;
  isActive: boolean;
}

export interface RecordingSession {
  sessionId: string;
  sessionName: string;
  startTime: Timestamp;
  endTime?: Timestamp;
  duration?: number;             // In seconds
  deviceId?: string;
  deviceName?: string;
  
  // Active sensors during session
  activeSensors: SensorType[];
  
  // Data counts
  dataPoints: {
    eda?: number;
    temperature?: number;
    ppg?: number;
    heartRate?: number;
    spo2?: number;
    accelerometer?: number;
    gyroscope?: number;
  };
  
  // Session metadata
  notes?: string;
  tags?: string[];
  location?: string;
  activity?: string;
  mood?: string;
  
  // Flags
  isComplete: boolean;
  hasErrors: boolean;
  qualityScore?: number;         // Overall data quality 0-100
}

// ============================================================================
// STIMULATION EVENTS
// ============================================================================

export interface StimulationEvent {
  timestamp: Timestamp;
  waveform: 'SINE' | 'SQUARE' | 'TRIANGLE' | 'SAWTOOTH' | 'CUSTOM';
  frequency: number;             // Hz
  amplitude: number;             // Percentage or mA
  pulseWidth?: number;           // Microseconds
  duration: number;              // Milliseconds
  deviceId?: string;
  deviceName?: string;
  sessionId?: string;
  
  // Therapy details
  electrodePosition?: string;
  targetArea?: string;
  intensity?: 'LOW' | 'MEDIUM' | 'HIGH';
  
  // User feedback
  comfort?: number;              // 1-10 scale
  effectiveness?: number;        // 1-10 scale
  sideEffects?: string[];
  notes?: string;
}

// ============================================================================
// ANALYTICS & AGGREGATIONS
// ============================================================================

export interface DailyAnalytics {
  date: string;                  // YYYY-MM-DD
  userId: string;
  timestamp: Timestamp;
  
  // Session statistics
  totalSessions: number;
  totalDuration: number;         // In seconds
  avgSessionDuration: number;
  
  // Sensor data statistics
  eda?: {
    avgConductance: number;
    minConductance: number;
    maxConductance: number;
    stressTimePercentage: number;
    dataPoints: number;
  };
  
  temperature?: {
    avgTemp: number;
    minTemp: number;
    maxTemp: number;
    dataPoints: number;
  };
  
  heartRate?: {
    avgBPM: number;
    minBPM: number;
    maxBPM: number;
    restingBPM?: number;
    maxBPM_recorded?: number;
    avgHRV?: number;
    dataPoints: number;
  };
  
  spo2?: {
    avgSpO2: number;
    minSpO2: number;
    dataPoints: number;
  };
  
  activity?: {
    stepCount?: number;
    activeMinutes?: number;
    sedentaryMinutes?: number;
    movementIntensity?: number;
  };
  
  // Stimulation statistics
  stimulation?: {
    totalEvents: number;
    totalDuration: number;
    avgComfort?: number;
    avgEffectiveness?: number;
  };
}

export interface WeeklyAnalytics {
  weekStart: string;             // YYYY-MM-DD (Monday)
  weekEnd: string;
  userId: string;
  timestamp: Timestamp;
  
  // Aggregated daily data
  totalSessions: number;
  totalDuration: number;
  avgDailyDuration: number;
  
  // Trends
  trends: {
    stressLevel?: 'IMPROVING' | 'STABLE' | 'WORSENING';
    heartRateVariability?: 'IMPROVING' | 'STABLE' | 'WORSENING';
    activityLevel?: 'INCREASING' | 'STABLE' | 'DECREASING';
  };
  
  // Summary statistics
  avgHeartRate?: number;
  avgStressScore?: number;
  avgSpO2?: number;
  avgTemperature?: number;
}

// ============================================================================
// RAW LOGS
// ============================================================================

export interface RawSensorLog {
  timestamp: Timestamp;
  deviceId?: string;
  deviceName?: string;
  sessionId?: string;
  module: string;                // e.g., 'max30101_demo', 'lsm6dso_app'
  logLevel: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  message: string;
  rawData?: string;              // Original raw log line
}

// ============================================================================
// BATCH OPERATIONS
// ============================================================================

export interface BatchSensorData {
  userId: string;
  sessionId?: string;
  deviceId?: string;
  timestamp: Timestamp;
  
  eda?: EDAReading[];
  temperature?: TemperatureReading[];
  ppg?: PPGReading[];
  heartRate?: HeartRateReading[];
  spo2?: SpO2Reading[];
  accelerometer?: AccelerometerReading[];
  gyroscope?: GyroscopeReading[];
  imu?: IMUReading[];
}

// ============================================================================
// EXPORT ALL SENSOR READING TYPES
// ============================================================================

export type AnySensorReading = 
  | EDAReading 
  | TemperatureReading 
  | PPGReading 
  | HeartRateReading 
  | SpO2Reading 
  | AccelerometerReading 
  | GyroscopeReading 
  | IMUReading;

import {
  collection,
  addDoc,
  setDoc,
  doc,
  serverTimestamp,
  Timestamp,
  writeBatch,
  query,
  where,
  orderBy,
  limit,
  getDocs,
  updateDoc,
  increment,
  getDoc
} from 'firebase/firestore';
import { db } from './firebaseConfig';
import {
  SensorType,
  DataQuality,
  EDAReading,
  TemperatureReading,
  PPGReading,
  HeartRateReading,
  SpO2Reading,
  AccelerometerReading,
  GyroscopeReading,
  IMUReading,
  DeviceInfo,
  RecordingSession,
  StimulationEvent,
  DailyAnalytics,
  RawSensorLog,
  BatchSensorData,
  AnySensorReading,
  MinuteSummaryReading,
} from './sensorTypes';

/**
 * Firebase Data Logger - Enhanced Version
 * 
 * Comprehensive utility functions to save sensor data to Firestore
 * with proper organization, indexing, and analytics support
 * 
 * Database Structure:
 * users/{userId}/
 *   ├── profile/                    # User profile
 *   ├── devices/                    # Registered devices
 *   ├── sessions/                   # Recording sessions
 *   ├── sensor_data/
 *   │   ├── eda/                   # EDA/GSR readings
 *   │   ├── temperature/           # Temperature readings
 *   │   ├── ppg/                   # PPG readings
 *   │   ├── heart_rate/            # Heart rate readings
 *   │   ├── spo2/                  # SpO2 readings
 *   │   ├── accelerometer/         # Accelerometer readings
 *   │   ├── gyroscope/             # Gyroscope readings
 *   │   ├── imu/                   # Combined IMU readings
 *   │   └── raw_logs/              # Raw device logs
 *   ├── analytics/
 *   │   ├── daily/                 # Daily aggregations
 *   │   └── weekly/                # Weekly aggregations
 *   └── stimulation_events/        # Stimulation therapy records
 */

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get the collection path for a specific sensor type
 */
const getSensorCollectionPath = (sensorType: SensorType): string => {
  const paths: Record<SensorType, string> = {
    [SensorType.EDA]: 'sensor_data/eda/readings',
    [SensorType.TEMPERATURE]: 'sensor_data/temperature/readings',
    [SensorType.PPG_RED]: 'sensor_data/ppg/readings',
    [SensorType.PPG_IR]: 'sensor_data/ppg/readings',
    [SensorType.PPG_GREEN]: 'sensor_data/ppg/readings',
    [SensorType.HEART_RATE]: 'sensor_data/heart_rate/readings',
    [SensorType.SPO2]: 'sensor_data/spo2/readings',
    [SensorType.ACCELEROMETER]: 'sensor_data/accelerometer/readings',
    [SensorType.GYROSCOPE]: 'sensor_data/gyroscope/readings',
  };
  return paths[sensorType] || 'sensor_data/other/readings';
};

/**
 * FIRESTORE SAFETY FILTER: Prevents NaN/Infinity from crashing Firebase writes
 * 
 * When the user touches the EDA sensor or sensors spike from noise, hardware can emit NaN or Infinity.
 * Firebase hard-crashes if these values are written to the database.
 * 
 * This function sanitizes all numeric values:
 * - Returns null for non-finite numbers (NaN, Infinity, -Infinity)
 * - Returns null for undefined/null
 * - Returns the number as-is if finite
 * 
 * Usage: safeNum(value) instead of just value
 */
const safeNum = (val: any): number | null => {
  if (val === null || val === undefined) return null;
  if (typeof val === 'number' && !Number.isFinite(val)) return null; // Destroys NaN and Infinity
  return val;
};

/**
 * Calculate data quality based on sensor readings
 */
const calculateDataQuality = (reading: any): DataQuality => {
  // Implement quality assessment logic based on sensor type
  // For now, return GOOD as default
  return DataQuality.GOOD;
};

/**
 * Remove undefined values from an object before writing to Firestore.
 * Firestore rejects documents that contain undefined field values.
 */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Prepare arbitrary application data for Firestore without altering Firestore
 * sentinel values such as serverTimestamp(), increment(), or Timestamp objects.
 *
 * - undefined object fields are removed
 * - undefined array entries become null (Firestore does not accept undefined)
 * - NaN and +/-Infinity become null
 * - plain nested objects and arrays are sanitised recursively
 * - class instances / Firestore sentinel objects are preserved unchanged
 */
const sanitizeForFirestore = (value: any): any => {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((item) => {
      const cleaned = sanitizeForFirestore(item);
      return cleaned === undefined ? null : cleaned;
    });
  }

  if (!isPlainObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, sanitizeForFirestore(item)])
  );
};

const stripUndefined = <T extends object>(obj: T): Partial<T> =>
  sanitizeForFirestore(obj) as Partial<T>;

// ============================================================================
// FIREBASE WRITE BATCHING SYSTEM
// ============================================================================
// Batches all sensor writes to reduce from 200+/sec to ~60-100 per batch
// Performs batch writes every 3 seconds using writeBatch() API
// CRITICAL: Implements 1Hz throttling + 500-operation batch limit

interface FirebaseQueuedWrite {
  userId: string;
  collectionPath: string;  // e.g., 'sensor_data/eda/readings'
  data: any;  // The reading data with timestamp
}

interface BatchWriteStats {
  totalWrites: number;
  byType: Record<string, number>;
}

// Module-level queue for batching writes
let firebaseWriteQueue: FirebaseQueuedWrite[] = [];
let batchProcessorInterval: NodeJS.Timeout | null = null;
let batchCommitInProgress = false;

/**
 * THROTTLING MECHANISM: Track last write timestamp per sensor type
 * Ensures we only write 1 sample per second per sensor (1Hz downsampling)
 * Key format: "userId:sensorType" (e.g., "user123:ppg", "user123:imu")
 * 
 * HIGH-FREQUENCY SENSORS (1Hz throttling to reduce Firestore writes by 99%):
 *   - PPG (200Hz firmware → 1Hz writes)
 *   - IMU: accel/gyro (200Hz firmware → 1Hz writes)
 * 
 * OTHER SENSORS (use existing FB_MIN_INTERVAL_MS throttling):
 *   - Temperature (every 5s)
 *   - EDA (every 3s)
 */
const lastWriteTimestamp = new Map<string, number>();
const lastPPGWrite = new Map<string, number>();
const lastIMUWrite = new Map<string, number>();

/**
 * Check if we should throttle this sensor write
 * Returns true if >1 second has passed since last write for this sensor
 * Returns false if <1 second (drop this frame)
 */
const shouldThrottleWrite = (userId: string, sensorType: string): boolean => {
  const key = `${userId}:${sensorType}`;
  const now = Date.now();
  const lastWrite = lastWriteTimestamp.get(key) || 0;

  // Only write if 1+ second has passed since last write
  if (now - lastWrite >= 1000) {
    lastWriteTimestamp.set(key, now);
    return false; // Don't throttle, write this one
  }

  return true; // Throttle, skip this one
};

/**
 * Start the Firebase batch processor
 * Runs every 3 seconds, drains all queued writes using writeBatch()
 * Logs once per batch instead of per-write
 */
export const startFirebaseWriteBatcher = (): void => {
  if (batchProcessorInterval) {
    console.warn('[Firebase] ⚠️ Batch processor already running');
    return;
  }

  batchProcessorInterval = setInterval(async () => {
    // Avoid overlapping asynchronous commits when the network is slow.
    if (batchCommitInProgress || firebaseWriteQueue.length === 0) {
      return;
    }

    batchCommitInProgress = true;
    const queueToProcess = [...firebaseWriteQueue];
    firebaseWriteQueue = [];

    try {
      const writesByUser = new Map<string, FirebaseQueuedWrite[]>();
      for (const write of queueToProcess) {
        if (!writesByUser.has(write.userId)) {
          writesByUser.set(write.userId, []);
        }
        writesByUser.get(write.userId)!.push(write);
      }

      const stats: BatchWriteStats = {
        totalWrites: 0,
        byType: {},
      };

      for (const [userId, writes] of writesByUser) {
        const MAX_BATCH_SIZE = 450;

        for (let i = 0; i < writes.length; i += MAX_BATCH_SIZE) {
          const chunk = writes.slice(i, i + MAX_BATCH_SIZE);
          const batch = writeBatch(db);

          for (const write of chunk) {
            const collectionRef = collection(
              db,
              'users',
              userId,
              ...write.collectionPath.split('/')
            );
            const docRef = doc(collectionRef);
            batch.set(docRef, stripUndefined(write.data));
          }

          try {
            await batch.commit();

            stats.totalWrites += chunk.length;
            for (const write of chunk) {
              const sensorType = write.collectionPath.split('/')[1] || 'unknown';
              stats.byType[sensorType] = (stats.byType[sensorType] || 0) + 1;
            }
          } catch (error) {
            // Requeue only the failed chunk. Already committed chunks are not duplicated.
            firebaseWriteQueue.unshift(...chunk);
            console.error('[Firebase] ❌ Batch chunk failed and was requeued:', error);
          }
        }
      }

      const typeBreakdown = Object.entries(stats.byType)
        .map(([type, count]) => `${type}: ${count}`)
        .join(', ');

      if (stats.totalWrites > 0) {
        console.log(
          `[Firebase] ✅ Batch committed: ${stats.totalWrites} write(s)` +
          (typeBreakdown ? ` (${typeBreakdown})` : '')
        );
      }
    } catch (error) {
      // An unexpected processing failure should not lose queued records.
      firebaseWriteQueue.unshift(...queueToProcess);
      console.error('[Firebase] ❌ Batch processor failed; writes requeued:', error);
    } finally {
      batchCommitInProgress = false;
    }
  }, 3000);
};

/**
 * Stop the Firebase batch processor
 * Useful for cleanup or switching modes
 */
export const stopFirebaseWriteBatcher = (): void => {
  if (batchProcessorInterval) {
    clearInterval(batchProcessorInterval);
    batchProcessorInterval = null;
    // Batch processor stopped
  }
};

/**
 * Stop the data logger and safely flush remaining data
 * TEARDOWN DIAGNOSTICS: Catches any errors during final flush
 * Called during app unmount or session cleanup
 */
export const stopDataLogger = (userId?: string): void => {
  try {
    // Stop the batch processor interval FIRST
    stopFirebaseWriteBatcher();
  } catch (stopErr) {
    console.warn('[Firebase] Error stopping batcher (ignored):', stopErr);
  }

  // Only attempt flush if we have valid data structures
  try {
    if (userId && firebaseWriteQueue && Array.isArray(firebaseWriteQueue) && firebaseWriteQueue.length > 0) {
      flushFirebaseWriteQueue().catch(err => {
        console.warn('[Firebase] Final flush error (contained):', err?.message);
        // Error is contained, app won't crash
      });
    }
  } catch (flushErr) {
    console.warn('[Firebase] Error in final flush (contained):', flushErr);
  }
};

/**
 * Immediately flush the write queue and wait for completion
 * CRITICAL: Implements 500-operation batch limit and robust error isolation
 * Useful for graceful shutdown or before important operations
 * 
 * SAFETY: Wrapped in try/catch to prevent Firebase errors from crashing BLE pipeline or UI
 */
export const flushFirebaseWriteQueue = async (): Promise<void> => {
  // If the scheduled processor is already committing, wait briefly so shutdown
  // does not run a second Firestore batch concurrently.
  const waitStartedAt = Date.now();
  while (batchCommitInProgress && Date.now() - waitStartedAt < 5000) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  console.log('[Teardown Diagnostic] flushFirebaseWriteQueue called. Items in queue:', firebaseWriteQueue.length);

  if (!firebaseWriteQueue || firebaseWriteQueue.length === 0) {
    console.log('[Teardown Diagnostic] Queue is empty, skipping Firebase commit.');
    return;
  }

  const queueToProcess = [...firebaseWriteQueue];
  firebaseWriteQueue = [];  // Clear queue immediately to prevent double-processing

  try {
    // Group writes by user for atomic batching
    const writesByUser = new Map<string, FirebaseQueuedWrite[]>();
    for (const write of queueToProcess) {
      if (!writesByUser.has(write.userId)) {
        writesByUser.set(write.userId, []);
      }
      writesByUser.get(write.userId)!.push(write);
    }

    let totalWrites = 0;
    let batchCount = 0;

    // CRITICAL: Process each user's writes with 500-operation limit per batch
    for (const [userId, writes] of writesByUser) {
      // HARD LIMIT: Never exceed 500 operations per writeBatch()
      // Using 450 as safe margin to guarantee we stay under the hard limit
      const MAX_BATCH_SIZE = 450;

      for (let i = 0; i < writes.length; i += MAX_BATCH_SIZE) {
        const chunk = writes.slice(i, i + MAX_BATCH_SIZE);

        try {
          const batch = writeBatch(db);

          for (const write of chunk) {
            const collectionRef = collection(db, 'users', userId, ...write.collectionPath.split('/'));
            const docRef = doc(collectionRef);
            batch.set(docRef, stripUndefined(write.data));
          }

          await batch.commit();
          totalWrites += chunk.length;
          batchCount++;
        } catch (batchError: any) {
          console.error('[Firebase] ❌ Flush batch failed:', batchError);
          // Continue processing other batches. Shutdown must not hang forever.
        }
      }
    }

    if (totalWrites > 0) {
      console.log(
        `[Firebase] ✅ Flush committed: ${totalWrites} write(s) in ${batchCount} batch(es)`
      );
    }
  } catch (error: any) {
    // ISOLATION: Catch any top-level errors to prevent Firebase failures from crashing the app
    // Clear queue to prevent infinite retry loop
    // Do NOT rethrow — this error must be contained
  }
};


// ============================================================================
// EDA/GSR SENSOR FUNCTIONS
// ============================================================================

/**
 * Save EDA/GSR reading from ADS1113 sensor
 * NOTE: Queued for batch processing (writes every 3 seconds, not immediately)
 * 
 * @example
 * await saveEDAReading(user.uid, {
 *   rawValue: 12345,
 *   voltage: 2.5,
 *   resistance: 150,
 *   conductance: 6.67,
 *   stressLevel: 'MEDIUM'
 * });
 */
export const saveEDAReading = async (
  userId: string,
  data: Omit<EDAReading, 'timestamp' | 'sensorType'>
): Promise<void> => {
  try {
    const reading: EDAReading = {
      rawValue: safeNum(data.rawValue) ?? null,
      voltage: safeNum(data.voltage) ?? null,
      resistance: safeNum(data.resistance) ?? null,
      conductance: safeNum(data.conductance) ?? null,
      stressLevel: data.stressLevel ?? null,
      deviceId: data.deviceId ?? null,
      deviceName: data.deviceName ?? null,
      sessionId: data.sessionId ?? null,
      quality: data.quality ?? calculateDataQuality(data),
      sensorType: SensorType.EDA,
      timestamp: serverTimestamp() as Timestamp,
    };

    // Queue for batch processing instead of immediate write
    firebaseWriteQueue.push({
      userId,
      collectionPath: 'sensor_data/eda/readings',
      data: reading,
    });

    // Update session data point count immediately (lightweight operation)
    if (data.sessionId) {
      await updateSessionDataCount(userId, data.sessionId, 'eda');
    }
  } catch (error) {
    console.error('[Firebase] ❌ Failed to queue EDA reading:', error);
    throw error;
  }
};

// ============================================================================
// TEMPERATURE SENSOR FUNCTIONS
// ============================================================================

/**
 * Save temperature reading from AS6221 sensor
 * NOTE: Queued for batch processing (writes every 3 seconds, not immediately)
 * 
 * @example
 * await saveTemperatureReading(user.uid, {
 *   temperature: 36.5,
 *   temperatureFahrenheit: 97.7,
 *   bodyLocation: 'WRIST',
 *   skinContact: true
 * });
 */
export const saveTemperatureReading = async (
  userId: string,
  data: Omit<TemperatureReading, 'timestamp' | 'sensorType'>
): Promise<void> => {
  try {
    const reading: TemperatureReading = {
      temperature: safeNum(data.temperature) ?? null,
      temperatureFahrenheit: safeNum(data.temperatureFahrenheit) ?? null,
      bodyLocation: data.bodyLocation ?? null,
      skinContact: data.skinContact ?? null,
      deviceId: data.deviceId ?? null,
      deviceName: data.deviceName ?? null,
      sessionId: data.sessionId ?? null,
      quality: data.quality ?? calculateDataQuality(data),
      sensorType: SensorType.TEMPERATURE,
      timestamp: serverTimestamp() as Timestamp,
    };

    // Queue for batch processing instead of immediate write
    firebaseWriteQueue.push({
      userId,
      collectionPath: 'sensor_data/temperature/readings',
      data: reading,
    });

    // Update session data point count immediately (lightweight operation)
    if (data.sessionId) {
      await updateSessionDataCount(userId, data.sessionId, 'temperature');
    }
  } catch (error) {
    console.error('[Firebase] ❌ Failed to queue temperature reading:', error);
    throw error;
  }
};

// ============================================================================
// PPG SENSOR FUNCTIONS
// ============================================================================

/**
 * Save PPG reading from MAX30101 sensor
 * NOTE: Queued for batch processing (writes every 3 seconds, not immediately)
 * THROTTLED: 1Hz downsampling — only saves 1 reading/second per PPG channel
 * 
 * @example
 * await savePPGReading(user.uid, {
 *   channel: 'IR',
 *   rawValue: 123456,
 *   signalQuality: 85,
 *   skinContact: true
 * });
 */
export const savePPGReading = async (
  userId: string,
  data: Omit<PPGReading, 'timestamp' | 'sensorType'>
): Promise<void> => {
  try {
    let sensorType: SensorType;
    switch (data.channel) {
      case 'RED':
        sensorType = SensorType.PPG_RED;
        break;
      case 'IR':
        sensorType = SensorType.PPG_IR;
        break;
      case 'GREEN':
      case 'GREEN_FILT':
        sensorType = SensorType.PPG_GREEN;
        break;
      default:
        sensorType = SensorType.PPG_IR;
    }

    // THROTTLING: 1Hz downsampling for high-frequency raw data
    // At 100 Hz PPG, this drops 99 out of every 100 frames, keeping only 1/sec
    if (shouldThrottleWrite(userId, `ppg_${data.channel ? data.channel.toLowerCase() : 'ir'}`)) {
      // Frame throttled, skip this one
      return;
    }

    const reading: PPGReading = {
      channel: data.channel ?? null,
      rawValue: safeNum(data.rawValue) ?? null,
      signalQuality: safeNum(data.signalQuality) ?? null,
      skinContact: data.skinContact ?? null,
      deviceId: data.deviceId ?? null,
      deviceName: data.deviceName ?? null,
      sessionId: data.sessionId ?? null,
      quality: data.quality ?? calculateDataQuality(data),
      sensorType: sensorType,
      timestamp: serverTimestamp() as Timestamp,
    };

    // Queue for batch processing instead of immediate write
    firebaseWriteQueue.push({
      userId,
      collectionPath: 'sensor_data/ppg/readings',
      data: reading,
    });

    // Update session data point count immediately (lightweight operation)
    if (data.sessionId) {
      await updateSessionDataCount(userId, data.sessionId, 'ppg');
    }
  } catch (error) {
    console.error('[Firebase] ❌ Failed to queue PPG reading:', error);
    throw error;
  }
};

/**
 * Save heart rate reading derived from PPG
 * NOTE: Queued for batch processing (writes every 3 seconds, not immediately)
 * 
 * @example
 * await saveHeartRateReading(user.uid, {
 *   heartRate: 75,
 *   rrInterval: 800,
 *   hrv: 50,
 *   confidence: 95,
 *   derivedFrom: 'PPG_IR'
 * });
 */
export const saveHeartRateReading = async (
  userId: string,
  data: Omit<HeartRateReading, 'timestamp' | 'sensorType'>
): Promise<void> => {
  try {
    const reading = stripUndefined({
      heartRate: safeNum(data.heartRate) ?? 0,
      rrInterval: safeNum(data.rrInterval),
      hrv: safeNum(data.hrv),
      confidence: safeNum(data.confidence),
      derivedFrom: data.derivedFrom,
      deviceId: data.deviceId,
      deviceName: data.deviceName,
      sessionId: data.sessionId,
      metadata: data.metadata ? stripUndefined(data.metadata) : undefined,
      quality: data.quality ?? calculateDataQuality(data),
      sensorType: SensorType.HEART_RATE,
      timestamp: serverTimestamp() as Timestamp,
    }) as HeartRateReading;

    // Queue for batch processing instead of immediate write.
    // The object is already sanitised, and the batch layer sanitises again as
    // a final safety net before Firestore receives it.
    firebaseWriteQueue.push({
      userId,
      collectionPath: 'sensor_data/heart_rate/readings',
      data: reading,
    });

    if (data.sessionId) {
      await updateSessionDataCount(userId, data.sessionId, 'heartRate');
    }
  } catch (error) {
    console.error('[Firebase] ❌ Failed to queue heart rate reading:', error);
    throw error;
  }
};

/**
 * Save SpO2 reading from MAX30101
 * NOTE: Queued for batch processing (writes every 3 seconds, not immediately)
 * 
 * @example
 * await saveSpO2Reading(user.uid, {
 *   spO2: 98,
 *   perfusionIndex: 5.2,
 *   signalStrength: 90,
 *   redValue: 123456,
 *   irValue: 234567
 * });
 */
export const saveSpO2Reading = async (
  userId: string,
  data: Omit<SpO2Reading, 'timestamp' | 'sensorType'>
): Promise<void> => {
  try {
    const reading: SpO2Reading = {
      ...data,
      sensorType: SensorType.SPO2,
      timestamp: serverTimestamp() as Timestamp,
      quality: data.quality || calculateDataQuality(data),
    };

    // Queue for batch processing instead of immediate write
    firebaseWriteQueue.push({
      userId,
      collectionPath: 'sensor_data/spo2/readings',
      data: reading,
    });

    // Update session data point count immediately (lightweight operation)
    if (data.sessionId) {
      await updateSessionDataCount(userId, data.sessionId, 'spo2');
    }
  } catch (error) {
    console.error('[Firebase] ❌ Failed to queue SpO2 reading:', error);
    throw error;
  }
};

// ============================================================================
// IMU SENSOR FUNCTIONS (LSM6DSO)
// ============================================================================

/**
 * Save accelerometer reading from LSM6DSO
 * NOTE: Queued for batch processing (writes every 3 seconds, not immediately)
 * THROTTLED: 1Hz downsampling — only saves 1 reading/second per IMU
 * 
 * @example
 * await saveAccelerometerReading(user.uid, {
 *   x: 100,
 *   y: -50,
 *   z: 980,
 *   magnitude: 985
 * });
 */
export const saveAccelerometerReading = async (
  userId: string,
  data: Omit<AccelerometerReading, 'timestamp' | 'sensorType'>
): Promise<void> => {
  try {
    // THROTTLING: 1Hz downsampling for high-frequency raw data
    // At 104 Hz IMU, this drops 103 out of every 104 frames, keeping only 1/sec
    if (shouldThrottleWrite(userId, 'imu')) {
      // Frame throttled, skip this one
      return;
    }

    const reading: AccelerometerReading = {
      x: safeNum(data.x) ?? null,
      y: safeNum(data.y) ?? null,
      z: safeNum(data.z) ?? null,
      rawX: safeNum(data.rawX) ?? null,
      rawY: safeNum(data.rawY) ?? null,
      rawZ: safeNum(data.rawZ) ?? null,
      magnitude: safeNum(data.magnitude ?? (Math.sqrt((data.x ?? 0) ** 2 + (data.y ?? 0) ** 2 + (data.z ?? 0) ** 2))),
      deviceId: data.deviceId ?? null,
      deviceName: data.deviceName ?? null,
      sessionId: data.sessionId ?? null,
      quality: data.quality ?? calculateDataQuality(data),
      sensorType: SensorType.ACCELEROMETER,
      timestamp: serverTimestamp() as Timestamp,
    };

    // Queue for batch processing instead of immediate write
    firebaseWriteQueue.push({
      userId,
      collectionPath: 'sensor_data/accelerometer/readings',
      data: reading,
    });

    // Update session data point count immediately (lightweight operation)
    if (data.sessionId) {
      await updateSessionDataCount(userId, data.sessionId, 'accelerometer');
    }
  } catch (error) {
    console.error('[Firebase] ❌ Failed to queue accelerometer reading:', error);
    throw error;
  }
};

/**
 * Save gyroscope reading from LSM6DSO
 * NOTE: Queued for batch processing (writes every 3 seconds, not immediately)
 * THROTTLED: 1Hz downsampling — only saves 1 reading/second per IMU
 * 
 * @example
 * await saveGyroscopeReading(user.uid, {
 *   x: 500,
 *   y: -300,
 *   z: 100,
 *   magnitude: 583
 * });
 */
export const saveGyroscopeReading = async (
  userId: string,
  data: Omit<GyroscopeReading, 'timestamp' | 'sensorType'>
): Promise<void> => {
  try {
    // THROTTLING: 1Hz downsampling for high-frequency raw data
    // At 104 Hz IMU, this drops 103 out of every 104 frames, keeping only 1/sec
    if (shouldThrottleWrite(userId, 'imu')) {
      // Frame throttled, skip this one
      return;
    }

    const reading: GyroscopeReading = {
      x: safeNum(data.x) ?? null,
      y: safeNum(data.y) ?? null,
      z: safeNum(data.z) ?? null,
      rawX: safeNum(data.rawX) ?? null,
      rawY: safeNum(data.rawY) ?? null,
      rawZ: safeNum(data.rawZ) ?? null,
      magnitude: safeNum(data.magnitude ?? (Math.sqrt((data.x ?? 0) ** 2 + (data.y ?? 0) ** 2 + (data.z ?? 0) ** 2))),
      deviceId: data.deviceId ?? null,
      deviceName: data.deviceName ?? null,
      sessionId: data.sessionId ?? null,
      quality: data.quality ?? calculateDataQuality(data),
      sensorType: SensorType.GYROSCOPE,
      timestamp: serverTimestamp() as Timestamp,
    };

    // Queue for batch processing instead of immediate write
    firebaseWriteQueue.push({
      userId,
      collectionPath: 'sensor_data/gyroscope/readings',
      data: reading,
    });

    // Update session data point count immediately (lightweight operation)
    if (data.sessionId) {
      await updateSessionDataCount(userId, data.sessionId, 'gyroscope');
    }
  } catch (error) {
    console.error('[Firebase] ❌ Failed to queue gyroscope reading:', error);
    throw error;
  }
};

/**
 * Save combined IMU reading (accelerometer + gyroscope)
 * NOTE: Queued for batch processing (writes every 3 seconds, not immediately)
 * THROTTLED: 1Hz downsampling — only saves 1 reading/second per IMU
 * 
 * @example
 * await saveIMUReading(user.uid, {
 *   accelerometer: { x: 100, y: -50, z: 980 },
 *   gyroscope: { x: 500, y: -300, z: 100 },
 *   activity: 'WALKING'
 * });
 */
export const saveIMUReading = async (
  userId: string,
  data: Omit<IMUReading, 'timestamp'>
): Promise<void> => {
  try {
    // THROTTLING: 1Hz downsampling for high-frequency raw data
    // At 104 Hz IMU, this drops 103 out of every 104 frames, keeping only 1/sec
    if (shouldThrottleWrite(userId, 'imu')) {
      // Frame throttled, skip this one
      return;
    }

    const reading: IMUReading = {
      accelerometer: {
        x: safeNum(data.accelerometer?.x) ?? null,
        y: safeNum(data.accelerometer?.y) ?? null,
        z: safeNum(data.accelerometer?.z) ?? null,
        magnitude: safeNum(data.accelerometer?.magnitude) ?? null,
      },
      gyroscope: {
        x: safeNum(data.gyroscope?.x) ?? null,
        y: safeNum(data.gyroscope?.y) ?? null,
        z: safeNum(data.gyroscope?.z) ?? null,
        magnitude: safeNum(data.gyroscope?.magnitude) ?? null,
      },
      activity: data.activity ?? null,
      deviceId: data.deviceId ?? null,
      deviceName: data.deviceName ?? null,
      sessionId: data.sessionId ?? null,
      quality: data.quality ?? calculateDataQuality(data),
      timestamp: serverTimestamp() as Timestamp,
    };

    // Queue for batch processing instead of immediate write
    firebaseWriteQueue.push({
      userId,
      collectionPath: 'sensor_data/imu/readings',
      data: reading,
    });
  } catch (error) {
    console.error('[Firebase] ❌ Failed to queue IMU reading:', error);
    throw error;
  }
};

// ============================================================================
// DEVICE MANAGEMENT
// ============================================================================

/**
 * Register or update a device
 * 
 * @example
 * await saveDeviceInfo(user.uid, {
 *   deviceId: 'NRF52840_001',
 *   deviceName: 'My Smartwatch',
 *   deviceType: 'NRF52840',
 *   firmwareVersion: '1.0.0',
 *   isActive: true
 * });
 */
export const saveDeviceInfo = async (
  userId: string,
  deviceInfo: Omit<DeviceInfo, 'lastConnected' | 'firstRegistered'>
): Promise<void> => {
  try {
    const deviceRef = doc(db, 'users', userId, 'devices', deviceInfo.deviceId);
    const deviceDoc = await getDoc(deviceRef);

    if (deviceDoc.exists()) {
      // Update existing device
      await updateDoc(deviceRef, stripUndefined({
        ...deviceInfo,
        lastConnected: serverTimestamp(),
      }));
      console.log('[Firebase] ✅ Updated device:', deviceInfo.deviceName);
    } else {
      // Create new device
      await setDoc(deviceRef, stripUndefined({
        ...deviceInfo,
        lastConnected: serverTimestamp(),
        firstRegistered: serverTimestamp(),
        totalSessions: 0,
      }));
      console.log('[Firebase] ✅ Registered new device:', deviceInfo.deviceName);
    }
  } catch (error) {
    console.error('[Firebase] ❌ Failed to save device info:', error);
    throw error;
  }
};

// ============================================================================
// SESSION MANAGEMENT
// ============================================================================

/**
 * Start a new recording session
 * 
 * @example
 * const sessionId = await startSession(user.uid, {
 *   sessionName: 'Morning Workout',
 *   deviceId: 'NRF52840_001',
 *   activeSensors: [SensorType.HEART_RATE, SensorType.ACCELEROMETER],
 *   activity: 'Running'
 * });
 */
export const startSession = async (
  userId: string,
  sessionData: {
    sessionName: string;
    deviceId?: string;
    deviceName?: string;
    activeSensors: SensorType[];
    notes?: string;
    tags?: string[];
    location?: string;
    activity?: string;
    mood?: string;
  }
): Promise<string> => {
  try {
    const sessionRef = doc(collection(db, 'users', userId, 'sessions'));
    const sessionId = sessionRef.id;

    const session = stripUndefined({
      sessionId,
      sessionName: sessionData.sessionName,
      startTime: serverTimestamp() as Timestamp,
      deviceId: sessionData.deviceId,
      deviceName: sessionData.deviceName,
      activeSensors: sessionData.activeSensors,
      dataPoints: {},
      notes: sessionData.notes,
      tags: sessionData.tags,
      location: sessionData.location,
      activity: sessionData.activity,
      mood: sessionData.mood,
      isComplete: false,
      hasErrors: false,
    });

    await setDoc(sessionRef, session);

    // Upsert device session count (setDoc+merge avoids crash when device doc doesn't exist yet)
    if (sessionData.deviceId) {
      const deviceRef = doc(db, 'users', userId, 'devices', sessionData.deviceId);
      await setDoc(deviceRef, {
        totalSessions: increment(1),
        lastConnected: serverTimestamp(),
        deviceId: sessionData.deviceId,
        deviceName: sessionData.deviceName || 'Unknown',
        deviceType: 'NRF52840',
        isActive: true,
      }, { merge: true });
    }

    console.log('[Firebase] ✅ Started session:', sessionId);
    return sessionId;
  } catch (error) {
    console.error('[Firebase] ❌ Failed to start session:', error);
    throw error;
  }
};

/**
 * End a recording session
 * 
 * @example
 * await endSession(user.uid, sessionId, {
 *   qualityScore: 95,
 *   notes: 'Good data quality'
 * });
 */
export const endSession = async (
  userId: string,
  sessionId: string,
  updateData?: {
    qualityScore?: number;
    notes?: string;
    hasErrors?: boolean;
  }
): Promise<void> => {
  try {
    const sessionRef = doc(db, 'users', userId, 'sessions', sessionId);
    const sessionDoc = await getDoc(sessionRef);

    if (!sessionDoc.exists()) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const sessionData = sessionDoc.data() as RecordingSession;
    const startTime = sessionData.startTime;
    const endTime = serverTimestamp();

    await updateDoc(sessionRef, stripUndefined({
      endTime,
      isComplete: true,
      qualityScore: updateData?.qualityScore,
      hasErrors: updateData?.hasErrors || false,
      notes: updateData?.notes ?? sessionData.notes,
    }));

    console.log('[Firebase] ✅ Ended session:', sessionId);
  } catch (error) {
    console.error('[Firebase] ❌ Failed to end session:', error);
    throw error;
  }
};

/**
 * Update session data point count
 * (Internal helper function)
 */
const updateSessionDataCount = async (
  userId: string,
  sessionId: string,
  dataType: keyof RecordingSession['dataPoints']
): Promise<void> => {
  try {
    const sessionRef = doc(db, 'users', userId, 'sessions', sessionId);
    await updateDoc(sessionRef, {
      [`dataPoints.${dataType}`]: increment(1),
    });
  } catch (error) {
    console.error('[Firebase] ⚠️ Failed to update session data count:', error);
    // Don't throw - this is a non-critical operation
  }
};

// ============================================================================
// STIMULATION EVENT MANAGEMENT
// ============================================================================

/**
 * Save a stimulation event
 * 
 * @example
 * await saveStimulationEvent(user.uid, {
 *   waveform: 'SINE',
 *   frequency: 10,
 *   amplitude: 50,
 *   duration: 5000,
 *   comfort: 7,
 *   effectiveness: 8
 * });
 */
export const saveStimulationEvent = async (
  userId: string,
  event: Omit<StimulationEvent, 'timestamp'>
): Promise<void> => {
  try {
    await addDoc(collection(db, 'users', userId, 'stimulation_events'), {
      ...event,
      timestamp: serverTimestamp(),
    });

    console.log('[Firebase] ✅ Saved stimulation event:', event.waveform);
  } catch (error) {
    console.error('[Firebase] ❌ Failed to save stimulation event:', error);
    throw error;
  }
};

// ============================================================================
// RAW LOGS
// ============================================================================

/**
 * Save a raw sensor log entry
 * 
 * @example
 * await saveRawSensorLog(user.uid, {
 *   module: 'max30101_demo',
 *   logLevel: 'INFO',
 *   message: 'PPG FIFO | RED=12345 | IR=12346',
 *   deviceId: 'NRF52840_001'
 * });
 */
export const saveRawSensorLog = async (
  userId: string,
  log: Omit<RawSensorLog, 'timestamp'>
): Promise<void> => {
  try {
    await addDoc(collection(db, 'users', userId, 'sensor_data', 'raw_logs', 'entries'), {
      ...log,
      timestamp: serverTimestamp(),
    });

    // Only log occasionally to avoid spam
    if (Math.random() < 0.01) {
      console.log('[Firebase] 📄 Saved raw log batch');
    }
  } catch (error) {
    console.error('[Firebase] ❌ Failed to save raw log:', error);
    // Don't throw - logs are non-critical
  }
};

// ============================================================================
// BATCH OPERATIONS
// ============================================================================

/**
 * Save multiple sensor readings efficiently using Firestore batch
 * 
 * @example
 * await saveSensorBatch(user.uid, {
 *   eda: [reading1, reading2, reading3],
 *   temperature: [reading1, reading2],
 *   heartRate: [reading1, reading2, reading3, reading4]
 * });
 */
export const saveSensorBatch = async (
  userId: string,
  batchData: {
    sessionId?: string;
    deviceId?: string;
    eda?: Omit<EDAReading, 'timestamp' | 'sensorType'>[];
    temperature?: Omit<TemperatureReading, 'timestamp' | 'sensorType'>[];
    ppg?: Omit<PPGReading, 'timestamp' | 'sensorType'>[];
    heartRate?: Omit<HeartRateReading, 'timestamp' | 'sensorType'>[];
    spo2?: Omit<SpO2Reading, 'timestamp' | 'sensorType'>[];
    accelerometer?: Omit<AccelerometerReading, 'timestamp' | 'sensorType'>[];
    gyroscope?: Omit<GyroscopeReading, 'timestamp' | 'sensorType'>[];
  }
): Promise<void> => {
  try {
    const batch = writeBatch(db);
    let batchCount = 0;
    const MAX_BATCH_SIZE = 500; // Firestore limit

    // Helper to add to batch
    const addToBatch = (collectionPath: string[], data: any) => {
      const docRef = doc(collection(db, 'users', userId, ...collectionPath));
      batch.set(docRef, {
        ...data,
        timestamp: serverTimestamp(),
      });
      batchCount++;
    };

    // Add EDA readings
    if (batchData.eda) {
      for (const reading of batchData.eda.slice(0, MAX_BATCH_SIZE - batchCount)) {
        addToBatch(['sensor_data', 'eda', 'readings'], {
          ...reading,
          sensorType: SensorType.EDA,
          sessionId: batchData.sessionId,
          deviceId: batchData.deviceId,
        });
      }
    }

    // Add temperature readings
    if (batchData.temperature) {
      for (const reading of batchData.temperature.slice(0, MAX_BATCH_SIZE - batchCount)) {
        addToBatch(['sensor_data', 'temperature', 'readings'], {
          ...reading,
          sensorType: SensorType.TEMPERATURE,
          sessionId: batchData.sessionId,
          deviceId: batchData.deviceId,
        });
      }
    }

    // Add PPG readings
    if (batchData.ppg) {
      for (const reading of batchData.ppg.slice(0, MAX_BATCH_SIZE - batchCount)) {
        addToBatch(['sensor_data', 'ppg', 'readings'], {
          ...reading,
          sessionId: batchData.sessionId,
          deviceId: batchData.deviceId,
        });
      }
    }

    // Add heart rate readings
    if (batchData.heartRate) {
      for (const reading of batchData.heartRate.slice(0, MAX_BATCH_SIZE - batchCount)) {
        addToBatch(['sensor_data', 'heart_rate', 'readings'], {
          ...reading,
          sensorType: SensorType.HEART_RATE,
          sessionId: batchData.sessionId,
          deviceId: batchData.deviceId,
        });
      }
    }

    // Add SpO2 readings
    if (batchData.spo2) {
      for (const reading of batchData.spo2.slice(0, MAX_BATCH_SIZE - batchCount)) {
        addToBatch(['sensor_data', 'spo2', 'readings'], {
          ...reading,
          sensorType: SensorType.SPO2,
          sessionId: batchData.sessionId,
          deviceId: batchData.deviceId,
        });
      }
    }

    // Add accelerometer readings
    if (batchData.accelerometer) {
      for (const reading of batchData.accelerometer.slice(0, MAX_BATCH_SIZE - batchCount)) {
        addToBatch(['sensor_data', 'accelerometer', 'readings'], {
          ...reading,
          sensorType: SensorType.ACCELEROMETER,
          sessionId: batchData.sessionId,
          deviceId: batchData.deviceId,
        });
      }
    }

    // Add gyroscope readings
    if (batchData.gyroscope) {
      for (const reading of batchData.gyroscope.slice(0, MAX_BATCH_SIZE - batchCount)) {
        addToBatch(['sensor_data', 'gyroscope', 'readings'], {
          ...reading,
          sensorType: SensorType.GYROSCOPE,
          sessionId: batchData.sessionId,
          deviceId: batchData.deviceId,
        });
      }
    }

    if (batchCount > 0) {
      await batch.commit();
      console.log(`[Firebase] ✅ Saved ${batchCount} sensor readings in batch`);
    }
  } catch (error) {
    console.error('[Firebase] ❌ Failed to save sensor batch:', error);
    throw error;
  }
};

// ============================================================================
// ANALYTICS & AGGREGATIONS
// ============================================================================

/**
 * Update daily analytics for a user
 * This should be called periodically or at the end of each day
 * 
 * @example
 * await updateDailyAnalytics(user.uid, '2024-01-15');
 */
export const updateDailyAnalytics = async (
  userId: string,
  date: string // YYYY-MM-DD
): Promise<void> => {
  try {
    // This is a placeholder - implement full analytics aggregation
    // based on your specific needs

    const analyticsRef = doc(db, 'users', userId, 'analytics', 'daily', date);

    // Query all data for the day and aggregate
    // Implementation would involve:
    // 1. Query all sensor readings for the date range
    // 2. Calculate statistics (avg, min, max, etc.)
    // 3. Store in analytics collection

    console.log('[Firebase] ✅ Updated daily analytics for', date);
  } catch (error) {
    console.error('[Firebase] ❌ Failed to update daily analytics:', error);
    throw error;
  }
};

// ============================================================================
// BACKWARD COMPATIBILITY FUNCTIONS
// ============================================================================

/**
 * Legacy function for backward compatibility
 * Automatically routes to appropriate new function based on sensorType
 * 
 * @deprecated Use specific sensor functions instead
 */
export const saveSensorReading = async (
  userId: string,
  reading: {
    sensorType: string;
    value: number;
    unit?: string;
    deviceId?: string;
    deviceName?: string;
    sessionId?: string;
  }
): Promise<void> => {
  try {
    const type = reading.sensorType.toUpperCase();

    // Route to appropriate function
    switch (type) {
      case 'EDA':
      case 'GSR':
        await saveEDAReading(userId, {
          rawValue: reading.value,
          voltage: reading.value / 1000, // Estimate
          resistance: reading.value,
          conductance: 1000 / reading.value,
          deviceId: reading.deviceId,
          deviceName: reading.deviceName,
          sessionId: reading.sessionId,
        });
        break;

      case 'TEMPERATURE':
      case 'TEMP':
        await saveTemperatureReading(userId, {
          temperature: reading.value,
          temperatureFahrenheit: (reading.value * 9 / 5) + 32,
          deviceId: reading.deviceId,
          deviceName: reading.deviceName,
          sessionId: reading.sessionId,
        });
        break;

      case 'HEART_RATE':
      case 'HR':
      case 'BPM':
        await saveHeartRateReading(userId, {
          heartRate: reading.value,
          deviceId: reading.deviceId,
          deviceName: reading.deviceName,
          sessionId: reading.sessionId,
        });
        break;

      case 'SPO2':
      case 'OXYGEN':
        await saveSpO2Reading(userId, {
          spO2: reading.value,
          redValue: 0,
          irValue: 0,
          deviceId: reading.deviceId,
          deviceName: reading.deviceName,
          sessionId: reading.sessionId,
        });
        break;

      case 'PPG_RED':
      case 'PPG_IR':
      case 'PPG_GREEN':
        const channel = type.split('_')[1] as 'RED' | 'IR' | 'GREEN';
        await savePPGReading(userId, {
          channel,
          rawValue: reading.value,
          deviceId: reading.deviceId,
          deviceName: reading.deviceName,
          sessionId: reading.sessionId,
        });
        break;

      default:
        // Save to generic collection for unknown types
        await addDoc(collection(db, 'users', userId, 'sensor_data', 'other', 'readings'), {
          ...reading,
          timestamp: serverTimestamp(),
        });
        console.log('[Firebase] ⚠️ Saved unknown sensor type:', type);
    }
  } catch (error) {
    console.error('[Firebase] ❌ Failed to save sensor reading:', error);
    throw error;
  }
};

/**
 * Legacy function for backward compatibility
 * 
 * @deprecated Use saveRawSensorLog instead
 */
export const saveSensorLog = async (
  userId: string,
  log: {
    module: string;
    message: string;
    logLevel?: 'INFO' | 'DEBUG' | 'WARN' | 'ERROR';
    deviceId?: string;
    deviceName?: string;
  }
): Promise<void> => {
  await saveRawSensorLog(userId, {
    module: log.module,
    message: log.message,
    logLevel: log.logLevel || 'INFO',
    deviceId: log.deviceId,
    deviceName: log.deviceName,
  });
};

/**
 * Legacy batch function for backward compatibility
 * 
 * @deprecated Use saveSensorBatch instead
 */
export const saveSensorReadingBatch = async (
  userId: string,
  readings: Array<{
    sensorType: string;
    value: number;
    unit?: string;
    deviceId?: string;
    deviceName?: string;
  }>
): Promise<void> => {
  const promises = readings.map(reading => saveSensorReading(userId, reading));
  await Promise.all(promises);
  console.log(`[Firebase] ✅ Saved ${readings.length} sensor readings (legacy batch)`);
};

// ============================================================================
// OFFLINE WRISTBAND MINUTE-SUMMARY HISTORY
// ============================================================================

export interface HistoricalMinuteSummaryInput
  extends Omit<MinuteSummaryReading, 'timestamp' | 'syncedAt'> {
  timestampMs: number;
}

const minuteSummaryDocId = (record: HistoricalMinuteSummaryInput): string => {
  const device = (record.deviceId || 'wristband').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  // Stable across retries/resume: the same NAND history index + firmware uptime
  // resolves to the same Firestore document instead of creating duplicates.
  return `${device}_${Math.max(0, Math.floor(record.historyIndex))}_${Math.max(0, Math.floor(record.firmwareUptimeMs))}`;
};

/**
 * Persist Algorithm V0 minute results downloaded from wristband NAND.
 * Uses deterministic document IDs and batched set() operations so retries are
 * idempotent and a reconnect/resume cannot duplicate already-synced minutes.
 */
export const saveHistoricalMinuteSummaries = async (
  userId: string,
  records: HistoricalMinuteSummaryInput[]
): Promise<void> => {
  if (!userId || records.length === 0) return;

  const MAX_BATCH = 400; // comfortably below Firestore's 500-write limit
  for (let offset = 0; offset < records.length; offset += MAX_BATCH) {
    const chunk = records.slice(offset, offset + MAX_BATCH);
    const batch = writeBatch(db);

    for (const record of chunk) {
      const { timestampMs, ...payload } = record;
      if (!Number.isFinite(timestampMs) || timestampMs <= 0) continue;

      const ref = doc(
        db,
        'users', userId,
        'sensor_data', 'minute_summaries',
        'readings', minuteSummaryDocId(record)
      );

      batch.set(ref, stripUndefined({
        ...payload,
        timestamp: Timestamp.fromMillis(timestampMs),
        syncedAt: serverTimestamp(),
      }), { merge: true });
    }

    await batch.commit();
  }
};

/** Load stored Algorithm V0 minute summaries for a wall-clock time range. */
export const getMinuteSummariesForRange = async (
  userId: string,
  start: Date,
  end: Date
): Promise<Array<MinuteSummaryReading & { id: string }>> => {
  if (!userId) return [];

  const q = query(
    collection(db, 'users', userId, 'sensor_data', 'minute_summaries', 'readings'),
    where('timestamp', '>=', Timestamp.fromDate(start)),
    where('timestamp', '<=', Timestamp.fromDate(end)),
    orderBy('timestamp', 'asc')
  );

  const snap = await getDocs(q);
  return snap.docs.map(d => ({
    id: d.id,
    ...(d.data() as MinuteSummaryReading),
  }));
};

// ============================================================================
// QUERY HELPERS
// ============================================================================

/**
 * Get recent sensor readings for a specific sensor type
 * 
 * @example
 * const recentHR = await getRecentReadings(user.uid, SensorType.HEART_RATE, 100);
 */
export const getRecentReadings = async (
  userId: string,
  sensorType: SensorType,
  limitCount: number = 50
): Promise<any[]> => {
  try {
    const collectionPath = getSensorCollectionPath(sensorType);
    const q = query(
      collection(db, 'users', userId, collectionPath),
      orderBy('timestamp', 'desc'),
      limit(limitCount)
    );

    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error('[Firebase] ❌ Failed to get recent readings:', error);
    throw error;
  }
};

/**
 * Get session data by ID
 * 
 * @example
 * const session = await getSession(user.uid, sessionId);
 */
export const getSession = async (
  userId: string,
  sessionId: string
): Promise<RecordingSession | null> => {
  try {
    const sessionRef = doc(db, 'users', userId, 'sessions', sessionId);
    const sessionDoc = await getDoc(sessionRef);

    if (sessionDoc.exists()) {
      return sessionDoc.data() as RecordingSession;
    }
    return null;
  } catch (error) {
    console.error('[Firebase] ❌ Failed to get session:', error);
    throw error;
  }
};

// ============================================================================
// SESSION QUERY HELPERS
// ============================================================================

export interface SessionSummary {
  sessionId: string;
  sessionName: string;
  deviceName?: string;
  startTime: Date | null;
  endTime: Date | null;
  isComplete: boolean;
  dataPointCount: number;
}

/**
 * Fetch the most recent recording sessions for a user.
 */
export const getRecentSessions = async (
  userId: string,
  maxCount = 10
): Promise<SessionSummary[]> => {
  try {
    const q = query(
      collection(db, 'users', userId, 'sessions'),
      orderBy('startTime', 'desc'),
      limit(maxCount)
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => {
      const data = d.data();
      const totalPoints = data.dataPoints
        ? Object.values(data.dataPoints as Record<string, number>).reduce((a, b) => a + b, 0)
        : 0;
      return {
        sessionId: d.id,
        sessionName: data.sessionName ?? 'Session',
        deviceName: data.deviceName,
        startTime: (data.startTime as Timestamp)?.toDate() ?? null,
        endTime: (data.endTime as Timestamp)?.toDate() ?? null,
        isComplete: data.isComplete ?? false,
        dataPointCount: totalPoints,
      };
    });
  } catch (error) {
    console.error('[Firebase] ❌ Failed to get recent sessions:', error);
    return [];
  }
};

// ============================================================================
// USER PROFILE MANAGEMENT
// ============================================================================

export interface UserProfile {
  uid: string;
  email: string | null;
  displayName?: string | null;
  // Basic info
  height?: number;       // cm
  weight?: number;       // kg
  sex?: 'Male' | 'Female' | 'Other';
  age?: number;
  // Timestamps
  createdAt?: Timestamp;
  lastSeenAt?: Timestamp;
  // App settings
  onboardingComplete?: boolean;
  // Baseline psychological questionnaire answers
  baselineAnswers?: Record<number, string>;
}

/**
 * Create or update the Firestore user profile document.
 * Always safe to call multiple times (uses setDoc with merge).
 */
export const saveUserProfile = async (
  userId: string,
  data: Partial<Omit<UserProfile, 'uid'>>
): Promise<void> => {
  try {
    const profileRef = doc(db, 'users', userId, 'profile', 'info');
    await setDoc(profileRef, {
      uid: userId,
      ...data,
      lastSeenAt: serverTimestamp(),
    }, { merge: true });
    console.log('[Firebase] ✅ User profile saved for:', userId);
  } catch (error) {
    console.error('[Firebase] ❌ Failed to save user profile:', error);
    throw error;
  }
};

/**
 * Create the top-level user document (required for Firestore rules
 * that gate access via `exists(/databases/$(database)/documents/users/$(uid))`).
 */
export const ensureUserDocument = async (
  userId: string,
  email: string | null
): Promise<void> => {
  try {
    const userRef = doc(db, 'users', userId);
    const snap = await getDoc(userRef);
    if (!snap.exists()) {
      await setDoc(userRef, {
        uid: userId,
        email,
        createdAt: serverTimestamp(),
        lastSeenAt: serverTimestamp(),
      });
      console.log('[Firebase] ✅ User document created:', userId);
    } else {
      // Just bump lastSeenAt
      await updateDoc(userRef, { lastSeenAt: serverTimestamp() });
    }
  } catch (error) {
    console.error('[Firebase] ❌ Failed to ensure user document:', error);
    // Non-fatal – app continues
  }
};

/**
 * Fetch the stored user profile info.
 * Returns null if not found.
 */
export const getUserProfile = async (
  userId: string
): Promise<UserProfile | null> => {
  try {
    const profileRef = doc(db, 'users', userId, 'profile', 'info');
    const snap = await getDoc(profileRef);
    if (snap.exists()) {
      return snap.data() as UserProfile;
    }
    return null;
  } catch (error) {
    console.error('[Firebase] ❌ Failed to get user profile:', error);
    return null;
  }
};

// ============================================================================
// QUESTIONNAIRE RESULTS
// ============================================================================

export interface QuestionnaireResult {
  type: string;          // e.g. 'GAD7', 'PHQ9', 'BAI', 'BDI', 'PSQI', 'CFQ', 'PCL5'
  score: number;
  maxScore: number;
  level: string;         // e.g. 'Minimal Anxiety'
  responses: Record<string, unknown>;
  difficulty?: number | null;
  completedAt: Timestamp;
  notes?: string;
  metadata?: Record<string, unknown>;
  repeatIntervalDays?: number;
}

export interface QuestionnaireStatusSummary {
  score?: number;
  level?: string;
  lastCompletedAt?: Date;
  nextDueAt?: Date;
  repeatIntervalDays?: number;
  submissionsCount?: number;
  lastResultId?: string;
}

export interface QuestionnaireHistoryEntry {
  resultId: string;
  type: string;
  score?: number;
  maxScore?: number;
  level?: string;
  responses?: Record<string, unknown>;
  difficulty?: number | null;
  notes?: string;
  metadata?: Record<string, unknown>;
  repeatIntervalDays?: number;
  completedAt?: Date;
}

const DEFAULT_QUESTIONNAIRE_REPEAT_DAYS = 14;

const normalizeRepeatIntervalDays = (days?: number): number => {
  if (typeof days === 'number' && Number.isFinite(days) && days > 0) {
    return Math.floor(days);
  }
  return DEFAULT_QUESTIONNAIRE_REPEAT_DAYS;
};

const parseTimestampToDate = (value: unknown): Date | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const maybeTimestamp = value as { toDate?: () => Date };
  return typeof maybeTimestamp.toDate === 'function' ? maybeTimestamp.toDate() : undefined;
};

/**
 * Save a psychological questionnaire result to Firestore.
 *
 * Path: users/{userId}/questionnaires/{type}/results/{docId}
 */
export const saveQuestionnaireResult = async (
  userId: string,
  result: Omit<QuestionnaireResult, 'completedAt'>
): Promise<void> => {
  try {
    const repeatIntervalDays = normalizeRepeatIntervalDays(result.repeatIntervalDays);
    const nextDueAt = new Date(Date.now() + repeatIntervalDays * 24 * 60 * 60 * 1000);
    const resultRef = doc(collection(db, 'users', userId, 'questionnaires', result.type, 'results'));

    await setDoc(
      resultRef,
      stripUndefined({
        ...result,
        resultId: resultRef.id,
        schemaVersion: 2,
        repeatIntervalDays,
        completedAt: serverTimestamp(),
      })
    );

    // Also maintain a summary doc so we can easily see last completion
    await setDoc(
      doc(db, 'users', userId, 'questionnaire_status', result.type),
      stripUndefined({
        type: result.type,
        score: result.score,
        level: result.level,
        lastCompletedAt: serverTimestamp(),
        nextDueAt: Timestamp.fromDate(nextDueAt),
        repeatIntervalDays,
        submissionsCount: increment(1),
        lastResultId: resultRef.id,
      }),
      { merge: true }
    );
    console.log('[Firebase] ✅ Saved questionnaire result:', result.type, result.score);
  } catch (error) {
    console.error('[Firebase] ❌ Failed to save questionnaire result:', error);
    throw error;
  }
};

/**
 * Fetch the completion status for all questionnaires for a user.
 * Returns a map of questionnaireType -> last completion info.
 */
export const getQuestionnaireStatuses = async (
  userId: string
): Promise<Record<string, QuestionnaireStatusSummary>> => {
  try {
    const snap = await getDocs(collection(db, 'users', userId, 'questionnaire_status'));
    const result: Record<string, QuestionnaireStatusSummary> = {};
    snap.forEach((d) => {
      const data = d.data();
      result[d.id] = {
        score: typeof data.score === 'number' ? data.score : undefined,
        level: typeof data.level === 'string' ? data.level : undefined,
        lastCompletedAt: parseTimestampToDate(data.lastCompletedAt),
        nextDueAt: parseTimestampToDate(data.nextDueAt),
        repeatIntervalDays: typeof data.repeatIntervalDays === 'number' ? data.repeatIntervalDays : undefined,
        submissionsCount: typeof data.submissionsCount === 'number' ? data.submissionsCount : undefined,
        lastResultId: typeof data.lastResultId === 'string' ? data.lastResultId : undefined,
      };
    });
    return result;
  } catch (error) {
    console.error('[Firebase] ❌ Failed to get questionnaire statuses:', error);
    return {};
  }
};

/**
 * Fetch historical questionnaire submissions for a specific type.
 * Results are sorted newest first by completedAt.
 */
export const getQuestionnaireHistory = async (
  userId: string,
  questionnaireType: string,
  maxEntries: number = 100
): Promise<QuestionnaireHistoryEntry[]> => {
  try {
    const safeLimit = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : 100;
    const historyQuery = query(
      collection(db, 'users', userId, 'questionnaires', questionnaireType, 'results'),
      orderBy('completedAt', 'desc'),
      limit(safeLimit)
    );

    const snap = await getDocs(historyQuery);
    return snap.docs.map((resultDoc) => {
      const data = resultDoc.data();
      return {
        resultId: resultDoc.id,
        type: typeof data.type === 'string' ? data.type : questionnaireType,
        score: typeof data.score === 'number' ? data.score : undefined,
        maxScore: typeof data.maxScore === 'number' ? data.maxScore : undefined,
        level: typeof data.level === 'string' ? data.level : undefined,
        responses: (typeof data.responses === 'object' && data.responses !== null)
          ? (data.responses as Record<string, unknown>)
          : undefined,
        difficulty: typeof data.difficulty === 'number' || data.difficulty === null
          ? data.difficulty
          : undefined,
        notes: typeof data.notes === 'string' ? data.notes : undefined,
        metadata: (typeof data.metadata === 'object' && data.metadata !== null)
          ? (data.metadata as Record<string, unknown>)
          : undefined,
        repeatIntervalDays: typeof data.repeatIntervalDays === 'number' ? data.repeatIntervalDays : undefined,
        completedAt: parseTimestampToDate(data.completedAt),
      };
    });
  } catch (error) {
    console.error('[Firebase] ❌ Failed to fetch questionnaire history:', error);
    return [];
  }
};

/**
 * Fetch one historical questionnaire submission by result document id.
 */
export const getQuestionnaireHistoryEntry = async (
  userId: string,
  questionnaireType: string,
  resultId: string
): Promise<QuestionnaireHistoryEntry | null> => {
  try {
    const resultRef = doc(db, 'users', userId, 'questionnaires', questionnaireType, 'results', resultId);
    const resultSnap = await getDoc(resultRef);
    if (!resultSnap.exists()) {
      return null;
    }

    const data = resultSnap.data();
    return {
      resultId: resultSnap.id,
      type: typeof data.type === 'string' ? data.type : questionnaireType,
      score: typeof data.score === 'number' ? data.score : undefined,
      maxScore: typeof data.maxScore === 'number' ? data.maxScore : undefined,
      level: typeof data.level === 'string' ? data.level : undefined,
      responses: (typeof data.responses === 'object' && data.responses !== null)
        ? (data.responses as Record<string, unknown>)
        : undefined,
      difficulty: typeof data.difficulty === 'number' || data.difficulty === null
        ? data.difficulty
        : undefined,
      notes: typeof data.notes === 'string' ? data.notes : undefined,
      metadata: (typeof data.metadata === 'object' && data.metadata !== null)
        ? (data.metadata as Record<string, unknown>)
        : undefined,
      repeatIntervalDays: typeof data.repeatIntervalDays === 'number' ? data.repeatIntervalDays : undefined,
      completedAt: parseTimestampToDate(data.completedAt),
    };
  } catch (error) {
    console.error('[Firebase] ❌ Failed to fetch questionnaire history entry:', error);
    return null;
  }
};

// ============================================================================
// WELLNESS ENTRIES (MOOD & SLEEP)
// ============================================================================

/**
 * Save a mood or sleep quality entry.
 *
 * Path: users/{userId}/wellness_entries/{docId}
 */
export const saveWellnessEntry = async (
  userId: string,
  entry: {
    entryType: 'mood' | 'sleep';
    value: number;      // 0-4 for mood (sad→happy), 0-2 for sleep
    label: string;      // e.g. 'Happy', 'Poor'
    date: string;       // YYYY-MM-DD
  }
): Promise<void> => {
  try {
    await addDoc(collection(db, 'users', userId, 'wellness_entries'), {
      ...entry,
      timestamp: serverTimestamp(),
    });
    console.log('[Firebase] ✅ Saved wellness entry:', entry.entryType, entry.value);
  } catch (error) {
    console.error('[Firebase] ❌ Failed to save wellness entry:', error);
    // Non-fatal
  }
};

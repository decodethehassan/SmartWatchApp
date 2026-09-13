import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter } from 'react-native';

import { bleService } from './BLEService';
import { parseV0Min, type V0MinParsed } from './SensorParser';
import {
  saveHistoricalMinuteSummaries,
  type HistoricalMinuteSummaryInput,
} from '../firebase/dataLogger';

const BLE_DATA_EVENT = 'BLE_DATA_LINE';
const META_PREFIX = 'wristband_memory_sync_v1';

export type MemorySyncPhase =
  | 'idle'
  | 'checking'
  | 'syncing'
  | 'saving'
  | 'complete'
  | 'stopping'
  | 'stopped'
  | 'error';

export interface MemoryInfo {
  protocolVersion: number;
  historyCount: number;
  historyCapacity: number;
  rawUsedBytes: number;
  rawCapacityBytes: number;
  rawFull: boolean;
  historyFull: boolean;
  deviceUptimeMs: number;
}

export interface MemorySyncState {
  phase: MemorySyncPhase;
  info: MemoryInfo | null;
  session: number | null;
  startIndex: number;
  nextIndex: number;
  endIndex: number;
  received: number;
  persisted: number;
  lastSyncedIndex: number;
  progress: number;
  message: string;
  error: string | null;
}

interface SyncContext {
  userId: string;
  deviceId?: string;
  deviceName?: string;
}

interface ResumeMeta {
  lastSyncedIndex: number;
  lastHistoryCount: number;
  lastDeviceUptimeMs: number;
  bootEpochMs: number;
}

type StateListener = (state: MemorySyncState) => void;

const initialState: MemorySyncState = {
  phase: 'idle',
  info: null,
  session: null,
  startIndex: 0,
  nextIndex: 0,
  endIndex: 0,
  received: 0,
  persisted: 0,
  lastSyncedIndex: -1,
  progress: 0,
  message: 'Ready to sync wristband memory',
  error: null,
};

const finiteInt = (value: string | undefined, fallback = 0): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
};

class MemorySyncService {
  private state: MemorySyncState = { ...initialState };
  private listeners = new Set<StateListener>();
  private context: SyncContext | null = null;
  private resumeMeta: ResumeMeta | null = null;
  private pendingRecords: HistoricalMinuteSummaryInput[] = [];
  private persistChain: Promise<void> = Promise.resolve();
  private persistError: Error | null = null;
  private infoTimeout: ReturnType<typeof setTimeout> | null = null;
  private syncGeneration = 0;

  constructor() {
    DeviceEventEmitter.addListener(BLE_DATA_EVENT, (line: string) => {
      if (typeof line !== 'string') return;
      const clean = line.trim();
      if (!clean.startsWith('D,')) return;
      void this.handleMemoryLine(clean);
    });
  }

  private clearInfoTimeout(): void {
    if (this.infoTimeout) {
      clearTimeout(this.infoTimeout);
      this.infoTimeout = null;
    }
  }

  getState(): MemorySyncState {
    return { ...this.state };
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  private publish(patch: Partial<MemorySyncState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      try {
        listener(this.getState());
      } catch (error) {
        console.warn('[MemorySync] state listener failed:', error);
      }
    }
  }

  private metaKey(): string | null {
    if (!this.context?.userId) return null;
    const device = (this.context.deviceId || 'SMARTWATCH').replace(/[^A-Za-z0-9_-]/g, '_');
    return `${META_PREFIX}:${this.context.userId}:${device}`;
  }

  private async loadMeta(): Promise<ResumeMeta | null> {
    const key = this.metaKey();
    if (!key) return null;
    try {
      const raw = await AsyncStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<ResumeMeta>;
      if (!Number.isFinite(parsed.lastSyncedIndex)) return null;
      return {
        lastSyncedIndex: Number(parsed.lastSyncedIndex),
        lastHistoryCount: Number(parsed.lastHistoryCount) || 0,
        lastDeviceUptimeMs: Number(parsed.lastDeviceUptimeMs) || 0,
        bootEpochMs: Number(parsed.bootEpochMs) || 0,
      };
    } catch (error) {
      console.warn('[MemorySync] Could not read resume metadata:', error);
      return null;
    }
  }

  private async saveMeta(lastSyncedIndex?: number): Promise<void> {
    const key = this.metaKey();
    if (!key || !this.state.info) return;

    const previous = this.resumeMeta;
    const meta: ResumeMeta = {
      lastSyncedIndex:
        lastSyncedIndex !== undefined
          ? lastSyncedIndex
          : previous?.lastSyncedIndex ?? this.state.lastSyncedIndex,
      lastHistoryCount: this.state.info.historyCount,
      lastDeviceUptimeMs: this.state.info.deviceUptimeMs,
      bootEpochMs:
        previous?.bootEpochMs && previous.bootEpochMs > 0
          ? previous.bootEpochMs
          : Date.now() - this.state.info.deviceUptimeMs,
    };

    this.resumeMeta = meta;
    try {
      await AsyncStorage.setItem(key, JSON.stringify(meta));
    } catch (error) {
      console.warn('[MemorySync] Could not persist resume metadata:', error);
    }
  }

  /**
   * Start a user-requested memory sync. The service first asks MEM_INFO, then
   * automatically resumes from the last Firestore-confirmed history index.
   */
  async startSync(context: SyncContext): Promise<boolean> {
    if (!context.userId) {
      this.publish({ phase: 'error', error: 'Sign in before syncing memory.', message: 'Sign in required' });
      return false;
    }
    if (!bleService.isCurrentlyConnected()) {
      this.publish({ phase: 'error', error: 'Wristband is not connected.', message: 'Connect wristband first' });
      return false;
    }
    if (['checking', 'syncing', 'saving', 'stopping'].includes(this.state.phase)) {
      return false;
    }

    this.syncGeneration += 1;
    this.clearInfoTimeout();
    this.context = context;
    this.pendingRecords = [];
    this.persistChain = Promise.resolve();
    this.persistError = null;
    this.resumeMeta = null;
    this.publish({
      ...initialState,
      phase: 'checking',
      message: 'Checking wristband memory…',
    });

    const ok = await bleService.sendLogServiceCommand('MEM_INFO\n', true);
    if (!ok) {
      this.publish({
        phase: 'error',
        error: 'Could not send MEM_INFO to the wristband.',
        message: 'Memory check failed',
      });
      return false;
    }

    this.infoTimeout = setTimeout(() => {
      if (this.state.phase === 'checking') {
        this.publish({
          phase: 'error',
          error: 'No MEM_INFO response received from the wristband.',
          message: 'Memory check timed out',
        });
      }
    }, 5000);
    return true;
  }

  async stopSync(): Promise<void> {
    if (!['checking', 'syncing', 'saving'].includes(this.state.phase)) return;
    const wasChecking = this.state.phase === 'checking';
    this.clearInfoTimeout();
    this.publish({ phase: 'stopping', message: 'Stopping memory sync…' });
    const ok = await bleService.sendLogServiceCommand('MEM_SYNC_STOP\n', true);
    if (!ok) {
      this.publish({ phase: 'error', error: 'Could not send MEM_SYNC_STOP.', message: 'Could not stop memory sync cleanly' });
      return;
    }
    if (wasChecking) {
      this.publish({ phase: 'stopped', message: 'Memory sync stopped' });
    }
  }

  /** Called by the UI when the wristband link drops mid-transfer. */
  async handleDisconnected(): Promise<void> {
    if (!['checking', 'syncing', 'saving', 'stopping'].includes(this.state.phase)) return;
    this.clearInfoTimeout();
    try {
      await this.flushPending(true);
    } catch (error) {
      console.warn('[MemorySync] Could not flush final disconnected batch:', error);
    }
    this.publish({
      phase: 'stopped',
      message: 'Disconnected — reconnect and tap Sync Memory to resume',
      error: null,
    });
  }

  /** Forget only the app-side resume cursor; NAND and cloud data are untouched. */
  async resetResumeCursor(): Promise<void> {
    const key = this.metaKey();
    if (key) await AsyncStorage.removeItem(key);
    this.resumeMeta = null;
    this.publish({ lastSyncedIndex: -1 });
  }

  private async handleMemoryLine(line: string): Promise<void> {
    if (line.startsWith('D,INFO,')) {
      await this.handleInfo(line);
      return;
    }
    if (line.startsWith('D,BEGIN,')) {
      this.handleBegin(line);
      return;
    }
    if (line.startsWith('D,M,')) {
      this.handleMinute(line);
      return;
    }
    if (line.startsWith('D,PROGRESS,')) {
      this.handleProgress(line);
      return;
    }
    if (line.startsWith('D,END,')) {
      await this.handleEnd(line);
      return;
    }
    if (line.startsWith('D,STOP,')) {
      try {
        await this.flushPending(true);
        this.publish({ phase: 'stopped', message: 'Memory sync stopped' });
      } catch (error: any) {
        this.publish({
          phase: 'error',
          error: error?.message || String(error),
          message: 'Memory sync stopped, but downloaded data was not fully saved',
        });
      }
      return;
    }
    if (line.startsWith('D,SKIP,')) {
      console.warn('[MemorySync] Firmware skipped unreadable history record:', line);
      return;
    }
    if (line.startsWith('D,ERROR,')) {
      const error = line.slice('D,ERROR,'.length) || 'Unknown firmware memory error';
      this.publish({ phase: 'error', error, message: `Memory sync error: ${error}` });
    }
  }

  private async handleInfo(line: string): Promise<void> {
    this.clearInfoTimeout();
    if (!this.context) return;

    const p = line.split(',');
    if (p.length < 10) {
      this.publish({ phase: 'error', error: 'Malformed D,INFO response', message: 'Invalid memory information' });
      return;
    }

    const info: MemoryInfo = {
      protocolVersion: finiteInt(p[2]),
      historyCount: finiteInt(p[3]),
      historyCapacity: finiteInt(p[4]),
      rawUsedBytes: finiteInt(p[5]),
      rawCapacityBytes: finiteInt(p[6]),
      rawFull: finiteInt(p[7]) !== 0,
      historyFull: finiteInt(p[8]) !== 0,
      deviceUptimeMs: finiteInt(p[9]),
    };

    let meta = await this.loadMeta();
    const nowBootEpoch = Date.now() - info.deviceUptimeMs;

    if (!meta) {
      meta = {
        lastSyncedIndex: -1,
        lastHistoryCount: info.historyCount,
        lastDeviceUptimeMs: info.deviceUptimeMs,
        bootEpochMs: nowBootEpoch,
      };
    } else {
      // A smaller history count means NAND history was reset/reflashed. Start
      // again at index 0 instead of incorrectly skipping the new generation.
      if (info.historyCount < meta.lastHistoryCount) {
        meta.lastSyncedIndex = -1;
      }

      // Device uptime moving backwards indicates a reboot. New records after
      // that reboot can still be anchored correctly; Algorithm V0 history from
      // an earlier boot cannot receive a guaranteed wall-clock time without RTC.
      if (info.deviceUptimeMs + 5000 < meta.lastDeviceUptimeMs) {
        meta.bootEpochMs = nowBootEpoch;
      } else if (!Number.isFinite(meta.bootEpochMs) || meta.bootEpochMs <= 0) {
        meta.bootEpochMs = nowBootEpoch;
      }
    }

    meta.lastHistoryCount = info.historyCount;
    meta.lastDeviceUptimeMs = info.deviceUptimeMs;
    this.resumeMeta = meta;

    const startIndex = Math.min(Math.max(meta.lastSyncedIndex + 1, 0), info.historyCount);
    this.publish({
      info,
      lastSyncedIndex: meta.lastSyncedIndex,
      startIndex,
      nextIndex: startIndex,
      endIndex: info.historyCount,
      progress: info.historyCount > 0 ? startIndex / info.historyCount : 1,
      message: `${info.historyCount} minute result${info.historyCount === 1 ? '' : 's'} stored`,
    });

    await this.saveMeta(meta.lastSyncedIndex);

    if (info.historyCount === 0 || startIndex >= info.historyCount) {
      this.publish({
        phase: 'complete',
        progress: 1,
        message: info.historyCount === 0 ? 'No stored minute results yet' : 'Wristband memory is already synced',
      });
      return;
    }

    const command = startIndex > 0 ? `MEM_SYNC_RESULTS,${startIndex}\n` : 'MEM_SYNC_RESULTS\n';
    const ok = await bleService.sendLogServiceCommand(command, true);
    if (!ok) {
      this.publish({
        phase: 'error',
        error: 'Could not start memory download.',
        message: 'Memory download failed to start',
      });
    }
  }

  private handleBegin(line: string): void {
    const p = line.split(',');
    if (p.length < 5) return;
    const session = finiteInt(p[2]);
    const startIndex = finiteInt(p[3]);
    const endIndex = finiteInt(p[4]);
    this.publish({
      phase: 'syncing',
      session,
      startIndex,
      nextIndex: startIndex,
      endIndex,
      received: 0,
      persisted: 0,
      progress: endIndex > 0 ? startIndex / endIndex : 1,
      message: `Downloading stored results ${startIndex + 1}–${endIndex}…`,
      error: null,
    });
  }

  private handleMinute(line: string): void {
    if (!this.context || !this.resumeMeta) return;

    const match = line.match(/^D,M,(\d+),(\d+),(.+)$/);
    if (!match) return;

    const session = finiteInt(match[1]);
    const historyIndex = finiteInt(match[2]);
    const payload = match[3];
    const vm: V0MinParsed | null = parseV0Min(payload);
    if (!vm) {
      console.warn('[MemorySync] Could not parse stored V0_MIN:', payload);
      return;
    }

    const timestampMs = this.resumeMeta.bootEpochMs + vm.t_ms;
    const record: HistoricalMinuteSummaryInput = {
      timestampMs,
      firmwareUptimeMs: vm.t_ms,
      historyIndex,
      syncSession: session,
      memoryProtocolVersion: this.state.info?.protocolVersion,
      source: 'WRISTBAND_MEMORY',
      deviceId: this.context.deviceId,
      deviceName: this.context.deviceName,
      activity: vm.activity,
      activityConfidence: vm.act_conf,
      artifactFraction: vm.art_frac,
      heartRate: vm.hr_bpm,
      hrCoverageSec: vm.hr_coverage_sec,
      hrQuality: vm.hr_quality,
      hrvRmssdMs: vm.hrv_rmssd_ms,
      hrvQuality: vm.hrv_quality,
      edaMuScl: vm.eda_muSCL,
      edaSigmaScr: vm.eda_sigmaSCR,
      edaQuality: vm.eda_quality,
      edaConfidence: vm.eda_confidence,
      temperatureC: vm.temp_c,
      temperatureQuality: vm.temp_quality,
      temperatureSlope5m: vm.temp_slope_5m,
      sleepState: vm.sleep_state,
      sleepConfidence: vm.sleep_conf,
      timestampSource: 'DEVICE_UPTIME_ANCHOR',
    };

    this.pendingRecords.push(record);
    const nextIndex = historyIndex + 1;
    const denominator = Math.max(this.state.endIndex, 1);
    this.publish({
      nextIndex,
      received: this.state.received + 1,
      progress: Math.min(1, nextIndex / denominator),
      message: `Downloading wristband memory… ${nextIndex}/${this.state.endIndex}`,
    });

    // Firmware emits D,PROGRESS every 60 records. This additional guard keeps
    // app RAM bounded even if a progress packet is lost.
    if (this.pendingRecords.length >= 120) {
      void this.flushPending(false);
    }
  }

  private handleProgress(line: string): void {
    const p = line.split(',');
    if (p.length < 5) return;
    const nextIndex = finiteInt(p[3]);
    const endIndex = finiteInt(p[4]);
    this.publish({
      nextIndex,
      endIndex,
      progress: endIndex > 0 ? Math.min(1, nextIndex / endIndex) : 1,
      message: `Downloading wristband memory… ${nextIndex}/${endIndex}`,
    });
    void this.flushPending(false);
  }

  private async handleEnd(line: string): Promise<void> {
    const p = line.split(',');
    const endIndex = p.length >= 5 ? finiteInt(p[4]) : this.state.endIndex;
    this.publish({ phase: 'saving', endIndex, progress: 1, message: 'Saving downloaded day results…' });

    try {
      await this.flushPending(true);
      const finalIndex = Math.max(this.state.lastSyncedIndex, endIndex - 1);
      await this.saveMeta(finalIndex);
      this.publish({
        phase: 'complete',
        lastSyncedIndex: finalIndex,
        progress: 1,
        message: `Memory sync complete — ${this.state.persisted} result${this.state.persisted === 1 ? '' : 's'} saved`,
        error: null,
      });
    } catch (error: any) {
      this.publish({
        phase: 'error',
        error: error?.message || String(error),
        message: 'Downloaded data could not be saved',
      });
    }
  }

  private flushPending(waitForCompletion: boolean): Promise<void> {
    if (!this.context || this.pendingRecords.length === 0) {
      return waitForCompletion ? this.persistChain : Promise.resolve();
    }

    const batch = this.pendingRecords.splice(0, this.pendingRecords.length);
    const userId = this.context.userId;
    const maxIndex = batch.reduce((max, r) => Math.max(max, r.historyIndex), -1);
    const generation = this.syncGeneration;

    this.persistChain = this.persistChain.then(async () => {
      await saveHistoricalMinuteSummaries(userId, batch);
      if (generation !== this.syncGeneration) return;

      this.persistError = null;
      const newLast = Math.max(this.state.lastSyncedIndex, maxIndex);
      await this.saveMeta(newLast);
      this.publish({
        persisted: this.state.persisted + batch.length,
        lastSyncedIndex: newLast,
      });
    });

    // Attach a handler immediately so an async Firestore failure never becomes
    // an unhandled JS rejection. The original chain remains rejected, so later
    // batches do not advance the resume cursor past unsaved data. A new Sync
    // request will therefore re-download from the last confirmed index.
    void this.persistChain.catch(error => {
      this.persistError = error instanceof Error ? error : new Error(String(error));
      console.error('[MemorySync] Failed to persist downloaded minute summaries:', error);
    });

    return waitForCompletion ? this.persistChain : Promise.resolve();
  }
}

export const memorySyncService = new MemorySyncService();

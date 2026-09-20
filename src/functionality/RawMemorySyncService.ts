import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter } from 'react-native';
import { Directory, File, Paths } from 'expo-file-system';

import { bleService } from './BLEService';

const BLE_DATA_EVENT = 'BLE_DATA_LINE';
const RAW_META_PREFIX = 'wristband_raw_sync_v1';
const RAW_DIR_NAME = 'wristband_raw';

const RAW_MAGIC_0 = 0x52; // R
const RAW_MAGIC_1 = 0x42; // B
const RAW_HEADER_SIZE = 20;
const RAW_TYPE_BEGIN = 0x01;
const RAW_TYPE_DATA = 0x02;
const RAW_TYPE_END = 0x03;
const RAW_TYPE_ERROR = 0x04;
const RAW_PROTOCOL_VERSION = 1;
const WRITE_BUFFER_TARGET = 128 * 1024;
const UI_UPDATE_INTERVAL_MS = 250;

export type RawMemorySyncPhase =
  | 'idle'
  | 'checking'
  | 'syncing'
  | 'stopping'
  | 'complete'
  | 'stopped'
  | 'error';

export interface RawMemoryInfo {
  exportProtocolVersion: number;
  recordFormatVersion: number;
  pageSize: number;
  committedSpanBytes: number;
  pendingPageBytes: number;
  writtenPages: number;
  capacityBytes: number;
  storageFull: boolean;
  timeValid: boolean;
  anchorUnixMs: number;
  anchorUptimeMs: number;
}

export interface RawMemorySyncState {
  phase: RawMemorySyncPhase;
  info: RawMemoryInfo | null;
  session: number | null;
  fileName: string | null;
  fileUri: string | null;
  resumeOffset: number;
  currentOffset: number;
  totalBytes: number;
  bytesReceivedThisRun: number;
  dataFrames: number;
  progress: number;
  message: string;
  error: string | null;
}

interface RawSyncContext {
  userId?: string;
  deviceId?: string;
  deviceName?: string;
}

interface RawResumeMeta {
  fileName: string;
  lastVerifiedOffset: number;
  totalBytes: number;
  deviceId?: string;
  updatedAtMs: number;
}

interface RawBeginMeta {
  session: number;
  requestedOffset: number;
  totalBytes: number;
  pageSize: number;
  rawFirstPage: number;
  snapshotEndPageExclusive: number;
  anchorUnixMs: number;
  anchorUptimeMs: number;
  timeValid: boolean;
  rawRecordFormatVersion: number;
  writtenRawPages: number;
}

type StateListener = (state: RawMemorySyncState) => void;

const initialState: RawMemorySyncState = {
  phase: 'idle',
  info: null,
  session: null,
  fileName: null,
  fileUri: null,
  resumeOffset: 0,
  currentOffset: 0,
  totalBytes: 0,
  bytesReceivedThisRun: 0,
  dataFrames: 0,
  progress: 0,
  message: 'Ready to sync raw wristband data',
  error: null,
};

const finiteInt = (value: string | undefined, fallback = 0): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
};

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const readU16LE = (b: Uint8Array, o: number): number =>
  (b[o] | (b[o + 1] << 8)) >>> 0;

const readU32LE = (b: Uint8Array, o: number): number =>
  ((b[o]) |
    (b[o + 1] << 8) |
    (b[o + 2] << 16) |
    (b[o + 3] << 24)) >>> 0;

const readU64LE = (b: Uint8Array, o: number): number => {
  const lo = readU32LE(b, o);
  const hi = readU32LE(b, o + 4);
  return lo + hi * 0x100000000;
};

const crc32 = (data: Uint8Array): number => {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let bit = 0; bit < 8; bit++) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const concatBytes = (a: Uint8Array, b: Uint8Array): Uint8Array => {
  if (a.length === 0) return b.slice();
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

const timestampFileName = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `smartstim_raw_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${Date.now()}.bin`;
};

class RawMemorySyncService {
  private state: RawMemorySyncState = { ...initialState };
  private listeners = new Set<StateListener>();
  private context: RawSyncContext | null = null;
  private infoTimeout: ReturnType<typeof setTimeout> | null = null;

  private rawDirectory = new Directory(Paths.document, RAW_DIR_NAME);
  private file: File | null = null;
  private fileHandle: any = null;
  private beginMeta: RawBeginMeta | null = null;

  private frameBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private pendingChunks: Uint8Array[] = [];
  private pendingBytes = 0;
  private diskOffset = 0;
  private receivedOffset = 0;
  private bytesReceivedThisRun = 0;
  private dataFrames = 0;
  private lastUiPublishMs = 0;
  private finishing = false;
  private metaWriteChain: Promise<void> = Promise.resolve();

  constructor() {
    DeviceEventEmitter.addListener(BLE_DATA_EVENT, (line: string) => {
      if (typeof line !== 'string') return;
      const clean = line.trim();
      if (!clean.startsWith('D,')) return;
      void this.handleTextLine(clean);
    });
  }

  getState(): RawMemorySyncState {
    return { ...this.state };
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  private publish(patch: Partial<RawMemorySyncState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      try {
        listener(this.getState());
      } catch (error) {
        console.warn('[RawMemorySync] state listener failed:', error);
      }
    }
  }

  private clearInfoTimeout(): void {
    if (this.infoTimeout) {
      clearTimeout(this.infoTimeout);
      this.infoTimeout = null;
    }
  }

  private metaKey(): string {
    const user = (this.context?.userId || 'anonymous').replace(/[^A-Za-z0-9_-]/g, '_');
    const device = (this.context?.deviceId || 'SMARTWATCH').replace(/[^A-Za-z0-9_-]/g, '_');
    return `${RAW_META_PREFIX}:${user}:${device}`;
  }

  private async loadResumeMeta(): Promise<RawResumeMeta | null> {
    try {
      const raw = await AsyncStorage.getItem(this.metaKey());
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<RawResumeMeta>;
      if (!parsed.fileName || !Number.isFinite(parsed.lastVerifiedOffset)) return null;
      return {
        fileName: parsed.fileName,
        lastVerifiedOffset: Math.max(0, Number(parsed.lastVerifiedOffset)),
        totalBytes: Math.max(0, Number(parsed.totalBytes) || 0),
        deviceId: parsed.deviceId,
        updatedAtMs: Number(parsed.updatedAtMs) || 0,
      };
    } catch (error) {
      console.warn('[RawMemorySync] Could not load resume metadata:', error);
      return null;
    }
  }

  private queueResumeMetaWrite(offset: number, totalBytes: number): void {
    if (!this.file) return;
    const meta: RawResumeMeta = {
      fileName: this.file.name,
      lastVerifiedOffset: offset,
      totalBytes,
      deviceId: this.context?.deviceId,
      updatedAtMs: Date.now(),
    };
    const key = this.metaKey();
    this.metaWriteChain = this.metaWriteChain
      .catch((): void => {})
      .then(() => AsyncStorage.setItem(key, JSON.stringify(meta)));
  }

  private async clearResumeMeta(): Promise<void> {
    try {
      await this.metaWriteChain.catch((): void => {});
      await AsyncStorage.removeItem(this.metaKey());
    } catch (error) {
      console.warn('[RawMemorySync] Could not clear resume metadata:', error);
    }
  }

  /** Start full raw NAND sync to an app-private .bin file. */
  async startSync(context: RawSyncContext = {}): Promise<boolean> {
    if (!bleService.isCurrentlyConnected()) {
      this.publish({ phase: 'error', error: 'Wristband is not connected.', message: 'Connect wristband first' });
      return false;
    }
    if (['checking', 'syncing', 'stopping'].includes(this.state.phase)) return false;

    this.context = context;
    this.clearInfoTimeout();
    this.resetTransferRuntime();
    this.publish({
      ...initialState,
      phase: 'checking',
      message: 'Synchronizing wristband time and checking raw memory…',
    });

    // Best effort wall-clock anchor. The firmware keeps its precise t_ms in raw
    // records and stores this Unix-ms anchor as an event for later decoding.
    const timeOk = await bleService.sendLogServiceCommand(`TIME_SYNC,${Date.now()}\n`, true);
    if (!timeOk) {
      console.warn('[RawMemorySync] TIME_SYNC failed; continuing with uptime-only timestamps');
    }

    await new Promise(resolve => setTimeout(resolve, 150));

    const infoOk = await bleService.sendLogServiceCommand('MEM_RAW_INFO\n', true);
    if (!infoOk) {
      this.publish({ phase: 'error', error: 'Could not send MEM_RAW_INFO.', message: 'Raw memory check failed' });
      return false;
    }

    this.infoTimeout = setTimeout(() => {
      if (this.state.phase === 'checking') {
        this.publish({
          phase: 'error',
          error: 'No MEM_RAW_INFO response received from the wristband.',
          message: 'Raw memory check timed out',
        });
      }
    }, 6000);

    return true;
  }

  async stopSync(): Promise<void> {
    if (!['checking', 'syncing'].includes(this.state.phase)) return;
    this.clearInfoTimeout();

    if (this.state.phase === 'checking') {
      await this.closeTransferFile(true);
      this.publish({ phase: 'stopped', message: 'Raw memory sync stopped' });
      return;
    }

    this.publish({ phase: 'stopping', message: 'Stopping raw memory sync…' });
    const ok = await bleService.sendLogServiceCommand('MEM_RAW_STOP\n', true);
    if (!ok) {
      await this.handleTransferFailure('Could not send MEM_RAW_STOP. Partial file was kept for resume.');
    }
  }

  async handleDisconnected(): Promise<void> {
    if (!['checking', 'syncing', 'stopping'].includes(this.state.phase)) return;
    this.clearInfoTimeout();
    bleService.stopRawBinaryCapture();

    try {
      this.flushPendingToDisk();
      this.queueResumeMetaWrite(this.diskOffset, this.state.totalBytes);
      await this.metaWriteChain.catch((): void => {});
    } finally {
      this.closeFileHandle();
    }

    this.publish({
      phase: 'stopped',
      currentOffset: this.diskOffset,
      progress: this.state.totalBytes > 0 ? Math.min(1, this.diskOffset / this.state.totalBytes) : 0,
      message: 'Disconnected — reconnect and tap Sync Raw Data to resume',
      error: null,
    });
  }

  /** Forget a partial transfer and start a fresh .bin on the next sync. */
  async resetResumeCursor(deletePartialFile = false): Promise<void> {
    const meta = await this.loadResumeMeta();
    if (deletePartialFile && meta?.fileName) {
      try {
        this.ensureRawDirectory();
        const partial = new File(this.rawDirectory, meta.fileName);
        if (partial.exists) partial.delete();
      } catch (error) {
        console.warn('[RawMemorySync] Could not delete partial raw file:', error);
      }
    }
    await AsyncStorage.removeItem(this.metaKey());
  }

  private async handleTextLine(line: string): Promise<void> {
    if (line.startsWith('D,RAW_INFO,')) {
      await this.handleRawInfo(line);
      return;
    }

    if (line.startsWith('D,TIME_SYNC,')) {
      console.log('[RawMemorySync]', line);
      return;
    }

    if (line.startsWith('D,ERROR,') && this.state.phase === 'checking') {
      this.clearInfoTimeout();
      const error = line.slice('D,ERROR,'.length) || 'Unknown firmware raw-memory error';
      this.publish({ phase: 'error', error, message: `Raw memory error: ${error}` });
    }
  }

  private async handleRawInfo(line: string): Promise<void> {
    if (this.state.phase !== 'checking') return;
    this.clearInfoTimeout();

    const p = line.split(',');
    if (p.length < 13) {
      this.publish({ phase: 'error', error: 'Malformed D,RAW_INFO response', message: 'Invalid raw memory information' });
      return;
    }

    const info: RawMemoryInfo = {
      exportProtocolVersion: finiteInt(p[2]),
      recordFormatVersion: finiteInt(p[3]),
      pageSize: finiteInt(p[4]),
      committedSpanBytes: finiteInt(p[5]),
      pendingPageBytes: finiteInt(p[6]),
      writtenPages: finiteInt(p[7]),
      capacityBytes: finiteInt(p[8]),
      storageFull: finiteInt(p[9]) !== 0,
      timeValid: finiteInt(p[10]) !== 0,
      anchorUnixMs: finiteInt(p[11]),
      anchorUptimeMs: finiteInt(p[12]),
    };

    if (info.exportProtocolVersion !== RAW_PROTOCOL_VERSION) {
      this.publish({
        phase: 'error',
        info,
        error: `Unsupported raw export protocol ${info.exportProtocolVersion}.`,
        message: 'Firmware/app raw protocol mismatch',
      });
      return;
    }

    this.publish({ info, message: `${formatBytes(info.committedSpanBytes)} committed raw data found` });

    try {
      await this.prepareTransferFile();
    } catch (error: any) {
      this.publish({
        phase: 'error',
        error: error?.message || String(error),
        message: 'Could not prepare local raw-data file',
      });
      return;
    }

    // Enable byte-exact notification routing BEFORE the command; firmware can
    // send RB BEGIN immediately after processing MEM_RAW_SYNC.
    bleService.startRawBinaryCapture((bytes) => this.handleRawBytes(bytes));

    const resumeOffset = this.diskOffset;
    // Use the short firmware alias so the entire resume command fits inside
    // the default 20-byte ATT payload even when the byte offset has 8-10 digits.
    // The old MEM_RAW_SYNC,<offset> form can be truncated after reconnect when
    // Android is back on the default MTU, which changes the requested offset.
    const command = resumeOffset > 0 ? `RAW,${resumeOffset}\n` : 'RAW\n';
    const ok = await bleService.sendLogServiceCommand(command, true);
    if (!ok) {
      bleService.stopRawBinaryCapture();
      this.closeFileHandle();
      this.publish({
        phase: 'error',
        error: 'Could not start raw NAND download.',
        message: 'Raw memory download failed to start',
      });
    }
  }

  private ensureRawDirectory(): void {
    this.rawDirectory.create({ idempotent: true, intermediates: true });
  }

  private async prepareTransferFile(): Promise<void> {
    this.ensureRawDirectory();
    const resume = await this.loadResumeMeta();

    if (resume?.fileName && resume.lastVerifiedOffset > 0) {
      const candidate = new File(this.rawDirectory, resume.fileName);
      const size = Number(candidate.size ?? 0);
      if (candidate.exists && size === resume.lastVerifiedOffset) {
        this.file = candidate;
        this.fileHandle = candidate.open();
        this.fileHandle.offset = size;
        this.diskOffset = size;
        this.receivedOffset = size;
        this.publish({
          fileName: candidate.name,
          fileUri: candidate.uri,
          resumeOffset: size,
          currentOffset: size,
          totalBytes: resume.totalBytes,
          progress: resume.totalBytes > 0 ? Math.min(1, size / resume.totalBytes) : 0,
          message: `Resuming raw download from ${formatBytes(size)}…`,
        });
        return;
      }

      // Resume metadata and file disagree: do not risk appending at the wrong
      // offset. Preserve the old file and begin a new snapshot instead.
      await AsyncStorage.removeItem(this.metaKey());
    }

    const fresh = new File(this.rawDirectory, timestampFileName());
    fresh.create({ overwrite: false, intermediates: true });
    this.file = fresh;
    this.fileHandle = fresh.open();
    this.fileHandle.offset = 0;
    this.diskOffset = 0;
    this.receivedOffset = 0;
    this.publish({
      fileName: fresh.name,
      fileUri: fresh.uri,
      resumeOffset: 0,
      currentOffset: 0,
      progress: 0,
      message: 'Starting raw memory download…',
    });
  }

  private handleRawBytes(bytes: Uint8Array): void {
    if (!bytes.length || this.finishing) return;

    try {
      this.frameBuffer = concatBytes(this.frameBuffer, bytes);
      this.drainRawFrames();
    } catch (error: any) {
      void this.handleTransferFailure(error?.message || String(error));
    }
  }

  private drainRawFrames(): void {
    while (this.frameBuffer.length >= RAW_HEADER_SIZE) {
      if (this.frameBuffer[0] !== RAW_MAGIC_0 || this.frameBuffer[1] !== RAW_MAGIC_1) {
        let found = -1;
        for (let i = 1; i + 1 < this.frameBuffer.length; i++) {
          if (this.frameBuffer[i] === RAW_MAGIC_0 && this.frameBuffer[i + 1] === RAW_MAGIC_1) {
            found = i;
            break;
          }
        }
        if (found < 0) {
          // Preserve a trailing 'R' in case the RB magic is split across BLE notifications.
          this.frameBuffer = this.frameBuffer[this.frameBuffer.length - 1] === RAW_MAGIC_0
            ? this.frameBuffer.slice(-1)
            : new Uint8Array(0);
          return;
        }
        this.frameBuffer = this.frameBuffer.slice(found);
        if (this.frameBuffer.length < RAW_HEADER_SIZE) return;
      }

      const version = this.frameBuffer[2];
      const type = this.frameBuffer[3];
      const session = readU32LE(this.frameBuffer, 4);
      const offset = readU32LE(this.frameBuffer, 8);
      const payloadLength = readU16LE(this.frameBuffer, 12);
      const expectedCrc = readU32LE(this.frameBuffer, 16);
      const frameLength = RAW_HEADER_SIZE + payloadLength;

      if (version !== RAW_PROTOCOL_VERSION) {
        throw new Error(`Unsupported RB protocol ${version}`);
      }
      if (payloadLength > 4096) {
        throw new Error(`Invalid raw frame length ${payloadLength}`);
      }
      if (this.frameBuffer.length < frameLength) return;

      const payload = this.frameBuffer.slice(RAW_HEADER_SIZE, frameLength);
      this.frameBuffer = this.frameBuffer.slice(frameLength);

      const actualCrc = crc32(payload);
      if (actualCrc !== expectedCrc) {
        throw new Error(
          `Raw CRC mismatch at offset ${offset}: expected 0x${expectedCrc.toString(16)}, got 0x${actualCrc.toString(16)}`,
        );
      }

      this.handleRawFrame(type, session, offset, payload);
      if (this.finishing) return;
    }
  }

  private handleRawFrame(type: number, session: number, offset: number, payload: Uint8Array): void {
    if (type === RAW_TYPE_BEGIN) {
      this.handleBeginFrame(session, offset, payload);
      return;
    }

    if (type === RAW_TYPE_DATA) {
      this.handleDataFrame(session, offset, payload);
      return;
    }

    if (type === RAW_TYPE_ERROR) {
      const reason = String.fromCharCode(...Array.from(payload));
      console.warn('[RawMemorySync] Firmware raw error:', reason);
      return;
    }

    if (type === RAW_TYPE_END) {
      void this.handleEndFrame(session, offset, payload);
    }
  }

  private handleBeginFrame(session: number, requestedOffset: number, payload: Uint8Array): void {
    if (payload.length !== 40) throw new Error(`Invalid RAW BEGIN payload length ${payload.length}`);

    const meta: RawBeginMeta = {
      session,
      requestedOffset,
      totalBytes: readU32LE(payload, 0),
      pageSize: readU32LE(payload, 4),
      rawFirstPage: readU32LE(payload, 8),
      snapshotEndPageExclusive: readU32LE(payload, 12),
      anchorUnixMs: readU64LE(payload, 16),
      anchorUptimeMs: readU64LE(payload, 24),
      timeValid: payload[32] !== 0,
      rawRecordFormatVersion: payload[33],
      writtenRawPages: readU32LE(payload, 36),
    };

    if (requestedOffset !== this.receivedOffset) {
      throw new Error(
        `Raw resume offset mismatch: local ${this.receivedOffset}, firmware ${requestedOffset}. Reset the partial raw sync and retry.`,
      );
    }

    this.beginMeta = meta;
    this.publish({
      phase: 'syncing',
      session,
      totalBytes: meta.totalBytes,
      currentOffset: requestedOffset,
      progress: meta.totalBytes > 0 ? Math.min(1, requestedOffset / meta.totalBytes) : 1,
      message: `Downloading raw sensor data… ${formatBytes(requestedOffset)} / ${formatBytes(meta.totalBytes)}`,
      error: null,
    });

    this.queueResumeMetaWrite(this.diskOffset, meta.totalBytes);
    this.writeSidecar(meta);
  }

  private handleDataFrame(session: number, offset: number, payload: Uint8Array): void {
    if (!this.beginMeta) throw new Error('RAW DATA received before BEGIN');
    if (session !== this.beginMeta.session) throw new Error(`Unexpected raw session ${session}`);
    if (offset !== this.receivedOffset) {
      throw new Error(`Raw offset mismatch: expected ${this.receivedOffset}, received ${offset}`);
    }

    this.pendingChunks.push(payload);
    this.pendingBytes += payload.length;
    this.receivedOffset += payload.length;
    this.bytesReceivedThisRun += payload.length;
    this.dataFrames += 1;

    if (this.pendingBytes >= WRITE_BUFFER_TARGET) {
      this.flushPendingToDisk();
    }

    this.publishProgress(false);
  }

  private async handleEndFrame(session: number, offset: number, payload: Uint8Array): Promise<void> {
    if (this.finishing) return;
    this.finishing = true;

    try {
      if (payload.length !== 20) throw new Error(`Invalid RAW END payload length ${payload.length}`);
      const totalBytes = readU32LE(payload, 0);
      const currentOffset = readU32LE(payload, 4);
      const sentThisConnection = readU32LE(payload, 8);
      const framesThisConnection = readU32LE(payload, 12);
      const status = readU32LE(payload, 16);

      console.log('[RawMemorySync] END', {
        session,
        offset,
        totalBytes,
        currentOffset,
        sentThisConnection,
        framesThisConnection,
        status,
      });

      this.flushPendingToDisk();
      bleService.stopRawBinaryCapture();
      this.closeFileHandle();
      this.publishProgress(true);

      if (status === 0 && this.diskOffset === totalBytes) {
        await this.clearResumeMeta();
        if (this.beginMeta) this.writeSidecar(this.beginMeta, true);
        this.publish({
          phase: 'complete',
          currentOffset: this.diskOffset,
          totalBytes,
          progress: 1,
          message: `Raw sync complete — ${formatBytes(totalBytes)} saved locally`,
          error: null,
        });
      } else {
        this.queueResumeMetaWrite(this.diskOffset, totalBytes);
        await this.metaWriteChain.catch((): void => {});
        this.publish({
          phase: 'stopped',
          currentOffset: this.diskOffset,
          totalBytes,
          progress: totalBytes > 0 ? Math.min(1, this.diskOffset / totalBytes) : 0,
          message: `Raw sync stopped at ${formatBytes(this.diskOffset)} — tap Sync Raw Data to resume`,
          error: status > 1 ? `Firmware raw transfer ended with status ${status}` : null,
        });
      }
    } catch (error: any) {
      await this.handleTransferFailure(error?.message || String(error));
    } finally {
      this.finishing = false;
    }
  }

  private flushPendingToDisk(): void {
    if (this.pendingBytes === 0) return;
    if (!this.fileHandle) throw new Error('Raw output file is not open');

    const merged = new Uint8Array(this.pendingBytes);
    let cursor = 0;
    for (const chunk of this.pendingChunks) {
      merged.set(chunk, cursor);
      cursor += chunk.length;
    }

    this.fileHandle.offset = this.diskOffset;
    this.fileHandle.writeBytes(merged);
    this.diskOffset += merged.length;
    this.pendingChunks = [];
    this.pendingBytes = 0;
    this.queueResumeMetaWrite(this.diskOffset, this.state.totalBytes || this.beginMeta?.totalBytes || 0);
  }

  private publishProgress(force: boolean): void {
    const now = Date.now();
    if (!force && now - this.lastUiPublishMs < UI_UPDATE_INTERVAL_MS) return;
    this.lastUiPublishMs = now;

    const total = this.beginMeta?.totalBytes || this.state.totalBytes;
    const current = this.receivedOffset;
    this.publish({
      currentOffset: current,
      totalBytes: total,
      bytesReceivedThisRun: this.bytesReceivedThisRun,
      dataFrames: this.dataFrames,
      progress: total > 0 ? Math.min(1, current / total) : 0,
      message: `Downloading raw sensor data… ${formatBytes(current)} / ${formatBytes(total)}`,
    });
  }

  private writeSidecar(meta: RawBeginMeta, complete = false): void {
    if (!this.file) return;
    try {
      this.ensureRawDirectory();
      const sidecar = new File(this.rawDirectory, `${this.file.name}.meta.json`);
      if (!sidecar.exists) sidecar.create({ overwrite: true, intermediates: true });
      sidecar.write(JSON.stringify({
        session: meta.session,
        requested_offset: meta.requestedOffset,
        total_bytes: meta.totalBytes,
        page_size: meta.pageSize,
        raw_first_page: meta.rawFirstPage,
        snapshot_end_page_exclusive: meta.snapshotEndPageExclusive,
        anchor_unix_ms: meta.anchorUnixMs,
        anchor_uptime_ms: meta.anchorUptimeMs,
        time_valid: meta.timeValid,
        raw_record_format_version: meta.rawRecordFormatVersion,
        written_raw_pages: meta.writtenRawPages,
        downloaded_at_unix_ms: Date.now(),
        complete,
        local_file_name: this.file.name,
      }, null, 2));
    } catch (error) {
      console.warn('[RawMemorySync] Could not write metadata sidecar:', error);
    }
  }

  private closeFileHandle(): void {
    if (!this.fileHandle) return;
    try {
      this.fileHandle.close();
    } catch (error) {
      console.warn('[RawMemorySync] Error closing raw file:', error);
    }
    this.fileHandle = null;
  }

  private async closeTransferFile(keepResume: boolean): Promise<void> {
    bleService.stopRawBinaryCapture();
    try {
      this.flushPendingToDisk();
      if (keepResume && this.file) {
        this.queueResumeMetaWrite(this.diskOffset, this.state.totalBytes);
        await this.metaWriteChain.catch((): void => {});
      }
    } finally {
      this.closeFileHandle();
    }
  }

  private async handleTransferFailure(message: string): Promise<void> {
    if (this.finishing === false) this.finishing = true;
    this.clearInfoTimeout();
    bleService.stopRawBinaryCapture();

    try {
      if (this.fileHandle) {
        this.flushPendingToDisk();
        this.queueResumeMetaWrite(this.diskOffset, this.state.totalBytes || this.beginMeta?.totalBytes || 0);
        await this.metaWriteChain.catch((): void => {});
      }
    } catch (flushError) {
      console.warn('[RawMemorySync] Could not flush partial file after error:', flushError);
    } finally {
      this.closeFileHandle();
    }

    this.publish({
      phase: 'error',
      currentOffset: this.diskOffset,
      progress: this.state.totalBytes > 0 ? Math.min(1, this.diskOffset / this.state.totalBytes) : 0,
      message: 'Raw memory sync failed — partial file kept for resume',
      error: message,
    });
    this.finishing = false;
  }

  private resetTransferRuntime(): void {
    bleService.stopRawBinaryCapture();
    this.closeFileHandle();
    this.file = null;
    this.beginMeta = null;
    this.frameBuffer = new Uint8Array(0);
    this.pendingChunks = [];
    this.pendingBytes = 0;
    this.diskOffset = 0;
    this.receivedOffset = 0;
    this.bytesReceivedThisRun = 0;
    this.dataFrames = 0;
    this.lastUiPublishMs = 0;
    this.finishing = false;
    this.metaWriteChain = Promise.resolve();
  }
}

export const rawMemorySyncService = new RawMemorySyncService();

import type { MinuteSummaryReading } from '../firebase/sensorTypes';

export type HistoryPeriod = 'day' | 'week' | 'month';
export type HistoricalReading = MinuteSummaryReading & { id: string };
export type MetricName = 'heartRate' | 'hrvRmssdMs' | 'temperatureC' | 'edaMuScl';
export type HistoryPoint = { atMs: number; value: number };

const MINUTE_MS = 60_000;
const GAP_MS = 90_000;
const approvedQuality = (s?: string): boolean =>
  ['GOOD', 'VALID', 'OK'].includes((s || '').trim().toUpperCase());

/** All grouping uses the phone's LOCAL calendar; firmware timestamps are absolute Unix ms. */
export const periodBounds = (period: HistoryPeriod, selected: Date) => {
  const start = new Date(selected.getFullYear(), selected.getMonth(), selected.getDate());
  if (period === 'week') {
    const mondayOffset = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - mondayOffset);
  } else if (period === 'month') {
    start.setDate(1);
  }
  const end = new Date(start);
  if (period === 'day') end.setDate(end.getDate() + 1);
  if (period === 'week') end.setDate(end.getDate() + 7);
  if (period === 'month') end.setMonth(end.getMonth() + 1);
  return { start, end };
};

export const shiftSelectedPeriod = (period: HistoryPeriod, selected: Date, delta: number) => {
  const date = new Date(selected);
  // Months have variable length: always move from the first day of that month.
  if (period === 'month') return new Date(date.getFullYear(), date.getMonth() + delta, 1);
  date.setDate(date.getDate() + (period === 'week' ? 7 : 1) * delta);
  return date;
};

const exactMs = (row: HistoricalReading): number => {
  // Never assign historical records timestamps based on the time of sync/download.
  if (row.timestampSource === 'UNAVAILABLE_LEGACY') return NaN;
  const ms = row.timestamp?.toMillis?.();
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : NaN;
};

const qualityScore = (row: HistoricalReading): number => {
  let score = 0;
  for (const quality of [row.hrQuality, row.hrvQuality, row.edaQuality, row.temperatureQuality]) {
    if (approvedQuality(quality)) score++;
  }
  if (row.syncedAt?.toMillis?.()) score += 0.01;
  return score;
};

/**
 * Graph-level overlap suppression across processed memory syncs and BIN imports.
 * Canonical BIN records have exact per-device/UTC IDs in Firestore. Historical
 * memory-sync and BIN timestamps may differ slightly when independently
 * reconstructed from TIME_SYNC. Merge ONLY results from the SAME identified
 * device no more than 1.5 seconds apart, choosing the highest quality row.
 * Do not quantize times to calendar minute boundaries or fill missing minutes.
 */
export const uniqueExactMinutes = (rows: HistoricalReading[]): HistoricalReading[] => {
  const perDevice = new Map<string,HistoricalReading[]>();
  for(const row of rows){
    const ms=exactMs(row);
    if(!Number.isFinite(ms))continue;
    const key=row.deviceId||'unknown';
    const group=perDevice.get(key)||[];
    group.push(row);
    perDevice.set(key,group);
  }
  const chosen:HistoricalReading[]=[];
  const better=(a:HistoricalReading,b:HistoricalReading):HistoricalReading => {
    const qa=qualityScore(a),qb=qualityScore(b);
    if(qa!==qb)return qa>qb?a:b;
    return (a.syncedAt?.toMillis?.()||0)>=(b.syncedAt?.toMillis?.()||0)?a:b;
  };
  for(const group of perDevice.values()){
    group.sort((a,b)=>exactMs(a)-exactMs(b));
    let best:HistoricalReading|null=null,firstMs=NaN;
    for(const row of group){
      const ms=exactMs(row);
      if(!best||ms-firstMs>1500){
        if(best)chosen.push(best);
        best=row;firstMs=ms;
      }else best=better(best,row);
    }
    if(best)chosen.push(best);
  }
  return chosen.sort((a,b)=>exactMs(a)-exactMs(b));
};

export const validMetricValue = (row: HistoricalReading, metric: MetricName): number | null => {
  const n = row[metric];
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  if (metric === 'heartRate') {
    return n >= 30 && n <= 220 && approvedQuality(row.hrQuality) ? n : null;
  }
  if (metric === 'hrvRmssdMs') {
    return n > 0 && n < 1000 && approvedQuality(row.hrvQuality) ? n : null;
  }
  if (metric === 'temperatureC') {
    // Preserve firmware-approved temperatures even below the preferred UI range.
    return n >= 20 && n <= 44 && approvedQuality(row.temperatureQuality) ? n : null;
  }
  return n >= 0 && n < 10000 && approvedQuality(row.edaQuality) ? n : null;
};

/** Day: individual minute points. Week/month: daily means of VALID minute values. */
export const buildMetricTrend = (
  rows: HistoricalReading[], metric: MetricName, period: HistoryPeriod, start: Date, end: Date,
): { points: HistoryPoint[]; validMinutes: number; displayMean: number | null } => {
  const valid = uniqueExactMinutes(rows)
    .map((row) => ({ atMs: exactMs(row), value: validMetricValue(row, metric) }))
    .filter((p): p is HistoryPoint => p.value !== null && p.atMs >= +start && p.atMs < +end);

  if (period === 'day') {
    return { points: valid, validMinutes: valid.length,
      displayMean: valid.length ? valid.reduce((s, p) => s + p.value, 0) / valid.length : null };
  }

  const buckets = new Map<number, { sum: number; count: number }>();
  for (const p of valid) {
    const d = new Date(p.atMs);
    const day = +new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const bucket = buckets.get(day) || { sum: 0, count: 0 };
    bucket.sum += p.value;
    bucket.count++;
    buckets.set(day, bucket);
  }
  const points = [...buckets.entries()]
    .map(([atMs, b]) => ({ atMs, value: b.sum / b.count }))
    .sort((a, b) => a.atMs - b.atMs);
  return { points, validMinutes: valid.length,
    // The period's mean is mean of recorded daily means, not a fabricated value for missing days.
    displayMean: points.length ? points.reduce((s, p) => s + p.value, 0) / points.length : null };
};

export const getActivitySummary = (rows: HistoricalReading[], start: Date, end: Date) => {
  const counts = new Map<string, number>();
  for (const row of uniqueExactMinutes(rows)) {
    const atMs = exactMs(row);
    if (atMs < +start || atMs >= +end) continue;
    const state = (row.activity || '').trim().toUpperCase();
    if (!state || state === 'UNKNOWN' || state === 'INVALID') continue;
    counts.set(state, (counts.get(state) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
};

/** Only count OBSERVED consecutive SLEEP minutes; gaps are never filled in. */
export const getObservedSleepSegments = (rows: HistoricalReading[], start: Date, end: Date): HistoryPoint[] => {
  let lastAt = 0;
  let runMinutes = 0;
  const nights: HistoryPoint[] = [];
  const push = () => {
    if (lastAt >= +start && lastAt < +end && runMinutes > 0) {
      nights.push({ atMs: lastAt, value: runMinutes });
    }
  };
  for (const row of uniqueExactMinutes(rows)) {
    const atMs = exactMs(row);
    const isSleep = row.sleepState?.trim().toUpperCase() === 'SLEEP';
    if (isSleep) {
      if (lastAt && atMs - lastAt > 0 && atMs - lastAt <= GAP_MS) {
        runMinutes++;
      } else {
        push(); // A gap cannot extend an earlier sleep segment.
        runMinutes = 1;
      }
      lastAt = atMs;
    } else {
      push();
      runMinutes = 0;
      lastAt = 0;
    }
  }
  push();
  return nights.sort((a, b) => a.atMs - b.atMs);
};

export const getObservedSleep = (rows: HistoricalReading[], start: Date, end: Date) =>
  getObservedSleepSegments(rows, start, end).slice(-1)[0] || null;

/** Largest observed sleep segment ending each local day, NOT full clinical sleep. */
export const sleepNightPoints = (rows: HistoricalReading[], start: Date, end: Date): HistoryPoint[] => {
  const byDay = new Map<number, number>();
  for (const episode of getObservedSleepSegments(rows, start, end)) {
    const ended = new Date(episode.atMs);
    const atMs = +new Date(ended.getFullYear(), ended.getMonth(), ended.getDate());
    byDay.set(atMs, Math.max(byDay.get(atMs) || 0, episode.value));
  }
  return [...byDay.entries()].map(([atMs, value]) => ({ atMs, value })).sort((a, b) => a.atMs - b.atMs);
};

export const displayDuration = (minutes: number): string =>
  `${Math.floor(minutes / 60)}h ${String(Math.floor(minutes % 60)).padStart(2, '0')}m`;

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Dimensions, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Circle, Line, Path, Text as SvgText } from 'react-native-svg';
import { getMinuteSummariesForRange } from '../../firebase/dataLogger';
import { memorySyncService } from '../../functionality/MemorySyncService';
import {
  buildMetricTrend, displayDuration, getActivitySummary, getObservedSleep,
  periodBounds, shiftSelectedPeriod, sleepNightPoints, uniqueExactMinutes,
  type HistoricalReading, type HistoryPeriod, type HistoryPoint, type MetricName,
} from '../../functionality/historyAggregation';

const SCREEN_WIDTH = Dimensions.get('window').width;
const NAVY = '#1B4965';
const muted = '#64748b';
const dayMs = 24 * 3600_000;
const metrics: Array<{ key: MetricName; title: string; unit: string; color: string; icon: string; min: number; max: number; decimals: number }> = [
  { key: 'heartRate', title: 'Heart Rate', unit: 'bpm', color: '#DC2626', icon: 'heart', min: 30, max: 220, decimals: 0 },
  { key: 'hrvRmssdMs', title: 'Heart Rate Variability', unit: 'ms', color: '#7c3aed', icon: 'pulse', min: 0, max: 200, decimals: 0 },
  { key: 'temperatureC', title: 'Skin Temperature', unit: '°C', color: '#f97316', icon: 'thermometer', min: 33, max: 44, decimals: 1 },
  { key: 'edaMuScl', title: 'EDA', unit: 'µS', color: '#18A999', icon: 'water', min: 0, max: 5, decimals: 2 },
];

const localDate = (date: Date) => date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const rangeLabel = (period: HistoryPeriod, selected: Date): string => {
  const { start, end } = periodBounds(period, selected);
  if (period === 'day') return selected.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  if (period === 'month') return selected.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  return `${localDate(start)} – ${localDate(new Date(end.getTime() - 1))}`;
};

/** SVG skips missing periods; it does not pretend a disconnected sensor recorded continuously. */
function TrendGraph({ points, start, end, period, color, minimum, maximum }:
  { points: HistoryPoint[]; start: Date; end: Date; period: HistoryPeriod; color: string; minimum: number; maximum: number }) {
  const width = SCREEN_WIDTH - 62;
  const height = 145;
  const left = 36, right = 9, top = 8, bottom = 29;
  const plotW = width - left - right, plotH = height - top - bottom;
  const values = points.map(p => p.value);
  const min = Math.min(minimum, ...(values.length ? values : [minimum]));
  const max = Math.max(maximum, ...(values.length ? values : [maximum]));
  const span = Math.max(1, max - min);
  const x = (ms: number) => left + (ms - +start) / (+end - +start) * plotW;
  const y = (value: number) => top + plotH - (value - min) / span * plotH;
  const segments: HistoryPoint[][] = [];
  let current: HistoryPoint[] = [];
  const sorted = [...points].sort((a, b) => a.atMs - b.atMs);
  const gapLimit = period === 'day' ? 90_000 : 36 * 3600_000;
  for (const p of sorted) {
    if (current.length && p.atMs - current[current.length - 1].atMs > gapLimit) {
      segments.push(current);
      current = [];
    }
    current.push(p);
  }
  if (current.length) segments.push(current);

  const ticks = [0, 1, 2, 3, 4];
  const labelFor = (fraction: number) => {
    const when = new Date(+start + (+end - +start) * fraction);
    if (period === 'day') return `${String(when.getHours()).padStart(2, '0')}:00`;
    return when.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });
  };
  return (
    <View style={styles.graphBox}>
      <Svg width={width} height={height} accessible accessibilityLabel="Recorded readings chart with gaps where data is unavailable">
        {ticks.map(i => (
          <React.Fragment key={i}>
            <Line x1={left} x2={left + plotW} y1={top + plotH * i / 4} y2={top + plotH * i / 4}
              stroke="#dbe5ef" strokeDasharray="4 4" />
            <SvgTextLabel key={`y${i}`} x={0} y={top + plotH * i / 4 + 3} value={(max - span * i / 4).toFixed(max - min < 10 ? 1 : 0)} />
            <SvgTextLabel key={`x${i}`} x={left + plotW * i / 4 - (i === 4 ? 23 : 10)} y={height - 8} value={labelFor(i / 4)} />
          </React.Fragment>
        ))}
        {segments.map((segment, index) => segment.length === 1 ? (
          <Circle key={index} cx={x(segment[0].atMs)} cy={y(segment[0].value)} r={2.4} fill={color}/>
        ) : (
          <Path key={index}
            d={segment.map((p, i) => `${i ? 'L' : 'M'}${x(p.atMs).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')}
            fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"/>
        ))}
      </Svg>
      <Text style={styles.chartHint}>{period === 'day' ? 'Recorded 1-minute points' : 'Daily averages'} · Gaps = no valid data</Text>
    </View>
  );
}

// react-native-svg Text is intentionally aliased to avoid collision with react-native Text.
function SvgTextLabel({ x, y, value }: { x: number; y: number; value: string }) {
  return <SvgText x={x} y={y} fontSize={9} fill={muted}>{value}</SvgText>;
}

export default function PhysioHistoryView({ userId }: { userId?: string }) {
  const [period, setPeriod] = useState<HistoryPeriod>('day');
  const [selected, setSelected] = useState(() => new Date());
  const [rows, setRows] = useState<HistoricalReading[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const { start, end } = useMemo(() => periodBounds(period, selected), [period, selected]);

  useEffect(() => {
    let previousPhase = memorySyncService.getState().phase;
    return memorySyncService.subscribe(state => {
      if (state.phase === 'complete' && previousPhase !== 'complete') setRefreshVersion(v => v + 1);
      previousPhase = state.phase;
    });
  }, []);

  const refresh = useCallback(() => setRefreshVersion(v => v + 1), []);
  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      setRows([]);
      setLoading(false);
      return () => { cancelled = true; };
    }
    setLoading(true);
    setError('');
    // Bring in up to twelve hours before the selected period to recognize sleep
    // crossing midnight, but never assign missing minutes to that episode.
    void getMinuteSummariesForRange(userId, new Date(+start - dayMs / 2), new Date(+end - 1))
      .then(results => { if (!cancelled) setRows(results); })
      .catch(() => { if (!cancelled) { setRows([]); setError('Could not load synced history. Check your connection and try again.'); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [userId, start.getTime(), end.getTime(), refreshVersion]);

  const unique = useMemo(() => uniqueExactMinutes(rows), [rows]);
  const sleep = useMemo(() => getObservedSleep(unique, start, end), [unique, +start, +end]);
  const activity = useMemo(() => getActivitySummary(unique, start, end), [unique, +start, +end]);
  const sleepTrend = useMemo(() => sleepNightPoints(unique, start, end), [unique, +start, +end]);
  const availableMinuteCount = unique.filter(r => {
    const n = r.timestamp?.toMillis?.() || 0;
    return n >= +start && n < +end;
  }).length;

  return (
    <View style={styles.wrapper}>
      <View style={styles.periodPicker}>
        {(['day', 'week', 'month'] as HistoryPeriod[]).map(item => (
          <TouchableOpacity key={item} style={[styles.periodButton, item === period && styles.periodActive]}
            onPress={() => setPeriod(item)} accessibilityRole="button">
            <Text style={[styles.periodText, item === period && styles.periodActiveText]}>{item[0].toUpperCase() + item.slice(1)}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={styles.rangeRow}>
        <TouchableOpacity style={styles.arrow} onPress={() => setSelected(d => shiftSelectedPeriod(period, d, -1))}>
          <Ionicons name="chevron-back" size={20} color={NAVY}/>
        </TouchableOpacity>
        <Text style={styles.rangeText}>{rangeLabel(period, selected)}</Text>
        <TouchableOpacity style={styles.arrow}
          onPress={() => setSelected(d => shiftSelectedPeriod(period, d, 1))}
          disabled={+periodBounds(period, shiftSelectedPeriod(period, selected, 1)).start > Date.now()}>
          <Ionicons name="chevron-forward" size={20} color={NAVY}/>
        </TouchableOpacity>
        <TouchableOpacity style={styles.arrow} onPress={refresh} accessibilityLabel="Refresh history">
          <Ionicons name="refresh" size={19} color={NAVY}/>
        </TouchableOpacity>
      </View>
      <Text style={styles.source}>From real, timestamped Algorithm V0 minute results · {availableMinuteCount} available minute(s)</Text>
      {!userId ? <Text style={styles.warning}>Sign in to see your saved history.</Text> : null}
      {loading ? <ActivityIndicator style={{ marginVertical: 28 }} size="large" color={NAVY}/> : null}
      {error ? <Text style={styles.warning}>{error}</Text> : null}
      {!loading && !error && userId && availableMinuteCount === 0 ? (
        <Text style={styles.warning}>No timestamped results for this period. Connect your wristband and use Settings → Wristband Data & Memory → Sync Memory.</Text>
      ) : null}
      {!loading && userId && !error ? <>
        {metrics.map(metric => {
          const data = buildMetricTrend(unique, metric.key, period, start, end);
          return (
            <View key={metric.key} style={[styles.metricCard, { borderLeftColor: metric.color }]}>
              <View style={styles.metricHeader}>
                <Ionicons name={metric.icon as any} color={metric.color} size={23}/>
                <Text style={styles.metricTitle}>{metric.title}</Text>
                <Text style={[styles.metricValue, { color: metric.color }]}>
                  {data.displayMean === null ? '—' : data.displayMean.toFixed(metric.decimals)}
                  <Text style={styles.metricUnit}> {metric.unit}</Text>
                </Text>
              </View>
              <Text style={styles.smallText}>{data.displayMean === null ? 'No valid readings' : period === 'day' ? 'Recorded minute average' : 'Mean of available daily averages'} · {data.validMinutes} valid minute(s)</Text>
              {data.points.length ? <TrendGraph points={data.points} start={start} end={end}
                period={period} color={metric.color} minimum={metric.min} maximum={metric.max}/> : null}
            </View>
          );
        })}
        <View style={[styles.metricCard, { borderLeftColor: '#2563eb' }]}>
          <View style={styles.metricHeader}>
            <Ionicons name="moon" size={23} color="#2563eb"/>
            <Text style={styles.metricTitle}>Sleep</Text>
            <Text style={[styles.metricValue, { color: '#2563eb' }]}>{sleep ? displayDuration(sleep.value) : '—'}</Text>
          </View>
          <Text style={styles.smallText}>{sleep ? 'Latest observed consecutive sleep segment in this period' : 'No continuous sleep segment recorded'}.</Text>
          {period !== 'day' && sleepTrend.length ? (
            <View style={{ marginTop: 10 }}>
              {sleepTrend.map(point => (
                <View key={point.atMs} style={styles.activityRow}>
                  <Text style={styles.activityLabel}>{localDate(new Date(point.atMs))}</Text>
                  <View style={{ flex: 1, marginHorizontal: 12, height: 7, backgroundColor: '#dbeafe', borderRadius: 4 }}>
                    <View style={{ width: `${Math.min(100, point.value / 600 * 100)}%`, height: 7, backgroundColor: '#2563eb', borderRadius: 4 }}/>
                  </View>
                  <Text style={styles.activityMinutes}>{displayDuration(point.value)}</Text>
                </View>
              ))}
            </View>
          ) : null}
          <Text style={styles.chartHint}>Observed SLEEP-classified minute coverage only. Missing minutes and REM/Light/Deep stages are never invented.</Text>
        </View>
        <View style={[styles.metricCard, { borderLeftColor: '#18A999' }]}>
          <View style={styles.metricHeader}>
            <Ionicons name="fitness" color="#18A999" size={23}/>
            <Text style={styles.metricTitle}>Activity</Text>
          </View>
          {activity.length ? activity.map(([state, minutes]) => (
            <View style={styles.activityRow} key={state}>
              <Text style={styles.activityLabel}>{state}</Text>
              <Text style={styles.activityMinutes}>{minutes} recorded min</Text>
            </View>
          )) : <Text style={styles.smallText}>No recorded activity classifications in this period.</Text>}
        </View>
      </> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { paddingHorizontal: 16, paddingTop: 2, paddingBottom: 24 },
  periodPicker: { flexDirection: 'row', backgroundColor: '#eef3f8', borderRadius: 11, padding: 4 },
  periodButton: { flex: 1, paddingVertical: 12, borderRadius: 9, alignItems: 'center' },
  periodActive: { backgroundColor: NAVY },
  periodText: { fontSize: 14, color: NAVY, fontWeight: '600' },
  periodActiveText: { color: 'white' },
  rangeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 13 },
  arrow: { padding: 5 },
  rangeText: { flex: 1, textAlign: 'center', color: NAVY, fontSize: 13, fontWeight: '700' },
  source: { fontSize: 11, color: muted, marginBottom: 14, lineHeight: 16 },
  warning: { padding: 13, borderRadius: 10, backgroundColor: '#fff7ed', color: '#92400e', marginBottom: 12, lineHeight: 20 },
  metricCard: { marginBottom: 14, padding: 13, backgroundColor: 'white', borderWidth: 1, borderLeftWidth: 4,
    borderColor: '#e2e8f0', borderRadius: 15, elevation: 2 },
  metricHeader: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 7 },
  metricTitle: { flex: 1, fontSize: 14, color: '#1e293b', fontWeight: '800' },
  metricValue: { fontSize: 20, fontWeight: '800' },
  metricUnit: { fontSize: 11, color: muted, fontWeight: '500' },
  smallText: { marginBottom: 8, fontSize: 11, color: muted, lineHeight: 17 },
  graphBox: { alignSelf: 'center', paddingTop: 5 },
  chartHint: { color: muted, fontSize: 10, textAlign: 'center', marginTop: 5, lineHeight: 16 },
  activityRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6, borderBottomColor: '#e2e8f0', borderBottomWidth: 1 },
  activityLabel: { color: '#334155', fontSize: 12, fontWeight: '700' },
  activityMinutes: { color: muted, fontSize: 12 },
});

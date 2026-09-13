/**
 * PPGWaveformCard.tsx
 *
 * Mobile renderer for the compact firmware C stream. The waveform calculation
 * intentionally mirrors tools/ppg_web_gui_hrv_stage.html:
 *   10-second timestamp window -> centred 5-sample moving average ->
 *   5th/95th percentile normalisation -> +/-120 clamp -> timestamp plotting.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import {
  Animated,
  Easing,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import Svg, { Circle, Line, Path, Rect, Text as SvgText } from 'react-native-svg';

const CHART_H = 190;
const PAD = { left: 42, right: 12, top: 16, bottom: 28 };
const PPG_GAP_MS = 500;
const DEFAULT_WINDOW_SECONDS = 10;
const PLOT_BLEED = 5;
const MIN_VISUAL_BUFFER_MS = 96;
const MAX_VISUAL_BUFFER_MS = 160;

export interface PPGWaveformCardProps {
  /** Compact C.clean values. filtSamples is retained as a compatibility alias. */
  cleanSamples?: number[];
  filtSamples?: number[];
  timestamps: number[];
  peakFlags: boolean[];
  qualityFlags: boolean[];
  artifactFlags: boolean[];
  contactFlags: boolean[];
  hrBpm: number;
  confidence: 'high' | 'low' | 'invalid';
  sqi: number;
  artifact: boolean;
  qualityOk: boolean;
  wearDetected: boolean;
  ibi_ms: number;
  fsHz: number;
  acdc: number;
  hrQuality: number;
  rmssdMs: number;
  prvReady: boolean;
  ibiCv: number;
  windowSeconds?: number;
}

type DisplayPoint = {
  t: number;
  y: number;
  peak: boolean;
  qok: boolean;
  artifact: boolean;
  contact: boolean;
  good: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function percentile(values: number[], p: number): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return Number.NaN;
  const index = clamp(Math.round(p * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[index];
}

/** Exact centred moving-average behaviour used by the HTML GUI. */
function movingAverage(values: number[], width: number): number[] {
  if (width <= 1) return values.slice();
  const radius = Math.floor(width / 2);
  return values.map((value, index) => {
    if (!Number.isFinite(value)) return Number.NaN;
    let sum = 0;
    let count = 0;
    for (
      let j = Math.max(0, index - radius);
      j < Math.min(values.length, index + radius + 1);
      j += 1
    ) {
      if (Number.isFinite(values[j])) {
        sum += values[j];
        count += 1;
      }
    }
    return count ? sum / count : Number.NaN;
  });
}

/** Exact default normalisation used by the HTML GUI. */
function normaliseLikeDesktop(values: number[]): number[] {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 8) return values.slice();
  const low = percentile(finite, 0.05);
  const high = percentile(finite, 0.95);
  const midpoint = (low + high) / 2;
  const halfRange = Math.max(1e-6, (high - low) / 2);
  return values.map(value =>
    Number.isFinite(value)
      ? clamp(((value - midpoint) / halfRange) * 80, -120, 120)
      : Number.NaN,
  );
}

function alignTail<T>(values: T[], count: number, fallback: T): T[] {
  if (count <= 0) return [];
  if (values.length >= count) return values.slice(-count);
  return [...Array<T>(count - values.length).fill(fallback), ...values];
}

/**
 * Estimate the compact-stream display cadence from real firmware timestamps.
 * This value is used only to animate the viewport between received samples.
 * It never creates sensor samples and is never used by HR/HRV/SQI/Firebase logic.
 */
function estimateCadenceMs(timestamps: number[], fallbackFs: number): number {
  const deltas: number[] = [];
  const start = Math.max(1, timestamps.length - 48);

  for (let index = start; index < timestamps.length; index += 1) {
    const delta = timestamps[index] - timestamps[index - 1];
    // Ignore duplicates, out-of-order frames, and genuine BLE gaps.
    if (Number.isFinite(delta) && delta >= 8 && delta <= 160) {
      deltas.push(delta);
    }
  }

  if (!deltas.length) {
    const fallback = fallbackFs > 0 ? 1000 / fallbackFs : 40;
    return clamp(fallback, 16, 100);
  }

  deltas.sort((a, b) => a - b);
  return clamp(deltas[Math.floor(deltas.length / 2)], 16, 100);
}

function buildSegmentedPath(
  points: DisplayPoint[],
  xFor: (t: number) => number,
  yFor: (y: number) => number,
): string {
  let path = '';
  let started = false;
  let previousTime: number | null = null;

  points.forEach(point => {
    if (!Number.isFinite(point.y)) {
      started = false;
      previousTime = null;
      return;
    }
    const x = xFor(point.t);
    const y = yFor(point.y);
    if (!started || (previousTime !== null && point.t - previousTime > PPG_GAP_MS)) {
      path += ` M ${x.toFixed(1)} ${y.toFixed(1)}`;
      started = true;
    } else {
      path += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    previousTime = point.t;
  });

  return path.trim();
}

const PPGWaveformCardImpl: React.FC<PPGWaveformCardProps> = props => {
  const {
    timestamps,
    peakFlags,
    qualityFlags,
    artifactFlags,
    contactFlags,
    hrBpm,
    confidence,
    sqi,
    artifact,
    qualityOk,
    wearDetected,
    ibi_ms,
    fsHz,
    acdc,
    hrQuality,
    rmssdMs,
    prvReady,
    ibiCv,
    windowSeconds = DEFAULT_WINDOW_SECONDS,
  } = props;

  const sourceSamples = props.cleanSamples ?? props.filtSamples ?? [];
  const { width: screenWidth } = useWindowDimensions();
  const cardWidth = Math.max(300, screenWidth - 32);
  const chartWidth = cardWidth - 32; // card content width after 16 px padding on each side
  const plotWidth = chartWidth - PAD.left - PAD.right;
  const plotHeight = CHART_H - PAD.top - PAD.bottom;

  /*
   * Visual-only 60 FPS scrolling:
   * - the SVG path still contains the exact firmware samples;
   * - React rebuilds the path only when a real sample batch arrives;
   * - a native-driver translateX animation moves that exact path smoothly
   *   between arrivals;
   * - a tiny display-only jitter buffer absorbs BLE packet batching.
   */
  const smoothScrollX = useRef(new Animated.Value(0)).current;
  const scrollAnimationRef = useRef<Animated.CompositeAnimation | null>(null);
  const previousViewportRef = useRef<{
    start: number;
    end: number;
    dataEnd: number;
    plotWidth: number;
  } | null>(null);

  const pulse = useRef(new Animated.Value(1)).current;
  const lastIbi = useRef(0);
  useEffect(() => {
    if (ibi_ms > 0 && ibi_ms !== lastIbi.current) {
      lastIbi.current = ibi_ms;
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.3, duration: 110, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 190, useNativeDriver: true }),
      ]).start();
    }
  }, [ibi_ms, pulse]);

  const display = useMemo(() => {
    const count = Math.min(sourceSamples.length, timestamps.length || sourceSamples.length);
    if (count <= 0) return { points: [] as DisplayPoint[], start: 0, end: 1, cadenceMs: 40 };

    const samples = sourceSamples.slice(-count);
    const effectiveFs = Number.isFinite(fsHz) && fsHz > 0 ? fsHz : 25;
    const fallbackEnd = Date.now();
    const ts = timestamps.length
      ? timestamps.slice(-count)
      : samples.map((_, index) => fallbackEnd - ((count - 1 - index) * 1000) / effectiveFs);
    const peaks = alignTail(peakFlags, count, false);
    const qok = alignTail(qualityFlags, count, qualityOk);
    const arts = alignTail(artifactFlags, count, artifact);
    const contacts = alignTail(contactFlags, count, !wearDetected);

    const end = ts[ts.length - 1];
    const cutoff = end - windowSeconds * 1000;
    let first = ts.findIndex(value => value >= cutoff);
    if (first < 0) first = 0;

    const windowSamples = samples.slice(first);
    const smoothed = movingAverage(windowSamples, 5);
    const normalised = normaliseLikeDesktop(smoothed);
    const windowTs = ts.slice(first);

    const points = normalised.map((y, index) => ({
      t: windowTs[index],
      y,
      peak: peaks[first + index] ?? false,
      qok: Boolean(qok[first + index]),
      artifact: Boolean(arts[first + index]),
      contact: Boolean(contacts[first + index]),
      good: Boolean(qok[first + index]) && !arts[first + index] && !contacts[first + index],
    }));

    return {
      points,
      // Keep the viewport span exactly fixed. Using the first available sample
      // as the left edge makes every BLE batch slightly rescale the whole path.
      start: end - windowSeconds * 1000,
      end,
      cadenceMs: estimateCadenceMs(windowTs, effectiveFs),
    };
  }, [
    sourceSamples,
    timestamps,
    peakFlags,
    qualityFlags,
    artifactFlags,
    contactFlags,
    fsHz,
    qualityOk,
    artifact,
    wearDetected,
    windowSeconds,
  ]);

  const windowMs = Math.max(1, windowSeconds * 1000);
  const visualBufferMs = clamp(
    display.cadenceMs * 3,
    MIN_VISUAL_BUFFER_MS,
    MAX_VISUAL_BUFFER_MS,
  );
  const viewportEnd = display.end + visualBufferMs;
  const viewportStart = viewportEnd - windowMs;

  const plotXFor = (t: number) =>
    PLOT_BLEED + ((t - viewportStart) / windowMs) * plotWidth;
  const plotYFor = (value: number) =>
    PLOT_BLEED + (1 - (value + 120) / 240) * plotHeight;

  const waveformPath = useMemo(
    () => buildSegmentedPath(display.points, plotXFor, plotYFor),
    [display.points, viewportStart, windowMs, plotWidth, plotHeight],
  );

  const badRegions = useMemo(() =>
    display.points.flatMap((point, index) => {
      if (point.good) return [];
      const x0 = plotXFor(point.t);
      const next = display.points[index + 1];
      const x1 = next ? plotXFor(next.t) : x0 + 2;
      return [{ x: x0, width: Math.max(1, x1 - x0) }];
    }), [display.points, viewportStart, windowMs, plotWidth]);

  const acceptedPeaks = useMemo(
    () => display.points.filter(point => point.peak && point.good && Number.isFinite(point.y)),
    [display.points],
  );
  const goodCount = useMemo(
    () => display.points.filter(point => point.good).length,
    [display.points],
  );
  const qokPercent = display.points.length ? (100 * goodCount) / display.points.length : 0;
  const artifactCount = useMemo(
    () => display.points.filter(point => point.artifact).length,
    [display.points],
  );
  const artifactPercent = display.points.length ? (100 * artifactCount) / display.points.length : 0;

  useEffect(() => {
    const nextViewport = {
      start: viewportStart,
      end: viewportEnd,
      dataEnd: display.end,
      plotWidth,
    };
    const previous = previousViewportRef.current;
    previousViewportRef.current = nextViewport;

    const viewportUnchanged =
      previous &&
      previous.start === nextViewport.start &&
      previous.end === nextViewport.end &&
      previous.plotWidth === plotWidth;

    // Metric-only renders and duplicate timestamps must not restart scrolling.
    if (viewportUnchanged) return undefined;

    scrollAnimationRef.current?.stop();

    if (display.points.length < 3 || !Number.isFinite(display.end)) {
      smoothScrollX.stopAnimation(() => {
        smoothScrollX.setValue(0);
      });
      return undefined;
    }

    const pixelsPerMs = plotWidth / windowMs;
    const coastDurationMs = clamp(
      visualBufferMs + display.cadenceMs * 2,
      140,
      240,
    );

    /*
     * Read the native animation value only when a real data batch arrives.
     * The previous version attached addListener(), which sent a callback from
     * the native animation to JavaScript on every frame and could itself cause
     * dropped frames on Android.
     */
    smoothScrollX.stopAnimation(currentAnimatedValue => {
      let continuityOffset = Number.isFinite(currentAnimatedValue)
        ? currentAnimatedValue
        : 0;

      if (
        previous &&
        display.end > previous.dataEnd &&
        previous.plotWidth > 0
      ) {
        const previousSpan = Math.max(1, previous.end - previous.start);
        const commonTimestamp = previous.dataEnd;
        const previousX =
          ((commonTimestamp - previous.start) / previousSpan) *
          previous.plotWidth;
        const nextX =
          ((commonTimestamp - nextViewport.start) / windowMs) *
          plotWidth;

        // Preserve the exact screen position of the last already-rendered
        // firmware sample when the new SVG path replaces the previous one.
        continuityOffset += previousX - nextX;
      }

      const maxCorrection = Math.max(4, plotWidth * 0.08);
      continuityOffset = clamp(
        continuityOffset,
        -maxCorrection,
        maxCorrection,
      );

      smoothScrollX.setValue(continuityOffset);

      const animation = Animated.timing(smoothScrollX, {
        toValue: continuityOffset - pixelsPerMs * coastDurationMs,
        duration: coastDurationMs,
        easing: Easing.linear,
        useNativeDriver: true,
      });

      scrollAnimationRef.current = animation;
      animation.start(({ finished }) => {
        if (finished && scrollAnimationRef.current === animation) {
          scrollAnimationRef.current = null;
        }
      });
    });

    return () => {
      scrollAnimationRef.current?.stop();
    };
  }, [
    display.cadenceMs,
    display.end,
    display.points.length,
    plotWidth,
    smoothScrollX,
    viewportEnd,
    viewportStart,
    visualBufferMs,
    windowMs,
  ]);

  const hasData = display.points.length > 2;
  const hrValid = hrBpm > 0 && confidence !== 'invalid';
  const qualityColour = !wearDetected ? '#64748b' : artifact ? '#ef4444' : qualityOk ? '#10b981' : '#f59e0b';
  const qualityLabel = !wearDetected ? 'Contact unstable' : artifact ? 'Artifact' : qualityOk ? 'Quality OK' : 'Quality low';
  const hrColour = confidence === 'high' ? '#10b981' : confidence === 'low' ? '#f59e0b' : '#94a3b8';

  return (
    <View style={[styles.card, { width: cardWidth }]}>
      <View style={styles.headerRow}>
        <View style={styles.headerTextBlock}>
          <Text style={styles.title}>PPG + accepted peaks</Text>
          <Text style={styles.subtitle}>Compact C.clean · same 10 s processing as PC GUI</Text>
        </View>
        <View style={[styles.badge, { borderColor: qualityColour, backgroundColor: `${qualityColour}18` }]}>
          <View style={[styles.badgeDot, { backgroundColor: qualityColour }]} />
          <Text style={[styles.badgeText, { color: qualityColour }]}>{qualityLabel}</Text>
        </View>
      </View>

      <View style={styles.kpiRow}>
        <View style={styles.hrKpi}>
          <Animated.Text style={[styles.heart, { transform: [{ scale: pulse }] }]}>♥</Animated.Text>
          <Text style={[styles.hrValue, { color: hrColour }]}>{hrValid ? hrBpm.toFixed(1) : '--'}</Text>
          <Text style={styles.hrUnit}>BPM</Text>
        </View>
        <View style={styles.kpi}><Text style={styles.kpiLabel}>HRQ</Text><Text style={styles.kpiValue}>{hrQuality}</Text></View>
        <View style={styles.kpi}><Text style={styles.kpiLabel}>IBI</Text><Text style={styles.kpiValue}>{ibi_ms > 0 ? `${ibi_ms}` : '--'} ms</Text></View>
        <View style={styles.kpi}><Text style={styles.kpiLabel}>RMSSD</Text><Text style={styles.kpiValue}>{rmssdMs >= 0 ? rmssdMs.toFixed(1) : '--'} ms</Text></View>
      </View>

      <View style={styles.chartWrap}>
        {/* Static chart chrome does not redraw during the 60 FPS scroll. */}
        <Svg width={chartWidth} height={CHART_H}>
          <Rect x={0} y={0} width={chartWidth} height={CHART_H} fill="#ffffff" rx={10} />
          {[0, 1, 2, 3, 4].map(index => {
            const y = PAD.top + (plotHeight * index) / 4;
            return <Line key={`h-${index}`} x1={PAD.left} y1={y} x2={chartWidth - PAD.right} y2={y} stroke="#e2e8f0" strokeWidth={1} />;
          })}
          {[0, 1, 2, 3, 4].map(index => {
            const x = PAD.left + (plotWidth * index) / 4;
            return <Line key={`v-${index}`} x1={x} y1={PAD.top} x2={x} y2={CHART_H - PAD.bottom} stroke="#f1f5f9" strokeWidth={1} />;
          })}
          <SvgText x={4} y={PAD.top + 5} fontSize={9} fill="#64748b">120</SvgText>
          <SvgText x={8} y={PAD.top + plotHeight / 2 + 3} fontSize={9} fill="#64748b">0</SvgText>
          <SvgText x={1} y={CHART_H - PAD.bottom + 3} fontSize={9} fill="#64748b">-120</SvgText>
          <SvgText x={PAD.left} y={CHART_H - 8} fontSize={9} fill="#64748b">-{windowSeconds}s</SvgText>
          <SvgText x={chartWidth - PAD.right - 18} y={CHART_H - 8} fontSize={9} fill="#64748b">now</SvgText>
        </Svg>

        {/* Only this exact-data plot layer moves; calculations remain untouched. */}
        <View
          pointerEvents="none"
          style={[
            styles.plotClip,
            {
              left: PAD.left - PLOT_BLEED,
              top: PAD.top - PLOT_BLEED,
              width: plotWidth + PLOT_BLEED * 2,
              height: plotHeight + PLOT_BLEED * 2,
            },
          ]}
        >
          <Animated.View
            renderToHardwareTextureAndroid
            shouldRasterizeIOS
            style={[
              styles.animatedPlot,
              {
                width: plotWidth + PLOT_BLEED * 2,
                height: plotHeight + PLOT_BLEED * 2,
                transform: [{ translateX: smoothScrollX }],
              },
            ]}
          >
            <Svg
              width={plotWidth + PLOT_BLEED * 2}
              height={plotHeight + PLOT_BLEED * 2}
            >
              {badRegions.map((region, index) => (
                <Rect
                  key={`bad-${index}`}
                  x={region.x}
                  y={PLOT_BLEED}
                  width={region.width}
                  height={plotHeight}
                  fill="rgba(239,68,68,0.05)"
                />
              ))}

              {waveformPath ? (
                <Path
                  d={waveformPath}
                  stroke="#0284c7"
                  strokeWidth={2.3}
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ) : null}

              {acceptedPeaks.map((point, index) => (
                <Circle
                  key={`peak-${index}`}
                  cx={plotXFor(point.t)}
                  cy={plotYFor(point.y)}
                  r={4.2}
                  fill="#f97316"
                />
              ))}
            </Svg>
          </Animated.View>
        </View>

        {!hasData ? <View style={styles.emptyOverlay}><Text style={styles.emptyText}>Waiting for compact C PPG stream…</Text></View> : null}
      </View>

      <Text style={styles.legend}>blue: clean PPG   orange: accepted peak   faint red: low-quality/artifact/contact region</Text>

      <View style={styles.metricsGrid}>
        <Metric label="QOK shown" value={hasData ? `${qokPercent.toFixed(0)}%` : '--'} />
        <Metric label="Artifact" value={hasData ? `${artifactPercent.toFixed(0)}%` : '--'} />
        <Metric label="Peaks" value={`${acceptedPeaks.length}`} />
        <Metric label="SQI" value={Number.isFinite(sqi) && sqi >= 0 ? sqi.toFixed(3) : '--'} />
        <Metric label="AC/DC" value={Number.isFinite(acdc) && acdc >= 0 ? acdc.toFixed(5) : '--'} />
        <Metric label="FS" value={Number.isFinite(fsHz) && fsHz > 0 ? `${fsHz.toFixed(1)} Hz` : '--'} />
        <Metric label="PRV ready" value={prvReady ? '1' : '0'} />
        <Metric label="IBI CV" value={Number.isFinite(ibiCv) && ibiCv >= 0 ? ibiCv.toFixed(3) : '--'} />
      </View>
    </View>
  );
};

const Metric: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <View style={styles.metric}>
    <Text style={styles.metricLabel}>{label}</Text>
    <Text style={styles.metricValue}>{value}</Text>
  </View>
);

const styles = StyleSheet.create({
  card: {
    alignSelf: 'center',
    backgroundColor: '#ffffff',
    borderColor: '#e2e8f0',
    borderRadius: 18,
    borderWidth: 1,
    elevation: 4,
    marginBottom: 16,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
  },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },
  headerTextBlock: { flex: 1 },
  title: { color: '#0f172a', fontSize: 17, fontWeight: '800' },
  subtitle: { color: '#64748b', fontSize: 10.5, marginTop: 3 },
  badge: { alignItems: 'center', borderRadius: 999, borderWidth: 1, flexDirection: 'row', gap: 5, paddingHorizontal: 8, paddingVertical: 5 },
  badgeDot: { borderRadius: 4, height: 7, width: 7 },
  badgeText: { fontSize: 10, fontWeight: '800' },
  kpiRow: { alignItems: 'center', flexDirection: 'row', gap: 9, marginBottom: 10, marginTop: 12 },
  hrKpi: { alignItems: 'baseline', flexDirection: 'row', minWidth: 120 },
  heart: { color: '#ef4444', fontSize: 25, marginRight: 5 },
  hrValue: { fontSize: 28, fontWeight: '900' },
  hrUnit: { color: '#64748b', fontSize: 9, fontWeight: '700', marginLeft: 3 },
  kpi: { alignItems: 'center', flex: 1 },
  kpiLabel: { color: '#94a3b8', fontSize: 8, fontWeight: '800', textTransform: 'uppercase' },
  kpiValue: { color: '#1e293b', fontSize: 11, fontWeight: '800', marginTop: 2 },
  chartWrap: { borderColor: '#e2e8f0', borderRadius: 10, borderWidth: 1, overflow: 'hidden', position: 'relative' },
  plotClip: { overflow: 'hidden', position: 'absolute' },
  animatedPlot: { position: 'absolute' },
  emptyOverlay: { alignItems: 'center', bottom: 0, justifyContent: 'center', left: 0, position: 'absolute', right: 0, top: 0 },
  emptyText: { color: '#64748b', fontSize: 12, fontWeight: '600' },
  legend: { color: '#64748b', fontSize: 9.5, marginTop: 7, textAlign: 'center' },
  metricsGrid: { borderTopColor: '#e2e8f0', borderTopWidth: 1, flexDirection: 'row', flexWrap: 'wrap', marginTop: 12, paddingTop: 8 },
  metric: { alignItems: 'center', paddingVertical: 5, width: '25%' },
  metricLabel: { color: '#94a3b8', fontSize: 8, fontWeight: '800', textTransform: 'uppercase' },
  metricValue: { color: '#334155', fontSize: 10.5, fontWeight: '900', marginTop: 2 },
});

/**
 * Avoid rebuilding the SVG when unrelated live values (for example IMU/EDA)
 * update while every PPG prop still has the same value/reference.
 */
export const PPGWaveformCard = React.memo(PPGWaveformCardImpl);
PPGWaveformCard.displayName = 'PPGWaveformCard';

export default PPGWaveformCard;

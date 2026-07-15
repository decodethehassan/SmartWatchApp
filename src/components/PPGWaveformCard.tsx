/**
 * PPGWaveformCard.tsx
 *
 * Premium real-time PPG waveform card powered by react-native-svg.
 *
 * Renders the firmware algo_v0 `filt` signal (baseline-removed, high-pass filtered)
 * that arrives via PPG_STREAM / PV BLE lines, at up to 50 Hz from the wristband.
 *
 * Features:
 *  – Scrolling 8-second window of filtered PPG waveform
 *  – Adaptive threshold line (firmware `th` field)
 *  – Beat peak markers (firmware `peak` flag)
 *  – Animated "heartbeat" pulse on each detected beat
 *  – Signal quality badge (SQI, artifact, qok)
 *  – Wear detection indicator
 */

import React, { useRef, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  Animated,
} from 'react-native';
import Svg, { Path, Circle, Line, Defs, LinearGradient, Stop, Rect } from 'react-native-svg';
import { theme } from '../styles/theme';

// ─── constants ───────────────────────────────────────────────────────────────
const { width: SCREEN_W } = Dimensions.get('window');
const CHART_H         = 160;
const CHART_PADDING_X = 12;
const CHART_PADDING_Y = 20;

// Number of samples to display in the scrolling window (~8 sec at 50 Hz)
const DISPLAY_SAMPLES = 400;

// ─── types ───────────────────────────────────────────────────────────────────
export interface PPGWaveformCardProps {
  /** Rolling filt[] samples from LiveSensorState.ppgStream.filt */
  filtSamples: number[];
  /** Rolling th[] samples from LiveSensorState.ppgStream.th */
  thSamples: number[];
  /** Rolling peaks[] from LiveSensorState.ppgStream.peaks */
  peakFlags: boolean[];
  /** Current HR in BPM from firmware (-1 = invalid) */
  hrBpm: number;
  /** HR confidence level */
  confidence: 'high' | 'low' | 'invalid';
  /** Signal quality index 0.0–1.0 */
  sqi: number;
  /** True if motion artifact detected */
  artifact: boolean;
  /** True if firmware quality gate open */
  qualityOk: boolean;
  /** True if wristband is worn (IR/green > threshold) */
  wearDetected: boolean;
  /** IBI in ms */
  ibi_ms: number;
}

// ─── helper ──────────────────────────────────────────────────────────────────

/** Normalise values to [0..1] within (min, max) */
function normalise(values: number[], min: number, max: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return values.map(() => 0.5);
  }
  const range = max - min;
  if (!Number.isFinite(range) || range === 0) return values.map(() => 0.5);
  return values.map(v => {
    if (!Number.isFinite(v)) return 0.5;
    return Math.max(0, Math.min(1, (v - min) / range));
  });
}

/** Build an SVG polyline path string from normalised [0..1] values */
function buildPath(
  normVals: number[],
  chartW: number,
  chartH: number,
  padX: number,
  padY: number,
): string {
  if (normVals.length < 2) return '';
  const w = chartW - 2 * padX;
  const h = chartH - 2 * padY;
  const step = w / Math.max(normVals.length - 1, 1);

  const points = normVals.map((v, i) => {
    const x = padX + i * step;
    const y = padY + h * (1 - v); // invert Y (top = high)
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  return `M ${points.join(' L ')}`;
}

// ─── component ───────────────────────────────────────────────────────────────

export const PPGWaveformCard: React.FC<PPGWaveformCardProps> = ({
  filtSamples,
  thSamples,
  peakFlags,
  hrBpm,
  confidence,
  sqi,
  artifact,
  qualityOk,
  wearDetected,
  ibi_ms,
}) => {
  const cardWidth = SCREEN_W - 32; // 16px margin each side

  // Animate heartbeat pulse on each beat
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const prevHrRef = useRef(hrBpm);
  const [lastBeatMs, setLastBeatMs] = useState<number>(0);

  // Fire pulse animation whenever a new beat arrives (ibi_ms changes)
  useEffect(() => {
    if (ibi_ms > 0 && ibi_ms !== lastBeatMs) {
      setLastBeatMs(ibi_ms);
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.35, duration: 120, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1.0, duration: 200, useNativeDriver: true }),
      ]).start();
    }
  }, [ibi_ms]);

  // Slice to display window
  const displayFilt  = useMemo(() => filtSamples.slice(-DISPLAY_SAMPLES), [filtSamples]);
  const displayTh    = useMemo(() => thSamples.slice(-DISPLAY_SAMPLES), [thSamples]);
  const displayPeaks = useMemo(() => peakFlags.slice(-DISPLAY_SAMPLES), [peakFlags]);

  // Compute shared Y range so threshold and waveform share the same scale
  const allValues = [...displayFilt, ...displayTh].filter(Number.isFinite);
  const yMin = allValues.length > 0 ? Math.min(...allValues) : -1;
  const yMax = allValues.length > 0 ? Math.max(...allValues) : 1;
  const yPad = Math.abs(yMax - yMin) * 0.12 || 0.5;

  const normFilt = useMemo(
    () => normalise(displayFilt, yMin - yPad, yMax + yPad),
    [displayFilt, yMin, yMax],
  );
  const normTh = useMemo(
    () => normalise(displayTh, yMin - yPad, yMax + yPad),
    [displayTh, yMin, yMax],
  );

  const filtPath = useMemo(
    () => buildPath(normFilt, cardWidth, CHART_H, CHART_PADDING_X, CHART_PADDING_Y),
    [normFilt, cardWidth],
  );
  const thPath = useMemo(
    () => buildPath(normTh, cardWidth, CHART_H, CHART_PADDING_X, CHART_PADDING_Y),
    [normTh, cardWidth],
  );

  // Peak circles
  const peakCircles = useMemo(() => {
    if (displayFilt.length < 2) return [];
    const w = cardWidth - 2 * CHART_PADDING_X;
    const h = CHART_H - 2 * CHART_PADDING_Y;
    const step = w / Math.max(displayFilt.length - 1, 1);
    const circles: { cx: number; cy: number }[] = [];
    displayPeaks.forEach((isPeak, i) => {
      if (isPeak && normFilt[i] !== undefined) {
        circles.push({
          cx: CHART_PADDING_X + i * step,
          cy: CHART_PADDING_Y + h * (1 - normFilt[i]),
        });
      }
    });
    return circles;
  }, [displayPeaks, normFilt, cardWidth]);

  const hasData     = displayFilt.length > 2;
  const hrValid     = hrBpm > 0 && confidence !== 'invalid';
  const sqiPercent  = Math.round(Math.max(0, Math.min(1, Number.isFinite(sqi) ? sqi : 0)) * 100);

  // Quality badge colour
  const qualityColor =
    !wearDetected     ? '#64748b' :
    artifact          ? '#ef4444' :
    qualityOk         ? '#10b981' : '#f59e0b';

  const qualityLabel =
    !wearDetected     ? 'Not worn' :
    artifact          ? 'Artifact' :
    qualityOk         ? 'Quality OK' : 'Settling…';

  const hrColor =
    confidence === 'high'  ? '#10b981' :
    confidence === 'low'   ? '#f59e0b' : '#94a3b8';

  return (
    <View style={[styles.card, { width: cardWidth }]}>
      {/* ── Header row ── */}
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.cardTitle}>PPG Waveform</Text>
          <Text style={styles.cardSubtitle}>Filtered signal · MAX30101 Green</Text>
        </View>
        {/* Quality badge */}
        <View style={[styles.qualityBadge, { backgroundColor: qualityColor + '22', borderColor: qualityColor }]}>
          <View style={[styles.qualityDot, { backgroundColor: qualityColor }]} />
          <Text style={[styles.qualityText, { color: qualityColor }]}>{qualityLabel}</Text>
        </View>
      </View>

      {/* ── Heart Rate + stats row ── */}
      <View style={styles.statsRow}>
        {/* HR with animated pulse */}
        <View style={styles.hrBlock}>
          <Animated.Text style={[styles.hrEmoji, { transform: [{ scale: pulseAnim }] }]}>
            ❤️
          </Animated.Text>
          <View>
            <Text style={[styles.hrValue, { color: hrColor }]}>
              {hrValid ? Math.round(hrBpm) : '--'}
            </Text>
            <Text style={styles.hrUnit}>BPM</Text>
          </View>
          {hrValid && (
            <View style={[styles.confidencePill, { backgroundColor: hrColor + '22' }]}>
              <Text style={[styles.confidenceText, { color: hrColor }]}>
                {confidence === 'high' ? 'HIGH' : 'LOW'}
              </Text>
            </View>
          )}
        </View>

        {/* SQI + IBI mini stats */}
        <View style={styles.miniStats}>
          <View style={styles.miniStatItem}>
            <Text style={styles.miniStatLabel}>SQI</Text>
            <Text style={styles.miniStatValue}>{hasData ? `${sqiPercent}%` : '--'}</Text>
          </View>
          <View style={styles.miniStatItem}>
            <Text style={styles.miniStatLabel}>IBI</Text>
            <Text style={styles.miniStatValue}>{ibi_ms > 0 ? `${ibi_ms}ms` : '--'}</Text>
          </View>
          <View style={styles.miniStatItem}>
            <Text style={styles.miniStatLabel}>Wear</Text>
            <Text style={[styles.miniStatValue, { color: wearDetected ? '#10b981' : '#94a3b8' }]}>
              {wearDetected ? 'Yes' : 'No'}
            </Text>
          </View>
        </View>
      </View>

      {/* ── Waveform Chart ── */}
      <View style={styles.chartContainer}>
        {hasData ? (
          <Svg width={cardWidth} height={CHART_H}>
            <Defs>
              {/* Green fill gradient under waveform */}
              <LinearGradient id="ppgGrad" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor="#10b981" stopOpacity="0.25" />
                <Stop offset="1" stopColor="#10b981" stopOpacity="0.00" />
              </LinearGradient>
              {/* Dark background gradient */}
              <LinearGradient id="bgGrad" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor="#0f172a" stopOpacity="1" />
                <Stop offset="1" stopColor="#1e293b" stopOpacity="1" />
              </LinearGradient>
            </Defs>

            {/* Background */}
            <Rect x={0} y={0} width={cardWidth} height={CHART_H} fill="url(#bgGrad)" rx={12} />

            {/* Threshold dashed line */}
            {thPath.length > 0 && (
              <Path
                d={thPath}
                stroke="#f59e0b"
                strokeWidth={1}
                strokeDasharray="4,4"
                fill="none"
                opacity={0.6}
              />
            )}

            {/* Waveform fill area (closed path) */}
            {filtPath.length > 0 && (
              <Path
                d={filtPath + ` L ${(cardWidth - CHART_PADDING_X).toFixed(1)},${CHART_H} L ${CHART_PADDING_X},${CHART_H} Z`}
                fill="url(#ppgGrad)"
              />
            )}

            {/* Waveform line */}
            {filtPath.length > 0 && (
              <Path
                d={filtPath}
                stroke="#34d399"
                strokeWidth={2}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}

            {/* Beat peak markers */}
            {peakCircles.map((pt, idx) => (
              <Circle
                key={idx}
                cx={pt.cx}
                cy={pt.cy}
                r={5}
                fill="#ef4444"
                stroke="#fff"
                strokeWidth={1.5}
                opacity={0.9}
              />
            ))}

            {/* Zero line (faint) */}
            <Line
              x1={CHART_PADDING_X}
              y1={CHART_H / 2}
              x2={cardWidth - CHART_PADDING_X}
              y2={CHART_H / 2}
              stroke="#ffffff"
              strokeWidth={0.4}
              opacity={0.15}
            />
          </Svg>
        ) : (
          /* Empty state */
          <View style={styles.emptyChart}>
            <Svg width={cardWidth} height={CHART_H}>
              <Defs>
                <LinearGradient id="bgGradEmpty" x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0" stopColor="#0f172a" stopOpacity="1" />
                  <Stop offset="1" stopColor="#1e293b" stopOpacity="1" />
                </LinearGradient>
              </Defs>
              <Rect x={0} y={0} width={cardWidth} height={CHART_H} fill="url(#bgGradEmpty)" rx={12} />
              {/* Dashed placeholder line */}
              <Line
                x1={CHART_PADDING_X}
                y1={CHART_H / 2}
                x2={cardWidth - CHART_PADDING_X}
                y2={CHART_H / 2}
                stroke="#334155"
                strokeWidth={1.5}
                strokeDasharray="6,6"
              />
            </Svg>
            <View style={styles.emptyOverlay}>
              <Text style={styles.emptyText}>
                {wearDetected
                  ? '⏳  Waiting for PPG stream…'
                  : '⌚  Place wristband on wrist'}
              </Text>
            </View>
          </View>
        )}

        {/* Legend */}
        <View style={styles.legend}>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: '#34d399' }]} />
            <Text style={styles.legendLabel}>Filtered PPG</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: '#f59e0b', opacity: 0.7 }]} />
            <Text style={styles.legendLabel}>Threshold</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: '#ef4444' }]} />
            <Text style={styles.legendLabel}>Beat peak</Text>
          </View>
        </View>
      </View>

      {/* ── Detailed Validation Parameters Grid (Firmware-Derived) ── */}
      <View style={styles.paramGrid}>
        <View style={styles.paramCol}>
          <Text style={styles.paramLabel}>QOK (Gate)</Text>
          <Text style={[styles.paramValue, { color: qualityOk ? '#10b981' : '#f59e0b' }]}>
            {qualityOk ? '1 (PASS)' : '0 (FAIL)'}
          </Text>
        </View>
        <View style={styles.paramCol}>
          <Text style={styles.paramLabel}>ARTIFACT</Text>
          <Text style={[styles.paramValue, { color: artifact ? '#ef4444' : '#10b981' }]}>
            {artifact ? '1 (YES)' : '0 (NO)'}
          </Text>
        </View>
        <View style={styles.paramCol}>
          <Text style={styles.paramLabel}>CONTACT</Text>
          <Text style={[styles.paramValue, { color: wearDetected ? '#10b981' : '#94a3b8' }]}>
            {wearDetected ? '1 (WORN)' : '0 (OFF)'}
          </Text>
        </View>
        <View style={styles.paramCol}>
          <Text style={styles.paramLabel}>SQI (Index)</Text>
          <Text style={[styles.paramValue, { color: sqi >= 0.5 ? '#10b981' : '#f59e0b' }]}>
            {hasData ? sqi.toFixed(3) : '--'}
          </Text>
        </View>
        <View style={styles.paramCol}>
          <Text style={styles.paramLabel}>FS (Freq)</Text>
          <Text style={styles.paramValue}>50.0 Hz</Text>
        </View>
      </View>
    </View>
  );
};

// ─── styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 20,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.10,
    shadowRadius: 12,
    elevation: 5,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  cardTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#0f172a',
    letterSpacing: -0.3,
  },
  cardSubtitle: {
    fontSize: 11,
    color: '#64748b',
    marginTop: 2,
  },
  qualityBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
    borderWidth: 1,
    gap: 5,
  },
  qualityDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  qualityText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
    gap: 16,
  },
  hrBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  hrEmoji: {
    fontSize: 28,
  },
  hrValue: {
    fontSize: 36,
    fontWeight: '800',
    letterSpacing: -1,
    lineHeight: 40,
  },
  hrUnit: {
    fontSize: 12,
    color: '#64748b',
    fontWeight: '600',
    letterSpacing: 1,
  },
  confidencePill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    marginLeft: 4,
  },
  confidenceText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  miniStats: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 16,
  },
  miniStatItem: {
    alignItems: 'center',
  },
  miniStatLabel: {
    fontSize: 10,
    color: '#94a3b8',
    fontWeight: '600',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  miniStatValue: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1e293b',
    marginTop: 2,
  },
  chartContainer: {
    borderRadius: 12,
    overflow: 'hidden',
  },
  emptyChart: {
    position: 'relative',
  },
  emptyOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 13,
    color: '#64748b',
    fontWeight: '500',
  },
  legend: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 20,
    marginTop: 8,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendLabel: {
    fontSize: 10,
    color: '#64748b',
    fontWeight: '500',
  },
  paramGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    gap: 8,
  },
  paramCol: {
    flex: 1,
    alignItems: 'center',
  },
  paramLabel: {
    fontSize: 8.5,
    color: '#94a3b8',
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  paramValue: {
    fontSize: 11,
    fontWeight: '800',
    color: '#334155',
    marginTop: 3,
  },
});

export default PPGWaveformCard;

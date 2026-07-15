import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, TextInput, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useBLE } from '../../functionality/BLEContext';
import { useAuth } from '../../auth/AuthContext';
import { saveStimulationEvent } from '../../firebase/dataLogger';
import {
  BLEProtocolType,
  ESP_SIGNAL_CTRL_PROTOCOL,
  NRF_LOG_PROTOCOL,
  NORDIC_UART_PROTOCOL,
  SUPPORTED_PROTOCOLS,
} from '../../functionality/BLEProtocols';

interface StimParams {
  offset: number;
  phase1: number;
  phase2: number;
  tonpos: number;
  toff: number;
  tonneg: number;
}

const DEFAULT_PARAMS: StimParams = {
  offset: 2505,
  phase1: 3000,
  phase2: 2010,
  tonpos: 2,
  toff: 1,
  tonneg: 1,
};

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));

const extractRxPayload = (line: string): string | null => {
  // Extract the portion after "RX: " prefix
  const rxMatch = line.match(/RX:\s*(.*)$/);
  if (rxMatch) {
    return rxMatch[1].trim();
  }
  return null;
};

const parseCfgLine = (payload: string): Partial<StimParams & { run: string }> => {
  const matches = [...payload.matchAll(/([A-Z0-9_]+)=([^\s]+)/g)];
  const result: Partial<StimParams & { run: string }> = {};

  for (const [, key, rawValue] of matches) {
    const numeric = Number(rawValue);
    switch (key) {
      case 'OFFSET':
        if (Number.isFinite(numeric)) result.offset = Math.round(numeric);
        break;
      case 'PHASE1':
        if (Number.isFinite(numeric)) result.phase1 = Math.round(numeric);
        break;
      case 'PHASE2':
        if (Number.isFinite(numeric)) result.phase2 = Math.round(numeric);
        break;
      case 'TONPOS':
        if (Number.isFinite(numeric)) result.tonpos = Math.round(numeric);
        break;
      case 'TOFF':
        if (Number.isFinite(numeric)) result.toff = Math.round(numeric);
        break;
      case 'TONNEG':
        if (Number.isFinite(numeric)) result.tonneg = Math.round(numeric);
        break;
      case 'RUN':
        result.run = rawValue;
        break;
      default:
        break;
    }
  }

  return result;
};

const parseDacLine = (payload: string): { dacCmd: string; ch1: string; ch2: string; ch3: string } => {
  // Parse format: "DAC_CMD: 2048 | CH1(mV): 0.00 | CH2(mV): 0.00 | CH3(mV): 0.00"
  const dac = payload.match(/DAC_CMD:\s*([0-9]+)/)?.[1] ?? '-';
  const ch1 = payload.match(/CH1\s*\(\s*mV\s*\):\s*([-0-9.]+)/)?.[1] ?? '-';
  const ch2 = payload.match(/CH2\s*\(\s*mV\s*\):\s*([-0-9.]+)/)?.[1] ?? '-';
  const ch3 = payload.match(/CH3\s*\(\s*mV\s*\):\s*([-0-9.]+)/)?.[1] ?? '-';
  console.log('[Stimulation] Parsed DAC:', { dac, ch1, ch2, ch3 });
  return { dacCmd: dac, ch1, ch2, ch3 };
};

export default function StimulationScreen() {
  const [params, setParams] = useState<StimParams>(DEFAULT_PARAMS);
  const [stimulationActive, setStimulationActive] = useState(false);
  const [runState, setRunState] = useState('-');
  const [dacCmd, setDacCmd] = useState('-');
  const [ch1Mv, setCh1Mv] = useState('-');
  const [ch2Mv, setCh2Mv] = useState('-');
  const [ch3Mv, setCh3Mv] = useState('-');
  const [latestDeviceLine, setLatestDeviceLine] = useState('No device response yet');
  const [lastUpdateTime, setLastUpdateTime] = useState<number>(0);

  const {
    isAnyDeviceConnected,
    activeDeviceName,
    connectedDeviceName,
    connectedDevice,
    isEarbudConnected,
    sendCommand,
    receivedMessages,
    setProtocolFilter,
    currentProtocol,
  } = useBLE();
  const { user } = useAuth();

  // Reset state when device disconnects
  useEffect(() => {
    if (!isAnyDeviceConnected) {
      console.log('[Stimulation] Device disconnected, resetting state');
      setParams(DEFAULT_PARAMS);
      setStimulationActive(false);
      setRunState('-');
      setDacCmd('-');
      setCh1Mv('-');
      setCh2Mv('-');
      setCh3Mv('-');
      setLatestDeviceLine('Device disconnected. Reconnect to see live status.');
      setLastUpdateTime(0);
    }
  }, [isAnyDeviceConnected]);

  useEffect(() => {
    // Keep stim preferred while still allowing wristband protocol discovery.
    setProtocolFilter([ESP_SIGNAL_CTRL_PROTOCOL, NRF_LOG_PROTOCOL, NORDIC_UART_PROTOCOL]);
    return () => {
      setProtocolFilter(SUPPORTED_PROTOCOLS);
    };
  }, []);

  // Auto-poll device status every 2 seconds when connected (only for writable protocols)
  useEffect(() => {
    if (!isAnyDeviceConnected) return;
    if (currentProtocol.type === BLEProtocolType.NRF_LOG_SERVICE) {
      console.log('[Stimulation] Skipping auto-polling for read-only NRF_LOG_SERVICE');
      return;
    }
    
    const pollInterval = setInterval(() => {
      console.log('[Stimulation] Auto-polling device status...');
      sendCommand('GET').catch(err => console.error('[Stimulation] Poll error:', err));
    }, 2000);
    
    return () => clearInterval(pollInterval);
  }, [isAnyDeviceConnected, currentProtocol, sendCommand]);

  useEffect(() => {
    if (receivedMessages.length === 0) return;
    
    // Only process the last message (avoid reprocessing old messages)
    const last = receivedMessages[receivedMessages.length - 1];
    console.log('[Stimulation] New message:', last);
    
    // Only process RX (received) messages, skip TX messages
    if (!last.includes('RX:')) {
      console.log('[Stimulation] Ignoring non-RX message');
      return;
    }
    
    const payload = extractRxPayload(last);
    if (!payload) {
      console.log('[Stimulation] Could not extract RX payload from:', last);
      return;
    }

    console.log('[Stimulation] ✅ Extracted payload:', payload);
    setLatestDeviceLine(payload);
    setLastUpdateTime(Date.now());

    if (payload.startsWith('CFG ')) {
      console.log('[Stimulation] Processing CFG response');
      const cfg = parseCfgLine(payload);
      console.log('[Stimulation] Parsed CFG:', cfg);
      setParams((prev) => ({
        ...prev,
        ...(cfg.offset !== undefined ? { offset: clamp(cfg.offset, 0, 4095) } : {}),
        ...(cfg.phase1 !== undefined ? { phase1: clamp(cfg.phase1, 0, 4095) } : {}),
        ...(cfg.phase2 !== undefined ? { phase2: clamp(cfg.phase2, 0, 4095) } : {}),
        ...(cfg.tonpos !== undefined ? { tonpos: Math.max(0, cfg.tonpos) } : {}),
        ...(cfg.toff !== undefined ? { toff: Math.max(0, cfg.toff) } : {}),
        ...(cfg.tonneg !== undefined ? { tonneg: Math.max(0, cfg.tonneg) } : {}),
      }));

      if (cfg.run !== undefined) {
        setRunState(cfg.run);
        setStimulationActive(cfg.run === '1');
      }
    } else if (payload.startsWith('DAC_CMD:')) {
      console.log('[Stimulation] Processing DAC_CMD response');
      const parsed = parseDacLine(payload);
      console.log('[Stimulation] Parsed DAC:', parsed);
      setDacCmd(parsed.dacCmd);
      setCh1Mv(parsed.ch1);
      setCh2Mv(parsed.ch2);
      setCh3Mv(parsed.ch3);
    } else if (payload.startsWith('ACK START')) {
      console.log('[Stimulation] Device acknowledged START');
      setStimulationActive(true);
    } else if (payload.startsWith('ACK STOP')) {
      console.log('[Stimulation] Device acknowledged STOP');
      setStimulationActive(false);
    } else {
      console.log('[Stimulation] Unknown response type:', payload);
    }
  }, [receivedMessages]);

  const updateParam = (key: keyof StimParams, value: number) => {
    if (key === 'offset' || key === 'phase1' || key === 'phase2') {
      setParams((prev) => ({ ...prev, [key]: clamp(Math.round(value), 0, 4095) }));
      return;
    }
    setParams((prev) => ({ ...prev, [key]: Math.max(0, Math.round(value)) }));
  };

  const sendBasicCommand = async (command: string) => {
    if (!isAnyDeviceConnected) {
      Alert.alert('Not Connected', 'Please connect to a device first.');
      return;
    }

    // Allow if earbud is connected (earbud IS the ESP_SIGNAL_CTRL)
    // OR if the wristband protocol is ESP_SIGNAL_CTRL
    if (!isEarbudConnected && currentProtocol.type !== BLEProtocolType.ESP_SIGNAL_CTRL) {
      Alert.alert(
        'Wrong Device Protocol',
        'Current connection is not ESP_SIGNAL_CTRL. Connect to the earpiece stimulator before sending stim commands.'
      );
      return;
    }

    await sendCommand(command);
  };

  const applyParameters = async () => {
    if (!isAnyDeviceConnected) {
      Alert.alert('Not Connected', 'Please connect to a device first.');
      return;
    }

    // Allow if earbud is connected OR if protocol is ESP_SIGNAL_CTRL
    if (!isEarbudConnected && currentProtocol.type !== BLEProtocolType.ESP_SIGNAL_CTRL) {
      Alert.alert(
        'Wrong Device Protocol',
        'Current connection is not ESP_SIGNAL_CTRL. Connect to the earpiece stimulator before sending stim commands.'
      );
      return;
    }

    const commands = [
      `SET OFFSET ${params.offset}`,
      `SET PHASE1 ${params.phase1}`,
      `SET PHASE2 ${params.phase2}`,
      `SET TONPOS ${params.tonpos}`,
      `SET TOFF ${params.toff}`,
      `SET TONNEG ${params.tonneg}`,
      'GET',
    ];

    console.log('[Stimulation] Applying parameters with commands:', commands);
    
    for (const command of commands) {
      console.log('[Stimulation] Sending:', command);
      await sendCommand(command);
      // Add small delay between commands to avoid overwhelming device
      await new Promise(r => setTimeout(r, 100));
    }

    Alert.alert('Parameters Applied', 'Stimulator parameters sent successfully.');
  };

  const handleStart = async () => {
    await sendBasicCommand('START');

    if (user) {
      try {
        const safeDeviceId = connectedDevice?.id ?? (isEarbudConnected ? '3C:0F:02:D7:2E:05' : 'unknown-device');
        const safeDeviceName = connectedDevice?.name ?? (isEarbudConnected ? 'ESP_SIGNAL_CTRL' : 'Unknown Device');
        
        await saveStimulationEvent(user.uid, {
          waveform: 'CUSTOM',
          frequency: 1000,
          amplitude: params.phase1,
          pulseWidth: params.tonpos,
          duration: 0,
          deviceId: safeDeviceId,
          deviceName: safeDeviceName,
          notes: `OFFSET:${params.offset} PHASE2:${params.phase2} TOFF:${params.toff} TONNEG:${params.tonneg}`,
          intensity: 'LOW',
        });
      } catch (e) {
        console.error('[Stimulation] Firebase log error:', e);
      }
    }
  };

  const handleStop = async () => {
    await sendBasicCommand('STOP');
  };

  const renderNumberControl = (
    label: string,
    key: keyof StimParams,
    step: number,
    min: number,
    max: number,
  ) => {
    const value = params[key];

    return (
      <View style={styles.paramCard} key={key}>
        <Text style={styles.paramLabel}>{label}</Text>
        <View style={styles.paramControls}>
          <TouchableOpacity
            style={styles.paramButton}
            onPress={() => updateParam(key, clamp(value - step, min, max))}
          >
            <Text style={styles.paramButtonText}>-</Text>
          </TouchableOpacity>

          <TextInput
            style={styles.paramInput}
            keyboardType="numeric"
            value={String(value)}
            onChangeText={(text) => {
              const numeric = Number(text.replace(/[^0-9]/g, ''));
              if (Number.isFinite(numeric)) {
                updateParam(key, clamp(numeric, min, max));
              }
            }}
          />

          <TouchableOpacity
            style={styles.paramButton}
            onPress={() => updateParam(key, clamp(value + step, min, max))}
          >
            <Text style={styles.paramButtonText}>+</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.header}>
        <View style={styles.headerIcon}>
          <Ionicons name="pulse" size={24} color="#ef4444" />
        </View>
        <Text style={styles.headerTitle}>ESP Signal Controller</Text>
      </View>

      <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
        <View style={styles.statusCard}>
          <View style={styles.statusRow}>
            <Ionicons name="bluetooth" size={16} color={isAnyDeviceConnected ? '#10b981' : '#ef4444'} />
            <Text style={styles.statusText}>
              {isAnyDeviceConnected ? `Connected: ${activeDeviceName ?? connectedDeviceName ?? 'Unknown'}` : 'Disconnected'}
            </Text>
          </View>
          <Text style={styles.subtleText}>Protocol target: ESP_SIGNAL_CTRL</Text>
          <Text style={styles.subtleText}>RUN: {runState}</Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Waveform Parameters</Text>
          {renderNumberControl('OFFSET (0-4095)', 'offset', 5, 0, 4095)}
          {renderNumberControl('PHASE1 (0-4095)', 'phase1', 5, 0, 4095)}
          {renderNumberControl('PHASE2 (0-4095)', 'phase2', 5, 0, 4095)}
          {renderNumberControl('TONPOS (ticks)', 'tonpos', 1, 0, 100000)}
          {renderNumberControl('TOFF (ticks)', 'toff', 1, 0, 100000)}
          {renderNumberControl('TONNEG (ticks)', 'tonneg', 1, 0, 100000)}

          <TouchableOpacity style={styles.applyButton} onPress={applyParameters}>
            <Text style={styles.applyButtonText}>Apply Parameters</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Device Controls</Text>
          <View style={styles.actionGrid}>
            <TouchableOpacity style={styles.actionButton} onPress={handleStart}>
              <Text style={styles.actionButtonText}>START</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionButton} onPress={handleStop}>
              <Text style={styles.actionButtonText}>STOP</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionButton} onPress={() => sendBasicCommand('GET')}>
              <Text style={styles.actionButtonText}>GET CONFIG</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionButton} onPress={() => sendBasicCommand('PING')}>
              <Text style={styles.actionButtonText}>PING</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.subtleText}>
            Output State: {stimulationActive ? 'ACTIVE' : 'STOPPED'}
          </Text>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Live Status</Text>
          <View style={styles.statusUpdateInfo}>
            <Ionicons 
              name={lastUpdateTime > 0 ? "checkmark-circle" : "alert-circle"} 
              size={16} 
              color={lastUpdateTime > 0 ? "#10b981" : "#ef4444"} 
            />
            <Text style={styles.statusUpdateText}>
              {lastUpdateTime > 0 
                ? `Last update: ${new Date(lastUpdateTime).toLocaleTimeString()}`
                : 'Waiting for device response...'}
            </Text>
          </View>
          <View style={styles.statusGrid}>
            <View style={styles.livePill}><Text style={styles.liveText}>DAC_CMD: {dacCmd}</Text></View>
            <View style={styles.livePill}><Text style={styles.liveText}>CH1: {ch1Mv} mV</Text></View>
            <View style={styles.livePill}><Text style={styles.liveText}>CH2: {ch2Mv} mV</Text></View>
            <View style={styles.livePill}><Text style={styles.liveText}>CH3: {ch3Mv} mV</Text></View>
          </View>
          <View style={styles.logBox}>
            <Text style={styles.logLabel}>Latest Device Line</Text>
            <Text style={styles.logValue}>{latestDeviceLine}</Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fee2e2',
    padding: 16,
    gap: 12,
  },
  headerIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#ffffff',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 19,
    fontWeight: 'bold',
    color: '#1e293b',
  },
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  statusCard: {
    backgroundColor: '#ffffff',
    margin: 16,
    marginBottom: 0,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  statusText: {
    fontSize: 13,
    color: '#0f172a',
    fontWeight: '700',
  },
  subtleText: {
    color: '#475569',
    fontSize: 12,
    marginTop: 2,
  },
  section: {
    backgroundColor: '#ffffff',
    marginTop: 16,
    marginHorizontal: 16,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: 'bold',
    color: '#b91c1c',
    marginBottom: 12,
  },
  paramCard: {
    marginBottom: 10,
  },
  paramLabel: {
    color: '#0f172a',
    fontSize: 13,
    marginBottom: 6,
    fontWeight: '600',
  },
  paramControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  paramButton: {
    width: 38,
    height: 38,
    borderRadius: 8,
    backgroundColor: '#e2e8f0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  paramButtonText: {
    fontSize: 20,
    fontWeight: '600',
    color: '#1e293b',
  },
  paramInput: {
    flex: 1,
    height: 38,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingHorizontal: 10,
    color: '#0f172a',
    fontWeight: '700',
    backgroundColor: '#ffffff',
  },
  applyButton: {
    marginTop: 8,
    backgroundColor: '#dc2626',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  applyButtonText: {
    color: '#ffffff',
    fontWeight: '800',
    fontSize: 14,
  },
  actionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 8,
  },
  actionButton: {
    minWidth: '47%',
    flex: 1,
    backgroundColor: '#e2e8f0',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  actionButtonText: {
    color: '#0f172a',
    fontWeight: '700',
  },
  statusGrid: {
    gap: 8,
  },
  statusUpdateInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f0fdf4',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 12,
    gap: 8,
  },
  statusUpdateText: {
    fontSize: 13,
    color: '#10b981',
    fontWeight: '600',
    flex: 1,
  },
  livePill: {
    backgroundColor: '#f1f5f9',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  liveText: {
    fontSize: 13,
    color: '#0f172a',
    fontWeight: '600',
  },
  logBox: {
    marginTop: 10,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fafafa',
    borderRadius: 8,
    padding: 10,
  },
  logLabel: {
    fontSize: 12,
    color: '#64748b',
    marginBottom: 4,
  },
  logValue: {
    fontSize: 12,
    color: '#0f172a',
    lineHeight: 18,
    textAlign: 'center',
  },
});

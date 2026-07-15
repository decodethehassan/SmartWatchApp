import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useBLE } from '../functionality/BLEContext';
import { BLEDevice } from '../functionality/BLEService';
import { BLEProtocolType } from '../functionality/BLEProtocols';

interface BluetoothScanModalProps {
  visible: boolean;
  onClose: () => void;
}

export const BluetoothScanModal: React.FC<BluetoothScanModalProps> = ({ visible, onClose }) => {
  const {
    isScanning,
    isConnected,
    discoveredDevices,
    connectedDeviceName,
    connectedDevice,
    statusMessage,
    startScan,
    stopScan,
    connectToDeviceRouter,
    disconnectAll,
    isEarbudConnected,
    isEarbudConnecting,
    requestPermissions,
    bluetoothState,
    enableBluetooth,
  } = useBLE();

  const [connecting, setConnecting] = useState<string | null>(null);

  // Auto-start scan when modal opens
  useEffect(() => {
    if (visible) {
      handleStartScan();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const handleStartScan = async () => {
    const granted = await requestPermissions();
    if (!granted) {
      Alert.alert(
        'Permission Required',
        'Bluetooth permissions are required to scan for devices. Please grant permissions in Settings.',
        [{ text: 'OK' }]
      );
      return;
    }
    await startScan();
  };

  const handleConnect = async (device: BLEDevice) => {
    try {
      setConnecting(device.id);
      await connectToDeviceRouter(device.id);
    } catch (err: any) {
      Alert.alert('Connection Failed', err.message || 'Could not connect to device.');
    } finally {
      setConnecting(null);
    }
  };

  const handleDisconnect = async () => {
    Alert.alert('Disconnect', 'Disconnect from all devices?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect',
        style: 'destructive',
        onPress: async () => {
          console.log('[BluetoothScanModal] Disconnect button tapped — calling disconnectAll');
          await disconnectAll();
        },
      },
    ]);
  };

  const handleClose = () => {
    if (isScanning) stopScan();
    onClose();
  };

  const renderDevice = (device: BLEDevice) => {
    const name = device.name || 'Unknown Device';
    
    // Properly determine device type using protocol UUID, not hardcoded MAC/name
    const isEarbud = device.protocol?.type === BLEProtocolType.ESP_SIGNAL_CTRL;
    const isWristband = device.protocol?.type === BLEProtocolType.NRF_LOG_SERVICE || 
                        device.protocol?.type === BLEProtocolType.NORDIC_UART;

    const isThisConnecting = isEarbud ? isEarbudConnecting : connecting === device.id;
    const isThisConnected = isEarbud ? isEarbudConnected : connectedDevice?.id === device.id;

    // Use protocol info for label, fallback to device type
    let deviceLabel = '❓ Unknown Device';
    if (isEarbud) {
      deviceLabel = '🎧 ESP Earbud';
    } else if (isWristband) {
      deviceLabel = device.protocol?.type === BLEProtocolType.NRF_LOG_SERVICE 
        ? '⌚ Wristband' 
        : '⌚ Wristband';
    }
    
    const statusColor = isThisConnected ? '#22c55e' : '#6b7280';
    const statusText = isThisConnecting ? 'Connecting...' : isThisConnected ? 'Connected' : 'Not Connected';

    return (
      <View style={styles.deviceCard}>
        <View style={styles.deviceInfo}>
          <Text style={styles.deviceName}>{name}</Text>
          <Text style={styles.deviceType}>{deviceLabel}</Text>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
            <Text style={[styles.deviceStatusText, { color: statusColor }]}>{statusText}</Text>
          </View>
          <Text style={styles.deviceMac}>{device.id}</Text>
        </View>

        <View style={styles.buttonCol}>
          {isThisConnecting ? (
            <ActivityIndicator color="#1B4965" />
          ) : isThisConnected ? (
            <TouchableOpacity
              style={styles.disconnectBtn}
              onPress={() => {
                console.log(`[BluetoothScanModal] Disconnect per-device: ${device.id} isEarbud=${isEarbud}`);
                disconnectAll();
              }}
            >
              <Text style={styles.disconnectBtnText}>Disconnect</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.connectBtn}
              onPress={() => {
                console.log(`[UI] Connect: ${device.id} isEarbud=${isEarbud}`);
                connectToDeviceRouter(device.id);
              }}
            >
              <Text style={styles.connectBtnText}>Connect</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  };

  const renderDeviceItem = ({ item: device }: { item: BLEDevice }) => {
    return renderDevice(device);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity style={styles.closeBtn} onPress={handleClose}>
            <Ionicons name="chevron-down" size={24} color="#1e293b" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Connect Device</Text>
          <View style={{ width: 36 }} />
        </View>

        {/* Status Bar */}
        <View style={[styles.statusBar, isConnected && styles.statusBarConnected]}>
          <Ionicons
            name={isConnected ? 'checkmark-circle' : isScanning ? 'radio-outline' : 'bluetooth'}
            size={18}
            color={isConnected ? '#10b981' : '#1B4965'}
          />
          <Text style={[styles.statusText, isConnected && styles.statusTextConnected]}>
            {isConnected ? `Connected: ${connectedDeviceName}` : statusMessage}
          </Text>
          {isScanning && <ActivityIndicator size="small" color="#1B4965" style={{ marginLeft: 8 }} />}
        </View>

        {/* Connected Device Banner */}
        {isConnected && (
          <View style={styles.connectedBanner}>
            <Ionicons name="watch" size={40} color="#1B4965" />
            <View style={styles.connectedBannerInfo}>
              <Text style={styles.connectedBannerTitle}>{connectedDeviceName}</Text>
              <Text style={styles.connectedBannerSub}>Receiving sensor data</Text>
            </View>
            <TouchableOpacity style={styles.connectedCloseBtn} onPress={handleClose}>
              <Text style={styles.connectedCloseBtnText}>Done</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Connection Summary */}
        <View style={styles.connectionSummary}>
          <View style={styles.summaryItem}>
            <Text style={styles.summaryIcon}>⌚</Text>
            <Text style={[styles.summaryStatus, { color: isConnected ? '#22c55e' : '#6b7280' }]}>
              {isConnected ? 'Wristband Connected' : 'Wristband Disconnected'}
            </Text>
          </View>
          <View style={styles.summaryDivider} />
          <View style={styles.summaryItem}>
            <Text style={styles.summaryIcon}>🎧</Text>
            <Text style={[styles.summaryStatus, { color: isEarbudConnected ? '#22c55e' : '#6b7280' }]}>
              {isEarbudConnected ? 'Earbud Connected' : 'Earbud Disconnected'}
            </Text>
          </View>
        </View>

        {/* Scan Controls */}
        <View style={styles.scanControls}>
          <Text style={styles.sectionLabel}>
            {discoveredDevices.length > 0
              ? `${discoveredDevices.length} device${discoveredDevices.length !== 1 ? 's' : ''} found`
              : isScanning
              ? 'Scanning for devices...'
              : 'No devices found'}
          </Text>
          <View style={styles.scanButtons}>
            {isScanning ? (
              <TouchableOpacity style={styles.stopBtn} onPress={stopScan}>
                <Ionicons name="stop-circle" size={18} color="#ef4444" />
                <Text style={styles.stopBtnText}>Stop</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.scanBtn} onPress={handleStartScan}>
                <Ionicons name="search" size={18} color="#ffffff" />
                <Text style={styles.scanBtnText}>Scan Again</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Device List */}
        {discoveredDevices.length === 0 ? (
          <View style={styles.emptyState}>
            {bluetoothState === 'PoweredOff' ? (
              <>
                <Ionicons name="bluetooth-outline" size={64} color="#ef4444" />
                <Text style={styles.emptyTitle}>Bluetooth is OFF</Text>
                <Text style={styles.emptySubtitle}>
                  Please turn on Bluetooth to scan and connect devices.
                </Text>
                <TouchableOpacity
                  style={[styles.doneButton, { width: '100%', marginHorizontal: 0, marginTop: 12, backgroundColor: '#1B4965' }]}
                  onPress={enableBluetooth}
                >
                  <Text style={styles.doneButtonText}>
                    {Platform.OS === 'android' ? 'Turn On Bluetooth' : 'Open Bluetooth Settings'}
                  </Text>
                </TouchableOpacity>
              </>
            ) : isScanning ? (
              <>
                <ActivityIndicator size="large" color="#1B4965" />
                <Text style={styles.emptyTitle}>Searching for devices...</Text>
                <Text style={styles.emptySubtitle}>Make sure your wristband is powered on and nearby</Text>
              </>
            ) : (
              <>
                <Ionicons name="bluetooth-outline" size={64} color="#cbd5e1" />
                <Text style={styles.emptyTitle}>No devices found</Text>
                <Text style={styles.emptySubtitle}>
                  Ensure your wristband is turned on, then tap Scan Again
                </Text>
              </>
            )}
          </View>
        ) : (
          <FlatList
            data={discoveredDevices}
            keyExtractor={(device) => device.id}
            renderItem={renderDeviceItem}
            contentContainerStyle={styles.deviceListContent}
            scrollEnabled={true}
            showsVerticalScrollIndicator={true}
          />
        )}

        {/* Info Footer */}
        <TouchableOpacity style={styles.doneButton} onPress={handleClose}>
          <Text style={styles.doneButtonText}>Done (Go to Dashboard)</Text>
        </TouchableOpacity>

        <View style={styles.footer}>
          <Ionicons name="information-circle-outline" size={16} color="#94a3b8" />
          <Text style={styles.footerText}>
            {Platform.OS === 'android'
              ? 'Ensure Location permission is granted for BLE scanning'
              : 'Allow Bluetooth access in Settings if prompted'}
          </Text>
        </View>
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e2e8f0',
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#f1f5f9',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1e293b',
  },
  statusBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1B49650F', // 10% primary Navy
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
  },
  statusBarConnected: {
    backgroundColor: '#f0fdf4',
  },
  statusText: {
    fontSize: 14,
    color: '#1B4965', // primary Navy
    fontWeight: '500',
    flex: 1,
  },
  statusTextConnected: {
    color: '#10b981',
  },
  connectedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    margin: 16,
    padding: 16,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: '#10b981',
    gap: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  connectedBannerInfo: {
    flex: 1,
  },
  connectedBannerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1e293b',
  },
  connectedBannerSub: {
    fontSize: 13,
    color: '#10b981',
    marginTop: 2,
  },
  connectedCloseBtn: {
    backgroundColor: '#10b981',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  connectedCloseBtnText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 14,
  },
  scanControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  sectionLabel: {
    fontSize: 14,
    color: '#64748b',
    fontWeight: '600',
  },
  scanButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  scanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1B4965',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    gap: 6,
  },
  scanBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  stopBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    gap: 6,
  },
  stopBtnText: {
    color: '#ef4444',
    fontSize: 14,
    fontWeight: '600',
  },
  deviceList: {
    paddingHorizontal: 16,
    paddingBottom: 16,
    gap: 10,
  },
  deviceListContent: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 16,
    gap: 10,
  },
  connectionSummary: {
    flexDirection: 'row',
    backgroundColor: '#1B49650F', // 10% primary Navy
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
    marginHorizontal: 16,
    alignItems: 'center',
  },
  summaryItem: {
    flex: 1,
    alignItems: 'center',
  },
  summaryIcon: {
    fontSize: 20,
  },
  summaryStatus: {
    fontSize: 11,
    fontWeight: '500',
    marginTop: 4,
    textAlign: 'center',
    color: '#1B4965',
  },
  summaryDivider: {
    width: 1,
    height: 30,
    backgroundColor: '#1B49651C', // 11% opacity Navy
  },
  deviceCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#ffffff', // White card
    borderRadius: 12,
    padding: 16,
    marginVertical: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0', // Light grey border
  },
  deviceInfo: {
    flex: 1,
  },
  deviceName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1e293b', // Dark text color
  },
  deviceType: {
    fontSize: 12,
    color: '#64748b', // Grey secondary text
    marginTop: 2,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  deviceStatusText: {
    fontSize: 12,
    fontWeight: '500',
  },
  deviceMac: {
    fontSize: 10,
    color: '#94a3b8', // Light grey text color
    marginTop: 4,
  },
  buttonCol: {
    marginLeft: 12,
  },
  connectBtn: {
    backgroundColor: '#1B4965',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  connectBtnText: {
    color: '#ffffff',
    fontWeight: '600',
    fontSize: 13,
  },
  disconnectBtn: {
    backgroundColor: '#dc2626',
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  disconnectBtnText: {
    color: '#ffffff',
    fontWeight: '600',
    fontSize: 13,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 40,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1e293b',
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#64748b',
    textAlign: 'center',
    lineHeight: 20,
  },
  doneButton: {
    backgroundColor: '#1B4965', // primary Navy
    marginHorizontal: 16,
    marginTop: 8,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  doneButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 6,
    borderTopWidth: 1,
    borderTopColor: '#e2e8f0',
    backgroundColor: '#ffffff',
  },
  footerText: {
    fontSize: 12,
    color: '#94a3b8',
    flex: 1,
  },
});

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { unstable_batchedUpdates } from 'react-native';
import { Platform, PermissionsAndroid, Linking } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Device } from 'react-native-ble-plx';
import { bleService, sharedBleManager, BLEDevice } from '../functionality/BLEService';
import { earbudService } from '../functionality/EarbudService';
import { teardownGuard } from '../functionality/BLETeardown';
import {
  BLEProtocol,
  BLEProtocolType,
  SUPPORTED_PROTOCOLS,
  NORDIC_UART_PROTOCOL,
  ESP32_PROTOCOL,
  ESP_SIGNAL_CTRL_PROTOCOL
} from './BLEProtocols';

// Always use real BLE service
console.log('[BLE] Using REAL BLE Service');

const LAST_DEVICE_KEY = 'ble_last_connected_device';

interface BLEContextType {
  // State
  isScanning: boolean;
  isConnecting: boolean;
  isConnected: boolean;
  discoveredDevices: BLEDevice[];
  connectedDevice: Device | null;
  connectedDeviceName: string | null;
  receivedMessages: string[];
  statusMessage: string;
  currentProtocol: BLEProtocol;
  availableProtocols: BLEProtocol[];
  selectedProtocols: BLEProtocol[];
  bluetoothState: string;

  // Earbud state
  isEarbudConnected: boolean;
  isEarbudConnecting: boolean;

  // Unified connection state
  isAnyDeviceConnected: boolean;
  activeDeviceId: string | undefined;
  activeDeviceName: string | undefined;

  // Actions
  startScan: () => Promise<void>;
  stopScan: () => void;
  connectToDeviceRouter: (deviceId: string) => Promise<void>;
  disconnectDevice: () => Promise<void>;
  disconnectEarbud: () => Promise<void>;
  disconnectAll: () => Promise<void>;
  sendCommand: (command: string) => Promise<void>;
  clearMessages: () => void;
  requestPermissions: () => Promise<boolean>;
  setProtocolFilter: (protocols: BLEProtocol[]) => void;
  toggleProtocol: (protocol: BLEProtocol) => void;
  enableBluetooth: () => Promise<boolean>;
}

const BLEContext = createContext<BLEContextType | undefined>(undefined);

export const useBLE = () => {
  const context = useContext(BLEContext);
  if (!context) {
    throw new Error('useBLE must be used within BLEProvider');
  }
  return context;
};

interface BLEProviderProps {
  children: ReactNode;
}

export const BLEProvider: React.FC<BLEProviderProps> = ({ children }) => {
  const [isScanning, setIsScanning] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [discoveredDevices, setDiscoveredDevices] = useState<BLEDevice[]>([]);
  const [connectedDevice, setConnectedDevice] = useState<Device | null>(null);
  const [connectedDeviceName, setConnectedDeviceName] = useState<string | null>(null);
  const [receivedMessages, setReceivedMessages] = useState<string[]>([]);
  const [statusMessage, setStatusMessage] = useState('Ready');
  const [currentProtocol, setCurrentProtocol] = useState<BLEProtocol>(NORDIC_UART_PROTOCOL);
  const [selectedProtocols, setSelectedProtocols] = useState<BLEProtocol[]>(SUPPORTED_PROTOCOLS);
  const [autoConnectAttempted, setAutoConnectAttempted] = useState(false);
  const [bluetoothState, setBluetoothState] = useState<string>('Unknown');
  const EARBUD_MAC = '3C:0F:02:D7:2E:05';

  // Earbud connection state (independent of wristband)
  const [isEarbudConnected, setIsEarbudConnected] = useState(false);
  const [isEarbudConnecting, setIsEarbudConnecting] = useState(false);

  const isMountedRef = React.useRef(true);
  const disconnectInFlightRef = React.useRef(false);

  // Auto-connect on startup
  useEffect(() => {
    earbudService.resetState();

    // Wire earbud data into the same pipeline as wristband data
    // Earbud data flows through identical message routing as wristband
    earbudService.setDataCallback((rawLine: string) => {
      if (!isMountedRef.current) return;
      const timestamp = new Date().toLocaleTimeString();
      const message = `[${timestamp}] RX: ${rawLine}`;
      console.log('[BLEContext] 🎧 Earbud data:', message);
      // Add to same message stream as wristband data
      // Parser/Pipeline will identify this as earbud data by content (no special handling needed)
      setReceivedMessages((prev) =>
        prev.length >= 2000 ? [...prev.slice(-1999), message] : [...prev, message]
      );
    });

    earbudService.setOnDisconnect(() => {
      if (!isMountedRef.current) return;
      unstable_batchedUpdates(() => {
        setIsEarbudConnected(false);
      });
    });

    // Initialize BLE service
    const initBLE = async () => {
      setStatusMessage('Initializing Bluetooth...');
      const initialized = await bleService.initialize();
      if (initialized) {
        // Check current Bluetooth state
        const state = await bleService.getBluetoothState();
        setBluetoothState(state);
        if (state === 'PoweredOn') {
          setStatusMessage('✓ Bluetooth ready');
          // Auto-connect removed - user must manually scan
        } else if (state === 'PoweredOff') {
          setStatusMessage('⚠️ Bluetooth is OFF. Please enable Bluetooth.');
        } else {
          setStatusMessage(`⚠️ Bluetooth state: ${state}`);
        }
      } else {
        setStatusMessage('❌ Bluetooth not available');
      }
    };

    initBLE();

    // Polling interval to ensure state is kept in sync
    const pollInterval = setInterval(async () => {
      try {
        const state = await bleService.getBluetoothState();
        setBluetoothState(state);
      } catch (err) {
        console.error('[BLEContext] Error polling Bluetooth state:', err);
      }
    }, 2000);

    // Also subscribe to manager onStateChange
    const stateSubscription = sharedBleManager.onStateChange((state) => {
      setBluetoothState(state);
      if (state === 'PoweredOn') {
        setStatusMessage('✓ Bluetooth ready');
      } else if (state === 'PoweredOff') {
        setStatusMessage('⚠️ Bluetooth is OFF. Please enable Bluetooth.');
      }
    }, true);

    // Setup callbacks
    bleService.setDataCallback((data: string) => {
      if (!isMountedRef.current) return;
      const timestamp = new Date().toLocaleTimeString();
      const message = `[${timestamp}] RX: ${data}`;
      // Keep last 2000 messages for the log monitor UI.
      // NOTE: we intentionally trim from the BACK (keep newest) so that
      // useSensorPipeline's absolute-index pointer is never invalidated.
      // The pipeline processes new messages by comparing length, so any
      // front-trim would cause it to miss all subsequent messages.
      setReceivedMessages((prev) =>
        prev.length >= 2000 ? [...prev.slice(-1999), message] : [...prev, message]
      );
    });

    bleService.setConnectionCallback((connected: boolean, device) => {
      if (!isMountedRef.current) return;
      // Wrap ALL setState calls in unstable_batchedUpdates so that native BLE
      // callbacks (which run outside React's event loop) produce ONE render
      // instead of 4-5 separate renders — preventing the disconnect crash and
      // reducing overall re-render pressure.
      unstable_batchedUpdates(() => {
        setIsConnected(connected);
        if (connected && device) {
          setConnectedDevice(bleService.getConnectedDevice());
          setConnectedDeviceName(device.name || 'Unknown Device');
          const protocol = bleService.getCurrentProtocol();
          setCurrentProtocol(protocol);
          setStatusMessage(`Connected to ${device.name || device.id} (${protocol.name})`);
          // Save last connected device (async, no setState)
          saveLastDevice(device.id, device.name || 'Unknown Device');
        } else {
          setConnectedDevice(null);
          setConnectedDeviceName(null);
          setStatusMessage('Disconnected');
        }
      });

      // Anchor wristband uptime to real wall-clock time immediately after every
      // watch connection. This is best-effort and does not block the UI. The
      // firmware persists the resulting absolute time alongside future V0
      // minute-history records, so timestamps remain correct across reboots.
      if (connected && device) {
        const unixMs = Date.now();
        void bleService.sendLogServiceCommand(`TIME_SYNC,${unixMs}\n`, true)
          .then((ok) => {
            if (ok) {
              console.log('[BLEContext] ✓ Wristband TIME_SYNC sent:', unixMs);
            } else {
              console.warn('[BLEContext] Wristband TIME_SYNC was not accepted');
            }
          })
          .catch((error) => {
            console.warn('[BLEContext] Wristband TIME_SYNC failed:', error);
          });
      }
    });

    bleService.setErrorCallback((error: string) => {
      if (!isMountedRef.current) return;
      setStatusMessage(`Error: ${error}`);
      const timestamp = new Date().toLocaleTimeString();
      setReceivedMessages((prev) => [...prev, `[${timestamp}] ERROR: ${error}`]);
    });

    // Cleanup on unmount
    return () => {
      isMountedRef.current = false;
      clearInterval(pollInterval);
      stateSubscription.remove();
      bleService.setDataCallback(() => { });
      bleService.setConnectionCallback(() => { });
      bleService.setErrorCallback(() => { });
      bleService.destroy();
    };
  }, []);

  const requestPermissions = async (): Promise<boolean> => {
    if (Platform.OS === 'android') {
      try {
        if (Platform.Version >= 31) {
          // Android 12+ requires BLUETOOTH_SCAN, BLUETOOTH_CONNECT, and ACCESS_FINE_LOCATION
          const granted = await PermissionsAndroid.requestMultiple([
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          ]);

          return (
            granted['android.permission.BLUETOOTH_SCAN'] === PermissionsAndroid.RESULTS.GRANTED &&
            granted['android.permission.BLUETOOTH_CONNECT'] === PermissionsAndroid.RESULTS.GRANTED &&
            granted['android.permission.ACCESS_FINE_LOCATION'] === PermissionsAndroid.RESULTS.GRANTED
          );
        } else {
          // Android 11 and below
          const granted = await PermissionsAndroid.request(
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
          );
          return granted === PermissionsAndroid.RESULTS.GRANTED;
        }
      } catch (error) {
        console.error('Permission request error:', error);
        return false;
      }
    }
    return true; // iOS handles permissions automatically
  };

  const saveLastDevice = async (deviceId: string, deviceName: string) => {
    try {
      await AsyncStorage.setItem(LAST_DEVICE_KEY, JSON.stringify({ deviceId, deviceName }));
      console.log('[BLEContext] Saved last device:', deviceName);
    } catch (error) {
      console.error('Failed to save last device:', error);
    }
  };

  const getLastDevice = async (): Promise<{ deviceId: string; deviceName: string } | null> => {
    try {
      const saved = await AsyncStorage.getItem(LAST_DEVICE_KEY);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch (error) {
      console.error('Failed to load last device:', error);
    }
    return null;
  };

  const attemptAutoConnect = async () => {
    if (autoConnectAttempted) return;
    setAutoConnectAttempted(true);

    const lastDevice = await getLastDevice();
    if (!lastDevice) {
      console.log('[BLEContext] No last device found for auto-connect');
      return;
    }

    console.log('[BLEContext] Attempting auto-connect to:', lastDevice.deviceName);
    setStatusMessage(`Auto-connecting to ${lastDevice.deviceName}...`);

    // Start a quick scan to find the device
    setIsScanning(true);
    let foundDevice: BLEDevice | null = null;

    await bleService.startScan(
      (device: BLEDevice) => {
        if (device.id === lastDevice.deviceId) {
          foundDevice = device;
          console.log('[BLEContext] Found last device:', device.name);
          bleService.stopScan();
        }
      },
      5 // Quick 5-second scan
    );

    setTimeout(async () => {
      setIsScanning(false);
      if (foundDevice) {
        console.log('[BLEContext] Connecting to last device...');
        await connectToDeviceRouter(foundDevice.id);
      } else {
        console.log('[BLEContext] Last device not found during auto-connect scan');
        setStatusMessage('Last device not found. Please scan manually.');
      }
    }, 5500);
  };

  const startScan = async () => {
    // First check if Bluetooth is enabled
    const state = await bleService.getBluetoothState();
    console.log('[BLEContext] Bluetooth state:', state);

    if (state !== 'PoweredOn') {
      let message = 'Bluetooth is not available';
      if (state === 'PoweredOff') {
        message = '⚠️ Bluetooth is OFF. Please turn on Bluetooth in your device settings.';
      } else if (state === 'Unauthorized') {
        message = '⚠️ Bluetooth permission denied. Please enable Bluetooth permissions.';
      }
      setStatusMessage(message);
      return;
    }

    const hasPermissions = await requestPermissions();
    if (!hasPermissions) {
      setStatusMessage('⚠️ Bluetooth permissions denied. Please grant permissions in settings.');
      return;
    }

    console.log('[BLEContext] Starting BLE scan...');
    setIsScanning(true);
    setDiscoveredDevices([]);
    setStatusMessage('Scanning for devices...');

    await bleService.startScan(
      (device: BLEDevice) => {
        console.log('[BLEContext] Device found:', device.name || device.id);
        setDiscoveredDevices((prev) => {
          // Avoid duplicates
          if (prev.some((d) => d.id === device.id)) {
            return prev;
          }
          // Sort: preferred device first, then by name
          const newDevices = [...prev, device];
          return newDevices.sort((a, b) => {
            if (a.name === 'DeepSleepDongle') return -1;
            if (b.name === 'DeepSleepDongle') return 1;
            return (a.name || '').localeCompare(b.name || '');
          });
        });
      }
    );
  };

  const stopScan = () => {
    console.log('[BLEContext] Stopping scan');
    bleService.stopScan();
    setIsScanning(false);
    setStatusMessage('Scan stopped');
  };

  const connectToDeviceRouter = async (deviceId: string) => {
    const isEarbud = deviceId === EARBUD_MAC ||
      (deviceId && discoveredDevices.find(d => d.id === deviceId)?.name?.toUpperCase().includes('ESP'));

    console.log(`[Router] ${deviceId} → ${isEarbud ? 'EarbudService 🎧' : 'BLEService ⌚'}`);

    if (isEarbud) {
      if (isEarbudConnected) {
        const stillAlive = await sharedBleManager.isDeviceConnected(deviceId).catch(() => false);
        if (stillAlive) {
          console.log('[Router] Earbud genuinely still connected.');
          return;
        } else {
          console.log('[Router] isEarbudConnected was true but device is gone — resetting...');
          setIsEarbudConnected(false);
          await earbudService.resetState();
        }
      }
      setIsEarbudConnecting(true);
      try {
        const success = await earbudService.connect(deviceId);
        console.log('[Router] earbudService result:', success);
        setIsEarbudConnected(success);
        if (success) {
          // Earbud IS the ESP_SIGNAL_CTRL, set protocol accordingly
          setCurrentProtocol(ESP_SIGNAL_CTRL_PROTOCOL);
          console.log('[Router] 🎧 Earbud connected, protocol set to ESP_SIGNAL_CTRL');
        }
      } catch (e) {
        console.error('[Router] earbudService error:', e);
        setIsEarbudConnected(false);
      } finally {
        setIsEarbudConnecting(false);
      }
    } else {
      if (connectedDevice?.id === deviceId) {
        console.log('[Router] Watch already connected.');
        return;
      }
      setIsConnecting(true);
      try {
        await bleService.connect(deviceId);
        // Connection state is handled entirely by setConnectionCallback above
        // Do NOT pass an inline callback here — it creates a second unguarded handler
      } catch (e) {
        console.error('[Router] bleService error:', e);
      } finally {
        setIsConnecting(false);
      }
    }
  };

  const disconnectDevice = async () => {
    console.log('[BLEContext] 🔌 Starting watch disconnect...');

    // Activate global teardown guard — silences all data callbacks instantly
    teardownGuard.begin();

    try {
      // Stop session first
      // (keep your existing session stop code here)

      // ONLY disconnect the watch — never touch earbudService here
      if (bleService.isCurrentlyConnected()) {
        await bleService.disconnect();
      }

      // Batch all state updates — prevents multiple re-renders during teardown
      unstable_batchedUpdates(() => {
        setIsConnected(false);
        setIsConnecting(false);
        setConnectedDevice(null);
        setConnectedDeviceName(null);
        setStatusMessage('Wristband disconnected');
      });

      console.log('[BLEContext] ✅ Watch disconnect complete');
    } catch (e) {
      console.log('[BLEContext] Watch disconnect error:', e);
      unstable_batchedUpdates(() => {
        setIsConnected(false);
        setConnectedDevice(null);
      });
    } finally {
      // ALWAYS release teardown guard — even if something threw
      teardownGuard.end();
    }
  };

  const disconnectEarbud = async () => {
    console.log('[BLEContext] 🔌 Disconnecting earbud...');
    teardownGuard.begin();

    try {
      earbudService.setDataCallback(() => { });
      await earbudService.disconnect();

      unstable_batchedUpdates(() => {
        setIsEarbudConnected(false);
        setIsEarbudConnecting(false);
      });

      console.log('[BLEContext] ✅ Earbud disconnect complete');
    } catch (e) {
      console.log('[BLEContext] Earbud disconnect error:', e);
      setIsEarbudConnected(false);
    } finally {
      teardownGuard.end();
    }
  };

  const disconnectAll = async () => {
    // Prevent double-calls
    if (teardownGuard.isTearingDown) {
      console.log('[BLEContext] disconnectAll already in progress, skipping');
      return;
    }

    // Kill data callbacks FIRST before anything else runs
    earbudService.setDataCallback(() => { });

    console.log('[BLEContext] 🔌 Disconnecting all devices...');
    teardownGuard.begin();

    try {
      // 1. Session stop — keep your existing session stop code here

      // 2. Earbud first
      if (isEarbudConnected) {
        console.log('[BLEContext] Stopping earbud...');
        await earbudService.disconnect();
      }

      // 4. Watch second
      if (bleService.isCurrentlyConnected()) {
        console.log('[BLEContext] Stopping watch...');
        await bleService.disconnect();
      }

      // 5. Batch state reset
      unstable_batchedUpdates(() => {
        setIsConnected(false);
        setIsEarbudConnected(false);
        setIsConnecting(false);
        setIsEarbudConnecting(false);
        setConnectedDevice(null);
        setConnectedDeviceName(null);
        setStatusMessage('Disconnected');
      });

      console.log('[BLEContext] ✅ All disconnected');
    } catch (e) {
      console.log('[BLEContext] disconnectAll error:', e);
      unstable_batchedUpdates(() => {
        setIsConnected(false);
        setIsEarbudConnected(false);
        setConnectedDevice(null);
      });
    } finally {
      teardownGuard.end();
    }
  };

  const sendCommand = async (command: string) => {
    // Route to earbud if connected, otherwise to wristband
    if (isEarbudConnected) {
      console.log('[BLEContext] 🎧 Routing command to EarbudService:', command);
      const success = await earbudService.sendCommand(command);
      console.log('[BLEContext] Command sent, waiting for device response...');
      return;
    }

    if (!isConnected) {
      setStatusMessage('Not connected to any device');
      return;
    }

    // ESP/NUS firmwares in this project parse line-based commands terminated by '\n'.
    const dataToSend = command.endsWith('\n') ? command : `${command}\n`;

    console.log('[BLEContext] Sending command:', JSON.stringify(dataToSend));
    const success = await bleService.sendData(dataToSend, true); // true = with response (Python default)

    if (!success) {
      setStatusMessage('Failed to send command');
    }
  };

  const clearMessages = () => {
    setReceivedMessages([]);
  };

  const setProtocolFilter = (protocols: BLEProtocol[]) => {
    setSelectedProtocols(protocols);
    bleService.setProtocolFilter(protocols);
    console.log('[BLEContext] Protocol filter updated:', protocols.map(p => p.name).join(', '));
  };

  const toggleProtocol = (protocol: BLEProtocol) => {
    setSelectedProtocols(prev => {
      const isSelected = prev.some(p => p.type === protocol.type);
      let newSelection: BLEProtocol[];

      if (isSelected) {
        // Remove protocol (but ensure at least one remains)
        newSelection = prev.filter(p => p.type !== protocol.type);
        if (newSelection.length === 0) {
          console.warn('[BLEContext] Cannot remove last protocol');
          return prev;
        }
      } else {
        // Add protocol
        newSelection = [...prev, protocol];
      }

      bleService.setProtocolFilter(newSelection);
      console.log('[BLEContext] Protocols toggled. Active:', newSelection.map(p => p.name).join(', '));
      return newSelection;
    });
  };

  const enableBluetooth = async (): Promise<boolean> => {
    if (Platform.OS === 'android') {
      const granted = await requestPermissions();
      if (!granted) {
        setStatusMessage('⚠️ Bluetooth permissions denied.');
        return false;
      }
      setStatusMessage('Enabling Bluetooth...');
      
      // Enforce a 3.5 second timeout on BleManager.enable() to prevent emulator/system hangs
      const enablePromise = bleService.enableBluetooth();
      const timeoutPromise = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3500));
      
      const success = await Promise.race([enablePromise, timeoutPromise]);
      
      if (success) {
        setBluetoothState('PoweredOn');
        setStatusMessage('✓ Bluetooth enabled');
        return true;
      } else {
        console.log('[BLEContext] enableBluetooth timed out or failed. Falling back to Bluetooth Settings intent...');
        setStatusMessage('Opening settings...');
        try {
          await Linking.sendIntent('android.settings.BLUETOOTH_SETTINGS');
        } catch (_) {
          try {
            await Linking.openSettings();
          } catch (err) {
            console.error('[BLEContext] Failed to open settings:', err);
          }
        }
        return false;
      }
    } else {
      try {
        await Linking.openSettings();
        return true;
      } catch (err) {
        console.error('[BLEContext] Failed to open settings:', err);
        return false;
      }
    }
  };

  const value: BLEContextType = {
    isScanning,
    isConnecting,
    isConnected,
    discoveredDevices,
    connectedDevice,
    connectedDeviceName,
    receivedMessages,
    statusMessage,
    currentProtocol,
    availableProtocols: SUPPORTED_PROTOCOLS,
    selectedProtocols,
    isEarbudConnected,
    isEarbudConnecting,
    bluetoothState,
    // Unified connection state
    isAnyDeviceConnected: isConnected || isEarbudConnected,
    activeDeviceId: connectedDevice?.id ?? (isEarbudConnected ? '3C:0F:02:D7:2E:05' : undefined),
    activeDeviceName: connectedDevice?.name ?? (isEarbudConnected ? 'ESP_SIGNAL_CTRL' : undefined),
    startScan,
    stopScan,
    connectToDeviceRouter,
    disconnectDevice,
    disconnectEarbud,
    disconnectAll,
    sendCommand,
    clearMessages,
    requestPermissions,
    setProtocolFilter,
    toggleProtocol,
    enableBluetooth,
  };

  return <BLEContext.Provider value={value}>{children}</BLEContext.Provider>;
};

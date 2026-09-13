// BLE Protocol definitions for different device types

export enum BLEProtocolType {
  NORDIC_UART = 'NORDIC_UART',
  ESP32_CUSTOM = 'ESP32_CUSTOM',
  ESP_SIGNAL_CTRL = 'ESP_SIGNAL_CTRL',
  // Custom Zephyr BLE log-backend service used by the Audio-Stimulator firmware
  NRF_LOG_SERVICE = 'NRF_LOG_SERVICE',
}

export interface BLEProtocol {
  name: string;
  type: BLEProtocolType;
  serviceUUID: string;
  rxCharUUID: string; // Write to device (n/a for log-only devices – same UUID used as placeholder)
  txCharUUID: string; // Receive from device (notify)
  preferredDeviceName?: string;
  preferredDeviceNames?: string[];
}

// ── Zephyr BLE Log Service ───────────────────────────────────────────────────
// Used by the Audio-Stimulator / SMARTWATCH nRF52840 firmware.
// CONFIG_BT_DEVICE_NAME = "SMARTWATCH" (prj.conf)
// Service UUID  : 9f7b0000-6c35-4d2c-9c85-4a8c1a2b3c4d  (ble_log_service.c)
// Notify char   : 9f7b0001-6c35-4d2c-9c85-4a8c1a2b3c4d
// Command char  : 9f7b0002-6c35-4d2c-9c85-4a8c1a2b3c4d
export const LOG_SERVICE_UUID = '9f7b0000-6c35-4d2c-9c85-4a8c1a2b3c4d';
export const LOG_NOTIFY_UUID  = '9f7b0001-6c35-4d2c-9c85-4a8c1a2b3c4d';
export const LOG_COMMAND_UUID = '9f7b0002-6c35-4d2c-9c85-4a8c1a2b3c4d';

export const NRF_LOG_PROTOCOL: BLEProtocol = {
  name: 'nRF Sensor Log Service',
  type: BLEProtocolType.NRF_LOG_SERVICE,
  serviceUUID:        LOG_SERVICE_UUID,
  rxCharUUID:         LOG_COMMAND_UUID, // writable command characteristic (MEM_INFO / MEM_SYNC_*)
  txCharUUID:         LOG_NOTIFY_UUID,  // notify characteristic
  preferredDeviceName: 'SMARTWATCH',
};

// ── Nordic UART Service (NUS) ────────────────────────────────────────────────
export const NORDIC_UART_PROTOCOL: BLEProtocol = {
  name: 'Nordic UART Service',
  type: BLEProtocolType.NORDIC_UART,
  serviceUUID: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  rxCharUUID:  '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
  txCharUUID:  '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
  preferredDeviceName: 'SMARTWATCH',
};

// ── ESP32 Custom Service ─────────────────────────────────────────────────────
export const ESP32_PROTOCOL: BLEProtocol = {
  name: 'ESP32 UART Service',
  type: BLEProtocolType.ESP32_CUSTOM,
  serviceUUID: '4fafc201-1fb5-459e-8fcc-c5c9c331914b',
  rxCharUUID:  'beb5483e-36e1-4688-b7f5-ea07361b26a8',
  txCharUUID:  '6d68efe5-04b6-4a85-abc4-c2670b7bf7fd',
  preferredDeviceName: 'ESP32',
};

// ── ESP Signal Controller Service (Python + Arduino firmware) ──────────────
export const ESP_SIGNAL_CTRL_PROTOCOL: BLEProtocol = {
  name: 'ESP Signal Controller',
  type: BLEProtocolType.ESP_SIGNAL_CTRL,
  serviceUUID: '12345678-1234-1234-1234-1234567890ab',
  rxCharUUID:  '12345678-1234-1234-1234-1234567890ac',
  txCharUUID:  '12345678-1234-1234-1234-1234567890ad',
  preferredDeviceName: 'ESP_SIGNAL_CTRL',
  preferredDeviceNames: ['ESP_SIGNAL_CTRL', 'Esp_signal_ctrl', 'ESP-SIGNAL-CTRL', 'ESP SIGNAL CTRL'],
};

export const ESP_EARBUD_PROTOCOL: BLEProtocol = {
  name: 'ESP_SIGNAL_CTRL',
  preferredDeviceName: 'ESP_SIGNAL_CTRL',
  serviceUUID: '12345678-1234-1234-1234-1234567890ab',
  rxCharUUID: '12345678-1234-1234-1234-1234567890ac',
  txCharUUID: '12345678-1234-1234-1234-1234567890ad',
  type: BLEProtocolType.ESP_SIGNAL_CTRL,
};

// ── All supported protocols – NRF_LOG first so it takes priority during scan ─
export const SUPPORTED_PROTOCOLS: BLEProtocol[] = [
  NRF_LOG_PROTOCOL,
  ESP_SIGNAL_CTRL_PROTOCOL,
  NORDIC_UART_PROTOCOL,
  ESP32_PROTOCOL,
];

// Retained for compatibility
export const TEMP_SERVICE_UUID = '12345678-1234-5678-1234-56789abcdef0';
export const TEMP_CHAR_UUID    = 'abcdef01-1234-5678-1234-56789abcdef0';

// ── Helpers ──────────────────────────────────────────────────────────────────

export function getProtocol(type: BLEProtocolType): BLEProtocol {
  const protocol = SUPPORTED_PROTOCOLS.find(p => p.type === type);
  if (!protocol) throw new Error(`Protocol type ${type} not found`);
  return protocol;
}

/** Match by serviceUUID OR (for the log service) by the log service UUID directly. */
export function getProtocolByServiceUUID(uuid: string): BLEProtocol | null {
  const lower = uuid.toLowerCase();
  return SUPPORTED_PROTOCOLS.find(
    p => p.serviceUUID.toLowerCase() === lower
  ) || null;
}

const normalizeDeviceNameToken = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '');

export function matchesPreferredDeviceName(protocol: BLEProtocol, deviceName: string): boolean {
  const normalizedName = normalizeDeviceNameToken(deviceName);
  const aliases = [
    ...(protocol.preferredDeviceNames ?? []),
    ...(protocol.preferredDeviceName ? [protocol.preferredDeviceName] : []),
  ];

  if (aliases.length === 0) return false;

  return aliases.some(alias => {
    const normalizedAlias = normalizeDeviceNameToken(alias);
    return normalizedAlias.length > 0 && normalizedName.includes(normalizedAlias);
  });
}

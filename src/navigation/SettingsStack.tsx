import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import SettingsScreen from '../screens/main/SettingsScreen';
import WristbandDataMemoryScreen from '../screens/main/WristbandDataMemoryScreen';
import SyncedMemoryResultsScreen from '../screens/main/SyncedMemoryResultsScreen';

export type SettingsStackParamList = {
  SettingsHome: undefined;
  WristbandDataMemory: undefined;
  SyncedMemoryResults: undefined;
};

const Stack = createNativeStackNavigator<SettingsStackParamList>();

export default function SettingsStack() {
  return (
    <Stack.Navigator id="settings-stack" screenOptions={{ headerShown: false }}>
      <Stack.Screen name="SettingsHome" component={SettingsScreen} />
      <Stack.Screen name="WristbandDataMemory" component={WristbandDataMemoryScreen} />
      <Stack.Screen name="SyncedMemoryResults" component={SyncedMemoryResultsScreen} />
    </Stack.Navigator>
  );
}

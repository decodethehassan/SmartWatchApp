import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useDevMode } from '../functionality/DevModeContext';

import HomeScreen from '../screens/main/HomeScreen';
import PhysiologicalInsightScreen from '../screens/main/PhysiologicalInsightScreen';
import StimulationScreen from '../screens/main/StimulationScreen';
import SensorTabScreen from '../screens/main/SensorTabScreen';
import PsychologicalStack from './PsychologicalStack';
import SettingsStack from './SettingsStack';

export type MainTabsParamList = {
  Home: undefined;
  Physiological: undefined;
  Stimulation: undefined;
  Psychological: undefined;
  Sensor: undefined;
  Settings: undefined;
};

const Tab = createBottomTabNavigator<MainTabsParamList>();

export default function MainTabsNavigator() {
  const insets = useSafeAreaInsets();
  const { isDevMode } = useDevMode();

  return (
    <Tab.Navigator
      id="main-tabs-navigator"
      screenOptions={({ route }) => ({
        headerShown: false,
        freezeOnBlur: true,
        tabBarActiveTintColor: '#1B4965',
        tabBarInactiveTintColor: '#94a3b8',
        tabBarStyle: {
          backgroundColor: '#ffffff',
          borderTopColor: '#e5e7eb',
          borderTopWidth: 1,
          paddingBottom: Math.max(insets.bottom, 6),
          paddingTop: 4,
          height: 56 + Math.max(insets.bottom, 6),
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '500',
        },
        tabBarIcon: ({ focused, color, size }) => {
          let iconName: keyof typeof Ionicons.glyphMap = 'home';

          if (route.name === 'Home') {
            iconName = focused ? 'home' : 'home-outline';
          } else if (route.name === 'Physiological') {
            iconName = focused ? 'heart' : 'heart-outline';
          } else if (route.name === 'Stimulation') {
            iconName = focused ? 'musical-notes' : 'musical-notes-outline';
          } else if (route.name === 'Psychological') {
            iconName = focused ? 'headset' : 'headset-outline';
          } else if (route.name === 'Sensor') {
            iconName = focused ? 'analytics' : 'analytics-outline';
          } else if (route.name === 'Settings') {
            iconName = focused ? 'settings' : 'settings-outline';
          }

          return <Ionicons name={iconName} size={size} color={color} />;
        },
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} options={{ title: 'Home' }} />
      <Tab.Screen name="Physiological" component={PhysiologicalInsightScreen} options={{ title: 'Physical' }} />
      <Tab.Screen name="Stimulation" component={StimulationScreen} options={{ title: 'Stimulation' }} />
      <Tab.Screen name="Psychological" component={PsychologicalStack} options={{ title: 'Mental' }} />
      {isDevMode && (
        <Tab.Screen name="Sensor" component={SensorTabScreen} options={{ title: 'Sensor' }} />
      )}
      <Tab.Screen name="Settings" component={SettingsStack} options={{ title: 'Settings' }} />
    </Tab.Navigator>
  );
}

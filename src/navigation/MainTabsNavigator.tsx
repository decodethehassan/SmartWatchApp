import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
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
const TAB_ICON_SIZE = 24;

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
        tabBarHideOnKeyboard: true,
        tabBarStyle: {
          backgroundColor: '#ffffff',
          borderTopColor: '#e5e7eb',
          borderTopWidth: 1,
          paddingTop: 5,
          paddingBottom: Math.max(insets.bottom, 6),
          height: 58 + Math.max(insets.bottom, 6),
        },
        tabBarItemStyle: {
          paddingHorizontal: 0,
        },
        tabBarLabelStyle: {
          fontSize: isDevMode ? 9 : 10,
          fontWeight: '600',
          marginTop: 1,
        },
        tabBarIcon: ({ focused, color }) => {
          if (route.name === 'Home') {
            return (
              <Ionicons
                name={focused ? 'home' : 'home-outline'}
                size={TAB_ICON_SIZE}
                color={color}
              />
            );
          }

          if (route.name === 'Physiological') {
            return (
              <Ionicons
                name={focused ? 'heart' : 'heart-outline'}
                size={TAB_ICON_SIZE}
                color={color}
              />
            );
          }

          if (route.name === 'Stimulation') {
            return (
              <MaterialCommunityIcons
                name="brain"
                size={TAB_ICON_SIZE + 1}
                color={color}
              />
            );
          }

          if (route.name === 'Psychological') {
            return (
              <MaterialCommunityIcons
                name="head-heart-outline"
                size={TAB_ICON_SIZE + 1}
                color={color}
              />
            );
          }

          if (route.name === 'Sensor') {
            return (
              <Ionicons
                name={focused ? 'hardware-chip' : 'hardware-chip-outline'}
                size={TAB_ICON_SIZE}
                color={color}
              />
            );
          }

          return (
            <Ionicons
              name={focused ? 'settings' : 'settings-outline'}
              size={TAB_ICON_SIZE}
              color={color}
            />
          );
        },
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} options={{ title: 'Home' }} />
      <Tab.Screen
        name="Physiological"
        component={PhysiologicalInsightScreen}
        options={{ title: 'Physio' }}
      />
      <Tab.Screen
        name="Stimulation"
        component={StimulationScreen}
        options={{ title: 'Stimulation' }}
      />
      <Tab.Screen
        name="Psychological"
        component={PsychologicalStack}
        options={{ title: 'Mental' }}
      />
      {isDevMode && (
        <Tab.Screen name="Sensor" component={SensorTabScreen} options={{ title: 'Sensor' }} />
      )}
      <Tab.Screen name="Settings" component={SettingsStack} options={{ title: 'Settings' }} />
    </Tab.Navigator>
  );
}

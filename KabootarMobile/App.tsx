import React from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import HomeScreen from "./src/screens/HomeScreen";
import DiscoverScreen from "./src/screens/DiscoverScreen";
import ShareScreen from "./src/screens/ShareScreen";

export type RootStackParamList = {
  Home: undefined;
  Discover: undefined;
  Share: { id?: string; key?: string } | undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <Stack.Navigator>
          <Stack.Screen
            name="Home"
            component={HomeScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="Discover"
            component={DiscoverScreen}
            options={{ title: "Discover" }}
          />
          <Stack.Screen
            name="Share"
            component={ShareScreen}
            options={{ title: "Share" }}
          />
        </Stack.Navigator>
      </NavigationContainer>
      <StatusBar style="light" />
    </SafeAreaProvider>
  );
}

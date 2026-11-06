import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { PushProvider } from '../src/push-context';
import { RepairRunner } from '../src/repair-runner';
import { SessionProvider } from '../src/session';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <PushProvider>
          <StatusBar style="dark" />
          <RepairRunner />
          <Stack screenOptions={{ headerShown: false }} />
        </PushProvider>
      </SessionProvider>
    </SafeAreaProvider>
  );
}

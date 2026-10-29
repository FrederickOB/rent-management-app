import { Redirect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { authClient } from '../src/auth-client';
import { useSession } from '../src/session';
import { Body, Button, colours, Screen } from '../src/ui';

interface DeviceSession {
  readonly id: string;
  readonly token: string;
  readonly userAgent?: string | null;
  readonly createdAt: string | Date;
}

/** Profile: devices signed in, remote sign-out and sign-out (AD-06). */
export default function Profile() {
  const router = useRouter();
  const { me, loading, signOut } = useSession();
  const [devices, setDevices] = useState<DeviceSession[]>([]);

  const load = useCallback(async () => {
    const result = await authClient.listSessions();
    setDevices((result.data ?? []) as DeviceSession[]);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!loading && !me) return <Redirect href="/sign-in" />;

  return (
    <Screen title="Profile">
      <Body>Devices signed in to your account. Sign out any you do not recognise.</Body>
      {devices.map((device) => (
        <View
          key={device.id}
          style={{
            borderWidth: 1,
            borderColor: colours.line,
            borderRadius: 10,
            padding: 12,
            gap: 4,
          }}
        >
          <Text style={{ fontSize: 15, color: colours.ink }}>
            {device.userAgent || 'Unknown device'}
          </Text>
          <Text style={{ fontSize: 13, color: colours.muted }}>
            Signed in {new Date(device.createdAt).toUTCString()}
          </Text>
          <Button
            label="Sign out this device"
            variant="quiet"
            onPress={() => void authClient.revokeSession({ token: device.token }).then(load)}
          />
        </View>
      ))}
      <Button
        label="Sign out"
        testID="sign-out"
        onPress={() => void signOut().then(() => router.replace('/sign-in'))}
      />
    </Screen>
  );
}

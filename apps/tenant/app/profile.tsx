import { Redirect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Platform, StyleSheet, Switch, Text, View } from 'react-native';
import { api } from '../src/api';
import { authClient } from '../src/auth-client';
import { toProblem } from '../src/problems';
import { usePush } from '../src/push-context';
import { markPromptAnswered } from '../src/push-prompt';
import type { PushConsent } from '../src/push-registration';
import { useSession } from '../src/session';
import {
  Body,
  Button,
  Card,
  colours,
  ErrorText,
  Heading,
  Loading,
  Notice,
  Screen,
} from '../src/ui';
import { useLoad } from '../src/use-load';

interface DeviceSession {
  readonly id: string;
  readonly token: string;
  readonly userAgent?: string | null;
  readonly createdAt: string | Date;
}

const loadPushConsent = async () => api.tenantMessaging.pushConsent();

/** Profile: notifications (M6 decision 5), devices signed in, remote sign-out and sign-out (AD-06). */
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
    <Screen title="Profile" scroll>
      <Notifications />
      <Heading>Devices</Heading>
      <Body>Devices signed in to your account. Sign out any you do not recognise.</Body>
      {devices.map((device) => (
        <View key={device.id} style={styles.device}>
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

/**
 * Notifications from each landlord, on or off (M6 decision 5). Turning one on asks the phone first
 * when it has not been asked; the API records the choice as consent from the app. The web build
 * has no push, so it says how the landlord reaches the tenant instead.
 */
function Notifications() {
  const { me, expire } = useSession();
  const push = usePush();
  const consent = useLoad(loadPushConsent, Boolean(me) && push.supported);
  const [changed, setChanged] = useState<PushConsent | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [noToken, setNoToken] = useState(false);

  if (!push.supported) {
    return (
      <Card testID="notifications" label="Notifications">
        <Heading>Notifications</Heading>
        <Body testID="push-unavailable">
          {Platform.OS === 'web'
            ? 'Notifications come with the app for iPhone and Android. Here on the web, your landlord reaches you by WhatsApp, SMS or email.'
            : 'Notifications are not available in this version of the app. Your landlord reaches you by WhatsApp, SMS or email.'}
        </Body>
      </Card>
    );
  }

  const list = changed ?? (consent.state.status === 'ready' ? consent.state.data : null);
  const blocked = push.permission === 'denied' || refused;
  // A switch is on only when this phone will get the notifications: the landlord may send them
  // and the phone allows them. The phone's settings can turn them off behind the app's back.
  const reaching = push.permission === 'granted' && !noToken;

  function toggle(companyId: string, on: boolean) {
    if (busy || !me) return;
    setBusy(companyId);
    setProblem(null);
    void markPromptAnswered(me.personId);
    const change: Promise<PushConsent | null> = on
      ? push.turnOn(companyId).then((outcome) => {
          if (outcome.result === 'on') return outcome.consent;
          if (outcome.result === 'unavailable') setNoToken(true);
          else setRefused(true);
          return null;
        })
      : push.turnOff(companyId);
    change
      .then(
        (next) => {
          if (next) setChanged(next);
        },
        (error: unknown) => {
          const found = toProblem(error);
          if (found.status === 401) return expire();
          setProblem(`We could not change your notifications. ${found.message}`);
        },
      )
      .finally(() => setBusy(null));
  }

  return (
    <Card testID="notifications" label="Notifications">
      <Heading>Notifications</Heading>
      <Body>
        Choose which landlords may send you notifications in this app: when a receipt is ready, when
        rent is due, and when they write to you. Each landlord decides what it sends.
      </Body>
      {noToken ? (
        <Notice testID="push-no-token">
          Notifications are not available on this phone just now. Your landlord reaches you by
          WhatsApp, SMS or email.
        </Notice>
      ) : null}
      {blocked ? (
        <Notice testID="push-blocked">
          Notifications are turned off for this app in your phone’s settings. Allow them there
          first, then turn them on here.
        </Notice>
      ) : null}
      {consent.state.status === 'loading' && !changed ? (
        <Loading label="Loading your notification choices" />
      ) : null}
      {consent.state.status === 'error' && !changed ? (
        <View style={styles.stack}>
          <ErrorText>
            We could not load your notification choices. {consent.state.problem.message}
          </ErrorText>
          <Button label="Try again" variant="quiet" testID="retry-push" onPress={consent.retry} />
        </View>
      ) : null}
      {list && list.length === 0 ? (
        <Body testID="no-landlords">
          When you rent from a landlord, you can choose here whether they may send you
          notifications.
        </Body>
      ) : null}
      {list?.map((landlord) => (
        <View key={landlord.companyId} style={styles.row} testID="push-row">
          <Text style={styles.label}>Notifications from {landlord.landlordName}</Text>
          <Switch
            testID="push-toggle"
            accessibilityLabel={`Notifications from ${landlord.landlordName}`}
            value={landlord.granted && reaching}
            disabled={busy !== null || blocked || noToken}
            onValueChange={(on) => toggle(landlord.companyId, on)}
            trackColor={{ true: colours.brand, false: colours.line }}
          />
        </View>
      ))}
      {problem ? <ErrorText testID="push-error">{problem}</ErrorText> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 8 },
  device: {
    borderWidth: 1,
    borderColor: colours.line,
    borderRadius: 10,
    padding: 12,
    gap: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    borderTopWidth: 1,
    borderTopColor: colours.line,
    paddingTop: 10,
  },
  label: { flex: 1, fontSize: 16, color: colours.ink },
});

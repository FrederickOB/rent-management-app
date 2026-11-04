import Constants, { ExecutionEnvironment } from 'expo-constants';
import type * as NotificationsModule from 'expo-notifications';
import { Platform } from 'react-native';

// Push on iOS and Android (M6 decision 5; plan 4.10), through Expo Notifications. The web build
// uses push.web.ts instead, which has none: Metro picks it for the web, so this module and
// expo-notifications never reach the web bundle.

type Notifications = typeof NotificationsModule;

let loaded: Notifications | null = null;
/**
 * Loaded on first use, not at start-up: the app opens without it, and screens (and tests) that
 * never touch push never load it. An inline require, which Metro supports; Jest's Babel setup
 * leaves a dynamic import() untransformed.
 */
const notifications = async (): Promise<Notifications> =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded on first use (above)
  (loaded ??= require('expo-notifications') as Notifications);

export type PushPermission = 'granted' | 'denied' | 'undetermined';

/** The `data` a notification carries: ids and the screen to open, never shown to anyone. */
export type TapData = Readonly<Record<string, unknown>>;

/** Expo Go on Android has had no remote push since SDK 53; a development or store build has. */
export const pushSupported: boolean = !(
  Platform.OS === 'android' && Constants.executionEnvironment === ExecutionEnvironment.StoreClient
);

export const devicePlatform: 'ios' | 'android' | 'web' =
  Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';

function statusOf(response: { readonly status?: string } | null | undefined): PushPermission {
  const status = response?.status;
  return status === 'granted' || status === 'undetermined' ? status : 'denied';
}

/** What the phone allows now, without asking. */
export async function permission(): Promise<PushPermission> {
  if (!pushSupported) return 'denied';
  try {
    return statusOf(await (await notifications()).getPermissionsAsync());
  } catch {
    return 'denied';
  }
}

/** Shows the phone's own permission prompt. Only call it from something the person tapped. */
export async function askPermission(): Promise<PushPermission> {
  if (!pushSupported) return 'denied';
  try {
    const module = await notifications();
    // Android 13 asks only once a channel exists, so make the one channel first.
    if (Platform.OS === 'android')
      await module.setNotificationChannelAsync('default', {
        name: 'Rent and messages',
        importance: module.AndroidImportance.DEFAULT,
      });
    return statusOf(await module.requestPermissionsAsync());
  } catch {
    return 'denied';
  }
}

/** The EAS project the push tokens belong to: `extra.eas.projectId` in app.json. */
export function projectId(): string | null {
  const fromConfig = (Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined)
    ?.eas?.projectId;
  const id = typeof fromConfig === 'string' ? fromConfig : Constants.easConfig?.projectId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * This device's Expo push token, or null when there is none to have: no permission, no EAS
 * project configured yet, or a simulator that cannot get one. Never logged.
 */
export async function deviceToken(): Promise<string | null> {
  if (!pushSupported) return null;
  const project = projectId();
  if (!project) return null;
  try {
    const { data } = await (await notifications()).getExpoPushTokenAsync({ projectId: project });
    return typeof data === 'string' && data.length > 0 ? data : null;
  } catch {
    return null;
  }
}

/**
 * While the app is open, a notification shows as the phone shows any: the title and body the
 * server sent, nothing added (decision 5). The app itself never renders a notification's text.
 */
export async function showWhileOpen(): Promise<void> {
  if (!pushSupported) return;
  const module = await notifications();
  module.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      // Android shows no banner without a sound.
      shouldPlaySound: Platform.OS === 'android',
      shouldSetBadge: false,
    }),
  });
}

function tapData(
  response: { actionIdentifier: string; notification: unknown } | null,
  module: Notifications,
): TapData | null {
  if (!response || response.actionIdentifier !== module.DEFAULT_ACTION_IDENTIFIER) return null;
  const data = (response.notification as { request?: { content?: { data?: unknown } } })?.request
    ?.content?.data;
  return data && typeof data === 'object' ? (data as TapData) : null;
}

/**
 * Whether this build can have push at all: a platform that has it, and an EAS project for its
 * tokens. Without the project no token can exist, so the app does not offer notifications.
 */
export const pushAvailable = (): boolean => pushSupported && projectId() !== null;

/** Empties the notification tray: on sign-out, so nothing of the person stays on the phone. */
export async function dismissAll(): Promise<void> {
  if (!pushSupported) return;
  try {
    await (await notifications()).dismissAllNotificationsAsync();
  } catch {
    // Only the tray stays as it was.
  }
}

/** Calls `listener` with each notification the person taps while the app runs. */
export async function listenForTaps(listener: (data: TapData) => void): Promise<() => void> {
  if (!pushSupported) return () => undefined;
  const module = await notifications();
  const subscription = module.addNotificationResponseReceivedListener((response) => {
    const data = tapData(response, module);
    if (data) listener(data);
  });
  return () => subscription.remove();
}

/** The notification whose tap opened the app, once: it is cleared as it is read. */
export async function launchTap(): Promise<TapData | null> {
  if (!pushSupported) return null;
  try {
    const module = await notifications();
    const response = await module.getLastNotificationResponseAsync();
    if (response) await module.clearLastNotificationResponseAsync();
    return tapData(response, module);
  } catch {
    return null;
  }
}

import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from './api';
import { toProblem } from './problems';
import {
  askPermission,
  devicePlatform,
  deviceToken,
  dismissAll,
  permission,
  pushAvailable,
} from './push';

// The device's push token and the tenant's push consent (M6 decision 5). A token belongs to the
// signed-in session: the API drops it when the session is revoked, and the app removes it itself
// on sign-out, and when the phone stops allowing notifications. Consent is the app's toggle,
// recorded by the API as consent from the app, and only once the phone allows notifications and
// this device has a token, so "on" is true.
//
// The token last registered is kept on the device (not in the offline cache, which sign-out
// empties first) until the API has removed it, so an app restarted after the phone's settings
// changed, or a sign-out made offline, can still remove it.

export type PushConsent = Awaited<ReturnType<typeof api.tenantMessaging.pushConsent>>;

const DEVICE_KEY = 'rent.push.v1:device';
/** A sign-out made offline: the session and its token wait for the API to hear of it. */
const SIGN_OUT_KEY = 'rent.push.v1:sign-out-pending';

/** Registered in this run of the app, so a return to the app does not register it again. */
let registeredThisRun: string | null = null;

async function storedToken(): Promise<string | null> {
  try {
    const text = await AsyncStorage.getItem(DEVICE_KEY);
    const token = text ? (JSON.parse(text) as { token?: unknown }).token : null;
    return typeof token === 'string' ? token : null;
  } catch {
    return null;
  }
}

async function storeToken(token: string | null): Promise<void> {
  try {
    if (token) await AsyncStorage.setItem(DEVICE_KEY, JSON.stringify({ token }));
    else await AsyncStorage.removeItem(DEVICE_KEY);
  } catch {
    // Best effort: the API also drops the token with the session.
  }
}

/** Whether this device has a token registered with the API, as far as it knows. */
export const hasRegisteredToken = async (): Promise<boolean> => (await storedToken()) !== null;

/**
 * Registers this device for the signed-in session when the phone already allows notifications.
 * Never asks the phone: that happens only when the person turns notifications on. Answers whether
 * a token is registered.
 */
export async function registerThisDevice(): Promise<boolean> {
  if (!pushAvailable() || (await permission()) !== 'granted') return false;
  const token = await deviceToken();
  if (!token) return false;
  if (registeredThisRun === token) return true;
  await api.tenantMessaging.registerPushDevice({ token, platform: devicePlatform });
  registeredThisRun = token;
  await storeToken(token);
  return true;
}

/**
 * Removes this device's token: before sign-out, or once the phone or the tenant has turned
 * notifications off. The token is forgotten only once the API has removed it, or has said it
 * cannot (a refusal: the session is gone, and the token with it). Offline, it throws and keeps it.
 */
export async function unregisterThisDevice(): Promise<void> {
  const token = registeredThisRun ?? (await storedToken());
  if (!token) return;
  try {
    await api.tenantMessaging.unregisterPushDevice({ token });
  } catch (error) {
    const problem = toProblem(error);
    if (problem.status === null || problem.status >= 500 || problem.status === 429) throw error;
  }
  registeredThisRun = null;
  await storeToken(null);
}

export type TurnOn =
  | { readonly result: 'on'; readonly consent: PushConsent }
  | { readonly result: 'denied' }
  /** The phone allows notifications, but this device has no token to receive them with. */
  | { readonly result: 'unavailable' };

/**
 * Turns notifications on, for one landlord or for all: the phone's prompt first if it has not
 * been asked, then the device, then the consent. A phone that says no, or a device that cannot
 * have a token, records nothing.
 */
export async function turnOnNotifications(companyId?: string): Promise<TurnOn> {
  let allowed = await permission();
  if (allowed === 'undetermined') allowed = await askPermission();
  if (allowed !== 'granted') return { result: 'denied' };
  if (!(await registerThisDevice())) return { result: 'unavailable' };
  const consent = await api.tenantMessaging.setPushConsent({
    granted: true,
    ...(companyId ? { companyId } : {}),
  });
  return { result: 'on', consent };
}

/** Turns notifications off for one landlord or all; the token goes once none is left on. */
export async function turnOffNotifications(companyId?: string): Promise<PushConsent> {
  const consent = await api.tenantMessaging.setPushConsent({
    granted: false,
    ...(companyId ? { companyId } : {}),
  });
  if (!consent.some((landlord) => landlord.granted))
    await unregisterThisDevice().catch(() => undefined);
  return consent;
}

/** The session ended on the API's side, which dropped its token too: forget it here. */
export function forgetRegistration(): void {
  registeredThisRun = null;
  void storeToken(null);
}

/**
 * Before signing out: removes the token while the session still works. Answers false when the
 * API could not be reached, so the sign-out waits for it (`finishPendingSignOut`): until then the
 * phone would keep getting the person's notifications. Empties the notification tray either way.
 */
export async function leaveThisDevice(): Promise<boolean> {
  const had = (registeredThisRun ?? (await storedToken())) !== null;
  let reached = true;
  try {
    await unregisterThisDevice();
  } catch {
    reached = false;
  }
  if (had) await dismissAll();
  return reached;
}

export async function markSignOutPending(): Promise<void> {
  try {
    await AsyncStorage.setItem(SIGN_OUT_KEY, '1');
  } catch {
    // As above.
  }
}

export async function signOutPending(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(SIGN_OUT_KEY)) === '1';
  } catch {
    return false;
  }
}

/**
 * Finishes a sign-out made offline, once the API can be reached: the token, then the session
 * (`signOut`, which also forgets the session on the device). Answers whether it is finished.
 */
export async function finishPendingSignOut(signOut: () => Promise<unknown>): Promise<boolean> {
  try {
    await unregisterThisDevice();
  } catch {
    return false;
  }
  await signOut().catch(() => undefined);
  try {
    await AsyncStorage.removeItem(SIGN_OUT_KEY);
  } catch {
    // As above.
  }
  return true;
}

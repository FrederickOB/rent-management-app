// The web build has no push (M6 decision 5): browsers' web push needs a service worker and keys
// this app does not have, and iOS offers it only to installed web apps. The tenant hears from the
// landlord on WhatsApp, SMS or email instead. Same exports as push.ts, so the screens need no
// platform checks of their own; nothing here loads expo-notifications.

export type PushPermission = 'granted' | 'denied' | 'undetermined';
export type TapData = Readonly<Record<string, unknown>>;

export const pushSupported = false;
export const devicePlatform: 'ios' | 'android' | 'web' = 'web';

export const pushAvailable = (): boolean => false;

export function projectId(): string | null {
  return null;
}

export async function dismissAll(): Promise<void> {}

export async function permission(): Promise<PushPermission> {
  return 'denied';
}

export async function askPermission(): Promise<PushPermission> {
  return 'denied';
}

export async function deviceToken(): Promise<string | null> {
  return null;
}

export async function showWhileOpen(): Promise<void> {}

export async function listenForTaps(_listener: (data: TapData) => void): Promise<() => void> {
  return () => undefined;
}

export async function launchTap(): Promise<TapData | null> {
  return null;
}

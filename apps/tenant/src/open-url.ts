import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';

/**
 * `returned`: the in-app browser has closed (iOS), so the screen can reload now. `opened`: the
 * page is open and the app hears of the person's return from focus and app-state events instead
 * (Android's custom tab, a browser tab on the web).
 */
export type OpenResult = 'opened' | 'returned';

/** The part of `window` the web path uses, so tests can stand in for the browser. */
export interface BrowserWindow {
  open(url?: string, target?: string): OpenedWindow | null;
  readonly location: { assign(url: string): void };
}

export interface OpenedWindow {
  opener: unknown;
  readonly closed: boolean;
  readonly document: { title: string; readonly body: { textContent: string | null } | null };
  readonly location: { replace(url: string): void };
  close(): void;
}

const BROWSER_OPTIONS: WebBrowser.WebBrowserOpenOptions = {
  // Android: in the app's own task, so Back returns to the app.
  createTask: false,
  showTitle: true,
  enableBarCollapsing: true,
  dismissButtonStyle: 'close',
};

/** Only web pages: the URL comes from the API, but nothing else may run in a tab of this app. */
function checked(url: string): string {
  if (!/^https?:\/\//i.test(url)) throw new Error('The API returned a link that is not a web page');
  return url;
}

/**
 * Opens a short-lived URL that must be fetched first: a single-use signing link or a 5-minute link
 * to a signed copy. The URL is used once, here; it is never stored or logged.
 *
 * Call it straight from the tap handler, before any `await`: on the web the tab must open while
 * the tap is still being handled.
 */
export function openFetchedUrl(
  fetchUrl: () => Promise<{ readonly url: string }>,
  waitingText: string,
): Promise<OpenResult> {
  if (Platform.OS === 'web')
    return openInNewTab(window as unknown as BrowserWindow, fetchUrl, waitingText);
  return openInAppBrowser(fetchUrl);
}

async function openInAppBrowser(
  fetchUrl: () => Promise<{ readonly url: string }>,
): Promise<OpenResult> {
  const { url } = await fetchUrl();
  const result = await WebBrowser.openBrowserAsync(checked(url), BROWSER_OPTIONS);
  return result.type === WebBrowser.WebBrowserResultType.OPENED ? 'opened' : 'returned';
}

/**
 * The web. Browsers block a window opened after an awaited request (iOS Safari in particular), so
 * an empty tab opens synchronously, in the tap, and is pointed at the URL once it arrives. Its
 * opener is cut first, so the page never gets a handle on the app. If the browser refuses even
 * that tab, the app's own tab goes to the page instead, and the person comes back with Back.
 */
export async function openInNewTab(
  host: BrowserWindow,
  fetchUrl: () => Promise<{ readonly url: string }>,
  waitingText: string,
): Promise<OpenResult> {
  const tab = host.open('', '_blank');
  if (tab) {
    try {
      tab.opener = null;
    } catch {
      // The signing page's own policy (Cross-Origin-Opener-Policy) cuts the link as well.
    }
    try {
      tab.document.title = waitingText;
      if (tab.document.body) tab.document.body.textContent = waitingText;
    } catch {
      // Only the waiting text is lost.
    }
  }
  let url: string;
  try {
    url = checked((await fetchUrl()).url);
  } catch (error) {
    tab?.close();
    throw error;
  }
  if (!tab) host.location.assign(url);
  // A tab the person closed while waiting stays closed.
  else if (!tab.closed) tab.location.replace(url);
  return 'opened';
}

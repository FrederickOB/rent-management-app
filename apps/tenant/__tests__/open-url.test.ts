import { openInNewTab, type BrowserWindow, type OpenedWindow } from '../src/open-url';

const LINK = 'http://localhost:3702/l/Tz8wzlGq2fz3T8ulnkmXH5m9vDkYB1dC0aCqfbnT2Xw';

function fakeTab(): OpenedWindow & { closedByPerson: boolean } {
  const tab = {
    opener: {} as unknown,
    closedByPerson: false,
    get closed() {
      return tab.closedByPerson;
    },
    document: { title: '', body: { textContent: '' as string | null } },
    location: { replace: jest.fn() },
    close: jest.fn(),
  };
  return tab;
}

function fakeHost(tab: OpenedWindow | null) {
  return {
    open: jest.fn(() => tab),
    location: { assign: jest.fn() },
  } satisfies BrowserWindow;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('TL-07 signing page opened from the web build', () => {
  it('opens the tab in the tap, before the link is fetched, and points it at the link', async () => {
    const tab = fakeTab();
    const host = fakeHost(tab);
    const link = deferred<{ url: string }>();
    const fetchLink = jest.fn(() => link.promise);

    const opened = openInNewTab(host, fetchLink, 'Opening the signing page…');
    // Synchronously, while the tap is still being handled: a later window.open is blocked.
    expect(host.open).toHaveBeenCalledWith('', '_blank');
    expect(tab.opener).toBeNull();
    expect(tab.document.title).toBe('Opening the signing page…');
    expect(tab.document.body?.textContent).toBe('Opening the signing page…');
    expect(tab.location.replace).not.toHaveBeenCalled();

    link.resolve({ url: LINK });
    await expect(opened).resolves.toBe('opened');
    expect(tab.location.replace).toHaveBeenCalledWith(LINK);
    expect(host.location.assign).not.toHaveBeenCalled();
  });

  it('closes the waiting tab when the link cannot be had', async () => {
    const tab = fakeTab();
    const host = fakeHost(tab);
    const refused = Object.assign(new Error('Refused'), { status: 409 });
    await expect(openInNewTab(host, () => Promise.reject(refused), 'Opening…')).rejects.toBe(
      refused,
    );
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.replace).not.toHaveBeenCalled();
  });

  it('goes to the page in the app’s own tab when the browser refuses a new one', async () => {
    const host = fakeHost(null);
    await openInNewTab(host, () => Promise.resolve({ url: LINK }), 'Opening…');
    expect(host.location.assign).toHaveBeenCalledWith(LINK);
  });

  it('leaves a tab the person closed while waiting closed', async () => {
    const tab = fakeTab();
    const host = fakeHost(tab);
    const link = deferred<{ url: string }>();
    const opened = openInNewTab(host, () => link.promise, 'Opening…');
    tab.closedByPerson = true;
    link.resolve({ url: LINK });
    await opened;
    expect(tab.location.replace).not.toHaveBeenCalled();
    expect(host.location.assign).not.toHaveBeenCalled();
  });

  it('never opens anything but a web page in the app’s tab', async () => {
    const tab = fakeTab();
    const host = fakeHost(tab);
    await expect(
      openInNewTab(host, () => Promise.resolve({ url: 'javascript:alert(1)' }), 'Opening…'),
    ).rejects.toThrow(/not a web page/);
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.replace).not.toHaveBeenCalled();
  });
});

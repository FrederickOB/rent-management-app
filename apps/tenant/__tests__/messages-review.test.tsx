import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import { Text } from 'react-native';
import Thread from '../app/messages/[companyId]';
import { newClientMessageId, uuidFromBytes } from '../src/ids';
import { pageForCache } from '../src/messages';
import { forgetOutbox } from '../src/outbox';
import { AGENCY, apiError, LANDLORD, ME } from './fixtures';
import {
  CONVERSATIONS,
  message,
  RECEIPT,
  STORAGE_URL,
  THREAD,
  UPLOAD_ID,
  UUID_V4,
} from './message-fixtures';

// M6 review round (LT findings L9 to L12, L15, L16 and the notes): the outbox keeps order, survives
// the app closing, settles a lost answer from the thread, offers Discard for refusals that cannot
// succeed, and stops at sign-out; the thread is one landlord's, opens attachments and shows read.

const mockExpire = jest.fn();
const mockConversations = jest.fn();
const mockMessages = jest.fn();
const mockSend = jest.fn();
const mockCreateUpload = jest.fn();
const mockDownload = jest.fn();
const mockPick = jest.fn();
const mockParams: { companyId?: string } = {};
const mockSession = { me: ME, loading: false, ended: false, expire: mockExpire };

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: () => true,
  }),
  useLocalSearchParams: () => mockParams,
  useFocusEffect: jest.fn(),
  Redirect: MockRedirect,
}));
jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(),
  WebBrowserResultType: { CANCEL: 'cancel', DISMISS: 'dismiss', OPENED: 'opened' },
}));
jest.mock('../src/session', () => ({ useSession: () => mockSession }));
jest.mock('../src/api', () => ({
  api: {
    tenantMessaging: {
      conversations: (...args: unknown[]) => mockConversations(...args),
      messages: (...args: unknown[]) => mockMessages(...args),
      send: (...args: unknown[]) => mockSend(...args),
      createPhotoUpload: (...args: unknown[]) => mockCreateUpload(...args),
      attachmentDownload: (...args: unknown[]) => mockDownload(...args),
    },
  },
}));
jest.mock('../src/photo-picker', () => ({
  canPickPhotos: true,
  pickPhotos: (...args: unknown[]) => mockPick(...args),
}));

function MockRedirect({ href }: { href: string }) {
  return <Text>Redirected to {href}</Text>;
}

const offline = () => new TypeError('Network request failed');
const storage = jest.fn();
const realFetch = globalThis.fetch;
const openBrowser = WebBrowser.openBrowserAsync as jest.Mock;
const ATTACHMENT_URL = 'https://storage.example.test/rent/photo.jpg?X-Amz-Signature=abc';

type Sent = { clientMessageId: string; body: string; uploadIds: string[] };
const sentAs = (input: Sent) =>
  message({
    direction: 'inbound',
    fromLandlord: false,
    body: input.body,
    clientMessageId: input.clientMessageId,
    deliveryStatus: 'sent',
    createdAt: new Date().toISOString(),
  });
const sends = () => mockSend.mock.calls.map(([input]) => input as Sent);

async function write(text: string) {
  await fireEvent.changeText(await screen.findByTestId('message-input'), text);
  await fireEvent.press(screen.getByTestId('send'));
}

function openThread(companyId: string) {
  mockParams.companyId = companyId;
  return render(<Thread />);
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const mock of [
    mockConversations,
    mockMessages,
    mockSend,
    mockCreateUpload,
    mockDownload,
    mockPick,
    storage,
  ])
    mock.mockReset();
  forgetOutbox();
  mockConversations.mockResolvedValue(CONVERSATIONS);
  mockMessages.mockResolvedValue(THREAD);
  mockSend.mockImplementation(async (input: Sent) => sentAs(input));
  storage.mockResolvedValue({ ok: true, status: 204 });
  globalThis.fetch = storage as unknown as typeof fetch;
  openBrowser.mockResolvedValue({ type: 'cancel' });
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('CM-05 a send whose answer was lost (clientMessageId)', () => {
  it('is settled by the thread: the landlord has it, so it is not sent again and shows once', async () => {
    let reached: ReturnType<typeof sentAs> | null = null;
    // The API stores the message, and the answer never comes back.
    mockSend.mockImplementationOnce(async (input: Sent) => {
      reached = sentAs(input);
      throw offline();
    });
    const first = await openThread(AGENCY.companyId);
    await write('Did my message reach you?');
    await waitFor(() =>
      expect(screen.getByTestId('pending-message')).toHaveTextContent(/Not sent\./),
    );
    await first.unmount();

    mockMessages.mockImplementation(async () => ({
      items: reached ? [reached, ...THREAD.items] : THREAD.items,
      nextCursor: null,
    }));
    await openThread(AGENCY.companyId);
    await waitFor(() => expect(screen.queryByTestId('pending-message')).not.toBeOnTheScreen());
    expect(screen.getAllByText('Did my message reach you?')).toHaveLength(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe('CM-05 the thread is one landlord’s (TL-12)', () => {
  it('a mounted thread that is given another landlord starts afresh', async () => {
    mockSend.mockRejectedValue(offline());
    const view = await openThread(AGENCY.companyId);
    expect(await screen.findByTestId('thread-title')).toHaveTextContent(AGENCY.name);
    await write('For the agency only.');
    await waitFor(() => expect(screen.getByTestId('retry-send')).toBeOnTheScreen());
    await fireEvent.changeText(screen.getByTestId('message-input'), 'A draft for the agency');

    mockMessages.mockResolvedValue({ items: [], nextCursor: null });
    mockParams.companyId = LANDLORD.companyId;
    await view.rerender(<Thread />);
    expect(await screen.findByTestId('thread-title')).toHaveTextContent(LANDLORD.name);
    expect(await screen.findByTestId('no-messages')).toBeOnTheScreen();
    expect(mockMessages).toHaveBeenLastCalledWith({ companyId: LANDLORD.companyId, limit: 30 });
    expect(screen.getByTestId('message-input')).toHaveDisplayValue('');
    expect(screen.queryByTestId('pending-message')).not.toBeOnTheScreen();
    expect(screen.queryByText(/For the agency only/)).not.toBeOnTheScreen();
  });
});

describe('CM-05 messages reach the landlord in the order written (L11)', () => {
  it('sends one at a time: a second message waits until the first is in', async () => {
    let finishFirst: () => void = () => undefined;
    mockSend.mockImplementationOnce(
      (input: Sent) =>
        new Promise((resolve) => {
          finishFirst = () => resolve(sentAs(input));
        }),
    );
    await openThread(AGENCY.companyId);
    await write('First');
    await write('Second');
    await waitFor(() => expect(screen.getAllByTestId('pending-message')).toHaveLength(2));
    expect(mockSend).toHaveBeenCalledTimes(1);
    await act(async () => finishFirst());
    await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2));
    expect(sends().map((input) => input.body)).toEqual(['First', 'Second']);
    await waitFor(() => expect(screen.queryByTestId('pending-message')).not.toBeOnTheScreen());
  });

  it('one that fails holds back the later ones, and Try again sends them all, in order', async () => {
    mockSend.mockRejectedValueOnce(offline());
    await openThread(AGENCY.companyId);
    await write('One');
    await waitFor(() => expect(screen.getByTestId('retry-send')).toBeOnTheScreen());
    mockSend.mockRejectedValueOnce(offline());
    await write('Two');
    await waitFor(() => expect(screen.getAllByTestId('retry-send')).toHaveLength(2));
    const [one, two] = screen.getAllByTestId('pending-message');
    expect(one).toHaveTextContent(/^You.*One.*Not sent\. We could not reach the server/);
    expect(two).toHaveTextContent(/Not sent\. It waits for your earlier message\./);
    // "Two" never went before "One" was in.
    expect(sends().map((input) => input.body)).toEqual(['One', 'One']);

    await fireEvent.press(within(two!).getByTestId('retry-send'));
    await waitFor(() => expect(screen.queryByTestId('pending-message')).not.toBeOnTheScreen());
    expect(sends().map((input) => input.body)).toEqual(['One', 'One', 'One', 'Two']);
    const ids = sends().map((input) => input.clientMessageId);
    expect(new Set(ids.slice(0, 3)).size).toBe(1);
    expect(ids[3]).not.toBe(ids[0]);
  });
});

describe('CM-05 a message that cannot be sent as it is (L9)', () => {
  it('a reused clientMessageId (422) offers Discard, not Try again, and says why', async () => {
    mockSend.mockRejectedValueOnce(
      apiError(
        422,
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was used for a different request.',
      ),
    );
    await openThread(AGENCY.companyId);
    await write('Hello again');
    const pending = await screen.findByTestId('pending-message');
    await waitFor(() =>
      expect(within(pending).getByTestId('delivery')).toHaveTextContent(
        'Not sent. Your landlord may already have this message: check above, then discard it.',
      ),
    );
    expect(within(pending).queryByTestId('retry-send')).not.toBeOnTheScreen();
    await fireEvent.press(within(pending).getByTestId('discard-send'));
    expect(screen.queryByTestId('pending-message')).not.toBeOnTheScreen();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('a refusal of the conversation (404) offers Discard only', async () => {
    mockSend.mockRejectedValueOnce(
      apiError(404, 'NOT_FOUND', 'This conversation is not available.'),
    );
    await openThread(AGENCY.companyId);
    await write('Hello?');
    const pending = await screen.findByTestId('pending-message');
    await waitFor(() => expect(within(pending).getByTestId('discard-send')).toBeOnTheScreen());
    expect(within(pending).queryByTestId('retry-send')).not.toBeOnTheScreen();
  });

  it('an upload the API refuses at send is uploaded again on the next try', async () => {
    mockPick.mockResolvedValue([
      { name: 'tap.jpg', contentType: 'image/jpeg', sizeBytes: 50_000, part: new Blob(['x']) },
    ]);
    mockCreateUpload
      .mockResolvedValueOnce({ uploadId: UPLOAD_ID, url: STORAGE_URL, fields: {}, expiresAt: 'x' })
      .mockResolvedValueOnce({
        uploadId: '0193a7c0-0000-7000-8000-0000000a0002',
        url: STORAGE_URL,
        fields: {},
        expiresAt: 'x',
      });
    mockSend.mockRejectedValueOnce(apiError(409, 'UPLOAD_EXPIRED', 'That upload has expired.'));
    await openThread(AGENCY.companyId);
    await fireEvent.press(await screen.findByTestId('add-photo'));
    await screen.findByTestId('photo-chip');
    await write('The tap drips.');
    const pending = await screen.findByTestId('pending-message');
    await waitFor(() => expect(within(pending).getByTestId('retry-send')).toBeOnTheScreen());
    await fireEvent.press(within(pending).getByTestId('retry-send'));
    await waitFor(() => expect(screen.queryByTestId('pending-message')).not.toBeOnTheScreen());
    expect(mockCreateUpload).toHaveBeenCalledTimes(2);
    expect(sends()[1]).toMatchObject({
      uploadIds: ['0193a7c0-0000-7000-8000-0000000a0002'],
      clientMessageId: sends()[0]!.clientMessageId,
    });
  });
});

describe('CM-05 a message written offline survives the app closing (L10)', () => {
  it('comes back as not sent, and Try again sends it with the same clientMessageId', async () => {
    mockSend.mockRejectedValueOnce(offline());
    const first = await openThread(AGENCY.companyId);
    await write('Written on the bus.');
    await waitFor(() => expect(screen.getByTestId('retry-send')).toBeOnTheScreen());
    await first.unmount();
    // The app closes: everything in memory goes; what the phone kept stays.
    forgetOutbox();

    await openThread(AGENCY.companyId);
    const pending = await screen.findByTestId('pending-message');
    expect(pending).toHaveTextContent(/Written on the bus\./);
    expect(within(pending).getByTestId('delivery')).toHaveTextContent(/^Not sent\./);
    await fireEvent.press(within(pending).getByTestId('retry-send'));
    await waitFor(() => expect(screen.queryByTestId('pending-message')).not.toBeOnTheScreen());
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(sends()[1]!.clientMessageId).toBe(sends()[0]!.clientMessageId);
    // Sent, it is no longer kept.
    const kept = JSON.stringify(await AsyncStorage.multiGet(await AsyncStorage.getAllKeys()));
    expect(kept).not.toContain('Written on the bus.');
  });

  it('a photo not uploaded before the app closed is not kept: the words can still go', async () => {
    mockPick.mockResolvedValue([
      { name: 'crack.jpg', contentType: 'image/jpeg', sizeBytes: 50_000, part: new Blob(['x']) },
    ]);
    mockCreateUpload.mockRejectedValueOnce(offline());
    const first = await openThread(AGENCY.companyId);
    await fireEvent.press(await screen.findByTestId('add-photo'));
    await screen.findByTestId('photo-chip');
    await write('A crack in the wall.');
    await waitFor(() => expect(screen.getByTestId('retry-send')).toBeOnTheScreen());
    await first.unmount();
    forgetOutbox();

    await openThread(AGENCY.companyId);
    const pending = await screen.findByTestId('pending-message');
    expect(within(pending).getByTestId('delivery')).toHaveTextContent(
      /The app closed before your photo was uploaded/,
    );
    await fireEvent.press(within(pending).getByTestId('retry-send'));
    await waitFor(() => expect(screen.queryByTestId('pending-message')).not.toBeOnTheScreen());
    expect(sends().at(-1)).toMatchObject({ body: 'A crack in the wall.', uploadIds: [] });
  });

  it('is kept per landlord: another landlord’s thread brings back none of it', async () => {
    mockSend.mockRejectedValueOnce(offline());
    const first = await openThread(AGENCY.companyId);
    await write('Only for the agency.');
    await waitFor(() => expect(screen.getByTestId('retry-send')).toBeOnTheScreen());
    await first.unmount();
    forgetOutbox();
    mockMessages.mockResolvedValue({ items: [], nextCursor: null });
    await openThread(LANDLORD.companyId);
    await screen.findByTestId('no-messages');
    await act(async () => undefined);
    expect(screen.queryByTestId('pending-message')).not.toBeOnTheScreen();
  });
});

describe('CM-05 nothing carries on after sign-out', () => {
  it('a send still on its way when the person signs out leaves nothing behind', async () => {
    let finish: () => void = () => undefined;
    mockSend.mockImplementationOnce(
      (input: Sent) =>
        new Promise((resolve) => {
          finish = () => resolve(sentAs(input));
        }),
    );
    await openThread(AGENCY.companyId);
    await write('Sent as I signed out.');
    await screen.findByTestId('pending-message');
    await act(async () => forgetOutbox());
    expect(screen.queryByTestId('pending-message')).not.toBeOnTheScreen();
    await act(async () => finish());
    await act(async () => undefined);
    expect(screen.queryByText('Sent as I signed out.')).not.toBeOnTheScreen();
    expect(mockMessages).toHaveBeenCalledTimes(1);
  });
});

describe('CM-05 the thread shows what the API knows about each message (L16)', () => {
  it('the tenant’s own message says when the landlord has read it', async () => {
    mockMessages.mockResolvedValue({
      items: [
        message({
          direction: 'inbound',
          fromLandlord: false,
          body: 'Read one',
          deliveryStatus: 'read',
        }),
        message({
          direction: 'inbound',
          fromLandlord: false,
          body: 'Just sent',
          deliveryStatus: 'sent',
          createdAt: '2026-11-04T09:30:00.000Z',
        }),
      ],
      nextCursor: null,
    });
    await openThread(AGENCY.companyId);
    const [read, sent] = await screen.findAllByTestId('own-message');
    expect(within(read!).getByTestId('delivery')).toHaveTextContent('Read');
    expect(within(sent!).getByTestId('delivery')).toHaveTextContent('Sent');
  });

  it('opens an attachment through a short-lived link fetched at the tap, never kept', async () => {
    mockDownload.mockResolvedValue({ url: ATTACHMENT_URL, expiresAt: '2026-11-04T12:05:00.000Z' });
    await openThread(AGENCY.companyId);
    await fireEvent.press(await screen.findByTestId('open-attachment'));
    await waitFor(() => expect(openBrowser).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('open-attachment')).toHaveTextContent('View the photo');
    expect(mockDownload).toHaveBeenCalledWith({
      companyId: AGENCY.companyId,
      messageId: RECEIPT.id,
      attachmentId: RECEIPT.attachments[0]!.id,
    });
    expect(openBrowser.mock.calls[0]![0]).toBe(ATTACHMENT_URL);
    const kept = JSON.stringify(await AsyncStorage.multiGet(await AsyncStorage.getAllKeys()));
    expect(kept).not.toContain('X-Amz-Signature');
  });

  it('the offline cache keeps no link in a caption or file name, so the page is still kept', () => {
    const page = pageForCache({
      items: [
        message({
          attachments: [
            {
              ...RECEIPT.attachments[0]!,
              caption: 'See https://example.test/leak',
              filename: 'from http://x.test/a.jpg',
            },
          ],
          attachmentCount: 1,
        }),
      ],
      nextCursor: null,
    });
    expect(JSON.stringify(page)).not.toContain('://');
    expect(page.items[0]!.attachments[0]!.caption).toBe('See [link]');
  });
});

describe('CM-05 clientMessageId is a proper random UUID', () => {
  it('comes from Web Crypto where there is one, otherwise the platform’s generator', () => {
    const fromWeb = newClientMessageId({ getRandomValues: (bytes) => bytes.fill(0xab) });
    expect(fromWeb).toBe(uuidFromBytes(new Uint8Array(16).fill(0xab)));
    expect(fromWeb).toMatch(UUID_V4);
    const native = jest.fn(() => 'C0FFEE00-0000-4000-8000-0000000000AA');
    expect(newClientMessageId({}, native)).toBe('c0ffee00-0000-4000-8000-0000000000aa');
    expect(native).toHaveBeenCalledTimes(1);
    const random = jest.spyOn(Math, 'random');
    newClientMessageId();
    newClientMessageId({}, native);
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });
});

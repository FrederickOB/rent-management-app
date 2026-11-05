import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { Text } from 'react-native';
import Thread from '../app/messages/[companyId]';
import Messages from '../app/messages/index';
import { forgetOutbox } from '../src/outbox';
import { AGENCY, apiError, guardError, LANDLORD, ME } from './fixtures';
import {
  CONVERSATIONS,
  message,
  OLDEST,
  OWN,
  RECEIPT,
  STORAGE_URL,
  THREAD,
  UPLOAD_ID,
  UUID_V4,
} from './message-fixtures';

const mockPush = jest.fn();
const mockExpire = jest.fn();
const mockConversations = jest.fn();
const mockMessages = jest.fn();
const mockSend = jest.fn();
const mockCreateUpload = jest.fn();
const mockPick = jest.fn();
const mockParams: { companyId?: string } = {};
const mockSession = { me: ME, loading: false, ended: false, expire: mockExpire };

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: mockPush,
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: () => true,
  }),
  useLocalSearchParams: () => mockParams,
  useFocusEffect: jest.fn(),
  Redirect: MockRedirect,
}));
jest.mock('../src/session', () => ({ useSession: () => mockSession }));
jest.mock('../src/api', () => ({
  api: {
    tenantMessaging: {
      conversations: (...args: unknown[]) => mockConversations(...args),
      messages: (...args: unknown[]) => mockMessages(...args),
      send: (...args: unknown[]) => mockSend(...args),
      createPhotoUpload: (...args: unknown[]) => mockCreateUpload(...args),
    },
  },
}));
// The phone apps have no photo picker yet (src/photo-picker.ts); the web build's stands in here.
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

/** What the tenant sends back as the API answers it: their message, on the in-app channel. */
const sentAs = (body: string) =>
  message({ direction: 'inbound', fromLandlord: false, body, createdAt: new Date().toISOString() });

function openThread(companyId: string) {
  mockParams.companyId = companyId;
  return render(<Thread />);
}

async function write(text: string) {
  await fireEvent.changeText(await screen.findByTestId('message-input'), text);
  await fireEvent.press(screen.getByTestId('send'));
}

beforeEach(() => {
  jest.clearAllMocks();
  // This file's own mocks are reset, not only cleared: a one-time answer that a failed test never
  // used must not reach the next test. (Resetting all mocks would empty the AsyncStorage mock.)
  for (const mock of [
    mockConversations,
    mockMessages,
    mockSend,
    mockCreateUpload,
    mockPick,
    storage,
  ])
    mock.mockReset();
  forgetOutbox();
  mockConversations.mockResolvedValue(CONVERSATIONS);
  mockMessages.mockResolvedValue(THREAD);
  mockSend.mockImplementation(async (input: { body: string }) => sentAs(input.body));
  storage.mockResolvedValue({ ok: true, status: 204 });
  globalThis.fetch = storage as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

describe('CM-05 tenant app messages: one conversation per landlord (TL-12)', () => {
  it('lists a conversation with each landlord, with its last message and what is new', async () => {
    await render(<Messages />);
    const rows = await screen.findAllByTestId('conversation-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAccessibleName(`Messages with ${AGENCY.name}, 2 new`);
    expect(rows[0]).toHaveTextContent(/Your receipt RCT-2026-000057 is ready\./);
    expect(rows[0]).toHaveTextContent(/4 Nov 2026, 09:15 GMT \(Africa\/Accra\)/);
    expect(within(rows[0]!).getByTestId('unread')).toHaveTextContent('2 new');
    expect(rows[1]).toHaveAccessibleName(`Messages with ${LANDLORD.name}`);
    expect(rows[1]).toHaveTextContent(`No messages yet. Write to ${LANDLORD.name}.`, {
      exact: false,
    });
    expect(within(rows[1]!).queryByTestId('unread')).not.toBeOnTheScreen();

    await fireEvent.press(rows[1]!);
    expect(mockPush).toHaveBeenCalledWith(`/messages/${LANDLORD.companyId}`);
  });

  it('says so when the tenant rents from no one yet', async () => {
    mockConversations.mockResolvedValue([]);
    await render(<Messages />);
    expect(await screen.findByTestId('no-conversations')).toHaveTextContent(
      /When you rent from a landlord, you can write to them here/,
    );
  });

  it('keeps each landlord’s thread, and what the tenant is still sending, apart', async () => {
    mockSend.mockRejectedValue(offline());
    const agency = await openThread(AGENCY.companyId);
    expect(await screen.findByTestId('thread-title')).toHaveTextContent(AGENCY.name);
    await screen.findAllByTestId('landlord-message');
    expect(mockMessages).toHaveBeenCalledWith({ companyId: AGENCY.companyId, limit: 30 });
    await write('Can I pay the agency on Friday?');
    await waitFor(() => expect(screen.getByTestId('retry-send')).toBeOnTheScreen());
    expect(mockSend.mock.calls[0]![0]).toMatchObject({ companyId: AGENCY.companyId });
    await agency.unmount();

    mockMessages.mockResolvedValue({ items: [], nextCursor: null });
    await openThread(LANDLORD.companyId);
    expect(await screen.findByTestId('thread-title')).toHaveTextContent(LANDLORD.name);
    expect(await screen.findByTestId('no-messages')).toBeOnTheScreen();
    expect(mockMessages).toHaveBeenLastCalledWith({ companyId: LANDLORD.companyId, limit: 30 });
    // The agency's unsent message stays in the agency's thread.
    expect(screen.queryByTestId('pending-message')).not.toBeOnTheScreen();
    expect(screen.queryByText('Can I pay the agency on Friday?')).not.toBeOnTheScreen();
  });

  it('shows an id that is not a landlord’s as not available, and asks the API nothing', async () => {
    await openThread('../../payments');
    expect(await screen.findByTestId('not-found')).toHaveTextContent(
      'This conversation is not available.',
    );
    expect(mockMessages).not.toHaveBeenCalled();
    expect(screen.queryByTestId('message-input')).not.toBeOnTheScreen();
  });
});

describe('CM-05 the thread: reading', () => {
  it('shows the landlord’s messages and the tenant’s own, oldest first, with when and how each came', async () => {
    await openThread(AGENCY.companyId);
    await waitFor(() => expect(screen.getByTestId('thread-title')).toHaveTextContent(AGENCY.name));
    await screen.findAllByTestId('landlord-message');
    const bubbles = screen.getAllByTestId(/^(own|landlord)-message$/);
    expect(bubbles).toHaveLength(3);
    expect(bubbles[0]).toHaveTextContent(new RegExp(OLDEST.body));
    expect(bubbles[1]).toHaveTextContent(/Your receipt is ready/);
    expect(bubbles[1]).toHaveTextContent(/By WhatsApp/);
    expect(within(bubbles[1]!).getByTestId('attachments')).toHaveTextContent('1 photo');
    expect(bubbles[2]).toHaveTextContent(new RegExp(OWN.body));
    expect(bubbles[2]).toHaveTextContent(/^You/);
    expect(bubbles[2]).toHaveTextContent(/4 Nov 2026, 09:15 GMT \(Africa\/Accra\)/);
    // The tenant's own message says it reached the landlord's inbox.
    expect(within(bubbles[2]!).getByTestId('delivery')).toHaveTextContent('Sent');
    expect(within(bubbles[0]!).queryByTestId('delivery')).not.toBeOnTheScreen();
    expect(bubbles[0]).toHaveTextContent(new RegExp(`^${AGENCY.name}`));
  });

  it('shows earlier messages on request, before the ones already shown', async () => {
    const earlier = message({
      body: 'Your lease is ready to sign.',
      createdAt: '2026-10-20T08:00:00.000Z',
    });
    mockMessages.mockResolvedValueOnce({ items: [OWN, RECEIPT], nextCursor: 'page-2' });
    mockMessages.mockResolvedValueOnce({ items: [OLDEST, earlier], nextCursor: null });
    await openThread(AGENCY.companyId);
    await fireEvent.press(await screen.findByTestId('show-earlier'));
    await waitFor(() => expect(screen.getAllByTestId(/^(own|landlord)-message$/)).toHaveLength(4));
    expect(mockMessages).toHaveBeenLastCalledWith({
      companyId: AGENCY.companyId,
      cursor: 'page-2',
      limit: 30,
    });
    const bubbles = screen.getAllByTestId(/^(own|landlord)-message$/);
    expect(bubbles[0]).toHaveTextContent(/Your lease is ready to sign/);
    expect(bubbles[3]).toHaveTextContent(new RegExp(OWN.body));
    expect(screen.queryByTestId('show-earlier')).not.toBeOnTheScreen();
  });
});

describe('CM-05 the thread: writing, with retries that never make a second message', () => {
  it('sends what the tenant writes with a clientMessageId, and shows it as sent', async () => {
    await openThread(AGENCY.companyId);
    await write('  Is the plumber coming today?  ');
    expect(await screen.findByText('Is the plumber coming today?')).toBeOnTheScreen();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith({
      companyId: AGENCY.companyId,
      clientMessageId: expect.stringMatching(UUID_V4),
      body: 'Is the plumber coming today?',
      uploadIds: [],
    });
    await waitFor(() => expect(screen.queryByTestId('pending-message')).not.toBeOnTheScreen());
    const own = screen.getAllByTestId('own-message');
    expect(own.at(-1)).toHaveTextContent(/Is the plumber coming today\?/);
    expect(within(own.at(-1)!).getByTestId('delivery')).toHaveTextContent('Sent');
    expect(screen.getByTestId('message-input')).toHaveDisplayValue('');
    // The thread is fetched again, for anything the landlord wrote meanwhile.
    await waitFor(() => expect(mockMessages).toHaveBeenCalledTimes(2));
  });

  it('a failed send shows Not sent with Try again, and the retry repeats the clientMessageId, so the landlord gets it once', async () => {
    let delivered: ReturnType<typeof sentAs> | null = null;
    mockSend.mockRejectedValueOnce(offline()).mockImplementationOnce(async (input) => {
      delivered = { ...sentAs((input as { body: string }).body) };
      return delivered;
    });
    await openThread(AGENCY.companyId);
    await write('The gate lock is broken.');
    const pending = await screen.findByTestId('pending-message');
    await waitFor(() =>
      expect(within(pending).getByTestId('delivery')).toHaveTextContent(
        /^Not sent\. We could not reach the server/,
      ),
    );
    // The API's next answer to the thread already holds the message the retry makes.
    mockMessages.mockImplementation(async () => ({
      items: delivered ? [delivered, ...THREAD.items] : THREAD.items,
      nextCursor: null,
    }));
    await fireEvent.press(within(pending).getByTestId('retry-send'));
    await waitFor(() => expect(screen.queryByTestId('pending-message')).not.toBeOnTheScreen());

    expect(mockSend).toHaveBeenCalledTimes(2);
    const [first, second] = mockSend.mock.calls.map(
      ([input]) => input as { clientMessageId: string },
    );
    expect(second!.clientMessageId).toBe(first!.clientMessageId);
    await waitFor(() => expect(mockMessages).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText('The gate lock is broken.')).toHaveLength(1);
  });

  it('a second tap on Send while the first is on its way sends nothing more', async () => {
    let finish: (value: unknown) => void = () => undefined;
    mockSend.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await openThread(AGENCY.companyId);
    await write('Hello?');
    expect(await screen.findByTestId('pending-message')).toHaveTextContent(/Sending…/);
    await fireEvent.press(screen.getByTestId('send'));
    expect(screen.getByTestId('composer-error')).toHaveTextContent(
      'Write a message or add a photo.',
    );
    expect(mockSend).toHaveBeenCalledTimes(1);
    finish(sentAs('Hello?'));
    await waitFor(() => expect(screen.queryByTestId('pending-message')).not.toBeOnTheScreen());
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('uploads photos to storage first, through presigned posts, and a retry does not upload them again', async () => {
    mockPick.mockResolvedValue([
      {
        name: 'leak.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 2_400_000,
        part: new Blob(['jpeg bytes'], { type: 'image/jpeg' }),
      },
    ]);
    mockCreateUpload.mockResolvedValue({
      uploadId: UPLOAD_ID,
      url: STORAGE_URL,
      fields: { key: 'uploads/messages/abc', policy: 'cG9saWN5' },
      expiresAt: '2026-11-04T12:10:00.000Z',
    });
    mockSend.mockRejectedValueOnce(apiError(503, 'UNAVAILABLE', 'Unavailable'));
    await openThread(AGENCY.companyId);
    await fireEvent.press(await screen.findByTestId('add-photo'));
    expect(await screen.findByTestId('photo-chip')).toHaveTextContent(/^Photo 1 \(2\.4 MB\)/);
    expect(mockPick).toHaveBeenCalledWith(5);

    await write('Water is leaking under the sink.');
    const pending = await screen.findByTestId('pending-message');
    await waitFor(() => expect(within(pending).getByTestId('retry-send')).toBeOnTheScreen());
    expect(mockCreateUpload).toHaveBeenCalledTimes(1);
    expect(mockCreateUpload).toHaveBeenCalledWith({
      companyId: AGENCY.companyId,
      contentType: 'image/jpeg',
      sizeBytes: 2_400_000,
    });
    expect(storage).toHaveBeenCalledTimes(1);
    const [url, init] = storage.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(STORAGE_URL);
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit' });
    // The policy's fields first, then the file, as storage expects.
    expect([...(init.body as FormData).keys()]).toEqual(['key', 'policy', 'file']);
    expect((init.body as FormData).get('file')).toBeInstanceOf(Blob);
    expect(mockSend.mock.calls[0]![0]).toMatchObject({ uploadIds: [UPLOAD_ID] });

    await fireEvent.press(within(pending).getByTestId('retry-send'));
    await waitFor(() => expect(screen.queryByTestId('pending-message')).not.toBeOnTheScreen());
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls[1]![0]).toMatchObject({
      clientMessageId: (mockSend.mock.calls[0]![0] as { clientMessageId: string }).clientMessageId,
      uploadIds: [UPLOAD_ID],
    });
    expect(mockCreateUpload).toHaveBeenCalledTimes(1);
    expect(storage).toHaveBeenCalledTimes(1);
  });

  it('a photo storage refuses leaves the message not sent, to try again', async () => {
    mockPick.mockResolvedValue([
      { name: 'a.png', contentType: 'image/png', sizeBytes: 80_000, part: new Blob(['x']) },
    ]);
    mockCreateUpload.mockResolvedValue({
      uploadId: UPLOAD_ID,
      url: STORAGE_URL,
      fields: {},
      expiresAt: '2026-11-04T12:10:00.000Z',
    });
    storage.mockResolvedValueOnce({ ok: false, status: 403 });
    await openThread(AGENCY.companyId);
    await fireEvent.press(await screen.findByTestId('add-photo'));
    await screen.findByTestId('photo-chip');
    await fireEvent.press(screen.getByTestId('send'));
    const pending = await screen.findByTestId('pending-message');
    await waitFor(() =>
      expect(within(pending).getByTestId('delivery')).toHaveTextContent(
        'Not sent. A photo could not be uploaded.',
      ),
    );
    expect(mockSend).not.toHaveBeenCalled();
    await fireEvent.press(within(pending).getByTestId('retry-send'));
    await waitFor(() => expect(screen.queryByTestId('pending-message')).not.toBeOnTheScreen());
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ body: '', uploadIds: [UPLOAD_ID] }),
    );
  });

  it('refuses a photo of another type or over 10 MB, and an empty message', async () => {
    mockPick.mockResolvedValue([
      { name: 'a.gif', contentType: 'image/gif', sizeBytes: 1_000, part: new Blob(['x']) },
      { name: 'b.jpg', contentType: 'image/jpeg', sizeBytes: 10_000_001, part: new Blob(['x']) },
    ]);
    await openThread(AGENCY.companyId);
    await fireEvent.press(await screen.findByTestId('add-photo'));
    await waitFor(() => expect(screen.getByTestId('composer-error')).toBeOnTheScreen());
    expect(screen.getByTestId('composer-error')).toHaveTextContent(/too big/);
    expect(screen.queryByTestId('photo-chip')).not.toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('send'));
    expect(screen.getByTestId('composer-error')).toHaveTextContent(
      'Write a message or add a photo.',
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('sends the tenant to sign in when the session has ended', async () => {
    mockSend.mockRejectedValueOnce(guardError(401, 'not_authenticated', 'Sign in'));
    await openThread(AGENCY.companyId);
    await write('Hello');
    await waitFor(() => expect(mockExpire).toHaveBeenCalled());
  });
});

describe('CM-05 the thread offline', () => {
  it('shows the thread last fetched, with when, and a message written offline waits as Not sent until a retry works', async () => {
    const online = await openThread(AGENCY.companyId);
    await screen.findAllByTestId('landlord-message');
    await waitFor(async () =>
      expect(await AsyncStorage.getAllKeys()).toEqual(
        expect.arrayContaining([`rent.cache.v1:${ME.personId}:messages:${AGENCY.companyId}`]),
      ),
    );
    await online.unmount();

    mockMessages.mockRejectedValue(offline());
    mockConversations.mockRejectedValue(offline());
    mockSend.mockRejectedValueOnce(offline());
    await openThread(AGENCY.companyId);
    expect(await screen.findByTestId('offline')).toHaveTextContent(
      /You are offline\. These are the messages we last fetched, at .+ \(Africa\/Accra\)/,
    );
    expect(screen.getByTestId('thread-title')).toHaveTextContent(AGENCY.name);
    expect(screen.getAllByTestId(/^(own|landlord)-message$/)).toHaveLength(3);
    // The cache keeps no link: the receipt's address shows as [link].
    expect(screen.getByText('Your receipt is ready: [link]')).toBeOnTheScreen();

    await write('Sent from the bus.');
    const pending = await screen.findByTestId('pending-message');
    await waitFor(() =>
      expect(within(pending).getByTestId('delivery')).toHaveTextContent(/^Not sent\./),
    );
    await fireEvent.press(within(pending).getByTestId('retry-send'));
    await waitFor(() => expect(screen.queryByTestId('pending-message')).not.toBeOnTheScreen());
    expect(await screen.findByText('Sent from the bus.')).toBeOnTheScreen();
    expect(mockSend).toHaveBeenCalledTimes(2);

    const stored = JSON.stringify(await AsyncStorage.multiGet(await AsyncStorage.getAllKeys()));
    expect(stored).not.toContain('://');
    expect(stored).not.toContain('Sent from the bus.');
  });
});

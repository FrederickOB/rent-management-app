import AsyncStorage from '@react-native-async-storage/async-storage';
import type { TenantNoticeView, TenantSigningView } from '@rent/contracts';
import { NOTICE_SIGNING_STATEMENT } from '@rent/domain/esign';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import { Text } from 'react-native';
import Home from '../app/home';
import TenancyScreen from '../app/tenancy/[leaseId]';
import ToSign from '../app/to-sign';
import { clearCache, readCache } from '../src/cache';
import { toSignSummary } from '../src/signing-items';
import {
  AGENCY,
  apiError,
  detail,
  LANDLORD,
  ME,
  SIGNER_ID,
  signingItem,
  TWO_LANDLORDS,
} from './fixtures';

// M7 plan 4.5 and 4.10 (LN-02, LN-04; TL-07, TL-12): notices in the tenant app, under To sign and
// among the tenancy's documents.

const mockPush = jest.fn();
const mockExpire = jest.fn();
const mockSigning = jest.fn();
const mockSigningLink = jest.fn();
const mockTenancies = jest.fn();
const mockTenancy = jest.fn();
const mockNotices = jest.fn();
const mockNoticeDocument = jest.fn();
const mockConversations = jest.fn();
const mockParams = { leaseId: '0193a7c0-0000-7000-8000-0000000000a1' };
const mockSession = { me: ME, loading: false, ended: false, expire: mockExpire };

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
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
    tenantApp: {
      signing: (...args: unknown[]) => mockSigning(...args),
      signingLink: (...args: unknown[]) => mockSigningLink(...args),
      tenancies: (...args: unknown[]) => mockTenancies(...args),
      tenancy: (...args: unknown[]) => mockTenancy(...args),
      notices: (...args: unknown[]) => mockNotices(...args),
      noticeDocument: (...args: unknown[]) => mockNoticeDocument(...args),
    },
    tenantMessaging: { conversations: (...args: unknown[]) => mockConversations(...args) },
  },
}));

function MockRedirect({ href }: { href: string }) {
  return <Text>Redirected to {href}</Text>;
}

const openBrowser = WebBrowser.openBrowserAsync as jest.Mock;
const SIGNING_URL = 'http://localhost:3702/l/notice-token-not-real';
const NOTICE_URL = 'http://localhost:8333/rent-evidence/notice.pdf?X-Amz-Signature=n0t1c3';
const NOTICE_ID = '0193a7c0-0000-7000-8000-00000000f001';
const OTHER_LEASE = '0193a7c0-0000-7000-8000-0000000000a2';

function noticeItem(overrides: Partial<TenantSigningView> = {}): TenantSigningView {
  return signingItem({
    signingRequestId: '0193a7c0-0000-7000-8000-0000000000e7',
    title: 'Notice of entry N-000007',
    subject: 'notice',
    notice: {
      noticeId: NOTICE_ID,
      number: 'N-000007',
      typeLabel: 'Notice of entry',
      issuedAt: '2026-11-04T09:00:00.000Z',
      effectiveDate: '2026-11-20',
      statement: NOTICE_SIGNING_STATEMENT,
    },
    signers: [{ roleLabel: 'Tenant', name: 'Abena Mensah', status: 'pending' }],
    ...overrides,
  });
}

function notice(overrides: Partial<TenantNoticeView> = {}): TenantNoticeView {
  return {
    noticeId: NOTICE_ID,
    number: 'N-000007',
    typeLabel: 'Notice of entry',
    issuedAt: '2026-11-04T09:00:00.000Z',
    effectiveDate: '2026-11-20',
    leaseId: mockParams.leaseId,
    unitCode: 'ACC-ELG-B1-05',
    acknowledged: false,
    acknowledgedAt: null,
    superseded: false,
    closed: false,
    signerId: SIGNER_ID,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSigning.mockResolvedValue([noticeItem()]);
  mockSigningLink.mockResolvedValue({ url: SIGNING_URL, expiresAt: '2026-11-20T00:00:00.000Z' });
  mockTenancies.mockResolvedValue(TWO_LANDLORDS);
  mockTenancy.mockResolvedValue(detail());
  mockNotices.mockResolvedValue([{ landlord: AGENCY, notices: [notice()] }]);
  mockNoticeDocument.mockResolvedValue({ url: NOTICE_URL });
  mockConversations.mockResolvedValue([]);
  openBrowser.mockResolvedValue({ type: 'cancel' });
});

describe('LN-04 a notice to acknowledge under To sign', () => {
  it('shows the notice, its dates and the statement, and opens its signing page; no decline', async () => {
    await render(<ToSign />);
    const item = await screen.findByTestId('notice-item');
    expect(within(item).getByText('Notice N-000007: Notice of entry')).toBeOnTheScreen();
    expect(within(item).getByText(`From ${AGENCY.name}`)).toBeOnTheScreen();
    expect(within(item).getByText('Issued 4 Nov 2026, 09:00 GMT (Africa/Accra)')).toBeOnTheScreen();
    expect(within(item).getByText('Effective date 20 November 2026')).toBeOnTheScreen();
    expect(within(item).getByTestId('notice-statement')).toHaveTextContent(
      NOTICE_SIGNING_STATEMENT,
    );
    expect(within(item).getByTestId('own-status')).toHaveTextContent(
      /Waiting for you to acknowledge it/,
    );
    expect(within(item).queryByTestId('other-signers')).not.toBeOnTheScreen();
    expect(within(item).queryByText(/decline/i)).not.toBeOnTheScreen();
    expect(screen.queryByTestId('signing-item')).not.toBeOnTheScreen();

    await fireEvent.press(within(item).getByTestId('acknowledge-notice'));
    await waitFor(() => expect(openBrowser).toHaveBeenCalledTimes(1));
    expect(mockSigningLink).toHaveBeenCalledWith({ signerId: SIGNER_ID });
    expect(openBrowser.mock.calls[0]![0]).toBe(SIGNING_URL);
  });

  it('once acknowledged, says so, and offers nothing more to sign', async () => {
    mockSigning.mockResolvedValue([
      noticeItem({
        signer: {
          id: SIGNER_ID,
          name: 'Abena Mensah',
          status: 'signed',
          signedAt: '2026-11-04T09:20:00.000Z',
        },
      }),
    ]);
    await render(<ToSign />);
    const item = await screen.findByTestId('notice-item');
    expect(within(item).getByTestId('own-status')).toHaveTextContent(/You have acknowledged it/);
    expect(
      within(item).getByText('Acknowledged 4 Nov 2026, 09:20 GMT (Africa/Accra)'),
    ).toBeOnTheScreen();
    expect(within(item).queryByTestId('acknowledge-notice')).not.toBeOnTheScreen();
  });

  it('a notice no longer waiting is explained as a notice, and a lease beside it keeps its words', async () => {
    mockSigning.mockResolvedValue([signingItem(), noticeItem()]);
    mockSigningLink.mockRejectedValue(apiError(404, 'NOT_FOUND', 'Signer not found'));
    await render(<ToSign />);
    expect(await screen.findByTestId('signing-item')).toBeOnTheScreen();
    await fireEvent.press(screen.getByTestId('acknowledge-notice'));
    expect(await screen.findByTestId('action-error')).toHaveTextContent(
      'This notice is no longer waiting for you to acknowledge it.',
    );
    await fireEvent.press(screen.getByTestId('review-and-sign'));
    await waitFor(() =>
      expect(screen.getByTestId('action-error')).toHaveTextContent(
        'This lease is no longer waiting for your signature.',
      ),
    );
  });
});

describe('TL-07 Home says what waits under To sign, leases and notices', () => {
  it('a notice to acknowledge', async () => {
    await render(<Home />);
    const entry = await screen.findByTestId('to-sign-entry');
    expect(entry).toHaveTextContent(/1 notice is waiting for you to acknowledge receipt\./);
    expect(within(entry).getByTestId('open-to-sign')).toHaveTextContent('Read and acknowledge');
  });

  it('a lease and two notices, each said in its own words', () => {
    const summary = toSignSummary([
      signingItem(),
      noticeItem(),
      noticeItem({ signingRequestId: '0193a7c0-0000-7000-8000-0000000000e8' }),
    ]);
    expect(summary).toEqual({
      text: '1 lease is waiting for your signature. 2 notices are waiting for you to acknowledge receipt.',
      waiting: true,
      action: 'Review and sign',
    });
    const done = noticeItem({
      signer: { id: SIGNER_ID, name: 'Abena Mensah', status: 'signed', signedAt: null },
    });
    expect(toSignSummary([done]).text).toBe('You have acknowledged every notice here.');
  });
});

describe('TL-12 a tenancy’s notices are its landlord’s own (M7 plan 4.10)', () => {
  it('lists this lease’s notices from this landlord only', async () => {
    mockNotices.mockResolvedValue([
      {
        landlord: AGENCY,
        notices: [
          notice(),
          notice({
            noticeId: '0193a7c0-0000-7000-8000-00000000f002',
            number: 'N-000008',
            leaseId: OTHER_LEASE,
          }),
        ],
      },
      // Another landlord, even naming the same lease id, never shows here.
      {
        landlord: LANDLORD,
        notices: [
          notice({ noticeId: '0193a7c0-0000-7000-8000-00000000f003', number: 'KO-N-000001' }),
        ],
      },
    ]);
    await render(<TenancyScreen />);
    const card = await screen.findByTestId('tenancy-notices');
    const rows = within(card).getAllByTestId('notice-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent(/Notice N-000007 · Notice of entry/);
    expect(within(card).queryByText(/N-000008/)).not.toBeOnTheScreen();
    expect(within(card).queryByText(/KO-N-000001/)).not.toBeOnTheScreen();
  });

  it('shows each notice’s state, downloads it, and opens the signing page while it waits', async () => {
    mockNotices.mockResolvedValue([
      {
        landlord: AGENCY,
        notices: [
          notice(),
          notice({
            noticeId: '0193a7c0-0000-7000-8000-00000000f004',
            number: 'N-000002',
            acknowledged: true,
            acknowledgedAt: '2026-10-02T10:00:00.000Z',
            signerId: null,
          }),
          notice({
            noticeId: '0193a7c0-0000-7000-8000-00000000f005',
            number: 'N-000003',
            superseded: true,
          }),
          notice({
            noticeId: '0193a7c0-0000-7000-8000-00000000f006',
            number: 'N-000004',
            closed: true,
          }),
        ],
      },
    ]);
    await render(<TenancyScreen />);
    const rows = await screen.findAllByTestId('notice-row');
    expect(rows.map((row) => within(row).getByTestId('notice-state').props.children)).toBeDefined();
    expect(within(rows[0]!).getByTestId('notice-state')).toHaveTextContent(
      'Waiting for you to acknowledge it',
    );
    expect(within(rows[1]!).getByTestId('notice-state')).toHaveTextContent('Acknowledged');
    expect(rows[1]).toHaveTextContent(/Acknowledged 2 Oct 2026, 10:00 GMT \(Africa\/Accra\)/);
    expect(within(rows[1]!).getByTestId('download-notice')).toHaveTextContent(
      'Download the acknowledgement',
    );
    expect(within(rows[2]!).getByTestId('notice-state')).toHaveTextContent(
      'Replaced by a later notice',
    );
    expect(within(rows[3]!).getByTestId('notice-state')).toHaveTextContent('Closed');
    // Only the one still waiting can be acknowledged.
    expect(screen.getAllByTestId('acknowledge-notice')).toHaveLength(1);
    expect(within(rows[0]!).getByTestId('acknowledge-notice')).toBeOnTheScreen();

    await fireEvent.press(within(rows[0]!).getByTestId('download-notice'));
    await waitFor(() => expect(openBrowser).toHaveBeenCalledTimes(1));
    expect(mockNoticeDocument).toHaveBeenCalledWith({ noticeId: NOTICE_ID });
    expect(openBrowser.mock.calls[0]![0]).toBe(NOTICE_URL);

    await fireEvent.press(within(rows[0]!).getByTestId('acknowledge-notice'));
    await waitFor(() => expect(openBrowser).toHaveBeenCalledTimes(2));
    expect(mockSigningLink).toHaveBeenCalledWith({ signerId: SIGNER_ID });
    // The short-lived links are never kept.
    const kept = JSON.stringify(await AsyncStorage.multiGet(await AsyncStorage.getAllKeys()));
    expect(kept).not.toContain('X-Amz-Signature');
  });

  it('offline: the notices last fetched, with no downloads; signing out empties them', async () => {
    const online = await render(<TenancyScreen />);
    await screen.findByTestId('tenancy-notices');
    await waitFor(async () => expect(await readCache(ME.personId, 'notices')).not.toBeNull());
    await online.unmount();

    mockNotices.mockRejectedValue(new TypeError('Network request failed'));
    await render(<TenancyScreen />);
    expect(await screen.findByTestId('notices-offline')).toHaveTextContent(
      /You are offline\. These are the notices we last fetched, at .+ \(Africa\/Accra\)/,
    );
    expect(screen.getAllByTestId('notice-row')).toHaveLength(1);
    expect(screen.queryByTestId('download-notice')).not.toBeOnTheScreen();

    // What sign-out does to the cache (src/session.tsx): nothing of the notices stays.
    await clearCache();
    expect(await readCache(ME.personId, 'notices')).toBeNull();
  });

  it('a tenancy with no notices shows no notices card', async () => {
    mockNotices.mockResolvedValue([{ landlord: AGENCY, notices: [] }]);
    await render(<TenancyScreen />);
    await screen.findByTestId('tenancy-detail');
    await waitFor(() => expect(mockNotices).toHaveBeenCalled());
    expect(screen.queryByTestId('tenancy-notices')).not.toBeOnTheScreen();
  });
});

import type { TenantSigningView, TenantTenancyDocumentView } from '@rent/contracts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import { Text } from 'react-native';
import Home from '../app/home';
import TenancyScreen from '../app/tenancy/[leaseId]';
import ToSign from '../app/to-sign';
import { toSignSummary } from '../src/signing-items';
import { AGENCY, apiError, detail, ME, signingItem, TWO_LANDLORDS } from './fixtures';

// M8 plan 4.7 and 4.11 (TL-08, TL-11): the move-in report to sign under To sign, and the
// tenancy's documents (the signed lease, the move-in report, the final statement), each opened
// through a short-lived link fetched at the tap.

const mockPush = jest.fn();
const mockExpire = jest.fn();
const mockSigning = jest.fn();
const mockSigningLink = jest.fn();
const mockTenancies = jest.fn();
const mockTenancy = jest.fn();
const mockDocuments = jest.fn();
const mockDownload = jest.fn();
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
      documents: (...args: unknown[]) => mockDocuments(...args),
      documentDownload: (...args: unknown[]) => mockDownload(...args),
      notices: async () => [],
    },
    tenantRepairs: { list: async () => [] },
  },
}));

function MockRedirect({ href }: { href: string }) {
  return <Text>Redirected to {href}</Text>;
}

const openBrowser = WebBrowser.openBrowserAsync as jest.Mock;
const SIGNING_URL = 'http://localhost:3702/l/move-in-token-not-real';
const DOCUMENT_URL = 'http://localhost:8333/rent-evidence/doc.pdf?X-Amz-Signature=d0c5';
const REPORT_SIGNER = '0193a7c0-0000-7000-8000-0000000000c7';

function reportItem(overrides: Partial<TenantSigningView> = {}): TenantSigningView {
  return signingItem({
    signingRequestId: '0193a7c0-0000-7000-8000-0000000000e8',
    title: 'Move-in report: ACC-ELG-B1-05',
    subject: 'move_in_report',
    notice: null,
    signer: { id: REPORT_SIGNER, name: 'Abena Mensah', status: 'pending', signedAt: null },
    signers: [
      { roleLabel: 'Tenant', name: 'Abena Mensah', status: 'pending' },
      { roleLabel: 'For the landlord', name: 'Kofi Manager', status: 'signed' },
    ],
    ...overrides,
  });
}

const DOCUMENTS: TenantTenancyDocumentView[] = [
  {
    kind: 'lease',
    title: 'Tenancy agreement: ACC-ELG-B1-05',
    documentId: '0193a7c0-0000-7000-8000-0000000000d1',
    signed: true,
    createdAt: '2026-08-20T10:00:00.000Z',
  },
  {
    kind: 'move_in_report',
    title: 'Move-in report: ACC-ELG-B1-05',
    documentId: '0193a7c0-0000-7000-8000-0000000000d2',
    signed: false,
    createdAt: '2026-09-01T10:00:00.000Z',
  },
  {
    kind: 'final_statement',
    title: 'Final statement: ACC-ELG-B1-05',
    documentId: '0193a7c0-0000-7000-8000-0000000000d3',
    signed: false,
    createdAt: '2026-11-05T10:00:00.000Z',
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  for (const mock of [mockSigning, mockSigningLink, mockDocuments, mockDownload]) mock.mockReset();
  mockSigning.mockResolvedValue([reportItem()]);
  mockSigningLink.mockResolvedValue({ url: SIGNING_URL });
  mockTenancies.mockResolvedValue(TWO_LANDLORDS);
  mockTenancy.mockResolvedValue(detail());
  mockDocuments.mockResolvedValue(DOCUMENTS);
  mockDownload.mockResolvedValue({ url: DOCUMENT_URL });
  openBrowser.mockResolvedValue({ type: 'cancel' });
});

describe('TL-08 the move-in report under To sign', () => {
  it('shows the report as its own kind of item, says what it is, and opens it to sign', async () => {
    await render(<ToSign />);
    const card = await screen.findByTestId('move-in-report-item');
    expect(within(card).getByText('Move-in report: ACC-ELG-B1-05')).toBeOnTheScreen();
    expect(within(card).getByText(`From ${AGENCY.name}`)).toBeOnTheScreen();
    expect(within(card).getByTestId('move-in-report-about')).toHaveTextContent(
      /condition of your home when you moved in, room by room, with photos/,
    );
    expect(screen.queryByTestId('signing-item')).not.toBeOnTheScreen();

    await fireEvent.press(within(card).getByTestId('review-move-in-report'));
    await waitFor(() => expect(openBrowser).toHaveBeenCalledTimes(1));
    expect(mockSigningLink).toHaveBeenCalledWith({ signerId: REPORT_SIGNER });
    expect(openBrowser.mock.calls[0]![0]).toBe(SIGNING_URL);
  });

  it('a report signed or withdrawn meanwhile is said in report words', async () => {
    mockSigningLink.mockRejectedValue(apiError(404, 'NOT_FOUND'));
    await render(<ToSign />);
    await fireEvent.press(await screen.findByTestId('review-move-in-report'));
    expect(
      await screen.findByText(/This move-in report is no longer waiting for your signature\./),
    ).toBeOnTheScreen();
  });

  it('a report still being prepared says “report”, not “lease”', async () => {
    mockSigning.mockResolvedValue([reportItem({ status: 'preparing' })]);
    await render(<ToSign />);
    expect(
      await screen.findByText(
        'Your landlord is still preparing this report. Try again in a few minutes.',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByTestId('review-move-in-report')).not.toBeOnTheScreen();
  });

  it('Home counts it with the leases and notices that wait', async () => {
    const notice = signingItem({
      signingRequestId: '0193a7c0-0000-7000-8000-0000000000e9',
      subject: 'notice',
      title: 'Notice of entry N-000007',
    });
    expect(toSignSummary([signingItem(), reportItem(), notice])).toEqual({
      text:
        '1 lease is waiting for your signature. 1 move-in report is waiting for your signature. ' +
        '1 notice is waiting for you to acknowledge receipt.',
      waiting: true,
      action: 'Review and sign',
    });
    expect(toSignSummary([reportItem(), reportItem()]).text).toBe(
      '2 move-in reports are waiting for your signature.',
    );
    expect(toSignSummary([reportItem()]).action).toBe('Review and sign');

    await render(<Home />);
    expect(await screen.findByTestId('to-sign-entry')).toHaveTextContent(
      /1 move-in report is waiting for your signature\./,
    );
  });
});

describe('TL-08 and TL-11 the tenancy’s documents', () => {
  it('lists the lease, the move-in report and the final statement for this tenancy', async () => {
    await render(<TenancyScreen />);
    const card = await screen.findByTestId('tenancy-documents');
    expect(mockDocuments).toHaveBeenCalledWith({ leaseId: mockParams.leaseId });
    const rows = within(card).getAllByTestId('tenancy-document');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent(
      /Tenancy agreement: ACC-ELG-B1-05.*The lease, signed by everyone/,
    );
    expect(rows[1]).toHaveTextContent(
      /Move-in report: ACC-ELG-B1-05.*The move-in report, not signed by everyone yet/,
    );
    expect(rows[2]).toHaveTextContent(/Final statement: ACC-ELG-B1-05.*The final statement/);
    expect(rows[2]).not.toHaveTextContent(/signed/);
  });

  it('downloads a document through a fresh short-lived link', async () => {
    await render(<TenancyScreen />);
    const card = await screen.findByTestId('tenancy-documents');
    await fireEvent.press(within(card).getAllByTestId('download-document')[1]!);
    await waitFor(() => expect(openBrowser).toHaveBeenCalledTimes(1));
    expect(mockDownload).toHaveBeenCalledWith({
      documentId: '0193a7c0-0000-7000-8000-0000000000d2',
    });
    expect(openBrowser.mock.calls[0]![0]).toBe(DOCUMENT_URL);

    mockDownload.mockRejectedValueOnce(apiError(404, 'NOT_FOUND', 'That document is not here.'));
    await fireEvent.press(within(card).getAllByTestId('download-document')[2]!);
    expect(await screen.findByTestId('document-error')).toHaveTextContent(
      'We could not open the document. That document is not here.',
    );
  });

  it('a failure to list them is said plainly; none shows no card', async () => {
    mockDocuments.mockRejectedValueOnce(apiError(500, 'INTERNAL', 'Boom'));
    const failed = await render(<TenancyScreen />);
    expect(await screen.findByTestId('documents-error')).toHaveTextContent(
      'We could not load this tenancy’s documents just now.',
    );
    await failed.unmount();

    mockDocuments.mockResolvedValue([]);
    await render(<TenancyScreen />);
    await screen.findByTestId('fact-deposit');
    await waitFor(() => expect(mockDocuments).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId('tenancy-documents')).not.toBeOnTheScreen();
  });

  it('a live tenancy offers “Report a repair”, filed under it', async () => {
    await render(<TenancyScreen />);
    await fireEvent.press(await screen.findByTestId('report-repair-here'));
    expect(mockPush).toHaveBeenCalledWith(`/repairs/new?leaseId=${mockParams.leaseId}`);
  });
});

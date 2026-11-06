import type { TenantRepairView, TenantSigningView } from '@rent/contracts';
import { render, screen, within } from '@testing-library/react-native';
import { Text } from 'react-native';
import Repairs from '../app/repairs';
import TenancyScreen from '../app/tenancy/[leaseId]';
import ToSign from '../app/to-sign';
import { formatTime, zoneOf } from '../src/format';
import { AGENCY, detail, LANDLORD, ME, signingItem } from './fixtures';

// DO-04 and the M8 review (LT 9): a landlord's times show in the landlord company's own zone, as
// the tenant endpoints now send it (`landlord.timeZone`), and say which zone it is; with none, or
// one the phone does not know, in Africa/Accra. A summer instant tells London from Accra.

const mockList = jest.fn();
const mockSigning = jest.fn();
const mockTenancy = jest.fn();
const mockNotices = jest.fn();
const mockParams = { leaseId: '0193a7c0-0000-7000-8000-0000000000a1' };
const mockSession = { me: ME, loading: false, ended: false, expire: jest.fn() };

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
    tenantApp: {
      signing: (...args: unknown[]) => mockSigning(...args),
      tenancy: (...args: unknown[]) => mockTenancy(...args),
      notices: (...args: unknown[]) => mockNotices(...args),
      documents: async () => [],
    },
    tenantRepairs: { list: (...args: unknown[]) => mockList(...args) },
  },
}));
jest.mock('../src/repair-files', () => ({
  filesSurvive: true,
  keepFile: jest.fn(),
  keptFilePart: jest.fn(),
  forgetRequestFiles: jest.fn(),
  forgetAllRepairFiles: jest.fn(),
}));

function MockRedirect({ href }: { href: string }) {
  return <Text>Redirected to {href}</Text>;
}

/** 1 July 2026, 09:00 UTC: 09:00 in Accra, 10:00 summer time in London. */
const SUMMER = '2026-07-01T09:00:00.000Z';
const LONDON = { ...AGENCY, timeZone: 'Europe/London' };

function repair(overrides: Partial<TenantRepairView> = {}): TenantRepairView {
  return {
    jobId: '0193a7c0-0000-7000-8000-00000000c0b1',
    ticket: 'MT-0042',
    status: 'assigned',
    statusLabel: 'Assigned',
    description: 'The kitchen tap drips.',
    category: 'plumbing',
    emergency: false,
    leaseId: mockParams.leaseId,
    unitCode: 'ACC-ELG-B1-05',
    visitAt: SUMMER,
    awaitingResponse: false,
    completionNote: null,
    steps: [{ kind: 'reported', at: SUMMER }],
    attachments: [],
    createdAt: SUMMER,
    forwarded: false,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('DO-04 a landlord’s times in the landlord’s own zone (review LT 9)', () => {
  it('picks the landlord’s zone, or Africa/Accra when there is none or the phone does not know it', () => {
    expect(zoneOf({ timeZone: 'Europe/London' })).toBe('Europe/London');
    expect(zoneOf({})).toBe('Africa/Accra');
    expect(zoneOf({ timeZone: '' })).toBe('Africa/Accra');
    expect(zoneOf({ timeZone: 'Mars/Olympus_Mons' })).toBe('Africa/Accra');
    expect(zoneOf(null)).toBe('Africa/Accra');
    expect(formatTime(SUMMER, zoneOf({ timeZone: 'Europe/London' }))).toMatch(
      /^1 Jul 2026, 10:00 .+ \(Europe\/London\)$/,
    );
  });

  it('repairs: each landlord’s visit, steps and report times in their own zone', async () => {
    mockList.mockResolvedValue([
      { landlord: LONDON, filesAllowed: true, repairs: [repair()] },
      {
        landlord: LANDLORD,
        filesAllowed: false,
        repairs: [repair({ jobId: '0193a7c0-0000-7000-8000-00000000c0b2', ticket: 'MT-0007' })],
      },
    ]);
    await render(<Repairs />);
    const [london, accra] = await screen.findAllByTestId('landlord-repairs');
    const inLondon = within(london!);
    expect(
      inLondon.getByText(/^Visit planned for 1 Jul 2026, 10:00 .+ \(Europe\/London\)$/),
    ).toBeOnTheScreen();
    expect(inLondon.getByTestId('repair-steps')).toHaveTextContent(
      /Reported, 1 Jul 2026, 10:00 .+ \(Europe\/London\)/,
    );
    expect(
      inLondon.getByText(/^Reported 1 Jul 2026, 10:00 .+ \(Europe\/London\)$/),
    ).toBeOnTheScreen();
    // A landlord sent without a zone: Africa/Accra.
    expect(
      within(accra!).getByText('Reported 1 Jul 2026, 09:00 GMT (Africa/Accra)'),
    ).toBeOnTheScreen();
  });

  it('To sign: when it was sent, and a notice’s dates, in the landlord’s zone', async () => {
    const notice: TenantSigningView = signingItem({
      signingRequestId: '0193a7c0-0000-7000-8000-0000000000e7',
      landlord: LONDON,
      title: 'Notice of entry N-000007',
      subject: 'notice',
      sentAt: SUMMER,
      notice: {
        noticeId: '0193a7c0-0000-7000-8000-00000000f001',
        number: 'N-000007',
        typeLabel: 'Notice of entry',
        issuedAt: SUMMER,
        effectiveDate: '2026-07-20',
        statement: 'Signing acknowledges receipt, not agreement.',
      },
    });
    mockSigning.mockResolvedValue([notice, signingItem({ landlord: LONDON, sentAt: SUMMER })]);
    await render(<ToSign />);
    const card = await screen.findByTestId('notice-item');
    expect(
      within(card).getByText(/^Issued 1 Jul 2026, 10:00 .+ \(Europe\/London\)$/),
    ).toBeOnTheScreen();
    expect(
      within(screen.getByTestId('signing-item')).getByText(
        /^Sent 1 Jul 2026, 10:00 .+ \(Europe\/London\)$/,
      ),
    ).toBeOnTheScreen();
  });

  it('a tenancy’s notices, in its landlord’s zone', async () => {
    mockTenancy.mockResolvedValue(detail({ landlord: LONDON }));
    mockNotices.mockResolvedValue([
      {
        landlord: LONDON,
        notices: [
          {
            noticeId: '0193a7c0-0000-7000-8000-00000000f001',
            number: 'N-000007',
            typeLabel: 'Notice of entry',
            issuedAt: SUMMER,
            effectiveDate: '2026-07-20',
            leaseId: mockParams.leaseId,
            unitCode: 'ACC-ELG-B1-05',
            acknowledged: true,
            acknowledgedAt: SUMMER,
            superseded: false,
            closed: false,
            signerId: null,
          },
        ],
      },
    ]);
    await render(<TenancyScreen />);
    const row = await screen.findByTestId('notice-row');
    expect(
      within(row).getByText(/^Issued 1 Jul 2026, 10:00 .+ \(Europe\/London\)$/),
    ).toBeOnTheScreen();
    expect(
      within(row).getByText(/^Acknowledged 1 Jul 2026, 10:00 .+ \(Europe\/London\)$/),
    ).toBeOnTheScreen();
  });
});

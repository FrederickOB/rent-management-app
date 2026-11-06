import type { TenantRepairView } from '@rent/contracts';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import { Text } from 'react-native';
import Home from '../app/home';
import Repairs from '../app/repairs';
import { readCache } from '../src/cache';
import { addRepair, flushRepairs, forgetRepairQueue, queuedRepairs } from '../src/repair-queue';
import { AGENCY, apiError, LANDLORD, ME, TWO_LANDLORDS } from './fixtures';

// MI-06 and CM-04 (M8 plan 4.11): the tenant's repairs in the app, each landlord's in a box of
// their own (TL-12), with their status, steps and files; work marked done waits for the tenant to
// confirm it or say what is still wrong. Requests still on the phone show under their landlord.

const mockPush = jest.fn();
const mockExpire = jest.fn();
const mockList = jest.fn();
const mockRespond = jest.fn();
const mockAttachment = jest.fn();
const mockReport = jest.fn();
const mockTenancies = jest.fn();
const mockSigning = jest.fn();
const mockForgetFiles = jest.fn();
const mockSession = { me: ME, loading: false, ended: false, expire: mockExpire };

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
  useLocalSearchParams: () => ({}),
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
      tenancies: (...args: unknown[]) => mockTenancies(...args),
      signing: (...args: unknown[]) => mockSigning(...args),
    },
    tenantRepairs: {
      list: (...args: unknown[]) => mockList(...args),
      respond: (...args: unknown[]) => mockRespond(...args),
      attachment: (...args: unknown[]) => mockAttachment(...args),
      report: (...args: unknown[]) => mockReport(...args),
      createUpload: jest.fn(),
    },
  },
}));
jest.mock('../src/repair-files', () => ({
  filesSurvive: true,
  keepFile: jest.fn(),
  keptFilePart: jest.fn(),
  forgetRequestFiles: (...args: unknown[]) => mockForgetFiles(...args),
  forgetAllRepairFiles: jest.fn(),
}));

function MockRedirect({ href }: { href: string }) {
  return <Text>Redirected to {href}</Text>;
}

const openBrowser = WebBrowser.openBrowserAsync as jest.Mock;
const FILE_URL = 'http://localhost:8333/rent-uploads/repairs/tap.jpg?X-Amz-Signature=r3pa1r';
const LEASE = TWO_LANDLORDS[0]!.tenancies[0]!.leaseId;
const OTHER_LEASE = TWO_LANDLORDS[1]!.tenancies[0]!.leaseId;

function repair(overrides: Partial<TenantRepairView> = {}): TenantRepairView {
  return {
    jobId: '0193a7c0-0000-7000-8000-00000000c0b1',
    ticket: 'MT-0042',
    status: 'in_progress',
    statusLabel: 'In progress',
    description: 'The kitchen tap drips.',
    category: 'plumbing',
    emergency: false,
    leaseId: LEASE,
    unitCode: 'ACC-ELG-B1-05',
    visitAt: null,
    awaitingResponse: false,
    completionNote: null,
    steps: [
      { kind: 'reported', at: '2026-11-05T09:00:00.000Z' },
      { kind: 'assigned', at: '2026-11-05T10:00:00.000Z' },
    ],
    attachments: [
      {
        id: '0193a7c0-0000-7000-8000-0000000a0001',
        kind: 'image',
        stage: 'report',
        contentType: 'image/jpeg',
      },
      {
        id: '0193a7c0-0000-7000-8000-0000000a0002',
        kind: 'audio',
        stage: 'report',
        contentType: 'audio/mp4',
      },
    ],
    createdAt: '2026-11-05T09:00:00.000Z',
    forwarded: false,
    ...overrides,
  };
}

const DONE = repair({
  jobId: '0193a7c0-0000-7000-8000-00000000c0b2',
  ticket: 'MT-0043',
  status: 'work_done',
  statusLabel: 'Work done',
  description: 'The bedroom socket sparks.',
  category: 'electrical',
  emergency: true,
  awaitingResponse: true,
  completionNote: 'Replaced the socket and its back box.',
  steps: [
    { kind: 'reported', at: '2026-11-03T08:00:00.000Z' },
    { kind: 'started', at: '2026-11-04T09:00:00.000Z' },
    { kind: 'work_done', at: '2026-11-04T13:20:00.000Z' },
  ],
  attachments: [
    {
      id: '0193a7c0-0000-7000-8000-0000000a0003',
      kind: 'image',
      stage: 'after',
      contentType: 'image/jpeg',
    },
  ],
});

const FORWARDED = repair({
  jobId: '0193a7c0-0000-7000-8000-00000000c0b3',
  ticket: 'MT-0007',
  status: 'reported',
  statusLabel: 'Reported',
  description: 'The roof leaks over the porch.',
  category: 'roofing',
  leaseId: OTHER_LEASE,
  unitCode: 'TEM-EST-B1-01',
  steps: [],
  attachments: [],
  forwarded: true,
});

beforeEach(() => {
  jest.clearAllMocks();
  for (const mock of [mockList, mockRespond, mockAttachment, mockReport]) mock.mockReset();
  forgetRepairQueue();
  mockList.mockResolvedValue([
    { landlord: AGENCY, repairs: [repair(), DONE] },
    { landlord: LANDLORD, repairs: [FORWARDED] },
  ]);
  mockTenancies.mockResolvedValue(TWO_LANDLORDS);
  mockSigning.mockResolvedValue([]);
  mockAttachment.mockResolvedValue({ url: FILE_URL });
  openBrowser.mockResolvedValue({ type: 'cancel' });
});

/** A request written on this phone that the API has not taken yet. */
async function queue(
  overrides: { clientId: string; companyId?: string; description?: string },
  refusal: unknown = new TypeError('Network request failed'),
) {
  const landlord = overrides.companyId === LANDLORD.companyId ? LANDLORD : AGENCY;
  mockReport.mockRejectedValueOnce(refusal);
  addRepair({
    clientId: overrides.clientId,
    personId: ME.personId,
    companyId: landlord.companyId,
    landlordName: landlord.name,
    leaseId: landlord === LANDLORD ? OTHER_LEASE : LEASE,
    unitCode: null,
    category: 'pest_control',
    description: overrides.description ?? 'Ants in the kitchen.',
    emergency: false,
    files: [],
  });
  await flushRepairs(ME.personId, landlord.companyId);
}

describe('MI-06 the tenant’s repairs, by landlord (TL-12)', () => {
  it('shows each landlord’s repairs in a box of their own, with status, steps and files', async () => {
    await render(<Repairs />);
    const boxes = await screen.findAllByTestId('landlord-repairs');
    expect(boxes).toHaveLength(2);

    const agency = within(boxes[0]!);
    expect(agency.getByText(AGENCY.name)).toBeOnTheScreen();
    const rows = agency.getAllByTestId('repair-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('MT-0042 · Plumbing')).toBeOnTheScreen();
    expect(within(rows[0]!).getByTestId('repair-status')).toHaveTextContent('In progress');
    expect(within(rows[0]!).getByTestId('repair-steps')).toHaveTextContent(
      /Reported, .+Someone is assigned, /,
    );
    const files = within(rows[0]!).getAllByTestId('repair-file');
    expect(files).toHaveLength(2);
    expect(files[0]).toHaveTextContent('Photo 1');
    expect(files[1]).toHaveTextContent('Voice note 2');
    expect(within(rows[0]!).queryByTestId('emergency')).not.toBeOnTheScreen();
    expect(within(rows[0]!).queryByTestId('awaiting-response')).not.toBeOnTheScreen();

    expect(within(rows[1]!).getByTestId('emergency')).toHaveTextContent('Emergency');
    expect(within(rows[1]!).getByTestId('completion-note')).toHaveTextContent(
      'What was done: Replaced the socket and its back box.',
    );
    expect(within(rows[1]!).getByTestId('repair-file')).toHaveTextContent(
      'Photo 1 (after the work)',
    );
    expect(within(rows[1]!).getByTestId('awaiting-response')).toBeOnTheScreen();

    // The other landlord's box holds only their repair: on Starter, forwarded and not tracked.
    const landlord = within(boxes[1]!);
    expect(landlord.getByText(LANDLORD.name)).toBeOnTheScreen();
    expect(landlord.getAllByTestId('repair-row')).toHaveLength(1);
    expect(landlord.getByTestId('forwarded')).toHaveTextContent(
      /We sent this to Kwabena Owusu directly\. They do not track repairs in this app/,
    );
    expect(landlord.queryByText(/MT-0042|MT-0043/)).not.toBeOnTheScreen();
  });

  it('opens a file through a short-lived link fetched at the tap, and keeps no link', async () => {
    await render(<Repairs />);
    const [first] = await screen.findAllByTestId('repair-row');
    await fireEvent.press(within(first!).getAllByTestId('repair-file')[1]!);
    await waitFor(() => expect(openBrowser).toHaveBeenCalledTimes(1));
    expect(mockAttachment).toHaveBeenCalledWith({
      jobId: '0193a7c0-0000-7000-8000-00000000c0b1',
      attachmentId: '0193a7c0-0000-7000-8000-0000000a0002',
    });
    expect(openBrowser.mock.calls[0]![0]).toBe(FILE_URL);
    const cached = JSON.stringify(await readCache(ME.personId, 'repairs'));
    expect(cached).toContain('MT-0042');
    expect(cached).not.toContain('X-Amz-Signature');

    mockAttachment.mockRejectedValueOnce(apiError(404, 'NOT_FOUND', 'That file is not here.'));
    await fireEvent.press(within(first!).getAllByTestId('repair-file')[0]!);
    expect(await screen.findByTestId('repair-error')).toHaveTextContent(
      'We could not open the file. That file is not here.',
    );
  });

  it('confirms the work is done, then shows the list as it is now', async () => {
    mockRespond.mockResolvedValue({ ...DONE, status: 'closed', awaitingResponse: false });
    await render(<Repairs />);
    await fireEvent.press(await screen.findByTestId('confirm-repair'));
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
    expect(mockRespond).toHaveBeenCalledWith({
      jobId: DONE.jobId,
      response: 'confirmed',
      reason: null,
    });
  });

  it('says what is still wrong, with a reason, and nothing goes without one', async () => {
    mockRespond.mockResolvedValue({ ...DONE, status: 'in_progress', awaitingResponse: false });
    await render(<Repairs />);
    await fireEvent.press(await screen.findByTestId('dispute-repair'));
    await fireEvent.press(screen.getByTestId('send-dispute'));
    expect(screen.getByTestId('repair-error')).toHaveTextContent(
      'Say in a few words what is still wrong.',
    );
    expect(mockRespond).not.toHaveBeenCalled();

    mockRespond.mockRejectedValueOnce(apiError(409, 'NOT_AWAITING', 'This repair has moved on.'));
    await fireEvent.changeText(screen.getByTestId('dispute-reason'), '  It still sparks.  ');
    await fireEvent.press(screen.getByTestId('send-dispute'));
    expect(await screen.findByTestId('repair-error')).toHaveTextContent(
      'We could not send your answer. This repair has moved on.',
    );

    await fireEvent.press(screen.getByTestId('send-dispute'));
    await waitFor(() => expect(mockRespond).toHaveBeenCalledTimes(2));
    expect(mockRespond).toHaveBeenLastCalledWith({
      jobId: DONE.jobId,
      response: 'disputed',
      reason: 'It still sparks.',
    });
    await waitFor(() => expect(screen.queryByTestId('dispute-reason')).not.toBeOnTheScreen());
  });

  it('a session that ended while answering signs the tenant out', async () => {
    mockRespond.mockRejectedValue(apiError(401, 'UNAUTHORIZED'));
    await render(<Repairs />);
    await fireEvent.press(await screen.findByTestId('confirm-repair'));
    await waitFor(() => expect(mockExpire).toHaveBeenCalled());
  });
});

describe('MI-01 requests still on the phone show under their landlord', () => {
  it('a request waiting for the network shows, and Send now sends it', async () => {
    await queue({ clientId: '0193a7c0-0000-4000-8000-00000000d001' });
    await render(<Repairs />);
    const [agency] = await screen.findAllByTestId('landlord-repairs');
    const row = within(agency!).getByTestId('queued-repair');
    expect(within(row).getByTestId('queued-state')).toHaveTextContent('Not sent yet');
    expect(within(row).getByTestId('queued-problem')).toHaveTextContent(
      'Waiting to send. It goes by itself when you are back online.',
    );

    mockReport.mockResolvedValueOnce(repair({ ticket: 'MT-0044' }));
    await fireEvent.press(within(row).getByTestId('send-queued'));
    await waitFor(() => expect(screen.queryByTestId('queued-repair')).not.toBeOnTheScreen());
    expect(mockReport).toHaveBeenCalledTimes(2);
    expect(mockReport.mock.calls[1]![0]).toMatchObject({
      clientId: '0193a7c0-0000-4000-8000-00000000d001',
    });
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });

  it('a refusal that cannot change waits for Discard, which removes it and its files', async () => {
    await queue(
      { clientId: '0193a7c0-0000-4000-8000-00000000d002', companyId: LANDLORD.companyId },
      apiError(422, 'MEDIA_TOO_LARGE', 'Too large'),
    );
    mockList.mockResolvedValue([{ landlord: AGENCY, repairs: [repair()] }]);
    await render(<Repairs />);
    const boxes = await screen.findAllByTestId('landlord-repairs');
    // The landlord with only a request on the phone still has a box of their own.
    expect(boxes).toHaveLength(2);
    const landlordBox = boxes.find((box) => within(box).queryByText(LANDLORD.name))!;
    const row = within(landlordBox).getByTestId('queued-repair');
    expect(within(row).getByTestId('queued-problem')).toHaveTextContent(
      'Not sent: a file is too big. Discard this request and write it again without it.',
    );
    expect(within(row).queryByTestId('send-queued')).not.toBeOnTheScreen();

    await fireEvent.press(within(row).getByTestId('discard-queued'));
    await waitFor(() => expect(screen.queryByTestId('queued-repair')).not.toBeOnTheScreen());
    expect(mockForgetFiles).toHaveBeenCalledWith(
      ME.personId,
      '0193a7c0-0000-4000-8000-00000000d002',
    );
    expect(queuedRepairs(ME.personId)).toEqual([]);
  });

  it('offline, the repairs last fetched show with when, and the queue with them', async () => {
    const online = await render(<Repairs />);
    await screen.findAllByTestId('repair-row');
    await waitFor(async () => expect(await readCache(ME.personId, 'repairs')).not.toBeNull());
    await online.unmount();

    mockList.mockRejectedValue(new TypeError('Network request failed'));
    await queue({ clientId: '0193a7c0-0000-4000-8000-00000000d003' });
    await render(<Repairs />);
    expect(await screen.findByTestId('offline')).toHaveTextContent(
      /You are offline\. These are the repairs we last fetched, at .+ \(Africa\/Accra\)/,
    );
    expect(screen.getAllByTestId('repair-row')).toHaveLength(3);
    expect(screen.getAllByTestId('queued-repair')).toHaveLength(1);
  });

  it('a request the app sends by itself while the list is open shows as a repair', async () => {
    await queue({ clientId: '0193a7c0-0000-4000-8000-00000000d004' });
    await render(<Repairs />);
    expect(await screen.findByTestId('queued-repair')).toBeOnTheScreen();
    expect(mockList).toHaveBeenCalledTimes(1);

    // Back online: RepairRunner sends what waits, away from this screen.
    mockReport.mockResolvedValueOnce(repair({ ticket: 'MT-0045' }));
    await act(async () => {
      await flushRepairs(ME.personId, AGENCY.companyId);
    });
    await waitFor(() => expect(screen.queryByTestId('queued-repair')).not.toBeOnTheScreen());
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2));
  });

  it('says so when there are no repairs yet, and opens the request screen', async () => {
    mockList.mockResolvedValue([
      { landlord: AGENCY, repairs: [] },
      { landlord: LANDLORD, repairs: [] },
    ]);
    await render(<Repairs />);
    expect(await screen.findAllByTestId('landlord-repairs')).toHaveLength(2);
    await fireEvent.press(screen.getByTestId('report-repair'));
    expect(mockPush).toHaveBeenCalledWith('/repairs/new');
  });
});

describe('MI-06 Home shows when a repair waits for the tenant', () => {
  it('marks Repairs “Waiting for you” and opens them', async () => {
    await render(<Home />);
    expect(await screen.findByTestId('repairs-waiting')).toHaveTextContent('Waiting for you');
    await fireEvent.press(screen.getByTestId('open-repairs'));
    expect(mockPush).toHaveBeenCalledWith('/repairs');
  });

  it('no marker when nothing waits', async () => {
    mockList.mockResolvedValue([{ landlord: AGENCY, repairs: [repair()] }]);
    await render(<Home />);
    expect(await screen.findByTestId('open-repairs')).toBeOnTheScreen();
    await waitFor(() => expect(mockList).toHaveBeenCalled());
    expect(screen.queryByTestId('repairs-waiting')).not.toBeOnTheScreen();
  });
});

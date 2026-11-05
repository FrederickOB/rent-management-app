import { act, render, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { writeCache } from '../src/cache';
import { forgetRepairQueue, queuedRepairs } from '../src/repair-queue';
import { RepairRunner } from '../src/repair-runner';
import { AGENCY, ME, TWO_LANDLORDS } from './fixtures';

// MI-01 (M8 decision 3): a request written offline goes by itself, once the tenant is signed in,
// when the app comes back to the front, and when the phone is back online. Each send repeats the
// request's clientId, so the API makes one job however often it is tried.

const mockReport = jest.fn();
const mockNetworkListeners: ((state: {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
}) => void)[] = [];
const mockSession: { me: typeof ME | null } = { me: ME };

jest.mock('expo-network', () => ({
  addNetworkStateListener: (listener: (typeof mockNetworkListeners)[number]) => {
    mockNetworkListeners.push(listener);
    return { remove: jest.fn() };
  },
}));
jest.mock('../src/session', () => ({ useSession: () => mockSession }));
jest.mock('../src/api', () => ({
  api: {
    tenantRepairs: {
      report: (...args: unknown[]) => mockReport(...args),
      createUpload: jest.fn(),
    },
  },
}));
jest.mock('../src/repair-files', () => ({
  filesSurvive: true,
  keepFile: jest.fn(),
  keptFilePart: jest.fn(),
  forgetRequestFiles: jest.fn(),
  forgetAllRepairFiles: jest.fn(),
}));

const CLIENT_ID = '0193a7c0-0000-4000-8000-00000000d0b1';
const OFFLINE = new TypeError('Network request failed');

/** What the queue kept on the phone when the app last closed: one request, waiting to go. */
async function keptOnThePhone() {
  await writeCache(ME.personId, 'repairs-queue', [AGENCY.companyId]);
  await writeCache(ME.personId, `repairs-queue:${AGENCY.companyId}`, [
    {
      clientId: CLIENT_ID,
      companyId: AGENCY.companyId,
      landlordName: AGENCY.name,
      leaseId: TWO_LANDLORDS[0]!.tenancies[0]!.leaseId,
      unitCode: 'ACC-ELG-B1-05',
      category: 'plumbing',
      description: 'The kitchen tap drips.',
      emergency: false,
      files: [],
      writtenAt: '2026-11-05T09:00:00.000Z',
      problem: 'Waiting to send. It goes by itself when you are back online.',
      retryable: true,
    },
  ]);
}

/** The listener the runner gave AppState. */
function appStateListener(): (state: string) => void {
  const calls = (AppState.addEventListener as jest.Mock).mock.calls;
  return calls[calls.length - 1][1];
}

beforeEach(() => {
  jest.clearAllMocks();
  mockReport.mockReset();
  forgetRepairQueue();
  mockNetworkListeners.length = 0;
  mockSession.me = ME;
});

describe('MI-01 requests on the phone go by themselves', () => {
  it('once signed in: restored from the phone and sent with their own clientId', async () => {
    await keptOnThePhone();
    mockReport.mockResolvedValue({ ticket: 'MT-0042' });
    await render(<RepairRunner />);
    await waitFor(() => expect(mockReport).toHaveBeenCalledTimes(1));
    expect(mockReport.mock.calls[0]![0]).toMatchObject({ clientId: CLIENT_ID, uploadIds: [] });
    await waitFor(() => expect(queuedRepairs(ME.personId)).toEqual([]));
  });

  it('still offline, it waits; back online or back in the app, it goes, once', async () => {
    await keptOnThePhone();
    mockReport.mockRejectedValueOnce(OFFLINE).mockRejectedValueOnce(OFFLINE);
    mockReport.mockResolvedValue({ ticket: 'MT-0042' });
    await render(<RepairRunner />);
    await waitFor(() => expect(mockReport).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(queuedRepairs(ME.personId)).toMatchObject([{ clientId: CLIENT_ID, state: 'waiting' }]),
    );

    // The app comes back to the front, still offline.
    await act(async () => appStateListener()('active'));
    await waitFor(() => expect(mockReport).toHaveBeenCalledTimes(2));

    // The phone is back online.
    await act(async () =>
      mockNetworkListeners[0]!({ isConnected: true, isInternetReachable: true }),
    );
    await waitFor(() => expect(queuedRepairs(ME.personId)).toEqual([]));
    expect(mockReport).toHaveBeenCalledTimes(3);
    expect(
      new Set(mockReport.mock.calls.map(([input]) => (input as { clientId: string }).clientId)),
    ).toEqual(new Set([CLIENT_ID]));

    // Nothing left: another event sends nothing more.
    await act(async () => appStateListener()('active'));
    expect(mockReport).toHaveBeenCalledTimes(3);
  });

  it('signed out, nothing is sent', async () => {
    await keptOnThePhone();
    mockSession.me = null;
    await render(<RepairRunner />);
    await act(async () => undefined);
    expect(mockReport).not.toHaveBeenCalled();
  });
});

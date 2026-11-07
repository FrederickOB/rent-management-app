import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';
import Repairs from '../app/repairs';
import { readCache } from '../src/cache';
import { addRepair, flushRepairs, forgetRepairQueue, queuedRepairs } from '../src/repair-queue';
import { SessionProvider, useSession } from '../src/session';
import { AGENCY, apiError, ME, TWO_LANDLORDS } from './fixtures';

// MI-01 and TL-12 (M8 decision 3): signing out, or a session that ended, leaves nothing of the
// tenant's repairs on a shared phone: not the list kept for offline reading, not the requests
// still waiting to go, not their files.

const mockMe = jest.fn();
const mockList = jest.fn();
const mockReport = jest.fn();
const mockForgetAllFiles = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: () => true,
  }),
  useLocalSearchParams: () => ({}),
  useFocusEffect: jest.fn(),
  Redirect: MockRedirect,
}));
jest.mock('expo-web-browser', () => ({
  openBrowserAsync: jest.fn(),
  WebBrowserResultType: { CANCEL: 'cancel', DISMISS: 'dismiss', OPENED: 'opened' },
}));
jest.mock('../src/api', () => ({
  api: {
    me: { get: (...args: unknown[]) => mockMe(...args) },
    tenantRepairs: {
      list: (...args: unknown[]) => mockList(...args),
      report: (...args: unknown[]) => mockReport(...args),
      createUpload: jest.fn(),
    },
  },
}));
jest.mock('../src/auth-client', () => ({
  authClient: { signOut: jest.fn(() => Promise.resolve()) },
}));
jest.mock('../src/repair-files', () => ({
  filesSurvive: true,
  keepFile: jest.fn(),
  keptFilePart: jest.fn(),
  forgetRequestFiles: jest.fn(),
  forgetAllRepairFiles: (...args: unknown[]) => mockForgetAllFiles(...args),
}));

function MockRedirect({ href }: { href: string }) {
  return <Text>Redirected to {href}</Text>;
}

function SignOut() {
  const { signOut } = useSession();
  return (
    <Text testID="sign-out" onPress={() => void signOut()}>
      Sign out
    </Text>
  );
}

/** Signed in until long after any run of these tests. */
const TENANT = { ...ME, sessionExpiresAt: '2099-01-01T00:00:00.000Z' };
const CLIENT_ID = '0193a7c0-0000-4000-8000-00000000d0a1';

/** A request written on this phone that could not go yet: it waits, kept on the phone. */
async function waitingRequest() {
  mockReport.mockRejectedValueOnce(new TypeError('Network request failed'));
  addRepair({
    clientId: CLIENT_ID,
    personId: TENANT.personId,
    companyId: AGENCY.companyId,
    landlordName: AGENCY.name,
    leaseId: TWO_LANDLORDS[0]!.tenancies[0]!.leaseId,
    unitCode: 'ACC-ELG-B1-05',
    category: 'plumbing',
    description: 'Water under the sink, private words',
    emergency: false,
    files: [],
  });
  await flushRepairs(TENANT.personId, AGENCY.companyId);
  await waitFor(async () =>
    expect(await readCache(TENANT.personId, `repairs-queue:${AGENCY.companyId}`)).not.toBeNull(),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  forgetRepairQueue();
  mockForgetAllFiles.mockClear();
  mockMe.mockResolvedValue(TENANT);
  mockList.mockResolvedValue([
    {
      landlord: AGENCY,
      repairs: [
        {
          jobId: '0193a7c0-0000-7000-8000-00000000c0b1',
          ticket: 'MT-0042',
          status: 'reported',
          statusLabel: 'Reported',
          description: 'The kitchen tap drips, private words',
          category: 'plumbing',
          emergency: false,
          leaseId: TWO_LANDLORDS[0]!.tenancies[0]!.leaseId,
          unitCode: 'ACC-ELG-B1-05',
          visitAt: null,
          awaitingResponse: false,
          completionNote: null,
          steps: [],
          attachments: [],
          createdAt: '2026-11-05T09:00:00.000Z',
          forwarded: false,
        },
      ],
    },
  ]);
});

describe('TL-12 signing out empties the repairs kept on the phone', () => {
  it('the list, the waiting request and its files are gone after sign-out', async () => {
    await waitingRequest();
    await render(
      <SessionProvider>
        <Repairs />
        <SignOut />
      </SessionProvider>,
    );
    expect(await screen.findByTestId('repair-row')).toBeOnTheScreen();
    expect(screen.getByTestId('queued-repair')).toBeOnTheScreen();
    await waitFor(async () => expect(await readCache(TENANT.personId, 'repairs')).not.toBeNull());

    await fireEvent.press(screen.getByTestId('sign-out'));
    expect(await screen.findByText('Redirected to /sign-in')).toBeOnTheScreen();
    expect(queuedRepairs(TENANT.personId)).toEqual([]);
    expect(mockForgetAllFiles).toHaveBeenCalled();
    expect(await readCache(TENANT.personId, 'repairs')).toBeNull();
    expect(await readCache(TENANT.personId, 'repairs-queue')).toBeNull();
    const kept = JSON.stringify(await AsyncStorage.multiGet(await AsyncStorage.getAllKeys()));
    expect(kept).not.toContain('private words');
    expect(kept).not.toContain(CLIENT_ID);
  });

  it('a session refused at launch empties them too', async () => {
    await waitingRequest();
    mockMe.mockRejectedValue(apiError(401, 'UNAUTHORIZED'));
    await render(
      <SessionProvider>
        <Repairs />
      </SessionProvider>,
    );
    expect(await screen.findByText('Redirected to /sign-in')).toBeOnTheScreen();
    await waitFor(() => expect(queuedRepairs(TENANT.personId)).toEqual([]));
    expect(mockForgetAllFiles).toHaveBeenCalled();
    await waitFor(async () =>
      expect(await readCache(TENANT.personId, `repairs-queue:${AGENCY.companyId}`)).toBeNull(),
    );
  });
});

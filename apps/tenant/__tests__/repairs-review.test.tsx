import AsyncStorage from '@react-native-async-storage/async-storage';
import type { TenantRepairView } from '@rent/contracts';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { Text } from 'react-native';
import Repairs from '../app/repairs';
import ReportRepair from '../app/repairs/new';
import SignIn from '../app/sign-in';
import { readCache } from '../src/cache';
import { clearDroppedRepairs, droppedRepairs } from '../src/repair-dropped';
import {
  addRepair,
  flushRepairs,
  forgetRepairQueue,
  queuedRepairs,
  restoreRepairs,
} from '../src/repair-queue';
import { checkVoiceNote } from '../src/repair-rules';
import { AGENCY, apiError, LANDLORD, ME, TWO_LANDLORDS } from './fixtures';

// The M8 review round for repairs in the tenant app (MI-01, MI-06; decision 3, F2): no files on
// Starter (LT 3); a photo and a video as two camera actions (LT 4); a voice note that stopped
// itself is kept (LT 5); a request that will still go is never called "not sent" (LT 8); and the
// notes of LT 9. The camera, the recorder and the phone's files are mocked.

const mockReport = jest.fn();
const mockCreateUpload = jest.fn();
const mockTenancies = jest.fn();
const mockList = jest.fn();
const mockCamera = jest.fn();
const mockLibrary = jest.fn();
const mockReplace = jest.fn();
const mockKeep = jest.fn();
const mockVoice: { onAutoStop?: (note: unknown) => void } = {};
const mockParams: { leaseId?: string } = {};
const mockSession = {
  me: ME,
  loading: false,
  ended: false,
  expire: jest.fn(),
  refresh: jest.fn(async () => undefined),
  finishSignOut: jest.fn(async () => undefined),
};

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: mockReplace,
    back: jest.fn(),
    canGoBack: () => true,
    dismissTo: jest.fn(),
  }),
  useLocalSearchParams: () => mockParams,
  useFocusEffect: jest.fn(),
  Redirect: MockRedirect,
}));
jest.mock('../src/session', () => ({ useSession: () => mockSession }));
jest.mock('../src/auth-client', () => ({
  authClient: {
    phoneNumber: {
      sendOtp: jest.fn(async () => ({ data: {}, error: null })),
      verify: jest.fn(async () => ({ data: {}, error: null })),
    },
  },
}));
jest.mock('../src/api', () => ({
  api: {
    tenantApp: { tenancies: (...args: unknown[]) => mockTenancies(...args) },
    tenantRepairs: {
      list: (...args: unknown[]) => mockList(...args),
      createUpload: (...args: unknown[]) => mockCreateUpload(...args),
      report: (...args: unknown[]) => mockReport(...args),
      respond: jest.fn(),
      attachment: jest.fn(),
    },
  },
}));
jest.mock('../src/repair-capture', () => ({
  canUseCamera: true,
  canRecordVoice: true,
  voiceFileInput: false,
  VOICE_SECONDS: 180,
  takeWithCamera: (...args: unknown[]) => mockCamera(...args),
  chooseFromLibrary: (...args: unknown[]) => mockLibrary(...args),
  chooseVoiceFile: async () => ({ status: 'cancelled' }),
  useVoiceRecorder: (onAutoStop?: (note: unknown) => void) => {
    mockVoice.onAutoStop = onAutoStop;
    return {
      supported: true,
      recording: false,
      seconds: 0,
      start: async () => 'started',
      stop: async () => null,
    };
  },
}));
jest.mock('../src/repair-files', () => ({
  filesSurvive: true,
  keepFile: (...args: unknown[]) => mockKeep(...args),
  keptFilePart: (_p: string, client: string, kept: string, name: string, type: string) => ({
    uri: `file:///docs/repairs/${client}/${kept}`,
    name,
    type,
  }),
  forgetRequestFiles: jest.fn(),
  forgetAllRepairFiles: jest.fn(),
}));

function MockRedirect({ href }: { href: string }) {
  return <Text>Redirected to {href}</Text>;
}

const photo = {
  name: 'tap.jpg',
  contentType: 'image/jpeg',
  sizeBytes: 2_400_000,
  durationSeconds: null,
  part: { uri: 'file:///cache/ImagePicker/tap.jpg', name: 'tap.jpg', type: 'image/jpeg' },
};
const voiceNote = {
  name: 'voice-note.m4a',
  contentType: 'audio/mp4',
  sizeBytes: 900_000,
  durationSeconds: 180,
  part: { uri: 'file:///cache/ExpoAudio/rec.m4a', name: 'voice-note.m4a', type: 'audio/mp4' },
};

function repair(overrides: Partial<TenantRepairView> = {}): TenantRepairView {
  return {
    jobId: '0193a7c0-0000-7000-8000-00000000c0b1',
    ticket: 'MT-0042',
    status: 'reported',
    statusLabel: 'Reported',
    description: 'The kitchen tap drips.',
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
    ...overrides,
  };
}

/** One group per landlord, as GET /me/repairs answers: the agency on Growth, the landlord not. */
const GROUPS = [
  { landlord: AGENCY, filesAllowed: true, repairs: [] },
  { landlord: LANDLORD, filesAllowed: false, repairs: [] },
];

beforeEach(() => {
  jest.clearAllMocks();
  for (const mock of [mockReport, mockCreateUpload, mockTenancies, mockList, mockCamera, mockKeep])
    mock.mockReset();
  forgetRepairQueue();
  clearDroppedRepairs();
  delete mockParams.leaseId;
  mockTenancies.mockResolvedValue(TWO_LANDLORDS);
  mockList.mockResolvedValue(GROUPS);
  mockKeep.mockImplementation(
    async (_p: string, client: string, media: Record<string, unknown>, index: number) => ({
      ...media,
      keptName: `${index}-${String(media.name)}`,
      part: { uri: `file:///docs/repairs/${client}/${index}`, name: media.name },
    }),
  );
  mockReport.mockImplementation(async () => repair());
});

async function writeFor(home: 0 | 1, text = 'The kitchen tap drips.') {
  await render(<ReportRepair />);
  const homes = await screen.findAllByTestId('choose-tenancy');
  await fireEvent.press(homes[home]!);
  await fireEvent.press(screen.getByTestId('category-plumbing'));
  await fireEvent.changeText(screen.getByTestId('repair-description'), text);
}

describe('MI-01 F2: no files on Starter (review LT 3)', () => {
  it('a landlord on Starter gets the words only: no file pickers, and nothing uploaded', async () => {
    await writeFor(1);
    await waitFor(() => expect(screen.getByTestId('no-files')).toBeOnTheScreen());
    expect(screen.getByTestId('no-files')).toHaveTextContent(
      'Kwabena Owusu takes repair requests in the app as words only. Say what is wrong, and they will be in touch with you about it.',
    );
    for (const id of ['take-photo', 'record-video', 'choose-media', 'record-voice'])
      expect(screen.queryByTestId(id)).not.toBeOnTheScreen();
    mockReport.mockResolvedValueOnce(repair({ forwarded: true }));
    await fireEvent.press(screen.getByTestId('send-repair'));
    expect(await screen.findByTestId('repair-forwarded')).toBeOnTheScreen();
    expect(mockCreateUpload).not.toHaveBeenCalled();
    expect(mockReport.mock.calls[0]![0]).toMatchObject({ uploadIds: [] });
  });

  it('the agency on Growth keeps the pickers', async () => {
    await writeFor(0);
    await waitFor(() => expect(mockList).toHaveBeenCalled());
    expect(screen.getByTestId('take-photo')).toBeOnTheScreen();
    expect(screen.getByTestId('record-video')).toBeOnTheScreen();
    expect(screen.queryByTestId('no-files')).not.toBeOnTheScreen();
  });

  it('a Starter refusal of files, and a lease that ended long ago, are said plainly', async () => {
    await writeFor(0);
    mockReport.mockRejectedValueOnce(apiError(403, 'REPAIR_FILES_NOT_ON_PLAN'));
    await fireEvent.press(screen.getByTestId('send-repair'));
    expect(await screen.findByTestId('repair-refused')).toHaveTextContent(
      /^Not sent: your landlord does not take photos, videos or voice notes in the app\./,
    );

    forgetRepairQueue();
    await writeFor(0, 'The window will not close.');
    mockReport.mockRejectedValueOnce(apiError(409, 'LEASE_ENDED', 'The lease ended'));
    await fireEvent.press(screen.getByTestId('send-repair'));
    expect(await screen.findByTestId('repair-refused')).toHaveTextContent(
      /this tenancy ended more than 30 days ago, so a repair for it cannot be reported in the app\. Contact your landlord directly/,
    );
  });
});

describe('MI-01 photos, videos and voice notes on the phone (review LT 4 and LT 5)', () => {
  it('“Take a photo” and “Record a video” ask the camera for one each', async () => {
    mockCamera.mockResolvedValue({ status: 'cancelled' });
    await writeFor(0);
    await fireEvent.press(screen.getByTestId('take-photo'));
    await fireEvent.press(screen.getByTestId('record-video'));
    await waitFor(() => expect(mockCamera).toHaveBeenCalledTimes(2));
    expect(mockCamera.mock.calls.map(([kind]) => kind)).toEqual(['photo', 'video']);
  });

  it('a voice note that stopped itself at 3 minutes is added, and the tenant is told', async () => {
    await writeFor(0);
    await act(async () => mockVoice.onAutoStop?.(voiceNote));
    await waitFor(() => expect(screen.getAllByTestId('repair-file')).toHaveLength(1));
    expect(screen.getByTestId('repair-file')).toHaveTextContent(/^Voice note \(3:00\)/);
    expect(screen.getByTestId('repair-problem')).toHaveTextContent(
      'Recording stopped at 3 minutes, the longest a voice note can be.',
    );
  });
});

describe('MI-01 a request that will still go is never called “not sent” (review LT 8)', () => {
  it('a server that cannot take it just now: saved, it goes by itself, no need to write it again', async () => {
    await writeFor(0);
    mockReport.mockRejectedValueOnce(apiError(503, 'UNAVAILABLE'));
    await fireEvent.press(screen.getByTestId('send-repair'));
    const waiting = await screen.findByTestId('repair-waiting');
    expect(waiting).toHaveTextContent(
      'We could not send your request just now, so it is saved on this phone. It will be sent by itself: there is no need to write it again.',
    );
    expect(screen.queryByTestId('repair-refused')).not.toBeOnTheScreen();
    expect(queuedRepairs(ME.personId)).toMatchObject([{ retryable: true }]);
  });

  it('offline: it will be sent when the tenant is back online', async () => {
    await writeFor(0);
    mockReport.mockRejectedValueOnce(new TypeError('Network request failed'));
    await fireEvent.press(screen.getByTestId('send-repair'));
    expect(await screen.findByTestId('repair-waiting')).toHaveTextContent(
      'You are offline, so your request is saved on this phone. It will be sent when you are back online: there is no need to write it again.',
    );
  });
});

describe('MI-01 the notes of the review (LT 9)', () => {
  it('Send waits while a file is still being kept', async () => {
    let keepDone!: () => void;
    mockKeep.mockImplementationOnce(
      (_p: string, client: string, media: Record<string, unknown>, index: number) =>
        new Promise((resolve) => {
          keepDone = () =>
            resolve({ ...media, keptName: `${index}-tap.jpg`, part: { uri: `file:///${client}` } });
        }),
    );
    mockLibrary.mockResolvedValueOnce({ status: 'chosen', media: [photo] });
    await writeFor(0);
    await fireEvent.press(screen.getByTestId('choose-media'));
    await waitFor(() => expect(mockKeep).toHaveBeenCalled());
    await fireEvent.press(screen.getByTestId('send-repair'));
    expect(mockReport).not.toHaveBeenCalled();
    await act(async () => keepDone());
    await waitFor(() => expect(screen.getAllByTestId('repair-file')).toHaveLength(1));
  });

  it('Discard asks first for a request that would still go; Keep it keeps it', async () => {
    mockReport.mockRejectedValueOnce(new TypeError('Network request failed'));
    addRepair({
      clientId: '0193a7c0-0000-4000-8000-00000000e001',
      personId: ME.personId,
      companyId: AGENCY.companyId,
      landlordName: AGENCY.name,
      leaseId: TWO_LANDLORDS[0]!.tenancies[0]!.leaseId,
      unitCode: null,
      category: 'plumbing',
      description: 'Waiting to go.',
      emergency: false,
      files: [],
    });
    await flushRepairs(ME.personId, AGENCY.companyId);
    await render(<Repairs />);
    const row = await screen.findByTestId('queued-repair');
    await fireEvent.press(within(row).getByTestId('discard-queued'));
    expect(screen.getByTestId('confirm-discard-box')).toHaveTextContent(
      /Discard this request\? It has not reached Osu Ridge Property Managers yet/,
    );
    await fireEvent.press(screen.getByTestId('keep-queued'));
    expect(screen.getByTestId('queued-repair')).toBeOnTheScreen();
    expect(queuedRepairs(ME.personId)).toHaveLength(1);

    await fireEvent.press(screen.getByTestId('discard-queued'));
    await fireEvent.press(screen.getByTestId('confirm-discard'));
    await waitFor(() => expect(screen.queryByTestId('queued-repair')).not.toBeOnTheScreen());
    expect(queuedRepairs(ME.personId)).toEqual([]);
  });

  it('a request that holds a link is kept on the phone too, with the link taken out', async () => {
    mockReport.mockRejectedValueOnce(new TypeError('Network request failed'));
    const clientId = '0193a7c0-0000-4000-8000-00000000e002';
    addRepair({
      clientId,
      personId: ME.personId,
      companyId: AGENCY.companyId,
      landlordName: AGENCY.name,
      leaseId: TWO_LANDLORDS[0]!.tenancies[0]!.leaseId,
      unitCode: null,
      category: 'electrical',
      description: 'Sparks, see https://video.example/clip?id=7 and the socket by the door.',
      emergency: true,
      files: [],
    });
    await flushRepairs(ME.personId, AGENCY.companyId);
    await waitFor(async () =>
      expect(await readCache(ME.personId, `repairs-queue:${AGENCY.companyId}`)).not.toBeNull(),
    );
    const kept = JSON.stringify(await AsyncStorage.multiGet(await AsyncStorage.getAllKeys()));
    expect(kept).not.toContain('://');
    expect(kept).toContain('Sparks, see [link] and the socket by the door.');

    // The app closes and opens again: the request is still there, and goes once.
    forgetRepairQueue();
    await restoreRepairs(ME.personId);
    expect(queuedRepairs(ME.personId)).toMatchObject([
      { clientId, description: 'Sparks, see [link] and the socket by the door.' },
    ]);
  });

  it('a session that ended with requests on the phone: the sign-in screen says they went', async () => {
    addRepair({
      clientId: '0193a7c0-0000-4000-8000-00000000e003',
      personId: ME.personId,
      companyId: AGENCY.companyId,
      landlordName: AGENCY.name,
      leaseId: TWO_LANDLORDS[0]!.tenancies[0]!.leaseId,
      unitCode: null,
      category: 'plumbing',
      description: 'One more.',
      emergency: false,
      files: [],
    });
    forgetRepairQueue('session_ended');
    expect(droppedRepairs()).toBe(1);
    const shown = await render(<SignIn />);
    expect(screen.getByTestId('repairs-dropped')).toHaveTextContent(
      'The repair request you had not sent yet was removed from this phone when your session ended. Write it again after you sign in.',
    );
    await shown.unmount();

    // A plain sign-out says nothing; signing in again clears it.
    forgetRepairQueue();
    expect(droppedRepairs()).toBe(1);
    await render(<SignIn />);
    await fireEvent.changeText(screen.getByTestId('phone-input'), '024 412 3456');
    await fireEvent.press(screen.getByTestId('send-code'));
    await fireEvent.changeText(await screen.findByTestId('code-input'), '123456');
    await fireEvent.press(screen.getByTestId('verify-code'));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/home'));
    expect(droppedRepairs()).toBe(0);
  });

  it('a voice note saved as an MPEG-4 video file goes as a video, and the tenant is told why', () => {
    expect(
      checkVoiceNote({ contentType: 'video/mp4', sizeBytes: 800_000, durationSeconds: 60 }),
    ).toEqual({
      ok: true,
      kind: 'video',
      notice: 'That voice note is saved in a video format (MPEG-4), so it is sent as a video.',
    });
    expect(
      checkVoiceNote({ contentType: 'video/mp4', sizeBytes: 800_000, durationSeconds: 120 }),
    ).toEqual({
      ok: false,
      problem:
        'That voice note is saved in a video format (MPEG-4), so it is sent as a video, which can be at most 90 seconds. Choose a shorter one, or one saved as AAC or MP3.',
    });
    expect(
      checkVoiceNote({ contentType: 'audio/mp4', sizeBytes: 800_000, durationSeconds: 120 }),
    ).toEqual({ ok: true, kind: 'audio' });
  });
});

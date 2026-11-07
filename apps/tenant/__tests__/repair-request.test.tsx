import type { TenantRepairView } from '@rent/contracts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { Text } from 'react-native';
import ReportRepair from '../app/repairs/new';
import {
  flushAllRepairs,
  forgetRepairQueue,
  queuedRepairs,
  restoreRepairs,
} from '../src/repair-queue';
import { AGENCY, LANDLORD, ME, TWO_LANDLORDS } from './fixtures';
import { UUID_V4 } from './message-fixtures';

// MI-01 (M8 decision 3 and plan 4.3): a repair request from the tenant app, with photos, video and
// voice notes, that goes once however often it is tried, offline included. The camera, the
// recorder and the phone's files are mocked; the queue and the screen are real.

const mockReport = jest.fn();
const mockCreateUpload = jest.fn();
const mockTenancies = jest.fn();
const mockCamera = jest.fn();
const mockLibrary = jest.fn();
const mockVoiceStart = jest.fn();
const mockVoiceStop = jest.fn();
const mockForgetFiles = jest.fn();
const mockReplace = jest.fn();
const mockParams: { leaseId?: string } = {};
const mockSession = { me: ME, loading: false, ended: false, expire: jest.fn() };

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: mockReplace,
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
    tenantApp: { tenancies: (...args: unknown[]) => mockTenancies(...args) },
    tenantRepairs: {
      createUpload: (...args: unknown[]) => mockCreateUpload(...args),
      report: (...args: unknown[]) => mockReport(...args),
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
  useVoiceRecorder: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- inside the mock factory
    const { useState } = require('react') as {
      useState: (initial: boolean) => [boolean, (next: boolean) => void];
    };
    const [recording, setRecording] = useState(false);
    return {
      supported: true,
      recording,
      seconds: 0,
      start: async () => {
        const started = (await mockVoiceStart()) as string;
        if (started === 'started') setRecording(true);
        return started;
      },
      stop: async () => {
        setRecording(false);
        return mockVoiceStop();
      },
    };
  },
}));
// The phone's files: kept under the request's folder by name, as repair-files.ts does.
jest.mock('../src/repair-files', () => ({
  filesSurvive: true,
  keepFile: async (
    _person: string,
    client: string,
    media: Record<string, unknown>,
    index: number,
  ) => ({
    ...media,
    keptName: `${index}-${String(media.name)}`,
    sizeBytes: (media.sizeBytes as number) || 1_234,
    part: {
      uri: `file:///docs/repairs/${client}/${index}-${String(media.name)}`,
      name: media.name,
      type: media.contentType,
    },
  }),
  keptFilePart: (_person: string, client: string, kept: string, name: string, type: string) => ({
    uri: `file:///docs/repairs/${client}/${kept}`,
    name,
    type,
  }),
  forgetRequestFiles: (...args: unknown[]) => mockForgetFiles(...args),
  forgetAllRepairFiles: jest.fn(),
}));

function MockRedirect({ href }: { href: string }) {
  return <Text>Redirected to {href}</Text>;
}

/** React Native's FormData takes a file as `{ uri, name, type }`; this records what is added. */
class PhoneFormData {
  readonly parts: [string, unknown][] = [];
  append(name: string, value: unknown) {
    this.parts.push([name, value]);
  }
}
const realFetch = globalThis.fetch;
const realFormData = globalThis.FormData;
const storage = jest.fn();
const STORAGE = 'https://storage.example.test/rent-uploads';

const photo = {
  name: 'tap.jpg',
  contentType: 'image/jpeg',
  sizeBytes: 2_400_000,
  durationSeconds: null,
  part: { uri: 'file:///tmp/tap.jpg', name: 'tap.jpg', type: 'image/jpeg' },
};
const voiceNote = {
  name: 'voice-note.m4a',
  contentType: 'audio/mp4',
  sizeBytes: 0,
  durationSeconds: 42,
  part: { uri: 'file:///tmp/rec.m4a', name: 'voice-note.m4a', type: 'audio/mp4' },
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
    steps: [{ kind: 'reported', at: '2026-11-05T09:00:00.000Z' }],
    attachments: [],
    createdAt: '2026-11-05T09:00:00.000Z',
    forwarded: false,
    ...overrides,
  };
}

let uploads = 0;
beforeEach(() => {
  jest.clearAllMocks();
  for (const mock of [
    mockReport,
    mockCreateUpload,
    mockTenancies,
    mockCamera,
    mockLibrary,
    mockVoiceStart,
    mockVoiceStop,
    storage,
  ])
    mock.mockReset();
  forgetRepairQueue();
  uploads = 0;
  delete mockParams.leaseId;
  mockTenancies.mockResolvedValue(TWO_LANDLORDS);
  mockCreateUpload.mockImplementation(async () => ({
    uploadId: `0193a7c0-0000-7000-8000-0000000d00${String((uploads += 1)).padStart(2, '0')}`,
    url: STORAGE,
    fields: { key: 'uploads/repairs/x', policy: 'cG9saWN5' },
    expiresAt: '2026-11-05T12:10:00.000Z',
  }));
  mockReport.mockImplementation(async () => repair());
  storage.mockResolvedValue({ ok: true, status: 204 });
  globalThis.fetch = storage as unknown as typeof fetch;
  globalThis.FormData = PhoneFormData as unknown as typeof FormData;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  globalThis.FormData = realFormData;
});

async function writeRequest() {
  await render(<ReportRepair />);
  const homes = await screen.findAllByTestId('choose-tenancy');
  expect(homes).toHaveLength(2);
  await fireEvent.press(homes[0]!);
  await fireEvent.press(screen.getByTestId('category-plumbing'));
  await fireEvent.changeText(screen.getByTestId('repair-description'), 'The kitchen tap drips.');
}

describe('MI-01 a repair request from the app, with its files (decision 3)', () => {
  it('a photo and a voice note go to storage first, then one job; the files then leave the phone', async () => {
    mockCamera.mockResolvedValue({ status: 'chosen', media: [photo] });
    mockVoiceStart.mockResolvedValue('started');
    mockVoiceStop.mockResolvedValue(voiceNote);
    await writeRequest();
    await fireEvent.press(screen.getByTestId('take-photo'));
    await fireEvent.press(screen.getByTestId('record-voice'));
    await waitFor(() =>
      expect(screen.getByTestId('record-voice')).toHaveTextContent(/Stop recording/),
    );
    await fireEvent.press(screen.getByTestId('record-voice'));
    await waitFor(() => expect(screen.getAllByTestId('repair-file')).toHaveLength(2));
    const files = screen.getAllByTestId('repair-file');
    expect(files[0]).toHaveTextContent(/^Photo \(2\.4 MB\)/);
    expect(files[1]).toHaveTextContent(/^Voice note \(0:42\)/);

    await fireEvent.press(screen.getByTestId('send-repair'));
    expect(await screen.findByTestId('repair-sent')).toHaveTextContent(/Your request is MT-0042/);
    const leaseId = TWO_LANDLORDS[0]!.tenancies[0]!.leaseId;
    expect(mockCreateUpload.mock.calls.map(([input]) => input)).toEqual([
      { leaseId, contentType: 'image/jpeg', sizeBytes: 2_400_000, durationSeconds: null },
      { leaseId, contentType: 'audio/mp4', sizeBytes: 1_234, durationSeconds: 42 },
    ]);
    const posted = storage.mock.calls.map(
      ([, init]) => (init as { body: PhoneFormData }).body.parts,
    );
    expect(posted).toHaveLength(2);
    expect(posted[0]!.map(([name]) => name)).toEqual(['key', 'policy', 'file']);
    expect(posted[0]![2]![1]).toMatchObject({ name: 'tap.jpg', type: 'image/jpeg' });
    expect(mockReport).toHaveBeenCalledTimes(1);
    const sent = mockReport.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      leaseId,
      category: 'plumbing',
      description: 'The kitchen tap drips.',
      emergency: false,
      uploadIds: ['0193a7c0-0000-7000-8000-0000000d0001', '0193a7c0-0000-7000-8000-0000000d0002'],
    });
    expect(sent.clientId).toMatch(UUID_V4);
    expect(mockForgetFiles).toHaveBeenCalledWith(ME.personId, sent.clientId);
    expect(queuedRepairs(ME.personId)).toEqual([]);
  });

  it('written offline: saved on the phone, then sent by itself once, with the same clientId, uploading nothing twice', async () => {
    mockCamera.mockResolvedValue({ status: 'chosen', media: [photo] });
    mockReport.mockRejectedValueOnce(new TypeError('Network request failed'));
    await writeRequest();
    await fireEvent.press(screen.getByTestId('take-photo'));
    await screen.findByTestId('repair-file');
    await fireEvent.press(screen.getByTestId('send-repair'));
    expect(await screen.findByTestId('repair-waiting')).toHaveTextContent(/saved on this phone/);
    const [waiting] = queuedRepairs(ME.personId);
    expect(waiting).toMatchObject({ state: 'waiting', companyId: AGENCY.companyId });

    // Back online: what the app does when it comes back or the network returns (RepairRunner).
    const results = await flushAllRepairs(ME.personId);
    expect(results).toMatchObject([{ status: 'sent', repair: { ticket: 'MT-0042' } }]);
    expect(mockReport).toHaveBeenCalledTimes(2);
    const [first, second] = mockReport.mock.calls.map(
      ([input]) => input as { clientId: string; uploadIds: string[] },
    );
    expect(second!.clientId).toBe(first!.clientId);
    expect(second!.uploadIds).toEqual(first!.uploadIds);
    expect(mockCreateUpload).toHaveBeenCalledTimes(1);
    expect(queuedRepairs(ME.personId)).toEqual([]);
  });

  it('a request still waiting when the app closes is sent once when it opens again', async () => {
    mockCamera.mockResolvedValue({ status: 'chosen', media: [photo] });
    mockReport.mockRejectedValueOnce(new TypeError('Network request failed'));
    await writeRequest();
    await fireEvent.press(screen.getByTestId('take-photo'));
    await screen.findByTestId('repair-file');
    await fireEvent.press(screen.getByTestId('send-repair'));
    await screen.findByTestId('repair-waiting');
    const clientId = queuedRepairs(ME.personId)[0]!.clientId;

    // The app closes: memory goes; the queue and the files stay on the phone.
    forgetRepairQueue();
    expect(queuedRepairs(ME.personId)).toEqual([]);
    await restoreRepairs(ME.personId);
    expect(queuedRepairs(ME.personId)).toMatchObject([{ clientId, state: 'waiting' }]);
    await flushAllRepairs(ME.personId);
    expect(mockReport).toHaveBeenCalledTimes(2);
    expect(mockReport.mock.calls[1]![0]).toMatchObject({ clientId });
    // The photo reached storage before the app closed: it is not uploaded again.
    expect(mockCreateUpload).toHaveBeenCalledTimes(1);
  });

  it('the emergency flag goes with it; on Starter the tenant hears their landlord was told directly', async () => {
    mockReport.mockImplementation(async () => repair({ forwarded: true, emergency: true }));
    await writeRequest();
    await fireEvent(screen.getByTestId('repair-emergency'), 'valueChange', true);
    await fireEvent.press(screen.getByTestId('send-repair'));
    expect(await screen.findByTestId('repair-forwarded')).toHaveTextContent(
      `We sent your request to ${AGENCY.name} directly.`,
      { exact: false },
    );
    expect(mockReport.mock.calls[0]![0]).toMatchObject({ emergency: true, uploadIds: [] });
  });

  it('keeps the limits: at most 10 files, a video of up to 90 seconds, the kinds the server takes', async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ ...photo, name: `p${i}.jpg` }));
    mockLibrary.mockResolvedValueOnce({ status: 'chosen', media: many });
    await writeRequest();
    await fireEvent.press(screen.getByTestId('choose-media'));
    await waitFor(() => expect(screen.getAllByTestId('repair-file')).toHaveLength(10));
    expect(screen.getByTestId('repair-problem')).toHaveTextContent(
      'You can send up to 10 files with one request.',
    );
    expect(mockLibrary).toHaveBeenCalledWith(10);

    // Make room, then try a long video and a HEIC photo.
    for (let i = 0; i < 10; i += 1) await fireEvent.press(screen.getAllByTestId('remove-file')[0]!);
    mockLibrary.mockResolvedValueOnce({
      status: 'chosen',
      media: [
        { ...photo, name: 'long.mov', contentType: 'video/quicktime', durationSeconds: 120 },
        { ...photo, name: 'x.heic', contentType: 'image/heic' },
      ],
    });
    await fireEvent.press(screen.getByTestId('choose-media'));
    await waitFor(() =>
      expect(screen.getByTestId('repair-problem')).toHaveTextContent(/cannot be sent|too long/),
    );
    expect(screen.queryByTestId('repair-file')).not.toBeOnTheScreen();
  });

  it('a refused camera or microphone is said plainly', async () => {
    mockCamera.mockResolvedValue({ status: 'denied' });
    mockVoiceStart.mockResolvedValue('denied');
    await writeRequest();
    await fireEvent.press(screen.getByTestId('take-photo'));
    expect(await screen.findByTestId('repair-problem')).toHaveTextContent(/may not use the camera/);
    await fireEvent.press(screen.getByTestId('record-voice'));
    await waitFor(() =>
      expect(screen.getByTestId('repair-problem')).toHaveTextContent(/may not use the microphone/),
    );
  });

  it('asks for the home, the kind and the words before anything is sent', async () => {
    await render(<ReportRepair />);
    await screen.findAllByTestId('choose-tenancy');
    await fireEvent.press(screen.getByTestId('send-repair'));
    expect(screen.getByTestId('repair-problem')).toHaveTextContent(
      'Choose the tenancy the repair is for.',
    );
    await fireEvent.press(screen.getAllByTestId('choose-tenancy')[1]!);
    await fireEvent.press(screen.getByTestId('send-repair'));
    expect(screen.getByTestId('repair-problem')).toHaveTextContent(
      'Choose what kind of repair it is.',
    );
    await fireEvent.press(screen.getByTestId('category-electrical'));
    await fireEvent.press(screen.getByTestId('send-repair'));
    expect(screen.getByTestId('repair-problem')).toHaveTextContent(
      'Say in a few words what is wrong.',
    );
    expect(mockReport).not.toHaveBeenCalled();
  });

  it('a request opened from a tenancy is for that tenancy, and its landlord’s queue (TL-12)', async () => {
    mockParams.leaseId = TWO_LANDLORDS[1]!.tenancies[0]!.leaseId;
    mockReport.mockRejectedValueOnce(new TypeError('Network request failed'));
    await render(<ReportRepair />);
    await waitFor(() =>
      expect(
        within(screen.getAllByTestId('choose-tenancy')[1]!).getByText(/With Kwabena Owusu/),
      ).toBeOnTheScreen(),
    );
    await fireEvent.press(screen.getByTestId('category-roofing'));
    await fireEvent.changeText(screen.getByTestId('repair-description'), 'The roof leaks.');
    await fireEvent.press(screen.getByTestId('send-repair'));
    await screen.findByTestId('repair-waiting');
    expect(mockReport.mock.calls[0]![0]).toMatchObject({ leaseId: mockParams.leaseId });
    expect(queuedRepairs(ME.personId, LANDLORD.companyId)).toHaveLength(1);
    expect(queuedRepairs(ME.personId, AGENCY.companyId)).toHaveLength(0);
  });
});

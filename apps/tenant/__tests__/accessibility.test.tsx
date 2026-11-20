import { render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { Pressable, Text, TextInput } from 'react-native';
import Home from '../app/home';
import Messages from '../app/messages';
import Thread from '../app/messages/[companyId]';
import Payments from '../app/payments';
import Profile from '../app/profile';
import Repairs from '../app/repairs';
import ReportRepair from '../app/repairs/new';
import SignIn from '../app/sign-in';
import TenancyScreen from '../app/tenancy/[leaseId]';
import ToSign from '../app/to-sign';
import { Button } from '../src/ui';
import { AGENCY, detail, LANDLORD, ME, signingItem, TWO_LANDLORDS } from './fixtures';
import { CONVERSATIONS, THREAD } from './message-fixtures';
import { BILLING, PAYMENTS } from './money-fixtures';

// NFR-A11Y (M11 plan 4.9): on the phone apps, every control on the key screens says what it is
// (a role) and has a name a screen reader reads (VoiceOver, TalkBack): buttons, links, radios,
// switches and text fields. Each screen renders with the fixtures the screen tests use.

const mockParams: Record<string, string> = {};
const mockSession = {
  me: ME,
  loading: false,
  ended: false,
  expire: jest.fn(),
  refresh: jest.fn(async () => undefined),
  finishSignOut: jest.fn(async () => undefined),
  signOut: jest.fn(async () => undefined),
};

jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: () => true,
    dismissTo: jest.fn(),
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
jest.mock('../src/auth-client', () => ({
  authClient: {
    phoneNumber: { sendOtp: jest.fn(), verify: jest.fn() },
    signOut: jest.fn(),
    listSessions: async () => ({ data: [], error: null }),
    revokeSession: jest.fn(),
  },
}));
jest.mock('../src/push-context', () => ({
  usePush: () => ({
    state: 'unavailable',
    consent: null,
    available: false,
    turnOn: jest.fn(),
    turnOff: jest.fn(),
    refresh: jest.fn(),
  }),
}));
/** What the API answers, read when a screen asks (the mock factory runs before this is set). */
const mockAnswers = {
  me: () => ME,
  tenancies: () => TWO_LANDLORDS,
  tenancy: () => detail(),
  signing: () => [signingItem()],
  billing: (leaseId: string) => BILLING[leaseId],
  payments: () => PAYMENTS,
  conversations: () => CONVERSATIONS,
  thread: () => THREAD,
  repairs: () => [
    { landlord: AGENCY, filesAllowed: true, repairs: [] },
    { landlord: LANDLORD, filesAllowed: false, repairs: [] },
  ],
};
jest.mock('../src/api', () => ({
  api: {
    me: { get: async () => mockAnswers.me() },
    tenantApp: {
      tenancies: async () => mockAnswers.tenancies(),
      tenancy: async () => mockAnswers.tenancy(),
      signing: async () => mockAnswers.signing(),
      notices: async () => [],
      documents: async () => [],
    },
    tenantMoney: {
      billing: async ({ leaseId }: { leaseId: string }) => mockAnswers.billing(leaseId),
      payments: async () => mockAnswers.payments(),
    },
    tenantMessaging: {
      conversations: async () => mockAnswers.conversations(),
      messages: async () => mockAnswers.thread(),
    },
    tenantRepairs: { list: async () => mockAnswers.repairs() },
    tenantPush: { consent: async () => ({ consented: false }) },
  },
}));
jest.mock('../src/repair-capture', () => ({
  canUseCamera: true,
  canRecordVoice: true,
  voiceFileInput: false,
  VOICE_SECONDS: 180,
  takeWithCamera: jest.fn(),
  chooseFromLibrary: jest.fn(),
  chooseVoiceFile: jest.fn(),
  useVoiceRecorder: () => ({
    supported: true,
    recording: false,
    seconds: 0,
    start: jest.fn(),
    stop: jest.fn(),
  }),
}));
jest.mock('../src/repair-files', () => ({
  filesSurvive: true,
  keepFile: jest.fn(),
  keptFilePart: jest.fn(),
  forgetRequestFiles: jest.fn(),
  forgetAllRepairFiles: jest.fn(),
}));
jest.mock('../src/photo-picker', () => ({ choosePhotos: jest.fn(), canChoosePhotos: false }));

function MockRedirect({ href }: { href: string }) {
  return <Text>Redirected to {href}</Text>;
}

/** A host element of the rendered screen: its type and props, and its children. */
interface Host {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
  readonly children: readonly (Host | string)[];
}

const textOf = (node: Host | string): string =>
  typeof node === 'string' ? node : node.children.map(textOf).join('');

/** What a screen reader calls a control: its label, or the text inside it. */
const nameOf = (node: Host): string =>
  String(node.props.accessibilityLabel ?? node.props['aria-label'] ?? textOf(node)).trim();

/** The whole rendered tree: the container, so every root is seen. */
const everything = (): Host =>
  ((screen as unknown as { container?: Host }).container ?? screen.root) as unknown as Host;

const CONTROL_ROLES = new Set(['button', 'link', 'radio', 'switch', 'checkbox', 'tab', 'menuitem']);

/** Every control on the screen: something that can be pressed, typed into or switched. */
function controls(root: Host): { kind: string; role: string; name: string; id: string }[] {
  const found: { kind: string; role: string; name: string; id: string }[] = [];
  const visit = (node: Host | string) => {
    if (typeof node === 'string') return;
    const type = String(node.type);
    const role = String(node.props.accessibilityRole ?? node.props.role ?? '');
    const pressable = typeof node.props.onClick === 'function' || node.props.accessible === true;
    const kind =
      type === 'TextInput'
        ? 'text field'
        : type === 'RCTSwitch' || type.includes('Switch')
          ? 'switch'
          : pressable && (role !== '' || typeof node.props.onClick === 'function')
            ? 'pressable'
            : null;
    if (kind) found.push({ kind, role, name: nameOf(node), id: String(node.props.testID ?? type) });
    for (const child of node.children) visit(child);
  };
  visit(root);
  return found;
}

/** Problems: a control with no role a screen reader knows, or without a name. */
function gaps(root: Host): string[] {
  return controls(root).flatMap((c) => {
    const problems: string[] = [];
    if (c.kind === 'pressable' && !CONTROL_ROLES.has(c.role))
      problems.push(`${c.id}: no control role (has "${c.role}")`);
    if (c.name === '') problems.push(`${c.id}: no name`);
    return problems;
  });
}

const SCREENS: [name: string, element: () => ReactElement, ready: string, params?: object][] = [
  ['sign-in', () => <SignIn />, 'phone-input'],
  ['home, with what is due and Pay', () => <Home />, 'pay'],
  [
    'tenancy',
    () => <TenancyScreen />,
    'fact-deposit',
    { leaseId: TWO_LANDLORDS[0]!.tenancies[0]!.leaseId },
  ],
  ['payments', () => <Payments />, 'payment-row'],
  ['messages', () => <Messages />, 'conversation-row'],
  ['a conversation', () => <Thread />, 'message-input', { companyId: AGENCY.companyId }],
  ['repairs', () => <Repairs />, 'report-repair'],
  ['new repair', () => <ReportRepair />, 'repair-description'],
  ['to sign', () => <ToSign />, 'review-and-sign'],
  ['profile', () => <Profile />, 'sign-out'],
];

describe('NFR-A11Y native: every control on the key screens has a role and a name', () => {
  for (const [name, element, ready, params] of SCREENS) {
    it(`${name}`, async () => {
      for (const key of Object.keys(mockParams)) delete mockParams[key];
      Object.assign(mockParams, params ?? {});
      await render(element());
      await waitFor(() => expect(screen.getAllByTestId(ready).length).toBeGreaterThan(0));
      const root = everything();
      expect(controls(root).length).toBeGreaterThan(0);
      expect(gaps(root)).toEqual([]);
    });
  }

  it('the check finds a control with no role, and one with no name', async () => {
    await render(
      <>
        <Pressable testID="no-role" onPress={() => undefined}>
          <Text>Open</Text>
        </Pressable>
        <Pressable testID="no-name" accessibilityRole="button" onPress={() => undefined} />
        <TextInput testID="unnamed-field" />
      </>,
    );
    expect(gaps(everything())).toEqual([
      'no-role: no control role (has "")',
      'no-name: no name',
      'unnamed-field: no name',
    ]);
  });

  it('a busy button keeps its name while it works', async () => {
    await render(<Button label="Send the request" busy testID="busy" onPress={() => undefined} />);
    expect(screen.getByTestId('busy')).toHaveAccessibleName('Send the request');
  });
});

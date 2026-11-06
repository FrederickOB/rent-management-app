import type { TenancyGroupView, TenantSigningView } from '@rent/contracts';
import { Redirect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { api } from '../src/api';
import { formatTime, leaseStatusLabel, leaseStatusTone, rentLabel, termLabel } from '../src/format';
import { conversationsForCache, loadConversations } from '../src/messages';
import { loadRepairs } from '../src/repair-queue';
import { toProblem } from '../src/problems';
import { usePush } from '../src/push-context';
import { landlordList, markPromptAnswered, promptAnswered } from '../src/push-prompt';
import type { TurnOn } from '../src/push-registration';
import { useSession } from '../src/session';
import { toSignSummary } from '../src/signing-items';
import { isBilled, TenancyMoney } from '../src/tenancy-money';
import {
  Badge,
  Body,
  Button,
  Card,
  colours,
  ErrorText,
  Heading,
  Loading,
  Notice,
  Screen,
  Small,
} from '../src/ui';
import { useCachedLoad, type CachedView } from '../src/use-cached-load';
import { useLoad, useReloadOnReturn, type LoadState } from '../src/use-load';

type Tenancy = TenancyGroupView['tenancies'][number];

const loadTenancies = () => api.tenantApp.tenancies();
const loadSigning = () => api.tenantApp.signing();

/**
 * Home (TL-01): the tenant's tenancies, grouped by landlord, each with what is due, paid-until
 * and the next payment, and Pay (M4b plan 4.10); and what is waiting for their signature (TL-07).
 * Each landlord's tenancies and money stay in a box of their own (TL-12): the screen never merges,
 * totals or compares one landlord's records with another's. Offline, the figures last fetched on
 * this device show, with the time they were fetched.
 */
export default function Home() {
  const router = useRouter();
  const { me, loading } = useSession();
  const tenancies = useCachedLoad('tenancies', loadTenancies, Boolean(me));
  const signing = useLoad(loadSigning, Boolean(me));
  const conversations = useCachedLoad(
    'conversations',
    loadConversations,
    Boolean(me),
    conversationsForCache,
  );
  // Each tenancy's money reloads when this goes up: on coming back to the screen or the app.
  const [moneyTick, setMoneyTick] = useState(0);
  const { reload: reloadTenancies } = tenancies;
  const { reload: reloadSigning } = signing;
  const repairs = useCachedLoad('repairs', loadRepairs, Boolean(me));
  const { reload: reloadConversations } = conversations;
  const { reload: reloadRepairs } = repairs;
  useReloadOnReturn(
    useCallback(() => {
      reloadTenancies();
      reloadSigning();
      reloadConversations();
      reloadRepairs();
      setMoneyTick((tick) => tick + 1);
    }, [reloadTenancies, reloadSigning, reloadConversations, reloadRepairs]),
  );
  const newMessages =
    conversations.view.status === 'ready' &&
    conversations.view.data.some((conversation) => conversation.unreadCount > 0);

  if (!loading && !me) return <Redirect href="/sign-in" />;
  return (
    <Screen title={me ? `Hello, ${me.name}` : 'Hello'} scroll>
      <ToSignEntry state={signing.state} onOpen={() => router.push('/to-sign')} />
      <Tenancies
        view={tenancies.view}
        onRetry={tenancies.retry}
        onReload={tenancies.reload}
        moneyTick={moneyTick}
        onOpen={(leaseId) => router.push(`/tenancy/${leaseId}`)}
      />
      {me && tenancies.view.status === 'ready' ? <PushPrompt personId={me.personId} /> : null}
      <MessagesEntry newMessages={newMessages} onOpen={() => router.push('/messages')} />
      <RepairsEntry
        waiting={
          repairs.view.status === 'ready' &&
          repairs.view.data.some((group) => group.repairs.some((repair) => repair.awaitingResponse))
        }
        onOpen={() => router.push('/repairs')}
      />
      <Button
        label="Payments and receipts"
        variant="quiet"
        testID="open-payments"
        onPress={() => router.push('/payments')}
      />
      <Button
        label="Profile and devices"
        variant="quiet"
        testID="open-profile"
        onPress={() => router.push('/profile')}
      />
    </Screen>
  );
}

/**
 * Messages (CM-05): the way in, marked when any landlord has written since the tenant last looked.
 * The marker says only that there is something new: Home never totals one landlord's records with
 * another's (TL-12).
 */
function MessagesEntry({ newMessages, onOpen }: { newMessages: boolean; onOpen: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={newMessages ? 'Messages, new messages' : 'Messages'}
      testID="open-messages"
      onPress={onOpen}
      style={({ pressed }) => [styles.entry, pressed && styles.pressed]}
    >
      <Text style={styles.entryText}>Messages</Text>
      {newMessages ? <Badge label="New" tone="ok" testID="new-messages" /> : null}
    </Pressable>
  );
}

/**
 * Repairs (MI-01, MI-06): the way in, marked when a repair's work is done and waits for the
 * tenant to confirm it or say what is still wrong.
 */
function RepairsEntry({ waiting, onOpen }: { waiting: boolean; onOpen: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={waiting ? 'Repairs, waiting for you' : 'Repairs'}
      testID="open-repairs"
      onPress={onOpen}
      style={({ pressed }) => [styles.entry, pressed && styles.pressed]}
    >
      <Text style={styles.entryText}>Repairs</Text>
      {waiting ? <Badge label="Waiting for you" tone="waiting" testID="repairs-waiting" /> : null}
    </Pressable>
  );
}

type PromptStage = 'checking' | 'ask' | 'busy' | 'on' | 'denied' | 'unavailable' | 'hidden';

/**
 * Asks once whether the tenant wants notifications on this phone (M6 decision 5), after Home has
 * shown their tenancies, never on first launch. It names each landlord the notifications would
 * come from: each decides what it sends. It asks while the phone has not been asked, and also
 * when the phone already allows notifications (Android 12 and older never ask) but a landlord
 * has no consent from the app yet. "Turn on" shows the phone's own prompt where needed, then
 * registers this device and records consent from the app for the landlords named. "Not now" is
 * remembered on this phone for this person; Profile has the toggles either way.
 */
function PushPrompt({ personId }: { personId: string }) {
  const { expire } = useSession();
  const push = usePush();
  const [stage, setStage] = useState<PromptStage>('checking');
  const [named, setNamed] = useState<{ companyId: string; landlordName: string }[]>([]);
  const [everyone, setEveryone] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const allowedAlready = push.permission === 'granted';
  const askable = push.supported && (push.permission === 'undetermined' || allowedAlready);

  useEffect(() => {
    if (!askable) return;
    let live = true;
    void (async () => {
      const answered = await promptAnswered(personId);
      const consent = answered ? null : await api.tenantMessaging.pushConsent().catch(() => null);
      if (!live) return;
      const landlords = consent
        ? allowedAlready
          ? consent.filter((landlord) => !landlord.granted)
          : consent
        : [];
      setNamed(landlords);
      setEveryone(consent !== null && landlords.length === consent.length);
      // Without the landlords' names there is nothing honest to ask.
      setStage((current) =>
        current === 'checking' ? (landlords.length > 0 ? 'ask' : 'hidden') : current,
      );
    })();
    return () => {
      live = false;
    };
  }, [askable, allowedAlready, personId]);

  if (stage === 'on')
    return (
      <Notice testID="push-on" tone="ok">
        Notifications are on. You can turn them off in Profile.
      </Notice>
    );
  if (stage === 'denied')
    return (
      <Notice testID="push-denied">
        Notifications are off for this app. To get them later, allow them in your phone’s settings,
        then turn them on in Profile.
      </Notice>
    );
  if (stage === 'unavailable')
    return (
      <Notice testID="push-unavailable">
        Notifications are not available on this phone just now. Your landlord will reach you by
        WhatsApp, SMS or email.
      </Notice>
    );
  if (!askable || (stage !== 'ask' && stage !== 'busy')) return null;

  async function turnOnFor(): Promise<TurnOn> {
    // One consent for every landlord when all are named; otherwise one for each named.
    if (everyone) return push.turnOn();
    let outcome: TurnOn = { result: 'denied' };
    for (const landlord of named) {
      outcome = await push.turnOn(landlord.companyId);
      if (outcome.result !== 'on') break;
    }
    return outcome;
  }

  function turnOn() {
    setStage('busy');
    setProblem(null);
    turnOnFor().then(
      (outcome) => {
        void markPromptAnswered(personId);
        setStage(outcome.result);
      },
      (error: unknown) => {
        const found = toProblem(error);
        if (found.status === 401) return expire();
        setProblem(`We could not turn notifications on. ${found.message}`);
        setStage('ask');
      },
    );
  }

  function notNow() {
    setStage('hidden');
    void markPromptAnswered(personId);
  }

  return (
    <Card testID="push-prompt" label="Notifications">
      <Heading>Get notifications on this phone</Heading>
      <Body>
        We can tell you when a receipt is ready, when rent is due and when your landlord writes to
        you. A notification says what has arrived; the details open in the app.
      </Body>
      <Body testID="push-landlords">
        {`Notifications from ${landlordList(named.map((landlord) => landlord.landlordName))}. You can turn each one off in Profile.`}
      </Body>
      {problem ? <ErrorText testID="push-error">{problem}</ErrorText> : null}
      <Button
        label="Turn on notifications"
        testID="push-turn-on"
        busy={stage === 'busy'}
        onPress={turnOn}
      />
      <Button label="Not now" variant="quiet" testID="push-not-now" onPress={notNow} />
    </Card>
  );
}

/** Leases out for the tenant's signature, or waiting on the others once the tenant has signed. */
function ToSignEntry({
  state,
  onOpen,
}: {
  state: LoadState<TenantSigningView[]>;
  onOpen: () => void;
}) {
  // Nothing to say until it is known; a failure is said quietly, under the tenancies' own state.
  if (state.status === 'loading') return null;
  if (state.status === 'error') {
    return state.problem.status === 401 ? null : (
      <Small testID="to-sign-error">
        We could not check for anything to sign. {state.problem.message}
      </Small>
    );
  }
  const items = state.data;
  if (items.length === 0) return null;
  // Leases to sign and notices to acknowledge (M7 plan 4.10).
  const summary = toSignSummary(items);
  return (
    <Card testID="to-sign-entry" label="To sign" highlight={summary.waiting}>
      <Heading>To sign</Heading>
      <Body>{summary.text}</Body>
      <Button
        label={summary.action}
        variant={summary.waiting ? 'primary' : 'quiet'}
        testID="open-to-sign"
        onPress={onOpen}
      />
    </Card>
  );
}

function Tenancies({
  view,
  onRetry,
  onReload,
  moneyTick,
  onOpen,
}: {
  view: CachedView<TenancyGroupView[]>;
  onRetry: () => void;
  onReload: () => void;
  moneyTick: number;
  onOpen: (leaseId: string) => void;
}) {
  if (view.status === 'loading') return <Loading label="Loading your tenancies" />;
  if (view.status === 'error') {
    return (
      <View style={styles.stack}>
        <ErrorText>We could not load your tenancies. {view.problem.message}</ErrorText>
        <Button label="Try again" variant="quiet" testID="retry" onPress={onRetry} />
      </View>
    );
  }
  const groups = view.data;
  return (
    <View style={styles.stack}>
      {view.offline ? (
        <View style={styles.stack}>
          <Notice testID="offline">
            You are offline. This is what we last fetched, at {formatTime(view.fetchedAt)}, so it
            may be out of date.
          </Notice>
          <Button label="Try again" variant="quiet" testID="retry-offline" onPress={onReload} />
        </View>
      ) : null}
      {view.refreshProblem && view.refreshProblem.status !== 401 ? (
        <Notice testID="refresh-problem">
          We could not update this just now, so it may be out of date. {view.refreshProblem.message}
        </Notice>
      ) : null}
      {groups.length === 0 ? (
        <Body testID="no-tenancies">
          You have no tenancies yet. When your landlord adds your tenancy, it will appear here.
        </Body>
      ) : (
        groups.map((group) => (
          <LandlordGroup
            key={group.landlord.companyId}
            group={group}
            moneyTick={moneyTick}
            onOpen={onOpen}
          />
        ))
      )}
    </View>
  );
}

/** One landlord's tenancies and their money, in a box of their own (TL-12). */
function LandlordGroup({
  group,
  moneyTick,
  onOpen,
}: {
  group: TenancyGroupView;
  moneyTick: number;
  onOpen: (leaseId: string) => void;
}) {
  return (
    <Card testID="landlord-group" label={`Rented from ${group.landlord.name}`}>
      <View>
        <Small>Rented from</Small>
        <Heading>{group.landlord.name}</Heading>
      </View>
      {group.tenancies.map((tenancy) => (
        <TenancyRow key={tenancy.leaseId} tenancy={tenancy} moneyTick={moneyTick} onOpen={onOpen} />
      ))}
    </Card>
  );
}

/** A tenancy: its terms, which open the lease, then its money and Pay beside them. */
function TenancyRow({
  tenancy,
  moneyTick,
  onOpen,
}: {
  tenancy: Tenancy;
  moneyTick: number;
  onOpen: (leaseId: string) => void;
}) {
  return (
    <View style={styles.row} testID="tenancy-row">
      <Pressable
        accessibilityRole="button"
        accessibilityHint="Opens the lease terms"
        testID="tenancy-card"
        onPress={() => onOpen(tenancy.leaseId)}
        style={({ pressed }) => [styles.terms, pressed && styles.pressed]}
      >
        <View style={styles.rowTop}>
          <Text style={styles.unit}>{tenancy.unitCode}</Text>
          <Badge label={leaseStatusLabel(tenancy.status)} tone={leaseStatusTone(tenancy.status)} />
        </View>
        <Text style={styles.property}>{tenancy.propertyName}</Text>
        <Small>{rentLabel(tenancy.monthlyRentMinor, tenancy.cycle)}</Small>
        <Small>{termLabel(tenancy.startDate, tenancy.endDate)}</Small>
        <Text style={styles.more}>See the lease ›</Text>
      </Pressable>
      {isBilled(tenancy.status) ? (
        <TenancyMoney
          leaseId={tenancy.leaseId}
          status={tenancy.status}
          endDate={tenancy.endDate}
          refreshTick={moneyTick}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 16 },
  row: {
    borderTopWidth: 1,
    borderTopColor: colours.line,
    paddingTop: 12,
    gap: 8,
  },
  terms: { gap: 4 },
  pressed: { opacity: 0.7 },
  rowTop: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  unit: { fontSize: 17, fontWeight: '700', color: colours.ink },
  property: { fontSize: 16, color: colours.ink },
  more: { fontSize: 15, fontWeight: '600', color: colours.brand, marginTop: 4 },
  entry: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 50,
    borderRadius: 10,
    paddingVertical: 14,
  },
  entryText: { color: colours.brand, fontSize: 16, fontWeight: '600' },
});

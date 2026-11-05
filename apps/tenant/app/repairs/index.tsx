import type { TenantRepairView } from '@rent/contracts';
import { MAINTENANCE_CATEGORY_LABELS } from '@rent/domain/maintenance';
import { Redirect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api } from '../../src/api';
import { formatTime } from '../../src/format';
import { openFetchedUrl } from '../../src/open-url';
import { toProblem } from '../../src/problems';
import {
  discardRepair,
  flushRepairs,
  loadRepairs,
  useRepairQueue,
  useSentRepairs,
  type QueuedRepair,
} from '../../src/repair-queue';
import { stepLabel } from '../../src/repair-rules';
import { useSession } from '../../src/session';
import {
  BackLink,
  Badge,
  Body,
  Button,
  Card,
  colours,
  ErrorText,
  Field,
  Heading,
  Loading,
  Notice,
  Screen,
  Small,
} from '../../src/ui';
import { useCachedLoad } from '../../src/use-cached-load';
import { useReloadOnReturn } from '../../src/use-load';

type Group = { companyId: string; name: string };

/**
 * Repairs (MI-01, MI-06, CM-04; M8 plan 4.11): each landlord's repairs in a box of their own
 * (TL-12), with their status, steps and files, and the requests still waiting on this phone. Work
 * marked done waits for the tenant: confirm it, or say what is still wrong. Offline, the list last
 * fetched on this device shows.
 */
export default function Repairs() {
  const router = useRouter();
  const { me, loading } = useSession();
  const repairs = useCachedLoad('repairs', loadRepairs, Boolean(me));
  const queued = useRepairQueue(me?.personId ?? null);
  useReloadOnReturn(repairs.reload);
  // A request on the phone that went meanwhile, from Send now or by itself once the app was back
  // online (RepairRunner), is now one of the landlord's repairs: fetch the list again.
  const { reload } = repairs;
  const sent = useSentRepairs();
  const sentSeen = useRef(sent);
  useEffect(() => {
    if (sent === sentSeen.current) return;
    sentSeen.current = sent;
    reload();
  }, [sent, reload]);
  const back = () => (router.canGoBack() ? router.back() : router.replace('/home'));
  if (!loading && !me) return <Redirect href="/sign-in" />;

  const view = repairs.view;
  const groups: Group[] = [];
  const seen = new Set<string>();
  const addGroup = (companyId: string, name: string) => {
    if (seen.has(companyId)) return;
    seen.add(companyId);
    groups.push({ companyId, name });
  };
  for (const item of queued) addGroup(item.companyId, item.landlordName);
  if (view.status === 'ready')
    for (const group of view.data) addGroup(group.landlord.companyId, group.landlord.name);

  return (
    <Screen title="Repairs" top={<BackLink onPress={back} label="Home" />} scroll>
      <Button
        label="Report a repair"
        testID="report-repair"
        onPress={() => router.push('/repairs/new')}
      />
      {view.status === 'loading' && queued.length === 0 ? (
        <Loading label="Loading your repairs" />
      ) : null}
      {view.status === 'error' ? (
        <View style={styles.stack}>
          <ErrorText testID="repairs-error">
            We could not load your repairs. {view.problem.message}
          </ErrorText>
          <Button label="Try again" variant="quiet" testID="retry" onPress={repairs.retry} />
        </View>
      ) : null}
      {view.status === 'ready' && view.offline ? (
        <Notice testID="offline">
          You are offline. These are the repairs we last fetched, at {formatTime(view.fetchedAt)},
          so they may be out of date.
        </Notice>
      ) : null}
      {view.status === 'ready' && groups.length === 0 ? (
        <Body testID="no-repairs">
          No repairs yet. When something needs fixing, report it here with photos, a video or a
          voice note.
        </Body>
      ) : null}
      {groups.map((group) => (
        <LandlordRepairs
          key={group.companyId}
          group={group}
          queued={queued.filter((item) => item.companyId === group.companyId)}
          repairs={
            view.status === 'ready'
              ? (view.data.find((g) => g.landlord.companyId === group.companyId)?.repairs ?? [])
              : []
          }
          onChanged={repairs.reload}
        />
      ))}
    </Screen>
  );
}

function LandlordRepairs({
  group,
  queued,
  repairs,
  onChanged,
}: {
  group: Group;
  queued: QueuedRepair[];
  repairs: TenantRepairView[];
  onChanged: () => void;
}) {
  return (
    <Card testID="landlord-repairs" label={`Repairs with ${group.name}`}>
      <View>
        <Small>Repairs with</Small>
        <Heading>{group.name}</Heading>
      </View>
      {queued.map((item) => (
        <QueuedRow key={item.clientId} item={item} landlordName={group.name} />
      ))}
      {repairs.map((repair) => (
        <RepairRow
          key={repair.jobId}
          repair={repair}
          landlordName={group.name}
          onChanged={onChanged}
        />
      ))}
      {queued.length === 0 && repairs.length === 0 ? <Small>No repairs yet.</Small> : null}
    </Card>
  );
}

/** A request still on this phone: sending, waiting for the network, or refused. */
function QueuedRow({ item, landlordName }: { item: QueuedRepair; landlordName: string }) {
  return (
    <View style={styles.row} testID="queued-repair">
      <View style={styles.rowTop}>
        <Text style={styles.title}>{MAINTENANCE_CATEGORY_LABELS[item.category]}</Text>
        <Badge
          label={item.state === 'sending' ? 'Sending…' : 'Not sent yet'}
          tone="waiting"
          testID="queued-state"
        />
      </View>
      <Body>{item.description}</Body>
      {item.files.length > 0 ? (
        <Small>{item.files.length === 1 ? '1 file' : `${item.files.length} files`}</Small>
      ) : null}
      {item.problem ? (
        <Text accessibilityRole="alert" style={styles.problem} testID="queued-problem">
          {item.problem}
        </Text>
      ) : null}
      {item.state !== 'sending' && item.retryable ? (
        <Button
          label="Send now"
          variant="quiet"
          testID="send-queued"
          onPress={() => void flushRepairs(item.personId, item.companyId)}
        />
      ) : null}
      {item.state !== 'sending' ? (
        <Button
          label="Discard"
          variant="quiet"
          testID="discard-queued"
          onPress={() => discardRepair(item.clientId)}
        />
      ) : null}
      <Small>Written for {landlordName}.</Small>
    </View>
  );
}

function toneOf(repair: TenantRepairView): 'ok' | 'waiting' | 'past' {
  if (repair.status === 'closed' || repair.status === 'cancelled') return 'past';
  if (repair.awaitingResponse) return 'waiting';
  return repair.status === 'work_done' ? 'ok' : 'waiting';
}

/** A repair the landlord has: status, steps, files, and the tenant's answer when work is done. */
function RepairRow({
  repair,
  landlordName,
  onChanged,
}: {
  repair: TenantRepairView;
  landlordName: string;
  onChanged: () => void;
}) {
  const { expire } = useSession();
  const [busy, setBusy] = useState<'confirm' | 'dispute' | 'file' | null>(null);
  const [disputing, setDisputing] = useState(false);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const opening = useRef(false);

  const respond = useCallback(
    (response: 'confirmed' | 'disputed') => {
      if (response === 'disputed' && reason.trim().length < 3) {
        setProblem('Say in a few words what is still wrong.');
        return;
      }
      setBusy(response === 'confirmed' ? 'confirm' : 'dispute');
      setProblem(null);
      api.tenantRepairs
        .respond({
          jobId: repair.jobId,
          response,
          reason: response === 'disputed' ? reason.trim() : null,
        })
        .then(
          () => {
            setDisputing(false);
            setReason('');
            onChanged();
          },
          (error: unknown) => {
            const found = toProblem(error);
            if (found.status === 401) return expire();
            setProblem(`We could not send your answer. ${found.message}`);
          },
        )
        .finally(() => setBusy(null));
    },
    [expire, onChanged, reason, repair.jobId],
  );

  function openFile(attachmentId: string) {
    if (opening.current) return;
    opening.current = true;
    setBusy('file');
    setProblem(null);
    // Straight from the tap: on the web the tab has to open before anything is awaited.
    void openFetchedUrl(
      () => api.tenantRepairs.attachment({ jobId: repair.jobId, attachmentId }),
      'Opening the file…',
    )
      .catch((error: unknown) => {
        const found = toProblem(error);
        if (found.status === 401) return expire();
        setProblem(`We could not open the file. ${found.message}`);
      })
      .finally(() => {
        opening.current = false;
        setBusy(null);
      });
  }

  const category = repair.category ? MAINTENANCE_CATEGORY_LABELS[repair.category] : 'Repair';
  return (
    <View style={styles.row} testID="repair-row">
      <View style={styles.rowTop}>
        <Text style={styles.title}>
          {repair.ticket} · {category}
        </Text>
        <Badge label={repair.statusLabel} tone={toneOf(repair)} testID="repair-status" />
      </View>
      {repair.emergency ? <Badge label="Emergency" tone="waiting" testID="emergency" /> : null}
      <Body>{repair.description}</Body>
      {repair.unitCode ? <Small>{repair.unitCode}</Small> : null}
      {repair.forwarded ? (
        <Notice testID="forwarded">
          We sent this to {landlordName} directly. They do not track repairs in this app, so its
          steps will not show here.
        </Notice>
      ) : null}
      {repair.visitAt ? <Small>Visit planned for {formatTime(repair.visitAt)}</Small> : null}
      {repair.steps.length > 0 ? (
        <View style={styles.steps} testID="repair-steps">
          {repair.steps.map((step, index) => (
            <Small key={`${step.kind}-${index}`}>{stepLabel(step)}</Small>
          ))}
        </View>
      ) : null}
      {repair.completionNote ? (
        <Small testID="completion-note">What was done: {repair.completionNote}</Small>
      ) : null}
      {repair.attachments.map((attachment, index) => (
        <Button
          key={attachment.id}
          label={`${attachment.kind === 'image' ? 'Photo' : attachment.kind === 'video' ? 'Video' : attachment.kind === 'audio' ? 'Voice note' : 'File'} ${index + 1}${attachment.stage === 'after' ? ' (after the work)' : attachment.stage === 'before' ? ' (before the work)' : ''}`}
          variant="quiet"
          testID="repair-file"
          busy={busy === 'file'}
          onPress={() => openFile(attachment.id)}
        />
      ))}
      {repair.awaitingResponse ? (
        <View style={styles.answer} testID="awaiting-response">
          <Body>The work is marked as done. Is it fixed?</Body>
          {disputing ? (
            <>
              <Field
                label="What is still wrong?"
                testID="dispute-reason"
                value={reason}
                onChangeText={setReason}
                multiline
                maxLength={1000}
              />
              <Button
                label="Send"
                testID="send-dispute"
                busy={busy === 'dispute'}
                onPress={() => respond('disputed')}
              />
              <Button
                label="Back"
                variant="quiet"
                testID="cancel-dispute"
                onPress={() => setDisputing(false)}
              />
            </>
          ) : (
            <>
              <Button
                label="Confirm the work is done"
                testID="confirm-repair"
                busy={busy === 'confirm'}
                onPress={() => respond('confirmed')}
              />
              <Button
                label="Tell us what’s wrong"
                variant="quiet"
                testID="dispute-repair"
                onPress={() => setDisputing(true)}
              />
            </>
          )}
        </View>
      ) : null}
      {problem ? <ErrorText testID="repair-error">{problem}</ErrorText> : null}
      <Small>Reported {formatTime(repair.createdAt)}</Small>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 12 },
  row: { borderTopWidth: 1, borderTopColor: colours.line, paddingTop: 12, gap: 6 },
  rowTop: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  title: { fontSize: 17, fontWeight: '700', color: colours.ink },
  steps: { gap: 2 },
  answer: { gap: 8 },
  problem: { color: colours.danger, fontSize: 14 },
});

import type { TenancyGroupView, TenantRepairView } from '@rent/contracts';
import type { MaintenanceCategory } from '@rent/domain/maintenance';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { api } from '../../src/api';
import { isUuid, newClientMessageId } from '../../src/ids';
import {
  canRecordVoice,
  canUseCamera,
  chooseFromLibrary,
  chooseVoiceFile,
  takeWithCamera,
  useVoiceRecorder,
  voiceFileInput,
  VOICE_SECONDS,
  type Capture,
} from '../../src/repair-capture';
import { forgetRequestFiles, keepFile } from '../../src/repair-files';
import {
  addRepair,
  flushRepairs,
  loadRepairs,
  queuedFilesSurvive,
  queuedRepair,
} from '../../src/repair-queue';
import {
  CATEGORY_CHOICES,
  checkRepairFile,
  checkVoiceNote,
  clockLabel,
  fileLabel,
  MAX_FILES,
  secondsLabel,
  type ChosenMedia,
  type RepairFile,
} from '../../src/repair-rules';
import { useSession } from '../../src/session';
import {
  BackLink,
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

const loadTenancies = async () => api.tenantApp.tenancies();

/** Tenancies a repair can be reported under: those in force, or about to start. */
const REPORTABLE = new Set(['signed', 'active', 'ending', 'holding_over']);

type Choice = {
  leaseId: string;
  companyId: string;
  landlordName: string;
  unitCode: string;
  propertyName: string;
};

function choicesOf(groups: TenancyGroupView[]): Choice[] {
  return groups.flatMap((group) =>
    group.tenancies
      .filter((tenancy) => REPORTABLE.has(tenancy.status))
      .map((tenancy) => ({
        leaseId: tenancy.leaseId,
        companyId: group.landlord.companyId,
        landlordName: group.landlord.name,
        unitCode: tenancy.unitCode,
        propertyName: tenancy.propertyName,
      })),
  );
}

type Outcome =
  | { readonly kind: 'sent'; readonly repair: TenantRepairView; readonly landlordName: string }
  /** Saved on the phone, and sent by itself: offline, or the API could not take it just now. */
  | { readonly kind: 'waiting'; readonly offline: boolean }
  | { readonly kind: 'refused'; readonly problem: string };

/**
 * Report a repair (MI-01; M8 decision 3 and plan 4.3): the tenancy, the category, what is wrong,
 * whether it is an emergency, and up to 10 photos, videos or voice notes. The request is written
 * once, with an id of its own, and goes through the queue (src/repair-queue.ts): straight away
 * when the phone is online, or later, by itself, when it is back. Its files are kept on the phone
 * until then.
 */
export default function ReportRepair() {
  const router = useRouter();
  const params = useLocalSearchParams<{ leaseId?: string | string[] }>();
  const wanted =
    typeof params.leaseId === 'string' && isUuid(params.leaseId) ? params.leaseId : null;
  const { me, loading } = useSession();
  const personId = me?.personId ?? null;
  const tenancies = useCachedLoad('tenancies', loadTenancies, Boolean(me));
  // F2: whether each landlord takes files (false on Starter), from the repairs list.
  const repairs = useCachedLoad('repairs', loadRepairs, Boolean(me));
  // A voice note that stopped itself at 3 minutes is added like one the tenant stopped (LT 5).
  const autoStopped = useRef<(note: ChosenMedia) => void>(() => undefined);
  const voice = useVoiceRecorder((note) => {
    if (note) autoStopped.current(note);
  });

  // The request's own id, made once, so every send of it makes one job; its files' folder too.
  const [clientId] = useState(() => newClientMessageId());
  const submitted = useRef(false);
  /** Numbers each kept file, never reused, so no two share a name in the request's folder. */
  const kept = useRef(0);
  const [leaseId, setLeaseId] = useState<string | null>(wanted);
  const [category, setCategory] = useState<MaintenanceCategory | null>(null);
  const [description, setDescription] = useState('');
  const [emergency, setEmergency] = useState(false);
  const [files, setFiles] = useState<(RepairFile & { keptName: string })[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // Leaving without sending: the files kept for this request go.
  useEffect(
    () => () => {
      if (!submitted.current && personId) forgetRequestFiles(personId, clientId);
    },
    [personId, clientId],
  );

  const choices = tenancies.view.status === 'ready' ? choicesOf(tenancies.view.data) : [];
  const chosen =
    choices.find((choice) => choice.leaseId === leaseId) ??
    (choices.length === 1 ? choices[0] : undefined);
  const filesAllowed =
    !chosen ||
    repairs.view.status !== 'ready' ||
    (repairs.view.data.find((group) => group.landlord.companyId === chosen.companyId)
      ?.filesAllowed ??
      true);

  if (!loading && !me) return <Redirect href="/sign-in" />;
  const back = () => (router.canGoBack() ? router.back() : router.replace('/repairs'));

  async function add(
    capture: Promise<Capture>,
    what: 'camera' | 'microphone' | null,
    source: 'visual' | 'voice' = 'visual',
  ) {
    if (!personId) return;
    setProblem(null);
    const result = await capture;
    if (result.status === 'denied') {
      setProblem(
        what === 'microphone'
          ? 'The app may not use the microphone. Allow it in your phone’s settings to record a voice note.'
          : 'The app may not use the camera. Allow it in your phone’s settings to take a photo or video.',
      );
      return;
    }
    if (result.status === 'cancelled') return;
    setAdding(true);
    const added: (RepairFile & { keptName: string })[] = [];
    let refused: string | null = null;
    for (const media of result.media) {
      if (files.length + added.length >= MAX_FILES) {
        refused = `You can send up to ${MAX_FILES} files with one request.`;
        break;
      }
      try {
        const file = await keepFile(personId, clientId, media, (kept.current += 1));
        const checked = source === 'voice' ? checkVoiceNote(file) : checkRepairFile(file);
        if (!checked.ok) {
          refused = checked.problem;
          continue;
        }
        const { notice } = checked as { readonly notice?: string };
        if (notice) refused = notice;
        added.push({
          key: file.keptName,
          keptName: file.keptName,
          name: file.name,
          contentType: file.contentType,
          sizeBytes: file.sizeBytes,
          durationSeconds: file.durationSeconds,
          kind: checked.kind,
          part: file.part,
          uploadId: null,
        });
      } catch {
        refused = 'We could not keep that file on the phone. Try again.';
      }
    }
    setFiles((list) => [...list, ...added].slice(0, MAX_FILES));
    setProblem(refused);
    setAdding(false);
  }

  autoStopped.current = (note) => {
    void add(Promise.resolve({ status: 'chosen', media: [note] }), null, 'voice').then(() =>
      setProblem(
        (shown) => shown ?? 'Recording stopped at 3 minutes, the longest a voice note can be.',
      ),
    );
  };

  async function recordOrStop() {
    if (voice.recording) {
      const note = await voice.stop();
      if (note) await add(Promise.resolve({ status: 'chosen', media: [note] }), null, 'voice');
      return;
    }
    if (files.length >= MAX_FILES) {
      setProblem(`You can send up to ${MAX_FILES} files with one request.`);
      return;
    }
    setProblem(null);
    const started = await voice.start();
    if (started === 'denied')
      setProblem(
        'The app may not use the microphone. Allow it in your phone’s settings to record a voice note.',
      );
    else if (started === 'failed') setProblem('We could not start recording. Try again.');
  }

  function send() {
    if (!personId || sending) return;
    if (!chosen) return setProblem('Choose the tenancy the repair is for.');
    if (!category) return setProblem('Choose what kind of repair it is.');
    const text = description.trim();
    if (text.length < 3) return setProblem('Say in a few words what is wrong.');
    if (voice.recording) return setProblem('Stop the recording first.');
    if (adding) return setProblem('Wait until your files are added.');
    setProblem(null);
    setSending(true);
    submitted.current = true;
    addRepair({
      clientId,
      personId,
      companyId: chosen.companyId,
      landlordName: chosen.landlordName,
      leaseId: chosen.leaseId,
      unitCode: chosen.unitCode,
      category,
      description: text,
      emergency,
      // F2: a landlord on Starter takes the description only.
      files: filesAllowed ? files : [],
    });
    void flushRepairs(personId, chosen.companyId).then((results) => {
      const mine = results.find(
        (r): r is Exclude<typeof r, { status: 'dropped' }> =>
          r.status !== 'dropped' && r.clientId === clientId,
      );
      const queued = queuedRepair(clientId);
      if (mine?.status === 'sent')
        setOutcome({ kind: 'sent', repair: mine.repair, landlordName: chosen.landlordName });
      // Still on the phone and still to go by itself (LT 8): it is waiting, not refused, so the
      // tenant has no reason to write it again.
      else if (!mine || queued?.retryable)
        setOutcome({
          kind: 'waiting',
          offline: mine?.status !== 'not_sent' || mine.problem.code === 'network',
        });
      else
        setOutcome({
          kind: 'refused',
          problem: queued?.problem ?? `Your request was not sent. ${mine.problem.message}`,
        });
      setSending(false);
    });
  }

  // Back to the Repairs screen this one was opened from, rather than a second copy of it on top;
  // from a tenancy or Home, Repairs takes this screen's place.
  if (outcome) return <Sent outcome={outcome} onDone={() => router.dismissTo('/repairs')} />;

  return (
    <Screen title="Report a repair" top={<BackLink onPress={back} label="Back" />} scroll>
      {tenancies.view.status === 'loading' ? <Loading label="Loading your tenancies" /> : null}
      {tenancies.view.status === 'ready' && choices.length === 0 ? (
        <Body testID="no-tenancy">
          You can report a repair once you have a tenancy in force in the app.
        </Body>
      ) : null}
      {choices.length > 1 ? (
        <Card label="Which home?">
          <Heading>Which home?</Heading>
          <View role="radiogroup" aria-label="Which home?" style={styles.homes}>
            {choices.map((choice) => (
              <Choose
                key={choice.leaseId}
                label={`${choice.unitCode}, ${choice.propertyName}`}
                hint={`With ${choice.landlordName}`}
                selected={chosen?.leaseId === choice.leaseId}
                testID="choose-tenancy"
                onPress={() => setLeaseId(choice.leaseId)}
              />
            ))}
          </View>
        </Card>
      ) : chosen ? (
        <Small testID="tenancy">
          For {chosen.unitCode}, {chosen.propertyName}, with {chosen.landlordName}
        </Small>
      ) : null}

      <Card label="What kind of repair?">
        <Heading>What kind of repair?</Heading>
        <View role="radiogroup" aria-label="What kind of repair?" style={styles.chips}>
          {CATEGORY_CHOICES.map((choice) => (
            <Choose
              key={choice.value}
              label={choice.label}
              selected={category === choice.value}
              testID={`category-${choice.value}`}
              compact
              onPress={() => setCategory(choice.value)}
            />
          ))}
        </View>
      </Card>

      <Field
        label="What is wrong?"
        testID="repair-description"
        value={description}
        onChangeText={setDescription}
        multiline
        maxLength={2000}
        placeholder="For example: the kitchen tap drips all the time"
      />

      <View style={styles.emergency}>
        <View style={styles.emergencyText}>
          <Text style={styles.label}>This is an emergency</Text>
          <Small>
            Danger to people or the home now, such as a burst pipe, a fire risk or no way to lock
            the door. Your landlord’s team is alerted at once.
          </Small>
        </View>
        <Switch
          testID="repair-emergency"
          accessibilityLabel="This is an emergency"
          value={emergency}
          onValueChange={setEmergency}
          trackColor={{ true: colours.danger, false: colours.line }}
        />
      </View>

      {filesAllowed ? null : (
        <Notice testID="no-files">
          {chosen?.landlordName ?? 'Your landlord'} takes repair requests in the app as words only.
          Say what is wrong, and they will be in touch with you about it.
        </Notice>
      )}
      {filesAllowed ? (
        <Card label="Photos, videos and voice notes">
          <Heading>Photos, videos and voice notes</Heading>
          <Small>
            Up to {MAX_FILES} files. Videos up to {secondsLabel(90)}, voice notes up to{' '}
            {secondsLabel(VOICE_SECONDS)}.
            {queuedFilesSurvive ? '' : ' Keep this page open until the request is sent.'}
          </Small>
          {files.map((file, index) => (
            <View key={file.key} style={styles.file} testID="repair-file">
              <Text style={styles.fileText}>{fileLabel(file)}</Text>
              <Button
                label="Remove"
                variant="quiet"
                testID="remove-file"
                onPress={() => setFiles((list) => list.filter((_, i) => i !== index))}
              />
            </View>
          ))}
          {canUseCamera ? (
            <>
              <Button
                label="Take a photo"
                variant="quiet"
                testID="take-photo"
                busy={adding}
                onPress={() => void add(takeWithCamera('photo'), 'camera')}
              />
              <Button
                label="Record a video"
                variant="quiet"
                testID="record-video"
                busy={adding}
                onPress={() => void add(takeWithCamera('video'), 'camera')}
              />
            </>
          ) : null}
          <Button
            label="Choose photos or videos"
            variant="quiet"
            testID="choose-media"
            busy={adding}
            onPress={() => void add(chooseFromLibrary(MAX_FILES - files.length), null)}
          />
          {canRecordVoice ? (
            <Button
              label={
                voice.recording
                  ? `Stop recording (${clockLabel(voice.seconds)})`
                  : 'Record a voice note'
              }
              variant={voice.recording ? 'primary' : 'quiet'}
              testID="record-voice"
              onPress={() => void recordOrStop()}
            />
          ) : null}
          {voiceFileInput ? (
            <Button
              label="Add a voice note"
              variant="quiet"
              testID="choose-voice"
              busy={adding}
              onPress={() => void add(chooseVoiceFile(), null, 'voice')}
            />
          ) : null}
        </Card>
      ) : null}

      {problem ? <ErrorText testID="repair-problem">{problem}</ErrorText> : null}
      <Button
        label="Send the request"
        testID="send-repair"
        busy={sending || adding}
        onPress={send}
      />
    </Screen>
  );
}

function Choose({
  label,
  hint,
  selected,
  testID,
  compact,
  onPress,
}: {
  label: string;
  hint?: string;
  selected: boolean;
  testID: string;
  compact?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      // M11 (NFR-A11Y): a radio says whether it is chosen, on the web as aria-checked; its name
      // is its visible text, the hint included (WCAG 2.5.3).
      role="radio"
      aria-checked={selected}
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [
        compact ? styles.chip : styles.choice,
        selected && styles.selected,
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.choiceText, selected && styles.selectedText]}>{label}</Text>
      {hint ? <Small>{hint}</Small> : null}
    </Pressable>
  );
}

/** What happened to the request: sent (or forwarded on Starter), waiting, or refused. */
function Sent({ outcome, onDone }: { outcome: Outcome; onDone: () => void }) {
  return (
    <Screen title={outcome.kind === 'sent' ? 'Request sent' : 'Request saved'}>
      {outcome.kind === 'sent' ? (
        outcome.repair.forwarded ? (
          <Notice testID="repair-forwarded" tone="ok">
            We sent your request to {outcome.landlordName} directly. They do not track repairs in
            this app, so they will contact you about it.
          </Notice>
        ) : (
          <Notice testID="repair-sent" tone="ok">
            Your request is {outcome.repair.ticket}. You will hear at each step, and you can follow
            it under Repairs.
          </Notice>
        )
      ) : outcome.kind === 'waiting' ? (
        <Notice testID="repair-waiting">
          {outcome.offline
            ? 'You are offline, so your request is saved on this phone. It will be sent when you are back online: there is no need to write it again.'
            : 'We could not send your request just now, so it is saved on this phone. It will be sent by itself: there is no need to write it again.'}
        </Notice>
      ) : (
        <ErrorText testID="repair-refused">{outcome.problem}</ErrorText>
      )}
      <Button label="See your repairs" testID="see-repairs" onPress={onDone} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  homes: { gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: colours.line,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  choice: { borderWidth: 1, borderColor: colours.line, borderRadius: 10, padding: 12, gap: 2 },
  selected: { borderColor: colours.brand, borderWidth: 2, backgroundColor: colours.okFill },
  pressed: { opacity: 0.8 },
  choiceText: { fontSize: 15, color: colours.ink },
  selectedText: { fontWeight: '700' },
  emergency: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  emergencyText: { flex: 1, gap: 4 },
  label: { fontSize: 16, fontWeight: '600', color: colours.ink },
  file: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: colours.line,
  },
  fileText: { fontSize: 15, color: colours.ink },
});

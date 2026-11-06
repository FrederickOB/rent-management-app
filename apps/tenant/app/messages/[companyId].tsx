import type { TenantMessage } from '@rent/contracts';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import {
  AppState,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { api } from '../../src/api';
import { formatTime } from '../../src/format';
import { isUuid, newClientMessageId } from '../../src/ids';
import {
  attachmentAction,
  attachmentNote,
  channelNote,
  deliveryLabel,
  conversationsForCache,
  loadConversations,
  pageForCache,
  PAGE_SIZE,
  threadOrder,
  type MessagePage,
} from '../../src/messages';
import {
  addToOutbox,
  discard,
  flush,
  restoreOutbox,
  settleFromThread,
  useOutbox,
  type Delivery,
  type OutboxItem,
  type OutboxPhoto,
} from '../../src/outbox';
import { openFetchedUrl } from '../../src/open-url';
import { MESSAGE_BODY_MAX } from '../../src/message-rules';
import { canPickPhotos, pickPhotos } from '../../src/photo-picker';
import { toProblem } from '../../src/problems';
import type { UploadPart } from '../../src/upload';
import { useSession } from '../../src/session';
import { BackLink, Button, colours, ErrorText, Loading, Notice, Small } from '../../src/ui';
import { isPhotoType, MAX_PHOTOS, photoProblem, sizeLabel } from '../../src/upload';
import { useCachedLoad } from '../../src/use-cached-load';
import { useReloadOnReturn } from '../../src/use-load';

/** While the thread is open and the app in front, it looks for the landlord's replies this often. */
const POLL_MS = 30_000;

type Attachment = TenantMessage['attachments'][number];
/** A photo chosen in this run, not sent yet: its bytes are on the phone. */
type ChosenPhoto = Omit<OutboxPhoto, 'uploadId' | 'part'> & { readonly part: UploadPart };

/**
 * One landlord's conversation (CM-05; M6 plan 4.10): every message with that landlord, on every
 * channel, oldest first, and a box to write in, with photos where the build can pick them.
 * Nothing from another landlord ever shows here (TL-12).
 *
 * A message the tenant writes goes through the outbox (src/outbox.ts): it shows as sending, then
 * as sent once the API has it, or as not sent (offline, or refused) with Try again, which sends it
 * with the same `clientMessageId`, so the landlord gets it once. Offline, the thread last fetched
 * on this device shows, with when, and writing still works.
 */
export default function Thread() {
  const params = useLocalSearchParams<{ companyId?: string | string[] }>();
  const companyId = typeof params.companyId === 'string' ? params.companyId : '';
  // One screen per landlord: nothing written, fetched or sent for one landlord carries over when
  // the same screen opens another's thread (TL-12).
  return <ThreadScreen key={companyId} companyId={companyId} />;
}

function ThreadScreen({ companyId }: { companyId: string }) {
  const router = useRouter();
  const valid = isUuid(companyId);
  const { me, loading, expire } = useSession();
  const personId = me?.personId ?? null;

  const loadPage = useCallback(
    async (): Promise<MessagePage> => api.tenantMessaging.messages({ companyId, limit: PAGE_SIZE }),
    [companyId],
  );
  const thread = useCachedLoad(
    `messages:${companyId}`,
    loadPage,
    Boolean(me) && valid,
    pageForCache,
  );
  const conversations = useCachedLoad(
    'conversations',
    loadConversations,
    Boolean(me),
    conversationsForCache,
  );
  const outbox = useOutbox(personId, companyId);
  const [older, setOlder] = useState<MessagePage | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sent, setSent] = useState<TenantMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [photos, setPhotos] = useState<ChosenPhoto[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const openingNow = useRef(false);

  const { reload } = thread;
  useReloadOnReturn(reload);
  useEffect(() => {
    if (!valid) return;
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') reload();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [valid, reload]);

  // What the app closed with, not sent, comes back (src/outbox.ts).
  useEffect(() => {
    if (personId && valid) void restoreOutbox(personId, companyId);
  }, [personId, companyId, valid]);

  // A message the thread shows already reached the landlord, though its answer was lost.
  const firstLoaded = thread.view.status === 'ready' ? thread.view.data : null;
  useEffect(() => {
    if (!personId) return;
    settleFromThread(personId, companyId, [...(firstLoaded?.items ?? []), ...(older?.items ?? [])]);
  }, [personId, companyId, firstLoaded, older]);

  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const keepPlace = useRef(false);

  if (!loading && !me) return <Redirect href="/sign-in" />;
  const back = () => (router.canGoBack() ? router.back() : router.replace('/messages'));

  const landlordName =
    conversations.view.status === 'ready'
      ? (conversations.view.data.find((c) => c.companyId === companyId)?.landlordName ?? null)
      : null;
  const view = thread.view;
  const firstPage = view.status === 'ready' ? view.data : null;
  const messages = threadOrder([firstPage?.items ?? [], older?.items ?? []], sent);
  const nextCursor = older ? older.nextCursor : (firstPage?.nextCursor ?? null);

  function afterFlush(deliveries: readonly Delivery[]) {
    const arrived = deliveries.flatMap((d) => (d.status === 'sent' ? [d.message] : []));
    if (arrived.length > 0) {
      setSent((list) => [...list, ...arrived]);
      reload();
    }
    if (deliveries.some((d) => d.status === 'not_sent' && d.problem.status === 401)) expire();
  }

  function send() {
    if (!personId || !valid) return;
    const body = draft.trim();
    if (body.length === 0 && photos.length === 0) {
      setProblem('Write a message or add a photo.');
      return;
    }
    const clientMessageId = newClientMessageId();
    addToOutbox({ clientMessageId, personId, companyId, body, photos });
    setDraft('');
    setPhotos([]);
    setProblem(null);
    // One at a time, in the order written: behind anything of this conversation still waiting.
    void flush(personId, companyId).then(afterFlush);
  }

  function retry() {
    if (personId) void flush(personId, companyId).then(afterFlush);
  }

  function openAttachment(message: TenantMessage, attachment: Attachment) {
    if (openingNow.current) return;
    openingNow.current = true;
    setOpening(attachment.id);
    setProblem(null);
    // Straight from the tap: on the web the tab has to open before anything is awaited. The link
    // lasts minutes and is never kept.
    void openFetchedUrl(
      () =>
        api.tenantMessaging.attachmentDownload({
          companyId,
          messageId: message.id,
          attachmentId: attachment.id,
        }),
      'Opening…',
    )
      .catch((error: unknown) => {
        const found = toProblem(error);
        if (found.status === 401) return expire();
        setProblem(`We could not open it. ${found.message}`);
      })
      .finally(() => {
        openingNow.current = false;
        setOpening(null);
      });
  }

  function addPhotos() {
    const room = MAX_PHOTOS - photos.length;
    if (room <= 0) {
      setProblem(`You can send up to ${MAX_PHOTOS} photos in one message.`);
      return;
    }
    // Straight from the tap: a browser opens its file picker only while the tap is handled.
    void pickPhotos(room).then((chosen) => {
      const accepted: ChosenPhoto[] = [];
      let refused: string | null = null;
      for (const photo of chosen) {
        const wrong = photoProblem(photo);
        if (wrong || !isPhotoType(photo.contentType)) refused = wrong;
        else accepted.push({ ...photo, contentType: photo.contentType });
      }
      if (accepted.length > 0) setPhotos((list) => [...list, ...accepted].slice(0, MAX_PHOTOS));
      setProblem(refused);
    });
  }

  function showEarlier() {
    if (!nextCursor || loadingOlder) return;
    setLoadingOlder(true);
    keepPlace.current = true;
    api.tenantMessaging
      .messages({ companyId, cursor: nextCursor, limit: PAGE_SIZE })
      .then(
        (page) =>
          setOlder((previous) => ({
            items: [...(previous?.items ?? []), ...page.items],
            nextCursor: page.nextCursor,
          })),
        (error: unknown) => {
          const found = toProblem(error);
          if (found.status === 401) expire();
          else setProblem(`We could not load earlier messages. ${found.message}`);
        },
      )
      .finally(() => setLoadingOlder(false));
  }

  const title = landlordName ?? 'Messages';
  return (
    <SafeAreaView style={styles.page}>
      <KeyboardAvoidingView
        style={styles.page}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.header}>
          <BackLink onPress={back} label="Messages" />
          <Text accessibilityRole="header" style={styles.title} testID="thread-title">
            {title}
          </Text>
        </View>
        <ScrollView
          ref={scroll}
          style={styles.scroll}
          contentContainerStyle={styles.scrollBody}
          testID="thread"
          onContentSizeChange={() => {
            // Newest at the bottom, in view; loading earlier messages keeps the reader's place.
            if (keepPlace.current) keepPlace.current = false;
            else scroll.current?.scrollToEnd({ animated: false });
          }}
        >
          {!valid ? (
            <ErrorText testID="not-found">This conversation is not available.</ErrorText>
          ) : null}
          {valid && view.status === 'loading' ? <Loading label="Loading your messages" /> : null}
          {valid && view.status === 'error' ? (
            <View style={styles.stack}>
              <ErrorText>
                {view.problem.status === 404
                  ? 'This conversation is not available.'
                  : `We could not load your messages. ${view.problem.message}`}
              </ErrorText>
              <Button label="Try again" variant="quiet" testID="retry" onPress={thread.retry} />
            </View>
          ) : null}
          {view.status === 'ready' && view.offline ? (
            <Notice testID="offline">
              You are offline. These are the messages we last fetched, at{' '}
              {formatTime(view.fetchedAt)}, so there may be newer ones. You can still write: your
              message will show Not sent until you are back online and tap Try again.
            </Notice>
          ) : null}
          {view.status === 'ready' && view.refreshProblem && view.refreshProblem.status !== 401 ? (
            <Notice testID="refresh-problem">
              We could not update this just now, so there may be newer messages.
            </Notice>
          ) : null}
          {nextCursor ? (
            <Button
              label="Show earlier messages"
              variant="quiet"
              testID="show-earlier"
              busy={loadingOlder}
              onPress={showEarlier}
            />
          ) : null}
          {view.status === 'ready' && messages.length === 0 && outbox.length === 0 ? (
            <Small testID="no-messages">
              No messages yet. Write to {landlordName ?? 'your landlord'} below.
            </Small>
          ) : null}
          {messages.map((message) => (
            <Bubble
              key={message.id}
              message={message}
              landlordName={landlordName}
              opening={opening}
              onOpen={(attachment) => openAttachment(message, attachment)}
            />
          ))}
          {outbox.map((item) => (
            <PendingBubble
              key={item.clientMessageId}
              item={item}
              onRetry={retry}
              onDiscard={() => discard(item.clientMessageId)}
            />
          ))}
        </ScrollView>
        {valid ? (
          <View style={styles.composer}>
            {photos.length > 0 ? (
              <View style={styles.chips}>
                {photos.map((photo, index) => (
                  <View key={`${photo.name}-${index}`} style={styles.chip} testID="photo-chip">
                    <Text style={styles.chipText}>
                      Photo {index + 1} ({sizeLabel(photo.sizeBytes)})
                    </Text>
                    <Button
                      label="Remove"
                      variant="quiet"
                      testID="remove-photo"
                      onPress={() => setPhotos((list) => list.filter((_, i) => i !== index))}
                    />
                  </View>
                ))}
              </View>
            ) : null}
            <TextInput
              accessibilityLabel={`Message to ${landlordName ?? 'your landlord'}`}
              testID="message-input"
              placeholder="Write a message"
              placeholderTextColor={colours.muted}
              multiline
              maxLength={MESSAGE_BODY_MAX}
              value={draft}
              onChangeText={(text) => {
                setDraft(text);
                if (problem) setProblem(null);
              }}
              style={styles.input}
            />
            {problem ? <ErrorText testID="composer-error">{problem}</ErrorText> : null}
            <View style={styles.actions}>
              {canPickPhotos ? (
                <View style={styles.action}>
                  <Button
                    label="Add photo"
                    variant="quiet"
                    testID="add-photo"
                    onPress={addPhotos}
                  />
                </View>
              ) : null}
              <View style={styles.action}>
                <Button label="Send" testID="send" onPress={send} />
              </View>
            </View>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/**
 * A message on the server: the landlord's, or the tenant's own with its delivery state. Each
 * stored attachment opens through a short-lived link fetched at the tap.
 */
function Bubble({
  message,
  landlordName,
  opening,
  onOpen,
}: {
  message: TenantMessage;
  landlordName: string | null;
  opening: string | null;
  onOpen: (attachment: Attachment) => void;
}) {
  const own = !message.fromLandlord;
  const attachments = attachmentNote(message);
  const channel = channelNote(message.channel);
  const openable = message.attachments.filter((attachment) => attachment.status === 'stored');
  return (
    <View
      testID={own ? 'own-message' : 'landlord-message'}
      style={[styles.bubble, own ? styles.own : styles.theirs]}
    >
      <Text style={styles.from}>{own ? 'You' : (landlordName ?? 'Your landlord')}</Text>
      {message.body ? <Text style={styles.body}>{message.body}</Text> : null}
      {attachments ? <Small testID="attachments">{attachments}</Small> : null}
      {openable.map((attachment) => (
        <Button
          key={attachment.id}
          label={attachmentAction(attachment)}
          variant="quiet"
          testID="open-attachment"
          busy={opening === attachment.id}
          onPress={() => onOpen(attachment)}
        />
      ))}
      <Text style={styles.meta}>
        {formatTime(message.createdAt)}
        {channel ? ` · ${channel}` : ''}
      </Text>
      {own ? (
        <Text style={styles.meta} testID="delivery">
          {deliveryLabel(message.deliveryStatus)}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * A message the API does not have yet: sending, or not sent with why, Try again where trying
 * again can work, and Discard.
 */
function PendingBubble({
  item,
  onRetry,
  onDiscard,
}: {
  item: OutboxItem;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  return (
    <View testID="pending-message" style={[styles.bubble, styles.own, styles.pending]}>
      <Text style={styles.from}>You</Text>
      {item.body ? <Text style={styles.body}>{item.body}</Text> : null}
      {item.photos.length > 0 ? (
        <Small>{item.photos.length === 1 ? '1 photo' : `${item.photos.length} photos`}</Small>
      ) : null}
      {item.state === 'sending' ? (
        <Text style={styles.meta} testID="delivery">
          Sending…
        </Text>
      ) : (
        <View>
          <Text accessibilityRole="alert" style={styles.notSent} testID="delivery">
            {item.problem ?? 'Not sent.'}
          </Text>
          {item.retryable ? (
            <Button label="Try again" variant="quiet" testID="retry-send" onPress={onRetry} />
          ) : null}
          <Button label="Discard" variant="quiet" testID="discard-send" onPress={onDiscard} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colours.page },
  header: {
    paddingHorizontal: 20,
    paddingTop: 8,
    maxWidth: 480,
    width: '100%',
    alignSelf: 'center',
  },
  title: { fontSize: 24, fontWeight: '700', color: colours.ink, marginTop: 4 },
  scroll: { flex: 1 },
  scrollBody: {
    padding: 20,
    gap: 10,
    maxWidth: 480,
    width: '100%',
    alignSelf: 'center',
  },
  stack: { gap: 12 },
  bubble: { borderRadius: 12, padding: 12, gap: 4, maxWidth: '88%' },
  own: { alignSelf: 'flex-end', backgroundColor: colours.okFill },
  theirs: {
    alignSelf: 'flex-start',
    backgroundColor: colours.surface,
    borderWidth: 1,
    borderColor: colours.line,
  },
  pending: { opacity: 0.9 },
  from: { fontSize: 13, fontWeight: '700', color: colours.muted },
  body: { fontSize: 16, lineHeight: 22, color: colours.ink },
  meta: { fontSize: 12, color: colours.muted },
  notSent: { fontSize: 14, color: colours.danger },
  composer: {
    borderTopWidth: 1,
    borderTopColor: colours.line,
    backgroundColor: colours.surface,
    padding: 12,
    gap: 8,
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
  },
  chips: { gap: 4 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: colours.line,
    borderRadius: 8,
    paddingHorizontal: 10,
  },
  chipText: { fontSize: 14, color: colours.ink },
  input: {
    borderWidth: 1,
    borderColor: colours.line,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    minHeight: 48,
    maxHeight: 140,
    color: colours.ink,
    backgroundColor: colours.surface,
  },
  actions: { flexDirection: 'row', gap: 8 },
  action: { flex: 1 },
});

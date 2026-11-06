import type { TenantMessage } from '@rent/contracts';
import { useCallback, useSyncExternalStore } from 'react';
import { api } from './api';
import { cacheable, readCache, writeCache } from './cache';
import { NETWORK_MESSAGE, toProblem, type Problem } from './problems';
import { uploadToStorage, UploadFailed, type PhotoType, type UploadPart } from './upload';

/**
 * Messages the tenant has written that the API has not accepted yet (M6 plan 4.10): sending now,
 * or not sent (offline, or refused) and waiting for the tenant to try again or discard them. Each
 * keeps the `clientMessageId` it was written with, so however often it is tried the API makes one
 * message, and the photos it has already uploaded, so a retry does not upload them again.
 *
 * - **One at a time.** A conversation's messages go in the order they were written, one after the
 *   other; one that fails holds back the ones after it, so the landlord never reads them out of
 *   order.
 * - **Kept on the phone**, per person and landlord (TL-12), in the offline cache, so a message
 *   written offline survives the app closing; signing out empties it. A photo's bytes are not
 *   kept: one not uploaded before the app closed has to be added again. Text holding a link is
 *   kept in memory only, since the cache keeps no link.
 * - **Settled by the thread:** when the thread shows a message with an outbox item's
 *   `clientMessageId`, the API had it all along (only its answer was lost), and the item goes.
 */
export interface OutboxPhoto {
  readonly name: string;
  readonly contentType: PhotoType;
  readonly sizeBytes: number;
  /** The bytes on this phone; null for a photo kept from an earlier run, already uploaded. */
  readonly part: UploadPart | null;
  /** Set once storage has the photo. */
  readonly uploadId: string | null;
}

export interface OutboxItem {
  readonly clientMessageId: string;
  readonly personId: string;
  readonly companyId: string;
  readonly body: string;
  readonly photos: readonly OutboxPhoto[];
  /** When the tenant wrote it, on this phone's clock: it orders the list, nothing more. */
  readonly writtenAt: string;
  readonly state: 'sending' | 'not_sent';
  readonly problem: string | null;
  /** Whether trying again can work. A refusal that never will waits for Discard. */
  readonly retryable: boolean;
}

export type Delivery =
  | { readonly status: 'sent'; readonly message: TenantMessage }
  | { readonly status: 'not_sent'; readonly problem: Problem }
  /** Signed out, or discarded, while it was on its way: nothing more happens. */
  | { readonly status: 'dropped' };

const items = new Map<string, OutboxItem>();
const listeners = new Set<() => void>();
const chains = new Map<string, Promise<unknown>>();
let version = 0;
/** Goes up on sign-out: anything still on its way from before stops there. */
let generation = 0;

const conversationKey = (personId: string, companyId: string) => `${personId}:${companyId}`;
const cacheName = (companyId: string) => `outbox:${companyId}`;

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function update(id: string, patch: Partial<OutboxItem>): OutboxItem | null {
  const item = items.get(id);
  if (!item) return null;
  const next = { ...item, ...patch };
  items.set(id, next);
  changed();
  return next;
}

/** The outbox for one person and one landlord, oldest first. */
export function outboxFor(personId: string, companyId: string): OutboxItem[] {
  return [...items.values()]
    .filter((item) => item.personId === personId && item.companyId === companyId)
    .sort((a, b) => a.writtenAt.localeCompare(b.writtenAt));
}

interface StoredItem {
  readonly clientMessageId: string;
  readonly body: string;
  readonly writtenAt: string;
  readonly photos: readonly Omit<OutboxPhoto, 'part'>[];
  /** Photos not uploaded when this was kept, so lost if the app closes. */
  readonly photosNotKept: number;
  readonly problem: string | null;
  readonly retryable: boolean;
}

/** Keeps one conversation's outbox on the phone, as it is now. */
async function keep(personId: string, companyId: string): Promise<void> {
  const stored: StoredItem[] = outboxFor(personId, companyId).map((item) => ({
    clientMessageId: item.clientMessageId,
    body: item.body,
    writtenAt: item.writtenAt,
    photos: item.photos
      .filter((photo) => photo.uploadId !== null)
      .map(({ name, contentType, sizeBytes, uploadId }) => ({
        name,
        contentType,
        sizeBytes,
        uploadId,
      })),
    photosNotKept: item.photos.filter((photo) => photo.uploadId === null).length,
    problem: item.state === 'sending' ? null : item.problem,
    retryable: item.retryable,
  }));
  // The cache refuses a whole write that holds a link, which would leave an old copy behind: a
  // message with a link in it is kept in memory only.
  const keepable = stored.filter((entry) => cacheable(JSON.stringify(entry)));
  await writeCache(personId, cacheName(companyId), keepable);
}

const LOST_PHOTOS =
  'Not sent. The app closed before your photo was uploaded: add it again in a new message, or send the words alone.';

/**
 * Brings back what a conversation's outbox held when the app last closed, as not sent. Anything
 * already here (written in this run) is left as it is.
 */
export async function restoreOutbox(personId: string, companyId: string): Promise<void> {
  const before = generation;
  const cached = await readCache<StoredItem[]>(personId, cacheName(companyId));
  if (!cached || before !== generation || !Array.isArray(cached.data)) return;
  let added = false;
  for (const stored of cached.data) {
    if (items.has(stored.clientMessageId)) continue;
    items.set(stored.clientMessageId, {
      clientMessageId: stored.clientMessageId,
      personId,
      companyId,
      body: stored.body,
      writtenAt: stored.writtenAt,
      photos: stored.photos.map((photo) => ({ ...photo, part: null })),
      state: 'not_sent',
      problem: stored.photosNotKept > 0 ? LOST_PHOTOS : (stored.problem ?? 'Not sent.'),
      retryable: stored.retryable,
    });
    added = true;
  }
  if (added) changed();
}

/** Adds a message the tenant has just written, as sending. */
export function addToOutbox(
  item: Omit<OutboxItem, 'state' | 'problem' | 'writtenAt' | 'retryable' | 'photos'> & {
    readonly writtenAt?: string;
    readonly photos: readonly Omit<OutboxPhoto, 'uploadId'>[];
  },
): void {
  items.set(item.clientMessageId, {
    ...item,
    photos: item.photos.map((photo) => ({ ...photo, uploadId: null })),
    writtenAt: item.writtenAt ?? new Date().toISOString(),
    state: 'sending',
    problem: null,
    retryable: true,
  });
  changed();
  void keep(item.personId, item.companyId);
}

/** The tenant gives up on a message that was not sent. */
export function discard(clientMessageId: string): void {
  const item = items.get(clientMessageId);
  if (!item || item.state === 'sending') return;
  items.delete(clientMessageId);
  changed();
  void keep(item.personId, item.companyId);
}

/**
 * The thread has loaded these messages: an outbox item whose `clientMessageId` is among them
 * reached the API, though its answer never came back. It goes; the thread shows the message once.
 */
export function settleFromThread(
  personId: string,
  companyId: string,
  messages: readonly TenantMessage[],
): void {
  const arrived = new Set(messages.flatMap((m) => (m.clientMessageId ? [m.clientMessageId] : [])));
  const settled = outboxFor(personId, companyId).filter((item) =>
    arrived.has(item.clientMessageId),
  );
  if (settled.length === 0) return;
  for (const item of settled) items.delete(item.clientMessageId);
  changed();
  void keep(personId, companyId);
}

/** Signing out, or a session that ended: nothing written by one person stays for the next. */
export function forgetOutbox(): void {
  generation += 1;
  items.clear();
  chains.clear();
  changed();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const snapshots = new Map<string, { readonly version: number; readonly list: OutboxItem[] }>();

/** The outbox for one landlord's thread, re-rendering as it changes. */
export function useOutbox(personId: string | null, companyId: string): OutboxItem[] {
  const read = useCallback(() => {
    if (!personId) return EMPTY;
    const key = conversationKey(personId, companyId);
    const cached = snapshots.get(key);
    if (cached?.version === version) return cached.list;
    const list = outboxFor(personId, companyId);
    snapshots.set(key, { version, list });
    return list;
  }, [personId, companyId]);
  return useSyncExternalStore(subscribe, read, read);
}

const EMPTY: OutboxItem[] = [];

const WAITING = 'Not sent. It waits for your earlier message.';

/** Whether the same send can work later: no answer, a busy or failing server, or a lost session. */
function retryable(problem: Problem): boolean {
  const { status, code } = problem;
  if (status === null || status >= 500 || status === 408 || status === 429 || status === 401)
    return true;
  return status === 409 && code?.toUpperCase() === 'REQUEST_IN_PROGRESS';
}

/** The API refused an upload the message named (expired or missing): upload the photos again. */
const uploadRefused = (problem: Problem): boolean =>
  problem.status !== null &&
  problem.status < 500 &&
  (problem.code?.toUpperCase().startsWith('UPLOAD') ?? false);

function notSentText(problem: Problem): string {
  if (problem.code === 'network') return `Not sent. ${NETWORK_MESSAGE}`;
  // C5: the same id reached the API before with other content; it may already have this message.
  if (problem.status === 422 && problem.code?.toUpperCase() === 'IDEMPOTENCY_KEY_REUSED')
    return 'Not sent. Your landlord may already have this message: check above, then discard it.';
  return `Not sent. ${problem.message}`;
}

/** Sends one message: its photos to storage first (each once), then the message itself. */
async function deliverOne(clientMessageId: string, since: number): Promise<Delivery> {
  let item = items.get(clientMessageId);
  if (!item) return { status: 'dropped' };
  const stale = () => since !== generation || !items.has(clientMessageId);
  item = update(clientMessageId, { state: 'sending', problem: null }) ?? item;
  try {
    const uploadIds: string[] = [];
    for (const [index, photo] of item.photos.entries()) {
      let uploadId = photo.uploadId;
      if (!uploadId) {
        if (!photo.part) throw new UploadFailed(410);
        const slot = await api.tenantMessaging.createPhotoUpload({
          companyId: item.companyId,
          contentType: photo.contentType,
          sizeBytes: photo.sizeBytes,
        });
        if (stale()) return { status: 'dropped' };
        await uploadToStorage(slot, { ...photo, part: photo.part });
        if (stale()) return { status: 'dropped' };
        const stored: string = slot.uploadId;
        uploadId = stored;
        const current: OutboxItem = item;
        const photos: OutboxPhoto[] = current.photos.map((p, i) =>
          i === index ? { ...p, uploadId: stored } : p,
        );
        item = update(clientMessageId, { photos }) ?? { ...current, photos };
        void keep(item.personId, item.companyId);
      }
      uploadIds.push(uploadId);
    }
    const message = await api.tenantMessaging.send({
      companyId: item.companyId,
      clientMessageId,
      body: item.body,
      uploadIds,
    });
    if (since !== generation) return { status: 'dropped' };
    items.delete(clientMessageId);
    changed();
    await keep(item.personId, item.companyId);
    return { status: 'sent', message };
  } catch (error) {
    if (stale()) return { status: 'dropped' };
    let problem: Problem;
    let again: boolean;
    if (error instanceof UploadFailed) {
      problem = {
        status: error.status,
        code: error.status === null ? 'network' : 'upload_failed',
        message: 'A photo could not be uploaded.',
      };
      // Storage refused it (a policy that ran out, say): a new upload can work, with the bytes.
      again = item.photos.every((photo) => photo.uploadId !== null || photo.part !== null);
    } else {
      problem = toProblem(error);
      again = retryable(problem);
      if (uploadRefused(problem)) {
        // The uploads it named are no good any more: upload the photos again next time, which
        // needs their bytes, still on the phone only in the run they were added.
        const current: OutboxItem = item;
        const photos: OutboxPhoto[] = current.photos.map((photo) => ({ ...photo, uploadId: null }));
        item = update(clientMessageId, { photos }) ?? { ...current, photos };
        again = photos.every((photo) => photo.part !== null);
      }
    }
    const text = error instanceof UploadFailed && !again ? LOST_PHOTOS : notSentText(problem);
    update(clientMessageId, { state: 'not_sent', problem: text, retryable: again });
    void keep(item.personId, item.companyId);
    return { status: 'not_sent', problem };
  }
}

/** Sends a conversation's waiting messages, oldest first, one at a time; stops at a failure. */
async function flushNow(personId: string, companyId: string, since: number): Promise<Delivery[]> {
  const queue = outboxFor(personId, companyId).filter((item) => item.retryable);
  for (const item of queue)
    if (item.state !== 'sending') update(item.clientMessageId, { state: 'sending', problem: null });
  const results: Delivery[] = [];
  for (const [index, item] of queue.entries()) {
    if (since !== generation) break;
    const result = await deliverOne(item.clientMessageId, since);
    results.push(result);
    if (result.status === 'not_sent') {
      for (const later of queue.slice(index + 1))
        update(later.clientMessageId, { state: 'not_sent', problem: WAITING, retryable: true });
      break;
    }
  }
  if (since === generation) void keep(personId, companyId);
  return results;
}

/**
 * Sends what is waiting in one conversation (a new message, or Try again), behind anything of
 * that conversation already on its way.
 */
export function flush(personId: string, companyId: string): Promise<Delivery[]> {
  const key = conversationKey(personId, companyId);
  const since = generation;
  const run = (chains.get(key) ?? Promise.resolve()).then(() =>
    since === generation ? flushNow(personId, companyId, since) : [],
  );
  chains.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

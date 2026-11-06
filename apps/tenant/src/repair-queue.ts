import type { TenantRepairView } from '@rent/contracts';
import type { MaintenanceCategory } from '@rent/domain/maintenance';
import { useCallback, useSyncExternalStore } from 'react';
import { api } from './api';
import { cacheable, readCache, withoutLinks, writeCache } from './cache';
import { NETWORK_MESSAGE, toProblem, type Problem } from './problems';
import { noteDroppedRepairs } from './repair-dropped';
import {
  filesSurvive,
  forgetAllRepairFiles,
  forgetRequestFiles,
  keptFilePart,
} from './repair-files';
import type { RepairFile } from './repair-rules';
import { uploadToStorage, UploadFailed } from './upload';

/**
 * Repair requests the tenant has written that the API has not accepted yet (MI-01; M8 decision
 * 3): sending now, waiting for the phone to be back online, or refused. One list per person and
 * landlord (TL-12). Each keeps the `clientId` it was written with, so however often it is sent
 * the API makes one job, and each file's upload once it is in storage, so a retry does not upload
 * it again.
 *
 * - **Kept on the phone:** the requests in the offline cache (their files by name only, never an
 *   address), and the files themselves in the app's own folder (repair-files.ts), so a request
 *   written offline survives the app closing. On the web, files live only in the open tab.
 * - **One at a time per landlord,** oldest first, so a later request never overtakes an earlier
 *   one; one that waits for the network holds back the ones after it.
 * - **Signing out** empties it all, files included.
 */
export interface QueuedRepair {
  readonly clientId: string;
  readonly personId: string;
  readonly companyId: string;
  readonly landlordName: string;
  readonly leaseId: string;
  readonly unitCode: string | null;
  readonly category: MaintenanceCategory;
  readonly description: string;
  readonly emergency: boolean;
  readonly files: readonly (RepairFile & { readonly keptName: string })[];
  /** When the tenant wrote it, on this phone's clock: it orders the list, nothing more. */
  readonly writtenAt: string;
  readonly state: 'sending' | 'waiting' | 'not_sent';
  readonly problem: string | null;
  /** Whether sending again can work. A refusal that never will waits for Discard. */
  readonly retryable: boolean;
}

export type RepairDelivery =
  | { readonly status: 'sent'; readonly clientId: string; readonly repair: TenantRepairView }
  | { readonly status: 'not_sent'; readonly clientId: string; readonly problem: Problem }
  | { readonly status: 'dropped' };

/** The tenant's repairs, by landlord (Home's marker and the Repairs screen). Stable, and async. */
export const loadRepairs = async () => api.tenantRepairs.list();

const items = new Map<string, QueuedRepair>();
const listeners = new Set<() => void>();
const chains = new Map<string, Promise<unknown>>();
let version = 0;
let generation = 0;
/** How many requests the API has taken since the app started: lists of repairs refetch on it. */
let sentCount = 0;

const INDEX = 'repairs-queue';
const cacheName = (companyId: string) => `repairs-queue:${companyId}`;

function changed(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function update(id: string, patch: Partial<QueuedRepair>): QueuedRepair | null {
  const item = items.get(id);
  if (!item) return null;
  const next = { ...item, ...patch };
  items.set(id, next);
  changed();
  return next;
}

/** One person's queued requests, oldest first; for one landlord, or all. */
export function queuedRepairs(personId: string, companyId?: string): QueuedRepair[] {
  return [...items.values()]
    .filter((item) => item.personId === personId && (!companyId || item.companyId === companyId))
    .sort((a, b) => a.writtenAt.localeCompare(b.writtenAt));
}

type StoredFile = Omit<RepairFile, 'part'> & { readonly keptName: string };
type StoredRepair = Omit<QueuedRepair, 'personId' | 'files' | 'state'> & {
  readonly files: readonly StoredFile[];
};

/** Keeps one landlord's queue in the offline cache, and the list of landlords with a queue. */
async function keep(personId: string, companyId: string): Promise<void> {
  const stored = queuedRepairs(personId, companyId)
    .map(({ personId: _p, files, state, problem, description, ...rest }): StoredRepair => ({
      ...rest,
      // The cache keeps no link (M8 review LT 9): the copy on the phone has any link the tenant
      // wrote taken out. The request in memory keeps them, and goes with them unless the app
      // closes first.
      description: withoutLinks(description),
      problem: state === 'sending' ? null : problem,
      files: files.map(({ part: _part, ...file }) => file),
    }))
    // Anything still holding a link stays in memory only: the cache refuses a whole write.
    .filter((entry) => cacheable(JSON.stringify(entry)));
  await writeCache(personId, cacheName(companyId), stored);
  const index = new Set((await readCache<string[]>(personId, INDEX))?.data ?? []);
  if (stored.length > 0) index.add(companyId);
  else index.delete(companyId);
  await writeCache(personId, INDEX, [...index]);
}

const LOST =
  'Not sent. A file was not kept when the app closed: discard this request and write it again.';

/** Brings back what the queue held when the app last closed, for every landlord. */
export async function restoreRepairs(personId: string): Promise<void> {
  const before = generation;
  const companies = (await readCache<string[]>(personId, INDEX))?.data ?? [];
  let added = false;
  for (const companyId of companies) {
    const cached = await readCache<StoredRepair[]>(personId, cacheName(companyId));
    if (before !== generation || !cached || !Array.isArray(cached.data)) continue;
    for (const stored of cached.data) {
      if (items.has(stored.clientId)) continue;
      const files = stored.files.map((file) => ({
        ...file,
        part:
          file.uploadId !== null
            ? null
            : keptFilePart(personId, stored.clientId, file.keptName, file.name, file.contentType),
      }));
      const lost = files.some((file) => file.uploadId === null && file.part === null);
      items.set(stored.clientId, {
        ...stored,
        personId,
        files,
        state: lost ? 'not_sent' : 'waiting',
        problem: lost ? LOST : stored.problem,
        retryable: lost ? false : stored.retryable,
      });
      added = true;
    }
  }
  if (added) changed();
}

/** Adds a request the tenant has just written, as sending. */
export function addRepair(
  item: Omit<QueuedRepair, 'state' | 'problem' | 'retryable' | 'writtenAt'> & {
    readonly writtenAt?: string;
  },
): void {
  items.set(item.clientId, {
    ...item,
    writtenAt: item.writtenAt ?? new Date().toISOString(),
    state: 'sending',
    problem: null,
    retryable: true,
  });
  changed();
  void keep(item.personId, item.companyId);
}

/** The tenant gives up on a request that was not sent; its files go too. */
export function discardRepair(clientId: string): void {
  const item = items.get(clientId);
  if (!item || item.state === 'sending') return;
  items.delete(clientId);
  changed();
  forgetRequestFiles(item.personId, clientId);
  void keep(item.personId, item.companyId);
}

/**
 * Signing out, or a session that ended: nothing of one person stays, files included. When the
 * session ended by itself, the sign-in screen says how many requests went with it.
 */
export function forgetRepairQueue(why: 'signed_out' | 'session_ended' = 'signed_out'): void {
  if (why === 'session_ended') noteDroppedRepairs(items.size);
  generation += 1;
  items.clear();
  chains.clear();
  changed();
  forgetAllRepairFiles();
}

/** One queued request, if it is still on the phone. */
export const queuedRepair = (clientId: string): QueuedRepair | null => items.get(clientId) ?? null;

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const EMPTY: QueuedRepair[] = [];
const snapshots = new Map<string, { readonly version: number; readonly list: QueuedRepair[] }>();

/** One person's queued requests, re-rendering as they change. */
export function useRepairQueue(personId: string | null): QueuedRepair[] {
  const read = useCallback(() => {
    if (!personId) return EMPTY;
    const cached = snapshots.get(personId);
    if (cached?.version === version) return cached.list;
    const list = queuedRepairs(personId);
    snapshots.set(personId, { version, list });
    return list;
  }, [personId]);
  return useSyncExternalStore(subscribe, read, read);
}

const readSent = () => sentCount;

/**
 * Changes each time the API takes a request from the queue, whoever sent it (the screen, or the
 * app by itself once back online), so a list of repairs knows to fetch again.
 */
export function useSentRepairs(): number {
  return useSyncExternalStore(subscribe, readSent, readSent);
}

/** No answer, a busy or failing server, or a lost session: the same send can work later. */
function retryable(problem: Problem): boolean {
  const { status, code } = problem;
  if (status === null || status >= 500 || status === 408 || status === 429 || status === 401)
    return true;
  return status === 409 && code?.toUpperCase() === 'REQUEST_IN_PROGRESS';
}

const MEDIA_WORDS: Readonly<Record<string, string>> = {
  MEDIA_TYPE_MISMATCH: 'a file is not what its name says',
  MEDIA_TYPE_NOT_ALLOWED: 'a file is of a kind that cannot be sent',
  MEDIA_TOO_LARGE: 'a file is too big',
  MEDIA_TOO_LONG: 'a video or voice note is too long',
  MEDIA_DURATION_REQUIRED: 'a video or voice note has no length',
};

function notSentText(problem: Problem): string {
  if (problem.code === 'network')
    return 'Waiting to send. It goes by itself when you are back online.';
  const code = problem.code?.toUpperCase();
  // F2: on Starter the landlord takes a description only.
  if (code === 'REPAIR_FILES_NOT_ON_PLAN')
    return 'Not sent: your landlord does not take photos, videos or voice notes in the app. Discard this request and write it again without them.';
  if (code === 'LEASE_ENDED')
    return 'Not sent: this tenancy ended more than 30 days ago, so a repair for it cannot be reported in the app. Contact your landlord directly, then discard this request.';
  const media = problem.code ? MEDIA_WORDS[problem.code.toUpperCase()] : undefined;
  if (media) return `Not sent: ${media}. Discard this request and write it again without it.`;
  if (problem.status === 422 && problem.code?.toUpperCase() === 'IDEMPOTENCY_KEY_REUSED')
    return 'Not sent. Your landlord may already have this request: check your repairs, then discard it.';
  return `Not sent. ${problem.message || NETWORK_MESSAGE}`;
}

async function deliverOne(clientId: string, since: number): Promise<RepairDelivery> {
  let item = items.get(clientId);
  if (!item) return { status: 'dropped' };
  const stale = () => since !== generation || !items.has(clientId);
  item = update(clientId, { state: 'sending', problem: null }) ?? item;
  try {
    const uploadIds: string[] = [];
    for (const [index, file] of item.files.entries()) {
      let uploadId = file.uploadId;
      if (!uploadId) {
        if (!file.part) throw new UploadFailed(410);
        const slot = await api.tenantRepairs.createUpload({
          leaseId: item.leaseId,
          contentType: file.contentType,
          sizeBytes: file.sizeBytes,
          durationSeconds: file.durationSeconds,
        });
        if (stale()) return { status: 'dropped' };
        await uploadToStorage(slot, {
          name: file.name,
          contentType: file.contentType,
          sizeBytes: file.sizeBytes,
          part: file.part,
        });
        if (stale()) return { status: 'dropped' };
        const stored: string = slot.uploadId;
        uploadId = stored;
        const current: QueuedRepair = item;
        const files = current.files.map((f, i) => (i === index ? { ...f, uploadId: stored } : f));
        item = update(clientId, { files }) ?? { ...current, files };
        void keep(item.personId, item.companyId);
      }
      uploadIds.push(uploadId);
    }
    const repair = await api.tenantRepairs.report({
      leaseId: item.leaseId,
      clientId,
      category: item.category,
      description: item.description,
      emergency: item.emergency,
      uploadIds,
    });
    if (since !== generation) return { status: 'dropped' };
    items.delete(clientId);
    sentCount += 1;
    changed();
    forgetRequestFiles(item.personId, clientId);
    await keep(item.personId, item.companyId);
    return { status: 'sent', clientId, repair };
  } catch (error) {
    if (stale()) return { status: 'dropped' };
    let problem: Problem;
    let again: boolean;
    if (error instanceof UploadFailed) {
      problem = {
        status: error.status,
        code: error.status === null ? 'network' : 'upload_failed',
        message: 'A file could not be uploaded.',
      };
      again = error.status !== 410;
    } else {
      problem = toProblem(error);
      again = retryable(problem);
    }
    const text = error instanceof UploadFailed && !again ? LOST : notSentText(problem);
    update(clientId, {
      state: problem.code === 'network' ? 'waiting' : 'not_sent',
      problem: text,
      retryable: again,
    });
    void keep(item.personId, item.companyId);
    return { status: 'not_sent', clientId, problem };
  }
}

async function flushNow(personId: string, companyId: string, since: number) {
  const queue = queuedRepairs(personId, companyId).filter((item) => item.retryable);
  const results: RepairDelivery[] = [];
  for (const [index, item] of queue.entries()) {
    if (since !== generation) break;
    const result = await deliverOne(item.clientId, since);
    results.push(result);
    if (result.status === 'not_sent') {
      for (const later of queue.slice(index + 1))
        update(later.clientId, {
          state: 'waiting',
          problem: 'Waiting to send, after your earlier request.',
          retryable: true,
        });
      break;
    }
  }
  return results;
}

/** Sends what waits for one landlord, behind anything of theirs already on its way. */
export function flushRepairs(personId: string, companyId: string): Promise<RepairDelivery[]> {
  const key = `${personId}:${companyId}`;
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

/** Sends what waits for every landlord: when the app opens, comes back, or is back online. */
export async function flushAllRepairs(personId: string): Promise<RepairDelivery[]> {
  const companies = [...new Set(queuedRepairs(personId).map((item) => item.companyId))];
  const results = await Promise.all(companies.map((id) => flushRepairs(personId, id)));
  return results.flat();
}

/** Whether a queued request's files outlive the app on this build (repair-files.ts). */
export const queuedFilesSurvive = filesSurvive;

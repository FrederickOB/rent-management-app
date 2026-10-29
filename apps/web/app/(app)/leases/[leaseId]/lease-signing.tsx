'use client';

import type { LeaseDetailView, SigningProgress } from '@rent/contracts';
import { SIGNER_ROLE_LABELS } from '@rent/domain/esign';
import Link from 'next/link';
import { toDataURL } from 'qrcode';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useApp } from '@/components/app-context';
import { Alert } from '@/components/ui/alert';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { TextAreaField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { openFetchedLink } from '@/lib/browser-files';
import { toProblem } from '@/lib/errors';
import { formatDate } from '@/lib/format';
import {
  handoverProblem,
  isOpenRequest,
  issueBlockers,
  issueProblem,
  needsHandover,
  recallProblem,
  REQUEST_STATUS_LABELS,
  requestLine,
  shortHash,
  SIGNING_POLL_MS,
  signerLines,
  signerState,
  type SignerProgress,
  type SigningProblem,
} from '@/lib/signing';
import { useInterval, useOnVisible } from '@/lib/use-interval';

type Changed = (next: LeaseDetailView, text: string) => void;

const REQUEST_TONES: Record<SigningProgress['status'], BadgeTone> = {
  preparing: 'blue',
  pending: 'blue',
  completed: 'green',
  declined: 'red',
  cancelled: 'dark',
};

/** What to do about a refusal: a link to the draft editor, or a reload. */
function ProblemAlert({
  problem,
  leaseId,
}: {
  readonly problem: SigningProblem;
  readonly leaseId: string;
}) {
  return (
    <Alert tone="error">
      <p>{problem.message}</p>
      {problem.fix === 'edit_draft' ? (
        <Link
          href={`/leases/${leaseId}/edit`}
          className="mt-2 inline-flex min-h-11 items-center font-medium underline underline-offset-2"
        >
          Edit the draft
        </Link>
      ) : null}
      {problem.fix === 'reload' ? (
        <Button
          className="mt-2"
          size="sm"
          variant="secondary"
          onClick={() => window.location.reload()}
        >
          Reload the page
        </Button>
      ) : null}
    </Alert>
  );
}

/**
 * The confirmation before a draft goes out for signing (TL-07; plan 4.8): who signs, and that the
 * terms freeze. What the lease itself shows is checked first; the API checks everything again.
 */
export function IssueForSigning({
  lease,
  onChanged,
  onCancel,
}: {
  readonly lease: LeaseDetailView;
  readonly onChanged: Changed;
  readonly onCancel: () => void;
}) {
  const blockers = issueBlockers(lease);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<SigningProblem | null>(null);

  async function send() {
    setPending(true);
    setProblem(null);
    try {
      const next = await api().leases.issue({ leaseId: lease.id });
      onChanged(
        next,
        'Sent for signing. The terms are frozen; each signer gets their link once the document is ready.',
      );
    } catch (failure) {
      setProblem(issueProblem(toProblem(failure)));
      setPending(false);
    }
  }

  return (
    <div
      role="group"
      aria-label="Send for signing"
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4 text-sm"
    >
      <p className="font-medium text-slate-900">Send this lease for signing?</p>
      <p className="text-slate-700">
        Sending freezes the terms and the document. To change anything afterwards, recall the lease:
        every link stops working and it goes back to draft. Each signer gets a link by SMS or email
        where they agreed to messages; anyone else is handed a link in person from this page.
      </p>
      <ul
        className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white"
        aria-label="Who signs"
      >
        {lease.parties.map((p) => (
          <li
            key={p.id}
            data-testid="issue-signer"
            className="flex flex-wrap justify-between gap-2 px-3 py-2"
          >
            <span>
              <span className="font-medium">{p.name}</span>{' '}
              <span className="text-slate-600">
                {SIGNER_ROLE_LABELS[p.role]}
                {p.required ? '' : ', optional'}
              </span>
            </span>
            <span className="text-slate-600">
              {[p.phone, p.email].filter(Boolean).join(' · ') || 'From their record'}
            </span>
          </li>
        ))}
      </ul>
      {blockers.length ? (
        <Alert tone="warning" title="Fix these in the draft first">
          <ul className="list-disc space-y-1 pl-5">
            {blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          <Link
            href={`/leases/${lease.id}/edit`}
            className="mt-2 inline-flex min-h-11 items-center font-medium underline underline-offset-2"
          >
            Edit the draft
          </Link>
        </Alert>
      ) : null}
      {problem ? <ProblemAlert problem={problem} leaseId={lease.id} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button pending={pending} disabled={blockers.length > 0} onClick={() => void send()}>
          Send for signing
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Keep it as a draft
        </Button>
      </div>
    </div>
  );
}

/** A fingerprint in short form, with the whole value one click away (CLAUDE.md section 9). */
function Fingerprint({
  label,
  value,
  testId,
}: {
  readonly label: string;
  readonly value: string;
  readonly testId: string;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="min-w-0">
      <dt className="text-slate-600">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2">
        <code data-testid={testId} title={value} className="font-mono text-sm break-all">
          SHA-256 {shortHash(value)}
        </code>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Copy the full fingerprint: ${label}`}
          onClick={() => void copy()}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </dd>
    </div>
  );
}

/**
 * A single-use link for one signer, handed over in person (decision 2): shown as a QR code and in
 * a field to copy. It replaces the signer's earlier link. It lives only in this panel's state and
 * is gone when the panel closes; it is never logged, stored or put in the address bar.
 */
function HandoverPanel({
  requestId,
  signer,
  onIssued,
  onClose,
}: {
  readonly requestId: string;
  readonly signer: SignerProgress;
  readonly onIssued: () => void;
  readonly onClose: () => void;
}) {
  const { timeZone } = useApp();
  const fieldId = useId();
  const [link, setLink] = useState<{ url: string; expiresAt: string; qr: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<SigningProblem | null>(null);

  async function make() {
    setPending(true);
    setProblem(null);
    try {
      const issued = await api().signingRequests.handoverLink({
        signingRequestId: requestId,
        signerId: signer.id,
      });
      const qr = await toDataURL(issued.url, { margin: 1, width: 240, errorCorrectionLevel: 'M' });
      setLink({ url: issued.url, expiresAt: issued.expiresAt, qr });
      onIssued();
    } catch (failure) {
      setProblem(handoverProblem(toProblem(failure)));
    } finally {
      setPending(false);
    }
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function close() {
    setLink(null);
    onClose();
  }

  return (
    <div
      role="group"
      aria-label={`Hand over a link to ${signer.name}`}
      className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-4 text-sm"
    >
      {problem ? <Alert tone="error">{problem.message}</Alert> : null}
      {link ? (
        <>
          <p className="text-slate-800">
            Let {signer.name} scan the code with their phone, or copy the link and give it to them
            yourself. It is for {signer.name} only and works until{' '}
            {formatDate(link.expiresAt, timeZone)}. Any earlier link to them no longer works.
          </p>
          <img
            src={link.qr}
            alt={`QR code of the signing link for ${signer.name}`}
            width={240}
            height={240}
            className="rounded-md border border-slate-200 bg-white"
          />
          <div className="space-y-1">
            <label htmlFor={fieldId} className="block text-sm font-medium text-slate-800">
              Signing link for {signer.name}
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                id={fieldId}
                readOnly
                value={link.url}
                onFocus={(event) => event.target.select()}
                className="block min-w-0 flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs text-slate-900"
              />
              <Button size="sm" variant="secondary" onClick={() => void copy()}>
                {copied ? 'Copied' : 'Copy the link'}
              </Button>
            </div>
          </div>
        </>
      ) : (
        <>
          <p className="text-slate-800">
            A new link for {signer.name} replaces any link they already have: the earlier one stops
            working. Their code still goes to the phone or email on record.
          </p>
          <Button pending={pending} onClick={() => void make()}>
            Make the link
          </Button>
        </>
      )}
      <Button variant="ghost" size="sm" onClick={close}>
        {link ? 'Done' : 'Cancel'}
      </Button>
    </div>
  );
}

function RecallForm({
  lease,
  onChanged,
  onCancel,
}: {
  readonly lease: LeaseDetailView;
  readonly onChanged: Changed;
  readonly onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<SigningProblem | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setProblem(null);
    try {
      const next = await api().leases.recall({ leaseId: lease.id, reason: reason.trim() || null });
      onChanged(
        next,
        'Recalled. Every signing link has stopped working, and the lease is a draft again.',
      );
    } catch (failure) {
      setProblem(recallProblem(toProblem(failure)));
      setPending(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="Recall the lease"
      className="space-y-3 rounded-md border border-red-200 bg-red-50 p-4 text-sm"
    >
      <p className="text-red-900">
        Recall this lease? Every signing link stops working and the lease goes back to draft, so its
        terms can change. Signatures already given no longer count: when it is sent again, everyone
        signs again.
      </p>
      {problem ? <ProblemAlert problem={problem} leaseId={lease.id} /> : null}
      <TextAreaField
        label="Reason (optional)"
        hint="Kept with the signing record."
        rows={2}
        maxLength={500}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        className="[&_textarea]:font-sans"
      />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger" pending={pending}>
          Recall the lease
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Keep it out for signature
        </Button>
      </div>
    </form>
  );
}

const DONE_NOTES: Partial<Record<SigningProgress['status'], string>> = {
  completed: 'Everyone has signed. The signed copy and its fingerprints are below.',
  declined: 'A signer declined. The lease is back to draft.',
};

/**
 * Signing progress (TL-07; plan 4.8 and 4.16): the request and each signer, with the hand-over
 * and recall while it is open, and the signed copy with both fingerprints once it completes. It
 * shows link activity, not message delivery (that arrives with M6). It asks again every 15 seconds
 * while the request is open.
 */
export function SigningPanel({
  lease,
  canManage,
  onChanged,
}: {
  readonly lease: LeaseDetailView;
  readonly canManage: boolean;
  readonly onChanged: Changed;
}) {
  const { timeZone } = useApp();
  const [progress, setProgress] = useState<SigningProgress | null | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [handover, setHandover] = useState<string | null>(null);
  const [recalling, setRecalling] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const waiting = lease.status === 'pending_signatures';
  // The latest callback, so a new one on each render of the page does not restart the polling.
  const changed = useRef(onChanged);
  useEffect(() => {
    changed.current = onChanged;
  });

  const load = useCallback(async () => {
    try {
      const next = await api().leases.signing({ leaseId: lease.id });
      setProgress(next);
      setProblem(null);
      setNow(new Date());
      // The lease follows the request a moment later (the worker finalises, or a decline returns
      // it to draft); once it has moved, the page shows it.
      if (waiting && next && !isOpenRequest(next.status)) {
        const view = await api().leases.get({ leaseId: lease.id });
        if (view.access === 'full' && view.status !== lease.status)
          changed.current(view, DONE_NOTES[next.status] ?? REQUEST_STATUS_LABELS[next.status]);
      }
    } catch (failure) {
      setProblem(toProblem(failure).message);
    }
  }, [lease.id, lease.status, waiting]);

  useEffect(() => {
    void load();
  }, [load]);
  const live = waiting || (progress ? isOpenRequest(progress.status) : false);
  useInterval(() => void load(), live ? SIGNING_POLL_MS : null);
  useOnVisible(() => {
    if (live) void load();
  });

  if (progress === undefined) return problem ? <Alert tone="error">{problem}</Alert> : null;
  if (progress === null) return null;

  const open = isOpenRequest(progress.status) && waiting;
  const download = async (which: 'frozen' | 'signed') => {
    setProblem(null);
    try {
      await openFetchedLink(
        async () => (await api().leases.signingDocument({ leaseId: lease.id, which })).url,
      );
    } catch (failure) {
      setProblem(toProblem(failure).message);
    }
  };

  return (
    <Card data-testid="signing">
      <CardHeader
        title={open || progress.status === 'completed' ? 'Signing' : 'Last signing request'}
        description={requestLine(progress, timeZone)}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span data-testid="signing-status">
              <Badge tone={REQUEST_TONES[progress.status]}>
                {REQUEST_STATUS_LABELS[progress.status]}
              </Badge>
            </span>
            <Button size="sm" variant="secondary" onClick={() => void load()}>
              Refresh
            </Button>
          </div>
        }
      />
      <CardBody>
        {problem ? <Alert tone="error">{problem}</Alert> : null}
        {open ? (
          <p className="text-sm text-slate-600">
            This shows the links each signer has had and opened; whether a message was delivered is
            not tracked yet. The page checks again every 15 seconds.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {progress.signedDocument ? (
            <Button onClick={() => void download('signed')}>Download the signed copy</Button>
          ) : null}
          {progress.frozenDocument ? (
            <Button variant="secondary" onClick={() => void download('frozen')}>
              {progress.status === 'completed'
                ? 'Download the document as it was signed'
                : isOpenRequest(progress.status)
                  ? 'Download the document being signed'
                  : 'Download the document that was sent'}
            </Button>
          ) : null}
        </div>
        {progress.documentSha256 || progress.finalSha256 ? (
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2" aria-label="Fingerprints">
            {progress.documentSha256 ? (
              <Fingerprint
                label="The document the signers read"
                value={progress.documentSha256}
                testId="document-sha256"
              />
            ) : null}
            {progress.finalSha256 ? (
              <Fingerprint
                label="The signed copy, with its signing certificate"
                value={progress.finalSha256}
                testId="final-sha256"
              />
            ) : null}
          </dl>
        ) : null}

        <ol className="divide-y divide-slate-100" aria-label="Signers">
          {progress.signers.map((signer) => {
            const state = signerState(signer, now, isOpenRequest(progress.status));
            const canHandOver =
              canManage && progress.status === 'pending' && waiting && signer.status === 'pending';
            return (
              <li key={signer.id} data-testid="signer" className="space-y-2 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-900">{signer.name}</span>
                    <span className="text-slate-600">
                      {signer.roleLabel}
                      {signer.required ? '' : ', optional'}
                    </span>
                    <span data-testid="signer-state">
                      <Badge tone={state.tone}>{state.label}</Badge>
                    </span>
                  </p>
                  {canHandOver && handover !== signer.id ? (
                    <Button
                      size="sm"
                      variant={needsHandover(signer) ? 'primary' : 'secondary'}
                      aria-label={`Hand over a link to ${signer.name}`}
                      onClick={() => setHandover(signer.id)}
                    >
                      {needsHandover(signer) ? 'Hand over a link' : 'Hand over a new link'}
                    </Button>
                  ) : null}
                </div>
                <ul className="space-y-0.5 text-slate-700">
                  {signerLines(signer, timeZone, now, isOpenRequest(progress.status)).map(
                    (line) => (
                      <li key={line}>{line}</li>
                    ),
                  )}
                  {progress.status === 'completed' ? (
                    <li>
                      {signer.copySent
                        ? 'Their signed copy was sent.'
                        : 'Their signed copy was not sent: they have no channel they agreed to. Give them a copy of the signed lease.'}
                    </li>
                  ) : null}
                </ul>
                {handover === signer.id && canHandOver ? (
                  <HandoverPanel
                    requestId={progress.requestId}
                    signer={signer}
                    onIssued={() => void load()}
                    onClose={() => setHandover(null)}
                  />
                ) : null}
              </li>
            );
          })}
        </ol>

        {canManage && open && !recalling ? (
          <Button variant="ghost" onClick={() => setRecalling(true)}>
            Recall the lease
          </Button>
        ) : null}
        {recalling && open ? (
          <RecallForm
            lease={lease}
            onChanged={(next, text) => {
              setRecalling(false);
              onChanged(next, text);
            }}
            onCancel={() => setRecalling(false)}
          />
        ) : null}
      </CardBody>
    </Card>
  );
}

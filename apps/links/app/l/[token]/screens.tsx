import type { SigningPage } from '../../../lib/links-api';
import { DrawPad } from './draw-pad';

type Query = Readonly<Record<string, string | undefined>>;

/** A time for people, always naming the zone (DO-04). */
function when(iso: string | null, timeZone: string): string {
  if (!iso) return '';
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));
  return `${text} (${timeZone})`;
}

/** What went wrong with the last action, from the API's error code. */
const PROBLEMS: Readonly<Record<string, string>> = {
  CODE_WRONG: 'That code is not right.',
  CODE_EXPIRED: 'That code has expired. Send yourself a new one.',
  CODE_REQUIRED: 'Send yourself a code first.',
  CODE_LIMIT: 'We have sent several codes already. Wait a few minutes before asking for another.',
  CODE_FORMAT: 'Enter the 6-digit code we sent you.',
  CODE_NOT_SENT: 'We could not send your code just now. Wait a minute and try again.',
  CONSENT_REQUIRED: 'Tick the box to agree to sign electronically.',
  SIGNATURE_REQUIRED: 'Type your full name, or draw your signature, to sign.',
  DRAWING_INVALID: 'Draw your signature again.',
  REASON_REQUIRED: 'Say in a few words why you are declining.',
  SIGNING_LOCKED: 'Too many wrong codes. Signing is locked for 30 minutes.',
  RATE_LIMITED: 'Too many requests. Wait a few minutes and try again.',
  LINK_NOT_USABLE: 'This link can no longer be used to sign.',
};

function problemText(query: Query): string | null {
  if (!query.error) return null;
  const text = PROBLEMS[query.error] ?? 'Something went wrong on our side. Try again in a minute.';
  const left = query.left ? Number(query.left) : NaN;
  return Number.isFinite(left)
    ? `${text} You have ${left} ${left === 1 ? 'try' : 'tries'} left.`
    : text;
}

function Contact({ page }: { page: SigningPage }) {
  const { landlord } = page;
  return (
    <section className="panel contact" aria-labelledby="contact">
      <h2 id="contact">Questions?</h2>
      <p>
        Contact {landlord.name}
        {landlord.contactName ? `: ${landlord.contactName}` : ''}.
      </p>
      {landlord.phone ? (
        <p>
          Phone: <a href={`tel:${landlord.phone}`}>{landlord.phone}</a>
        </p>
      ) : null}
      {landlord.email ? (
        <p>
          Email: <a href={`mailto:${landlord.email}`}>{landlord.email}</a>
        </p>
      ) : null}
    </section>
  );
}

function Signers({ page }: { page: SigningPage }) {
  return (
    <ul className="signers">
      {page.signers.map((s, i) => (
        <li key={i}>
          <span>
            {s.name}
            <br />
            <span className="small">{s.roleLabel}</span>
          </span>
          <span className={`status ${s.status}`}>
            {s.status === 'signed' ? 'Signed' : s.status === 'declined' ? 'Declined' : 'To sign'}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A link that no longer signs: what happened, and who to contact (plan 4.8). A signer who has
 * signed can download the document they signed only while their link is live (the API says so
 * with `downloadable`); an expired or revoked link offers nothing to download.
 */
export function Explanation({
  token,
  page,
  done,
}: {
  token: string;
  page: SigningPage;
  done?: string | undefined;
}) {
  const { title } = page.document;
  let heading: string;
  let body: string;
  switch (page.screen) {
    case 'signed':
      heading = done === 'signed' ? 'Thank you: you have signed' : 'You have already signed';
      body =
        page.reason === 'completed'
          ? `Everyone has signed ${title}. Your signed copy has been sent to you.`
          : page.reason === 'cancelled'
            ? `You signed ${title}, but the landlord then withdrew it, for example to change it. If it is sent again, you will get a new link.`
            : page.reason === 'declined'
              ? `You signed ${title}, but signing stopped because another signer declined. If it is sent again, you will get a new link.`
              : `You signed ${title}${page.signer.signedAt ? ` on ${when(page.signer.signedAt, page.timeZone)}` : ''}. We will send you the signed copy once everyone has signed.`;
      break;
    case 'declined':
      heading = done === 'declined' ? 'You declined to sign' : 'You have declined to sign';
      body = `You declined to sign ${title}. The landlord has been told and may send you a new version.`;
      break;
    case 'expired':
      heading = 'This link has expired';
      body = 'Signing links work for 30 days. Ask the landlord to send you a new link.';
      break;
    case 'revoked':
      heading = 'This link has been replaced';
      body =
        page.reason === 'superseded'
          ? 'A newer link was sent to you, so this one no longer works. Use the newest message, or ask for a new link.'
          : 'This link no longer works. Ask the landlord to send you a new link.';
      break;
    default:
      heading = 'This document is no longer out for signing';
      body =
        page.reason === 'cancelled'
          ? `${title} was withdrawn by the landlord, for example to change it. If it is sent again, you will get a new link.`
          : page.reason === 'declined'
            ? `Signing ${title} stopped because one of the signers declined. If it is sent again, you will get a new link.`
            : page.reason === 'completed'
              ? `Everyone has signed ${title}.`
              : page.reason === 'signed_by_all'
                ? `Everyone who must sign ${title} has signed, so it no longer needs your signature. The signed copy is being prepared.`
                : 'Ask the landlord to send you a new link.';
  }
  return (
    <>
      <h1>{heading}</h1>
      <p className={done ? 'panel done' : undefined}>{body}</p>
      {page.screen === 'signed' && page.document.downloadable ? (
        <p>
          <a href={`/l/${token}/document`}>Download the document you signed (PDF)</a>
          <br />
          <span className="small">
            Its fingerprint (SHA-256): <code className="hash">{page.document.sha256}</code>
          </span>
        </p>
      ) : null}
      {page.screen === 'signed' && page.signers.length > 0 ? <Signers page={page} /> : null}
      <Contact page={page} />
    </>
  );
}

/** The signed-copy page: everyone has signed; download the copy with its certificate. */
export function CopyScreen({ token, page }: { token: string; page: SigningPage }) {
  return (
    <>
      <h1>Your signed copy is ready</h1>
      <p>
        Everyone has signed {page.document.title} (reference {page.document.reference}). The copy
        ends with a signing certificate that records each signature.
      </p>
      <p>
        <a className="button" href={`/l/${token}/document`}>
          Download the signed copy (PDF)
        </a>
      </p>
      <p className="small">
        Fingerprint of the signed copy (SHA-256):{' '}
        <code className="hash">{page.document.finalSha256}</code>
      </p>
      <p className="small">
        Fingerprint of the document everyone signed (SHA-256):{' '}
        <code className="hash">{page.document.sha256}</code>
      </p>
      <Contact page={page} />
    </>
  );
}

/** The signing page (plan 4.8): the document, then the code, the signature and consent. */
export function SignScreen({
  token,
  page,
  query,
}: {
  token: string;
  page: SigningPage;
  query: Query;
}) {
  const problem = problemText(query);
  const code = page.code!;
  const locked = code.lockedUntil !== null;
  const draw = query.draw === '1';
  const declining = query.step === 'decline';
  const base = `/l/${token}`;
  return (
    <>
      <p className="panel notice">
        {page.landlord.name} asks you, {page.signer.name}, to sign this document as{' '}
        {page.signer.roleLabel.toLowerCase()}. Read it, then <a href="#sign">sign at the end</a>.
      </p>
      <article
        className="document"
        aria-label="The document"
        dangerouslySetInnerHTML={{ __html: page.document.html ?? '' }}
      />
      <p>
        <a href={`${base}/document`}>Download the PDF</a>
        <br />
        <span className="small">
          Its fingerprint (SHA-256): <code className="hash">{page.document.sha256}</code>
        </span>
      </p>

      <section id="sign" aria-labelledby="sign-heading">
        <h2 id="sign-heading">{declining ? 'Decline to sign' : 'Sign'}</h2>
        <Signers page={page} />
        {problem ? (
          <p className="panel problem" role="alert">
            {problem}
          </p>
        ) : null}
        {declining ? (
          <form method="post" action={`${base}/decline`}>
            <label htmlFor="reason">Why are you declining?</label>
            <textarea id="reason" name="reason" rows={3} required minLength={3} maxLength={500} />
            <p className="small">
              The landlord will see your reason. The lease goes back to them to change or cancel.
            </p>
            <button type="submit">Decline to sign</button> <a href={`${base}#sign`}>Back</a>
          </form>
        ) : locked ? (
          <p className="panel problem" role="alert">
            Too many wrong codes. Signing is locked until {when(code.lockedUntil, page.timeZone)}.
          </p>
        ) : code.sentAt === null ? (
          <form method="post" action={`${base}/code`}>
            <p>
              To sign, you need a 6-digit code. We will send it{' '}
              {code.channel === 'sms' ? 'by SMS to' : 'by email to'} {code.destinationMasked}.
            </p>
            <button type="submit" disabled={code.sendsLeft === 0}>
              Send me a code
            </button>
            {code.sendsLeft === 0 ? (
              <p className="small">You have asked for 3 codes. Wait a few minutes.</p>
            ) : null}
          </form>
        ) : (
          <>
            <form method="post" action={`${base}/sign`}>
              <p>
                We sent a code {code.channel === 'sms' ? 'by SMS to' : 'by email to'}{' '}
                {code.destinationMasked}. It works until {when(code.expiresAt, page.timeZone)}.
              </p>
              <label htmlFor="code">Your 6-digit code</label>
              <input
                className="code"
                id="code"
                name="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
              />
              {draw ? (
                <>
                  <input type="hidden" name="method" value="drawn" />
                  <label htmlFor="pad">Draw your signature</label>
                  <DrawPad name="drawing" />
                  <p className="small">
                    <a href={`${base}#sign`}>Type your name instead</a>
                  </p>
                </>
              ) : (
                <>
                  <input type="hidden" name="method" value="typed" />
                  <label htmlFor="typedName">Type your full name to sign</label>
                  <input
                    id="typedName"
                    name="typedName"
                    type="text"
                    autoComplete="name"
                    minLength={2}
                    maxLength={120}
                    required
                  />
                  <p className="small">
                    <a href={`${base}?draw=1#sign`}>Draw your signature instead</a>
                  </p>
                </>
              )}
              <input type="hidden" name="consentVersion" value={page.consent?.version ?? ''} />
              <label className="check">
                <input type="checkbox" name="consent" value="yes" required />
                <span>{page.consent?.text}</span>
              </label>
              <button type="submit">Sign</button>
            </form>
            <form method="post" action={`${base}/code`}>
              <button className="secondary" type="submit" disabled={code.sendsLeft === 0}>
                Send a new code
              </button>
            </form>
          </>
        )}
        {declining ? null : (
          <p className="small">
            <a href={`${base}?step=decline#sign`}>I do not want to sign</a>
          </p>
        )}
      </section>
      <Contact page={page} />
    </>
  );
}

/** The API could not be reached, or asked us to slow down. */
export function Trouble({ busy }: { busy: boolean }) {
  return (
    <>
      <h1>{busy ? 'Too many requests' : 'This page is not available just now'}</h1>
      <p>
        {busy
          ? 'This link was opened many times in a short while. Wait a few minutes and try again.'
          : 'Something went wrong on our side. Try again in a few minutes.'}
      </p>
    </>
  );
}

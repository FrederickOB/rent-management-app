// The email unsubscribe page's screens (CM-09; M6 decision 7). Plain HTML: one form with one
// button, no script of its own.

/** "a•••@example.com", or nothing when the API does not say. */
function toAddress(emailMasked: string | null): string {
  return emailMasked ? ` to ${emailMasked}` : '';
}

/**
 * How to stop the other channels (decision 7). STOP on WhatsApp stops WhatsApp, and STOP ALL
 * stops every channel. SMS replies need a two-way short code that does not exist yet (decision
 * 1), so the page does not promise that STOP works by SMS.
 */
export function OtherChannels({ landlordName }: { landlordName: string }) {
  return (
    <section className="panel" aria-labelledby="other">
      <h2 id="other">Other messages</h2>
      <p>This link stops emails only. To stop other messages from {landlordName}:</p>
      <ul>
        <li>
          <strong>WhatsApp:</strong> reply STOP to one of their WhatsApp messages. Reply STOP ALL to
          stop their WhatsApp messages, text messages, emails and app notifications.
        </li>
        <li>
          <strong>App notifications:</strong> in the tenant app, open Profile and turn notifications
          off.
        </li>
        <li>
          <strong>Text messages (SMS):</strong> reply STOP ALL on WhatsApp, or ask {landlordName} to
          stop them.
        </li>
      </ul>
    </section>
  );
}

export function ConfirmScreen({
  token,
  landlordName,
  emailMasked,
  problem,
}: {
  token: string;
  landlordName: string;
  emailMasked: string | null;
  problem: string | null;
}) {
  return (
    <>
      <h1>Stop emails from {landlordName}?</h1>
      <p>
        {landlordName} will stop sending emails{toAddress(emailMasked)} about your tenancy, such as
        rent reminders, receipts, building notices and links to sign documents.
      </p>
      {problem ? (
        <p className="panel problem" role="alert">
          {problem}
        </p>
      ) : null}
      <form method="post" action={`/u/${token}/confirm`}>
        <button type="submit">Stop emails</button>
      </form>
      <p className="small">
        Nothing changes until you press the button. A one-time code you ask for can still come by
        email.
      </p>
      <OtherChannels landlordName={landlordName} />
    </>
  );
}

export function DoneScreen({
  landlordName,
  emailMasked,
}: {
  landlordName: string;
  emailMasked: string | null;
}) {
  return (
    <>
      <h1>You will no longer get emails from {landlordName}</h1>
      <p className="panel done" role="status">
        We have recorded that you do not want emails{toAddress(emailMasked)} from {landlordName}{' '}
        about your tenancy.
      </p>
      <p>Changed your mind? Ask {landlordName} to send you emails again.</p>
      <OtherChannels landlordName={landlordName} />
    </>
  );
}

/** The standard screen for a link that no longer works, with how to stop emails without it. */
export function ExpiredScreen({ landlordName }: { landlordName: string }) {
  return (
    <>
      <h1>This link is not valid or has expired</h1>
      <p>
        Unsubscribe links stop working after a while. Use the link in a newer email from{' '}
        {landlordName}, or ask them to stop sending you emails.
      </p>
      <OtherChannels landlordName={landlordName} />
    </>
  );
}

/**
 * C6: the link was sent to an email address that is no longer the one the landlord has for the
 * person. It changes nothing, and names neither address: whoever holds the link may not be them.
 */
export function AddressChangedScreen({ landlordName }: { landlordName: string }) {
  return (
    <>
      <h1>This link cannot be used</h1>
      <p>
        It was sent to an email address that {landlordName} no longer has on record, so it changes
        nothing. To stop emails, use the link in a newer email from {landlordName}, or ask them.
      </p>
    </>
  );
}

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

import type { TenantSigningView } from '@rent/contracts';
import { Redirect, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api } from '../src/api';
import { formatTime, SIGNER_STATUS_LABELS } from '../src/format';
import { openFetchedUrl } from '../src/open-url';
import { toProblem, type Problem } from '../src/problems';
import { useSession } from '../src/session';
import { isNoticeItem, noticeDates, noticeStatement } from '../src/signing-items';
import {
  BackLink,
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
import { useLoad, useReloadOnReturn } from '../src/use-load';

type Item = TenantSigningView;
type Signer = Item['signers'][number];

const loadSigning = () => api.tenantApp.signing();

/** Why the signing page could not be opened, in words for the tenant. */
function linkMessage(problem: Problem, notice: boolean): string {
  if (problem.status === 404)
    return notice
      ? 'This notice is no longer waiting for you to acknowledge it.'
      : 'This lease is no longer waiting for your signature.';
  if (problem.status === 409) return problem.message;
  return `We could not open the signing page. ${problem.message}`;
}

/**
 * The other signers. The list does not say which entry is the tenant's own, so the first entry
 * with the tenant's name and status is taken as theirs.
 */
function othersOf(item: Item): Signer[] {
  const own = item.signers.findIndex(
    (s) => s.name === item.signer.name && s.status === item.signer.status,
  );
  return own < 0 ? item.signers : item.signers.filter((_, index) => index !== own);
}

/**
 * To sign (TL-07; M7 plan 4.10): each lease out for the tenant's own signature, and each notice
 * waiting for them to acknowledge receipt. "Review and sign" (or "Read and acknowledge") asks the
 * API for a fresh link and opens the signing page in the app's browser. For a lease the link
 * replaces the one sent by message; for a notice earlier links keep working (M7 decision 6). The
 * list reloads when the browser closes or the app is back in front.
 */
export default function ToSign() {
  const router = useRouter();
  const { me, loading, expire } = useSession();
  const signing = useLoad(loadSigning, Boolean(me));
  useReloadOnReturn(signing.reload);
  const [opening, setOpening] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = useRef(false);

  function review(item: Item) {
    if (busy.current) return;
    busy.current = true;
    setOpening(item.signer.id);
    setProblem(null);
    // Straight from the tap: on the web the tab has to open before anything is awaited.
    void openFetchedUrl(
      () => api.tenantApp.signingLink({ signerId: item.signer.id }),
      'Opening the signing page…',
    )
      .then((result) => {
        if (result === 'returned') signing.reload();
      })
      .catch((error: unknown) => {
        const found = toProblem(error);
        if (found.status === 401) return expire();
        setProblem(linkMessage(found, isNoticeItem(item)));
        // Signed or closed meanwhile: show the list as it is now.
        if (found.status === 404 || found.status === 409) signing.reload();
      })
      .finally(() => {
        busy.current = false;
        setOpening(null);
      });
  }

  const back = () => (router.canGoBack() ? router.back() : router.replace('/home'));
  if (!loading && !me) return <Redirect href="/sign-in" />;

  const state = signing.state;
  return (
    <Screen title="To sign" top={<BackLink onPress={back} label="Home" />} scroll>
      {problem ? <ErrorText testID="action-error">{problem}</ErrorText> : null}
      {state.status === 'loading' ? <Loading label="Loading what is waiting for you" /> : null}
      {state.status === 'error' ? (
        <View style={styles.stack}>
          <ErrorText>We could not load what is waiting for you. {state.problem.message}</ErrorText>
          <Button label="Try again" variant="quiet" testID="retry" onPress={signing.retry} />
        </View>
      ) : null}
      {state.status === 'ready' ? (
        <View style={styles.stack}>
          {state.refreshProblem && state.refreshProblem.status !== 401 ? (
            <Notice testID="refresh-problem">
              We could not update this just now, so it may be out of date.
            </Notice>
          ) : null}
          {state.data.length === 0 ? (
            <Body testID="nothing-to-sign">
              Nothing is waiting for your signature. When your landlord sends you a lease to sign or
              a notice to acknowledge, it will appear here.
            </Body>
          ) : (
            <>
              <Body>
                Read each document before you sign. To confirm it is you, the signing page sends a
                6-digit code to your phone. Signing a notice acknowledges that you received it; it
                does not mean that you agree with it.
              </Body>
              {state.data.map((item) =>
                isNoticeItem(item) ? (
                  <NoticeItem
                    key={item.signingRequestId}
                    item={item}
                    busy={opening === item.signer.id}
                    onReview={() => review(item)}
                  />
                ) : (
                  <SigningItem
                    key={item.signingRequestId}
                    item={item}
                    busy={opening === item.signer.id}
                    onReview={() => review(item)}
                  />
                ),
              )}
            </>
          )}
          <Button label="Refresh" variant="quiet" testID="refresh" onPress={signing.reload} />
        </View>
      ) : null}
    </Screen>
  );
}

function SigningItem({
  item,
  busy,
  onReview,
}: {
  item: Item;
  busy: boolean;
  onReview: () => void;
}) {
  const canSign = item.status === 'pending' && item.signer.status === 'pending';
  const others = othersOf(item);
  return (
    <Card testID="signing-item" label={item.title} highlight={canSign}>
      <View>
        <Heading>{item.title}</Heading>
        <Small>From {item.landlord.name}</Small>
        {item.tenancy ? (
          <Small>
            {item.tenancy.unitCode}, {item.tenancy.propertyName}
          </Small>
        ) : null}
        {item.sentAt ? <Small>Sent {formatTime(item.sentAt)}</Small> : null}
      </View>

      <View style={styles.own} testID="own-status">
        <Text style={styles.ownLabel}>Your signature</Text>
        {item.signer.status === 'signed' ? (
          <>
            <Badge label="You have signed" tone="ok" />
            {item.signer.signedAt ? <Small>Signed {formatTime(item.signer.signedAt)}</Small> : null}
            <Small>When everyone has signed, your copy will be with your tenancy.</Small>
          </>
        ) : item.signer.status === 'declined' ? (
          <Badge label="You declined to sign" tone="past" />
        ) : item.status === 'pending' ? (
          <Badge label="Waiting for your signature" tone="waiting" />
        ) : (
          <Small>Your landlord is still preparing this lease. Try again in a few minutes.</Small>
        )}
      </View>

      {others.length > 0 ? (
        <View style={styles.others} testID="other-signers">
          <Text style={styles.ownLabel}>Also signing</Text>
          {others.map((signer, index) => (
            <View key={`${signer.roleLabel}-${index}`} style={styles.signer}>
              <Text style={styles.signerName}>
                {signer.name}
                <Text style={styles.signerRole}> · {signer.roleLabel}</Text>
              </Text>
              <Small>{SIGNER_STATUS_LABELS[signer.status]}</Small>
            </View>
          ))}
        </View>
      ) : null}

      {canSign ? (
        <Button label="Review and sign" testID="review-and-sign" busy={busy} onPress={onReview} />
      ) : null}
    </Card>
  );
}

/**
 * A notice to acknowledge (M7 plan 4.5): what it is and when, the statement that signing
 * acknowledges receipt, not agreement, and no way to decline. It is the tenant's own; other
 * recipients are not listed.
 */
function NoticeItem({ item, busy, onReview }: { item: Item; busy: boolean; onReview: () => void }) {
  const notice = item.notice ?? null;
  const canSign = item.status === 'pending' && item.signer.status === 'pending';
  return (
    <Card testID="notice-item" label={item.title} highlight={canSign}>
      <View>
        <Heading>{notice ? `Notice ${notice.number}: ${notice.typeLabel}` : item.title}</Heading>
        <Small>From {item.landlord.name}</Small>
        {item.tenancy ? (
          <Small>
            {item.tenancy.unitCode}, {item.tenancy.propertyName}
          </Small>
        ) : null}
        {notice ? noticeDates(notice).map((line) => <Small key={line}>{line}</Small>) : null}
      </View>
      {notice ? <Body testID="notice-statement">{noticeStatement(notice)}</Body> : null}

      <View style={styles.own} testID="own-status">
        <Text style={styles.ownLabel}>Your acknowledgement</Text>
        {item.signer.status === 'signed' ? (
          <>
            <Badge label="You have acknowledged it" tone="ok" />
            {item.signer.signedAt ? (
              <Small>Acknowledged {formatTime(item.signer.signedAt)}</Small>
            ) : null}
          </>
        ) : item.status === 'pending' ? (
          <Badge label="Waiting for you to acknowledge it" tone="waiting" />
        ) : (
          <Small>Your landlord is still preparing this notice. Try again in a few minutes.</Small>
        )}
      </View>

      {canSign ? (
        <Button
          label="Read and acknowledge"
          testID="acknowledge-notice"
          busy={busy}
          onPress={onReview}
        />
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 16 },
  own: { gap: 6 },
  ownLabel: { fontSize: 13, fontWeight: '600', color: colours.muted, textTransform: 'uppercase' },
  others: { gap: 8 },
  signer: { gap: 2 },
  signerName: { fontSize: 16, color: colours.ink },
  signerRole: { fontSize: 14, color: colours.muted },
});

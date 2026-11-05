import type { TenantConversation } from '@rent/contracts';
import { Redirect, useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatTime } from '../../src/format';
import { conversationsForCache, loadConversations, unreadLabel } from '../../src/messages';
import { useSession } from '../../src/session';
import {
  BackLink,
  Badge,
  Body,
  Button,
  colours,
  ErrorText,
  Loading,
  Notice,
  Screen,
  Small,
} from '../../src/ui';
import { useCachedLoad } from '../../src/use-cached-load';
import { useReloadOnReturn } from '../../src/use-load';

/**
 * Messages (CM-05; M6 plan 4.10): one conversation with each landlord the tenant rents from, never
 * mixed (TL-12). Each shows its last message and how many of the landlord's messages are new.
 * Offline, the list last fetched on this device shows, with when.
 */
export default function Messages() {
  const router = useRouter();
  const { me, loading } = useSession();
  const conversations = useCachedLoad(
    'conversations',
    loadConversations,
    Boolean(me),
    conversationsForCache,
  );
  useReloadOnReturn(conversations.reload);

  const back = () => (router.canGoBack() ? router.back() : router.replace('/home'));
  if (!loading && !me) return <Redirect href="/sign-in" />;

  const view = conversations.view;
  return (
    <Screen title="Messages" top={<BackLink onPress={back} label="Home" />} scroll>
      {view.status === 'loading' ? <Loading label="Loading your messages" /> : null}
      {view.status === 'error' ? (
        <View style={styles.stack}>
          <ErrorText>We could not load your messages. {view.problem.message}</ErrorText>
          <Button label="Try again" variant="quiet" testID="retry" onPress={conversations.retry} />
        </View>
      ) : null}
      {view.status === 'ready' ? (
        <View style={styles.stack}>
          {view.offline ? (
            <Notice testID="offline">
              You are offline. This is the list we last fetched, at {formatTime(view.fetchedAt)}, so
              there may be newer messages.
            </Notice>
          ) : null}
          {view.refreshProblem && view.refreshProblem.status !== 401 ? (
            <Notice testID="refresh-problem">
              We could not update this just now, so there may be newer messages.
            </Notice>
          ) : null}
          {view.data.length === 0 ? (
            <Body testID="no-conversations">
              When you rent from a landlord, you can write to them here.
            </Body>
          ) : (
            view.data.map((conversation) => (
              <ConversationRow
                key={conversation.companyId}
                conversation={conversation}
                onOpen={() => router.push(`/messages/${conversation.companyId}`)}
              />
            ))
          )}
        </View>
      ) : null}
    </Screen>
  );
}

/** One landlord's conversation, in a box of its own (TL-12). */
function ConversationRow({
  conversation,
  onOpen,
}: {
  conversation: TenantConversation;
  onOpen: () => void;
}) {
  const unread = conversation.unreadCount;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Messages with ${conversation.landlordName}${unread > 0 ? `, ${unreadLabel(unread)}` : ''}`}
      testID="conversation-row"
      onPress={onOpen}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.rowTop}>
        <Text style={styles.name}>{conversation.landlordName}</Text>
        {unread > 0 ? <Badge label={unreadLabel(unread)} tone="ok" testID="unread" /> : null}
      </View>
      {conversation.lastMessagePreview ? (
        <Text style={styles.preview} numberOfLines={2}>
          {conversation.lastMessagePreview}
        </Text>
      ) : (
        <Small>No messages yet. Write to {conversation.landlordName}.</Small>
      )}
      {conversation.lastMessageAt ? <Small>{formatTime(conversation.lastMessageAt)}</Small> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 16 },
  row: {
    borderWidth: 1,
    borderColor: colours.line,
    borderRadius: 12,
    padding: 14,
    gap: 6,
    backgroundColor: colours.surface,
  },
  pressed: { opacity: 0.7 },
  rowTop: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  name: { fontSize: 17, fontWeight: '700', color: colours.ink },
  preview: { fontSize: 16, lineHeight: 22, color: colours.ink },
});

import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { Tone } from './format';

export const colours = {
  ink: '#111827',
  muted: '#4B5563',
  line: '#D1D5DB',
  brand: '#0F766E',
  brandInk: '#FFFFFF',
  danger: '#B91C1C',
  surface: '#FFFFFF',
  page: '#F9FAFB',
  okInk: '#065F46',
  okFill: '#D1FAE5',
  waitInk: '#92400E',
  waitFill: '#FEF3C7',
  pastInk: '#374151',
  pastFill: '#E5E7EB',
};

const TONES: Record<Tone, { readonly ink: string; readonly fill: string }> = {
  ok: { ink: colours.okInk, fill: colours.okFill },
  waiting: { ink: colours.waitInk, fill: colours.waitFill },
  past: { ink: colours.pastInk, fill: colours.pastFill },
};

/** A screen with its title. `scroll` for screens whose content can outgrow a 5-inch phone. */
export function Screen({
  title,
  children,
  scroll,
  top,
}: {
  title: string;
  children: ReactNode;
  scroll?: boolean;
  /** Shown above the title, such as a Back link. */
  top?: ReactNode;
}) {
  const heading = (
    <Text accessibilityRole="header" style={styles.title}>
      {title}
    </Text>
  );
  if (!scroll) {
    return (
      <SafeAreaView style={styles.page}>
        <View style={styles.body}>
          {top}
          {heading}
          {children}
        </View>
      </SafeAreaView>
    );
  }
  return (
    <SafeAreaView style={styles.page}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollBody}>
        {top}
        {heading}
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function Body({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <Text style={styles.text} testID={testID}>
      {children}
    </Text>
  );
}

/** Smaller, quieter text: a date sent, a hint. */
export function Small({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <Text style={styles.small} testID={testID}>
      {children}
    </Text>
  );
}

export function Heading({ children }: { children: ReactNode }) {
  return (
    <Text accessibilityRole="header" style={styles.heading}>
      {children}
    </Text>
  );
}

export function Field({ label, ...input }: TextInputProps & { label: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colours.muted}
        style={styles.input}
        {...input}
      />
    </View>
  );
}

export function Button({
  label,
  onPress,
  busy,
  testID,
  variant = 'primary',
}: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  testID?: string;
  variant?: 'primary' | 'quiet';
}) {
  const primary = variant === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      // Its name stays while it works and shows a spinner instead of its words (NFR-A11Y).
      accessibilityLabel={label}
      accessibilityState={{ busy: Boolean(busy), disabled: Boolean(busy) }}
      disabled={busy}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        primary ? styles.primary : styles.quiet,
        pressed && styles.pressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={primary ? colours.brandInk : colours.brand} />
      ) : (
        <Text style={primary ? styles.primaryText : styles.quietText}>{label}</Text>
      )}
    </Pressable>
  );
}

/** "‹ Back" at the top of a screen reached from another one. */
export function BackLink({ onPress, label = 'Back' }: { onPress: () => void; label?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      testID="back"
      hitSlop={12}
      style={({ pressed }) => [styles.back, pressed && styles.pressed]}
    >
      <Text style={styles.quietText}>‹ {label}</Text>
    </Pressable>
  );
}

export function ErrorText({
  children,
  testID = 'error',
}: {
  children: ReactNode;
  testID?: string;
}) {
  return (
    <Text accessibilityRole="alert" testID={testID} style={styles.error}>
      {children}
    </Text>
  );
}

/** A box of related content, such as one landlord's tenancies or one lease to sign. */
export function Card({
  children,
  testID,
  label,
  highlight,
}: {
  children: ReactNode;
  testID?: string;
  /** Names the group for screen readers. */
  label?: string;
  highlight?: boolean;
}) {
  return (
    <View
      testID={testID}
      role={label ? 'group' : undefined}
      aria-label={label}
      style={[styles.card, highlight && styles.cardHighlight]}
    >
      {children}
    </View>
  );
}

export function Badge({ label, tone, testID }: { label: string; tone: Tone; testID?: string }) {
  const colour = TONES[tone];
  return (
    <View style={[styles.badge, { backgroundColor: colour.fill }]} testID={testID}>
      <Text style={[styles.badgeText, { color: colour.ink }]}>{label}</Text>
    </View>
  );
}

/** A label and its value, stacked so long values wrap on a narrow phone. */
export function Fact({
  label,
  value,
  testID,
}: {
  label: string;
  /** One line, or one line each. */
  value: string | readonly string[];
  testID?: string;
}) {
  const lines = typeof value === 'string' ? [value] : value;
  return (
    <View style={styles.fact} testID={testID}>
      <Text style={styles.factLabel}>{label}</Text>
      {lines.map((line, index) => (
        <Text key={index} style={styles.factValue}>
          {line}
        </Text>
      ))}
    </View>
  );
}

/** A message that does not block the screen, such as "the session has ended". */
export function Notice({
  children,
  testID,
  tone = 'waiting',
}: {
  children: ReactNode;
  testID?: string;
  tone?: Tone;
}) {
  const colour = TONES[tone];
  return (
    <View
      accessibilityRole="alert"
      testID={testID}
      style={[styles.notice, { backgroundColor: colour.fill }]}
    >
      <Text style={[styles.noticeText, { color: colour.ink }]}>{children}</Text>
    </View>
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <View style={styles.loading} testID="loading">
      <ActivityIndicator accessibilityLabel={label} color={colours.brand} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colours.page },
  body: { flex: 1, padding: 20, gap: 16, maxWidth: 480, width: '100%', alignSelf: 'center' },
  scroll: { flex: 1 },
  scrollBody: {
    padding: 20,
    paddingBottom: 40,
    gap: 16,
    maxWidth: 480,
    width: '100%',
    alignSelf: 'center',
  },
  title: { fontSize: 26, fontWeight: '700', color: colours.ink, marginTop: 12 },
  heading: { fontSize: 18, fontWeight: '700', color: colours.ink },
  text: { fontSize: 16, lineHeight: 24, color: colours.muted },
  small: { fontSize: 14, lineHeight: 20, color: colours.muted },
  field: { gap: 6 },
  label: { fontSize: 15, fontWeight: '600', color: colours.ink },
  input: {
    borderWidth: 1,
    borderColor: colours.line,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 18,
    color: colours.ink,
    backgroundColor: colours.surface,
  },
  button: {
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    minHeight: 50,
    justifyContent: 'center',
  },
  primary: { backgroundColor: colours.brand },
  quiet: { backgroundColor: 'transparent' },
  pressed: { opacity: 0.85 },
  primaryText: { color: colours.brandInk, fontSize: 17, fontWeight: '600' },
  quietText: { color: colours.brand, fontSize: 16, fontWeight: '600' },
  back: { alignSelf: 'flex-start', paddingVertical: 6, minHeight: 32, justifyContent: 'center' },
  error: { color: colours.danger, fontSize: 15 },
  card: {
    borderWidth: 1,
    borderColor: colours.line,
    borderRadius: 12,
    padding: 14,
    gap: 10,
    backgroundColor: colours.surface,
  },
  cardHighlight: { borderColor: colours.brand, borderWidth: 2 },
  badge: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  badgeText: { fontSize: 13, fontWeight: '600' },
  fact: { gap: 2 },
  factLabel: { fontSize: 13, fontWeight: '600', color: colours.muted, textTransform: 'uppercase' },
  factValue: { fontSize: 16, lineHeight: 22, color: colours.ink },
  notice: { borderRadius: 10, padding: 12 },
  noticeText: { fontSize: 15, lineHeight: 21 },
  loading: { paddingVertical: 24, alignItems: 'center' },
});

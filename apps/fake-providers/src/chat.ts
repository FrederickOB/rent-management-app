import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { e164, escapeHtml, htmlPage } from './shared';
import type { FakeStore } from './store';

/**
 * A small development page for chatting as a tenant on the fake WhatsApp number (M6 plan 4.14):
 * what the platform sent this phone, what the phone wrote, and a box to write more. Messages go
 * through the same simulated webhook the tests use.
 */
const form = z.object({
  phone: e164,
  text: z.string().max(4096).optional(),
  choiceId: z.string().max(256).optional(),
});

export function registerChat(app: FastifyInstance, store: FakeStore): void {
  app.get('/chat', async (request, reply) => {
    const phone = z.object({ phone: e164 }).safeParse(request.query);
    if (!phone.success)
      return htmlPage(
        reply,
        'Fake WhatsApp chat',
        `<h1>Chat as a tenant</h1><form method="get" action="/chat"><label>Phone (E.164) <input name="phone" value="+233200000021"></label> <button>Open</button></form><p class="note">Use a seeded tenant's number, for example +233 20 000 0021.</p>`,
      );
    const number = phone.data.phone;
    const sent = store.messages
      .filter((m) => m.channel === 'whatsapp' && m.to === number)
      .map((m) => ({
        at: m.at,
        who: 'Platform',
        body: m.body,
        choices: (m.meta?.choices ?? []) as { id: string; title: string }[],
      }));
    const written = store.inbound
      .filter((m) => m.channel === 'whatsapp' && m.from === number)
      .map((m) => ({
        at: m.at,
        who: 'Tenant',
        body: m.body,
        choices: [] as { id: string; title: string }[],
      }));
    const thread = [...sent, ...written].sort((a, b) => (a.at < b.at ? -1 : 1));
    const last = sent[0];
    const buttons = (last?.choices ?? [])
      .map(
        (c) =>
          `<form method="post" action="/chat" style="display:inline"><input type="hidden" name="phone" value="${escapeHtml(number)}"><input type="hidden" name="choiceId" value="${escapeHtml(c.id)}"><input type="hidden" name="text" value="${escapeHtml(c.title)}"><button>${escapeHtml(c.title)}</button></form>`,
      )
      .join('');
    const rows = thread
      .map(
        (m) =>
          `<tr><td>${escapeHtml(m.at)}</td><td>${m.who}</td><td>${escapeHtml(m.body)}</td></tr>`,
      )
      .join('');
    return htmlPage(
      reply,
      `Chat ${number}`,
      `<h1>WhatsApp as ${escapeHtml(number)}</h1><p class="note">Times are UTC. Refresh to see replies.</p>
<table><thead><tr><th>Time</th><th>From</th><th>Message</th></tr></thead><tbody>${rows || '<tr><td colspan="3">Nothing yet.</td></tr>'}</tbody></table>
<p>${buttons}</p>
<form method="post" action="/chat"><input type="hidden" name="phone" value="${escapeHtml(number)}"><input name="text" size="60" autofocus> <button>Send</button></form>`,
    );
  });

  app.post('/chat', async (request, reply) => {
    const parsed = form.safeParse(request.body);
    if (!parsed.success || (!parsed.data.text && !parsed.data.choiceId))
      return reply.code(400).send({ error: 'phone and text required' });
    await app.inject({
      method: 'POST',
      url: '/whatsapp/_test/inbound',
      payload: {
        from: parsed.data.phone,
        ...(parsed.data.text ? { text: parsed.data.text } : {}),
        ...(parsed.data.choiceId ? { choiceId: parsed.data.choiceId } : {}),
      },
    });
    return reply.redirect(`/chat?phone=${encodeURIComponent(parsed.data.phone)}`, 303);
  });
}

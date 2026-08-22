import { describe, expect, it } from 'vitest';
import { formatTelegramHtml, publishToTelegram, splitMessage } from './telegram.js';

const multiPartContent = `${'A'.repeat(3900)}\n\n2. ${'B'.repeat(500)}`;

describe('Telegram publisher', () => {
  it('hides canonical URL lines behind a safe Source link', () => {
    const html = formatTelegramHtml([
      '#новости  1. AI & automation < launch',
      'https://example.com/story?a=1&b=2',
      '',
      '#ИИ #технологии',
    ].join('\n'));

    expect(html).toContain('AI &amp; automation &lt; launch');
    expect(html).toContain('<a href="https://example.com/story?a=1&amp;b=2">источник</a>');
    expect(html).not.toContain('\nhttps://example.com/story');
  });

  it('confirms all chunks before reporting success', async () => {
    const chunks = splitMessage(multiPartContent);
    const sent = [];
    const result = await publishToTelegram('token', 'chat', multiPartContent, {
      delayMs: 0,
      send: async (_token, _chat, text) => {
        sent.push(text);
        return { ok: true, messageId: sent.length };
      },
    });

    expect(chunks).toHaveLength(2);
    expect(sent).toHaveLength(2);
    expect(result).toMatchObject({
      ok: true,
      status: 'published',
      totalMessages: 2,
      messageIds: ['1', '2'],
    });
  });

  it('returns partial instead of success when a later chunk fails', async () => {
    let call = 0;
    const result = await publishToTelegram('token', 'chat', multiPartContent, {
      delayMs: 0,
      send: async () => {
        call += 1;
        return call === 1
          ? { ok: true, messageId: 101 }
          : { ok: false, retrySafe: true, deliveryUnknown: false, error: 'Forbidden' };
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'partial',
      retrySafe: false,
      messageIds: ['101'],
      error: 'Forbidden',
    });
  });

  it('treats an unknown delivery outcome as partial and non-retryable', async () => {
    const result = await publishToTelegram('token', 'chat', 'single message', {
      delayMs: 0,
      send: async () => ({
        ok: false,
        retrySafe: false,
        deliveryUnknown: true,
        error: 'connection reset',
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'partial',
      retrySafe: false,
      deliveryUnknown: true,
    });
  });

  it('honors Telegram retry_after before retrying a rate-limited chunk', async () => {
    let call = 0;
    const result = await publishToTelegram('token', 'chat', 'single message', {
      delayMs: 0,
      maxRateLimitRetries: 2,
      send: async () => {
        call += 1;
        return call === 1
          ? { ok: false, retrySafe: true, retryAfterSeconds: 0.001, error: 'Too Many Requests' }
          : { ok: true, messageId: 202 };
      },
    });

    expect(call).toBe(2);
    expect(result).toMatchObject({ ok: true, messageIds: ['202'] });
  });
});

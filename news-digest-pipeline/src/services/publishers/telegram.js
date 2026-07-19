/**
 * Telegram publisher.
 * Sends content to a Telegram chat/channel via Bot API and never reports a
 * partial multi-message send as a successful publication.
 */

const TG_MAX_LENGTH = 4096;
const INTER_MESSAGE_DELAY = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Split digest text into chunks that fit Telegram's 4096 character limit.
 * Splits at numbered item boundaries when possible, preserving whole items.
 */
export function splitMessage(text) {
  const value = String(text || '');
  if (value.length <= TG_MAX_LENGTH) return [value];

  const chunks = [];
  let remaining = value;

  while (remaining.length > TG_MAX_LENGTH) {
    let cutAt = -1;
    const searchArea = remaining.slice(0, TG_MAX_LENGTH);
    const itemPattern = /\n\n\d+\.\s/g;
    let match;
    while ((match = itemPattern.exec(searchArea)) !== null) {
      cutAt = match.index;
    }

    if (cutAt <= 0) {
      const lastBreak = searchArea.lastIndexOf('\n\n');
      if (lastBreak > 0) cutAt = lastBreak;
    }
    if (cutAt <= 0) cutAt = TG_MAX_LENGTH;

    chunks.push(remaining.slice(0, cutAt).trim());
    remaining = remaining.slice(cutAt).trim();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

async function sendOne(botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
    });

    let data;
    try {
      data = await response.json();
    } catch {
      return {
        ok: false,
        retrySafe: false,
        deliveryUnknown: true,
        error: `Telegram returned non-JSON HTTP ${response.status}`,
      };
    }

    if (!response.ok || !data.ok) {
      return {
        ok: false,
        retrySafe: response.status === 429 || response.status >= 500,
        retryAfterSeconds: Number(data?.parameters?.retry_after) || 0,
        deliveryUnknown: false,
        error: data?.description || 'Telegram HTTP ' + response.status,
      };
    }

    return { ok: true, messageId: String(data.result.message_id) };
  } catch (error) {
    // A network failure may occur after Telegram accepted the request, so do
    // not automatically retry it and risk duplicating a channel post.
    return {
      ok: false,
      retrySafe: false,
      deliveryUnknown: true,
      error: error.message || 'Telegram network error',
    };
  }
}

/**
 * @param {string} botToken Telegram bot token
 * @param {string|number} chatId Telegram channel/chat id
 * @param {string} content Digest content
 * @param {{send?: Function, delayMs?: number}} options Test injection hooks
 */
export async function publishToTelegram(botToken, chatId, content, options = {}) {
  const send = options.send || sendOne;
  const delayMs = options.delayMs ?? INTER_MESSAGE_DELAY;
  const maxRateLimitRetries = options.maxRateLimitRetries ?? 2;

  if (!botToken || !chatId) {
    return {
      ok: false,
      status: 'failed',
      retrySafe: true,
      deliveryUnknown: false,
      totalMessages: 0,
      messageIds: [],
      error: 'Missing Telegram bot token or publish chat id',
    };
  }

  const chunks = splitMessage(content);
  const messageIds = [];
  console.log(`[telegram] Sending ${chunks.length} message(s) to ${chatId}`);

  for (let index = 0; index < chunks.length; index += 1) {
    let result;
    for (let retry = 0; retry <= maxRateLimitRetries; retry += 1) {
      result = await send(botToken, chatId, chunks[index]);
      if (result?.ok) break;
      if (!result?.retryAfterSeconds || retry === maxRateLimitRetries) break;
      await sleep(result.retryAfterSeconds * 1000);
    }

    if (!result?.ok) {
      const partial = messageIds.length > 0 || Boolean(result?.deliveryUnknown);
      const status = partial ? 'partial' : 'failed';
      const error = result?.error || 'Telegram did not confirm delivery';
      console.error(`[telegram] ${status} publish: ${error}`);
      return {
        ok: false,
        status,
        retrySafe: !partial && result?.retrySafe === true,
        deliveryUnknown: Boolean(result?.deliveryUnknown),
        messageId: messageIds[0] || null,
        messageIds,
        totalMessages: chunks.length,
        error,
      };
    }

    messageIds.push(String(result.messageId));
    if (index < chunks.length - 1 && delayMs > 0) await sleep(delayMs);
  }

  return {
    ok: true,
    status: 'published',
    retrySafe: false,
    deliveryUnknown: false,
    messageId: messageIds[0],
    messageIds,
    totalMessages: chunks.length,
    error: null,
  };
}

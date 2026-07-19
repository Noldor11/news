import { publishToFacebook } from './facebook.js';
import { publishToTelegram } from './telegram.js';
import { publishToYouTube } from './youtube.js';
import { updateDigest } from '../../db/index.js';

function telegramFailure(status, error, retrySafe = false) {
  return {
    ok: false,
    status,
    retrySafe,
    deliveryUnknown: false,
    messageId: null,
    messageIds: [],
    totalMessages: 0,
    error,
  };
}

function hasTelegramDeliveryRecord(digest) {
  if (digest.telegram_message_id) return true;
  try {
    const messageIds = JSON.parse(digest.telegram_message_ids || '[]');
    return Array.isArray(messageIds) && messageIds.length > 0;
  } catch {
    return Boolean(digest.telegram_message_ids);
  }
}

/**
 * Publish a digest to selected platforms. Telegram is handled first because it
 * is the authoritative delivery target. A partial Telegram delivery is stored
 * as a terminal state and never presented as a successful publication.
 */
export async function publishDigest(digest, config, platforms) {
  const all = !platforms || !Array.isArray(platforms) || platforms.length === 0;
  const shouldPublish = (name) => all || platforms.includes(name);
  const results = { facebook: null, telegram: null, youtube: null };
  const shouldTelegram = shouldPublish('telegram');

  if (shouldTelegram) {
    if (digest.status === 'publish_partial' || hasTelegramDeliveryRecord(digest)) {
      results.telegram = telegramFailure(
        'blocked',
        'Telegram publication already has a recorded delivery state; refusing to risk a duplicate post.'
      );
      return results;
    }

    const tgPublishChat = config.telegramPublishChatId || config.telegramChatId;
    if (!config.telegramBotToken || !tgPublishChat) {
      results.telegram = telegramFailure(
        'failed',
        'Missing Telegram bot token or publish chat id.',
        true
      );
    } else {
      results.telegram = await publishToTelegram(
        config.telegramBotToken,
        tgPublishChat,
        digest.content,
      );
    }

    const telegramFields = {
      telegram_message_ids: JSON.stringify(results.telegram.messageIds || []),
      publication_error: results.telegram.error || null,
    };
    if (results.telegram.messageId) {
      telegramFields.telegram_message_id = String(results.telegram.messageId);
    }

    if (!results.telegram.ok) {
      telegramFields.status = results.telegram.status === 'partial'
        ? 'publish_partial'
        : 'publish_failed';
      updateDigest(digest.id, telegramFields);
      return results;
    }

    updateDigest(digest.id, {
      ...telegramFields,
      status: 'published',
      published_at: new Date().toISOString(),
    });
  }

  const updateFields = {};

  if (shouldPublish('facebook') && config.facebookPageAccessToken && config.facebookPageId) {
    results.facebook = await publishToFacebook(
      config.facebookPageAccessToken,
      config.facebookPageId,
      digest.content,
    );
    if (results.facebook?.postId) updateFields.facebook_post_id = results.facebook.postId;
  }

  if (shouldPublish('youtube') && config.youtubeAccessToken && config.youtubeChannelId) {
    results.youtube = await publishToYouTube(
      config.youtubeAccessToken,
      config.youtubeChannelId,
      digest.content,
    );
    if (results.youtube?.postId) updateFields.youtube_post_id = results.youtube.postId;
  }

  if (Object.keys(updateFields).length > 0) {
    updateFields.status = 'published';
    updateFields.published_at = new Date().toISOString();
    updateDigest(digest.id, updateFields);
  }

  return results;
}
import config from '../config.js';
import { collectWeeklyMarketplace } from './apify-marketplace.js';
import { publishToTelegram } from './publishers/telegram.js';

function weekRange(weekKey) {
  const start = new Date(`${weekKey}T12:00:00.000Z`);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const formatter = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'UTC',
    day: '2-digit',
    month: '2-digit',
  });
  return `${formatter.format(start)}-${formatter.format(end)}`;
}

function renderUpwork(result) {
  if (!result?.item) return ['UPWORK', 'Данные за неделю получить не удалось.'];
  const lines = ['UPWORK', result.item.summary];
  if (result.highlights?.length) {
    lines.push('', 'Самые конкурентные вакансии по числу заявок:');
    result.highlights.forEach((item, index) => {
      lines.push(
        `${index + 1}. ${item.title}`,
        `${item.applicants} заявок, ${item.budget}`,
        item.url,
      );
    });
  }
  return lines;
}

function renderFiverr(result) {
  if (!result?.item) return ['FIVERR', 'Данные за неделю получить не удалось.'];
  const lines = ['FIVERR', result.item.summary];
  if (result.highlights?.length) {
    lines.push('', 'Самые заметные гиги по накопленным отзывам:');
    result.highlights.forEach((item, index) => {
      const details = [
        `${item.reviews} отзывов`,
        item.priceFrom ? `цена от ${item.priceFrom}` : null,
        item.sellerLevel || null,
      ].filter(Boolean).join(', ');
      lines.push(`${index + 1}. ${item.title}`, details, item.url);
    });
  }
  return lines;
}

export function formatWeeklyMarketplaceReport(result) {
  const lines = [
    '#рынок_фриланса',
    `GDN: недельный срез Upwork и Fiverr за ${weekRange(result.weekKey)}`,
    '',
    ...renderUpwork(result.upwork),
    '',
    ...renderFiverr(result.fiverr),
    '',
    'Важно: заявки Upwork показывают конкуренцию вокруг вакансий. Отзывы Fiverr показывают накопленную репутацию продавцов, а не число заказов только за эту неделю.',
  ];

  if (result.errors?.length) {
    lines.push('', `Частичные ошибки сбора: ${result.errors.join('; ')}`);
  }
  return lines.join('\n').trim();
}

export async function runWeeklyMarketplaceReport({
  appConfig = config,
  now = new Date(),
  collect = collectWeeklyMarketplace,
  publish = publishToTelegram,
} = {}) {
  const collected = await collect(appConfig, { now });
  if (collected.disabled) {
    const error = new Error('Weekly marketplace research is disabled');
    error.retryable = false;
    throw error;
  }
  if (!collected.upwork && !collected.fiverr) {
    const missing = [
      !collected.upwork ? 'Upwork' : null,
      !collected.fiverr ? 'Fiverr' : null,
    ].filter(Boolean).join(', ');
    const error = new Error(`Weekly marketplace research is incomplete (${missing}): ${collected.errors.join('; ') || 'no usable data'}`);
    error.metrics = { sourceErrors: collected.errors, diagnostics: collected.diagnostics };
    throw error;
  }

  const content = formatWeeklyMarketplaceReport(collected);
  const chatId = appConfig.telegramPublishChatId || appConfig.telegramChatId;
  const telegram = await publish(appConfig.telegramBotToken, chatId, content);
  return {
    ok: Boolean(telegram?.ok),
    weekKey: collected.weekKey,
    content,
    upworkItems: collected.upwork?.itemCount || 0,
    fiverrItems: collected.fiverr?.itemCount || 0,
    cached: {
      upwork: Boolean(collected.upwork?.cached),
      fiverr: Boolean(collected.fiverr?.cached),
    },
    degraded: Boolean(collected.errors?.length || !collected.upwork || !collected.fiverr),
    sourceErrors: collected.errors || [],
    sourceDiagnostics: collected.diagnostics || [],
    telegram,
  };
}

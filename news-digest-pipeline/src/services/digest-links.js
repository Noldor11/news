const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;
const ITEM_PATTERN = /^(?:#новости\s+)?(\d+)\.\s+/gim;

function cleanText(value, fallback) {
  const withoutUrls = String(value || '')
    .replace(URL_PATTERN, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return withoutUrls || String(fallback || '').trim();
}

function renderFallback(articles, hashtagsSuffix) {
  const items = articles.map((article, index) => {
    const text = cleanText(article.commentary, article.title || 'No commentary available.');
    const prefix = index === 0 ? '#новости  1.' : `${index + 1}.`;
    return `${prefix} ${text}\n${article.url}`;
  });
  return `${items.join('\n\n')}${hashtagsSuffix ? `\n\n${hashtagsSuffix}` : ''}`.trim();
}

/**
 * The final LLM is allowed to write prose, not source URLs. This guarantees
 * that every Telegram item contains the exact URL collected from its RSS feed.
 */
export function enforceCanonicalDigestLinks(content, articles, hashtagsSuffix = '') {
  if (!Array.isArray(articles) || articles.length === 0) return String(content || '').trim();

  const suffix = String(hashtagsSuffix || '').trim();
  let draft = String(content || '').trim();
  if (suffix && draft.endsWith(suffix)) {
    draft = draft.slice(0, -suffix.length).trim();
  }

  const markers = [...draft.matchAll(ITEM_PATTERN)];
  const isExpectedOrder = markers.length === articles.length
    && markers.every((match, index) => Number(match[1]) === index + 1);

  if (!isExpectedOrder) return renderFallback(articles, suffix);

  const rendered = articles.map((article, index) => {
    const start = markers[index].index + markers[index][0].length;
    const end = index + 1 < markers.length ? markers[index + 1].index : draft.length;
    const text = cleanText(draft.slice(start, end), article.commentary || article.title);
    const prefix = index === 0 ? '#новости  1.' : `${index + 1}.`;
    return `${prefix} ${text}\n${article.url}`;
  });

  return `${rendered.join('\n\n')}${suffix ? `\n\n${suffix}` : ''}`.trim();
}
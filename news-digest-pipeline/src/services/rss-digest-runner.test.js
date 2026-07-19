import { describe, expect, it } from 'vitest';
import {
  classifyArticleCount,
  isFreshTechItem,
  resolveRssSettings,
  scoreItem,
  selectCandidatesWithFallback,
  selectDiverseCandidates,
} from './rss-digest-runner.js';

const freshDate = new Date(Date.now() - 60 * 60 * 1000).toUTCString();
const baseItem = (overrides = {}) => ({
  title: 'AI platform release',
  summary: 'OpenAI and developers released a new AI platform with model tooling and API security details.',
  source: 'Source A',
  url: `https://example.com/${Math.random()}`,
  publishedAt: freshDate,
  ...overrides,
});

describe('RSS selection quality gates', () => {
  it('uses the 15-17 fresh article policy by default', () => {
    expect(resolveRssSettings({})).toMatchObject({
      minArticles: 15,
      hardMinArticles: 8,
      maxArticles: 17,
      maxAgeHours: 36,
      fallbackMaxAgeHours: 72,
      maxPerSource: 3,
      fetchRetries: 2,
    });
  });

  it('publishes 8-14 items as degraded instead of dropping the whole day', () => {
    const settings = resolveRssSettings({
      minArticlesPerDigest: 15,
      hardMinArticlesPerDigest: 8,
      maxArticlesPerDigest: 17,
    });

    expect(classifyArticleCount(17, settings)).toBe('full');
    expect(classifyArticleCount(13, settings)).toBe('degraded');
    expect(classifyArticleCount(7, settings)).toBe('insufficient');
  });

  it('expands to the 72-hour fallback only when the hard floor is missed', () => {
    const settings = resolveRssSettings({
      minArticlesPerDigest: 3,
      hardMinArticlesPerDigest: 2,
      maxArticlesPerDigest: 3,
      rssMaxArticleAgeHours: 36,
      rssFallbackMaxArticleAgeHours: 72,
      rssMaxArticlesPerSource: 3,
    });
    const result = selectCandidatesWithFallback([
      baseItem({ url: 'https://fresh.example/1' }),
      baseItem({
        url: 'https://older.example/2',
        title: 'Anthropic publishes an AI model update',
        publishedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toUTCString(),
      }),
    ], settings);

    expect(result.fallbackUsed).toBe(true);
    expect(result.effectiveMaxAgeHours).toBe(72);
    expect(result.candidates).toHaveLength(2);
  });

  it('rejects stale and primarily political candidates', () => {
    const stale = scoreItem(baseItem({
      publishedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toUTCString(),
    }), 36);
    const political = scoreItem(baseItem({
      title: 'President election war update mentions AI once',
      summary: 'Government election politics and military war coverage with a brief AI reference.',
    }), 36);
    const politicalMention = scoreItem(baseItem({
      title: 'President comments on AI',
      summary: 'A brief comment follows the meeting.',
    }), 36);

    expect(isFreshTechItem(stale, 36)).toBe(false);
    expect(isFreshTechItem(political, 36)).toBe(false);
    expect(isFreshTechItem(politicalMention, 36)).toBe(false);
  });

  it('caps one source and removes near-identical headlines', () => {
    const selected = selectDiverseCandidates([
      baseItem({ url: 'https://a.example/1', title: 'OpenAI releases a new coding model', source: 'Source A' }),
      baseItem({ url: 'https://a.example/2', title: 'OpenAI releases a new coding model for developers', source: 'Source B' }),
      baseItem({ url: 'https://a.example/3', title: 'NVIDIA launches GPU architecture for AI', source: 'Source A' }),
      baseItem({ url: 'https://a.example/4', title: 'Anthropic publishes Claude API security update', source: 'Source A' }),
      baseItem({ url: 'https://b.example/5', title: 'Google DeepMind releases robot training research', source: 'Source B' }),
    ], { maxAgeHours: 36, maxPerSource: 2, limit: 10 });

    expect(selected.filter((item) => ['https://a.example/1', 'https://a.example/2'].includes(item.url))).toHaveLength(1);
    expect(selected.filter((item) => item.source === 'Source A')).toHaveLength(2);
    expect(selected).toHaveLength(4);
  });
  it('excludes already used URLs before applying source caps', () => {
    const selected = selectDiverseCandidates([
      baseItem({ url: 'https://a.example/used-1', title: 'OpenAI announces a new model', source: 'Source A' }),
      baseItem({ url: 'https://a.example/used-2', title: 'NVIDIA ships an AI accelerator', source: 'Source A' }),
      baseItem({ url: 'https://a.example/fresh-1', title: 'Anthropic updates enterprise controls', source: 'Source A' }),
      baseItem({ url: 'https://a.example/fresh-2', title: 'Google publishes robotics research', source: 'Source A' }),
      baseItem({ url: 'https://b.example/used-1', title: 'Microsoft revises cloud AI tooling', source: 'Source B' }),
      baseItem({ url: 'https://b.example/fresh-1', title: 'AWS expands machine learning service', source: 'Source B' }),
    ], {
      maxAgeHours: 36,
      fallbackMaxAgeHours: 72,
      maxPerSource: 2,
      limit: 10,
      excludedUrls: new Set([
        'https://a.example/used-1',
        'https://a.example/used-2',
        'https://b.example/used-1',
      ]),
    });

    expect(selected).toHaveLength(3);
    expect(selected.map((item) => item.url)).toEqual(expect.arrayContaining([
      'https://a.example/fresh-1',
      'https://a.example/fresh-2',
      'https://b.example/fresh-1',
    ]));
  });
});

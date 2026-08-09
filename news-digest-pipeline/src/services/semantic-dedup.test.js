import { describe, expect, it } from 'vitest';
import { eventSimilarity } from './rss-digest-runner.js';
import {
  buildSemanticPairs,
  resolveHistoricalDuplicates,
} from './semantic-dedup.js';

const item = (overrides = {}) => ({
  title: 'Technology news',
  summary: 'A concrete technology event with companies, actions, and results.',
  url: `https://example.com/${Math.random()}`,
  publishedAt: new Date().toISOString(),
  ...overrides,
});

describe('update-aware semantic deduplication', () => {
  it('sends paraphrased versions of the same event to semantic review', () => {
    const pairs = buildSemanticPairs([
      item({
        title: 'Google Assistant will disappear from your phone next month',
        summary: 'Google is removing Assistant from Android phones in September.',
      }),
    ], [
      item({
        title: 'Google plans to kill Assistant on your phone on September 4',
        summary: 'Google set September 4 as the date for removing Assistant from phones.',
      }),
    ], eventSimilarity, 10);

    expect(pairs).toHaveLength(1);
    expect(pairs[0].similarity.sharedTitleTokens).toBeGreaterThanOrEqual(2);
  });

  it('blocks a semantic duplicate but keeps a material follow-up update', async () => {
    const candidates = [
      item({
        title: 'Google Assistant will disappear from your phone next month',
        summary: 'Google is removing Assistant from Android phones in September.',
      }),
      item({
        title: 'OpenAI drags Apple lawsuit into the court of public opinion',
        summary: 'OpenAI published a new formal response with additional allegations and evidence.',
      }),
    ];
    const prior = [
      item({
        title: 'Google plans to kill Assistant on your phone on September 4',
        summary: 'Google set September 4 as the date for removing Assistant from phones.',
      }),
      item({
        title: 'OpenAI says Apple trade secrets lawsuit is rotten to its core',
        summary: 'Apple filed a trade secrets lawsuit and OpenAI rejected its initial claims.',
      }),
    ];
    const classifyPairs = async (_config, pairs) => ({
      decisions: pairs.map((pair) => ({
        id: pair.id,
        verdict: pair.candidate.title.startsWith('Google') ? 'duplicate' : 'update',
        reason: 'test verdict',
      })),
      usage: { inputTokens: 100, outputTokens: 20 },
    });

    const result = await resolveHistoricalDuplicates({
      candidates,
      priorArticles: prior,
      similarityFn: eventSimilarity,
      appConfig: { semanticDedupEnabled: true },
      classifyPairs,
      maxPairs: 10,
    });

    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].title).toContain('Google Assistant');
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0]).toMatchObject({
      title: expect.stringContaining('OpenAI'),
      semanticVerdict: 'update',
    });
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
  });

  it('allows a meaningful update even when the canonical URL did not change', async () => {
    const url = 'https://example.com/live-story';
    const result = await resolveHistoricalDuplicates({
      candidates: [item({
        url,
        title: 'Company investigation reaches a final decision',
        summary: 'The regulator issued a final decision and a new fine today.',
      })],
      priorArticles: [item({
        url,
        title: 'Company investigation begins',
        summary: 'The regulator opened an investigation last week.',
      })],
      similarityFn: eventSimilarity,
      appConfig: { semanticDedupEnabled: true },
      classifyPairs: async (_config, pairs) => ({
        decisions: pairs.map((pair) => ({ id: pair.id, verdict: 'update', reason: 'new final decision' })),
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });

    expect(result.rejected).toHaveLength(0);
    expect(result.selected[0].semanticVerdict).toBe('update');
  });

  it('collapses an ambiguous same-batch paraphrase through the semantic verdict', async () => {
    const result = await resolveHistoricalDuplicates({
      candidates: [
        item({
          title: 'Hugging Face is being used to easily undress women and children',
          summary: 'Researchers found nonconsensual explicit deepfakes made with image editing models.',
        }),
        item({
          title: 'Hugging Face Has a Deepfake Nudes Problem',
          summary: 'Researchers tested image editors and produced nonconsensual deepfake nudes.',
        }),
      ],
      priorArticles: [],
      similarityFn: eventSimilarity,
      appConfig: { semanticDedupEnabled: true },
      classifyPairs: async (_config, pairs) => ({
        decisions: pairs.map((pair) => ({ id: pair.id, verdict: 'duplicate', reason: 'same incident' })),
        usage: { inputTokens: 20, outputTokens: 5 },
      }),
    });

    expect(result.selected).toHaveLength(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].duplicateReason).toBe('semantic-batch');
  });
});

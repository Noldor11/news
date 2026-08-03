import { describe, expect, it } from 'vitest';
import {
  classifyArticleCount,
  isGadgetItem,
  isFreshTechItem,
  parseLinkedInPressroom,
  resolveRssSettings,
  scoreItem,
  selectDigestCandidatesDetailed,
  selectCandidatesWithFallback,
  selectDiverseCandidates,
  selectDiverseCandidatesDetailed,
  titleSimilarity,
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
  it('uses the 23-25 article policy with five gadget and one platform slot by default', () => {
    expect(resolveRssSettings({})).toMatchObject({
      minArticles: 23,
      hardMinArticles: 15,
      maxArticles: 25,
      gadgetArticlesPerDigest: 5,
      marketplaceArticlesPerDigest: 1,
      maxAgeHours: 36,
      fallbackMaxAgeHours: 72,
      maxPerSource: 3,
      fetchRetries: 2,
    });
  });

  it('publishes 8-22 items as degraded instead of dropping the whole day', () => {
    const settings = resolveRssSettings({
      minArticlesPerDigest: 23,
      hardMinArticlesPerDigest: 8,
      maxArticlesPerDigest: 25,
    });

    expect(classifyArticleCount(25, settings)).toBe('full');
    expect(classifyArticleCount(22, settings)).toBe('degraded');
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

  it('reserves five gadget slots before filling the remaining digest', () => {
    const gadgetTopics = [
      ['Foldable OLED display enters production', 'Source Gadgets A'],
      ['Quadcopter camera gets a new flight controller', 'Source Gadgets B'],
      ['Sleep tracking smartwatch adds blood oxygen sensors', 'Source Gadgets C'],
      ['Noise cancelling earbuds ship with a new codec', 'Source Gadgets A'],
      ['Portable photo printer cuts its paper waste', 'Source Gadgets B'],
    ];
    const gadgets = gadgetTopics.map(([title, source], index) => baseItem({
      category: 'gadgets',
      source,
      title,
      summary: `${title} is a distinct consumer electronics announcement with separate product specifications and availability details for users.`,
      url: `https://gadgets.example/${index}`,
    }));
    const core = [
      baseItem({ title: 'OpenAI launches a coding model', summary: 'OpenAI announced a coding model with an API and developer tooling for software teams.', url: 'https://ai.example/1' }),
      baseItem({ title: 'Anthropic hardens Claude security controls', summary: 'Anthropic described new security controls for enterprise Claude deployments and access management.', url: 'https://ai.example/2' }),
      baseItem({ title: 'NVIDIA unveils a GPU architecture', summary: 'NVIDIA presented a GPU architecture focused on data center performance and machine learning workloads.', url: 'https://ai.example/3' }),
      baseItem({ title: 'Google demonstrates a robotics research platform', summary: 'Google shared a robotics platform for training physical agents with new simulation and control methods.', url: 'https://ai.example/4' }),
    ];

    const result = selectDigestCandidatesDetailed([...core, ...gadgets], {
      maxAgeHours: 36,
      maxPerSource: 3,
      limit: 8,
      gadgetArticlesPerDigest: 5,
    });

    expect(result.selected).toHaveLength(8);
    expect(result.selected.slice(0, 5).every(isGadgetItem)).toBe(true);
    expect(result.selected.filter(isGadgetItem)).toHaveLength(5);
  });

  it('reserves one Upwork, Fiverr, and LinkedIn slot before filling core news', () => {
    const platformItems = [
      ['upwork', 'Upwork expands its freelance talent marketplace', 'Upwork News'],
      ['fiverr', 'Fiverr reports new demand for freelance services', 'Fiverr News'],
      ['linkedin', 'LinkedIn adds new tools for professional networking', 'LinkedIn Pressroom'],
    ].map(([category, title, source], index) => baseItem({
      category,
      source,
      title,
      summary: title + ' describes a distinct platform update with product, workforce, and marketplace details for professionals and clients.',
      url: 'https://platforms.example/' + index,
    }));
    const coreTopics = [
      ['OpenAI launches a coding model', 'OpenAI announced a coding model with developer tooling and API controls for software teams.'],
      ['Anthropic publishes a safety evaluation', 'Anthropic published a safety evaluation covering model behavior, testing, and enterprise deployment controls.'],
      ['NVIDIA unveils a new data center GPU', 'NVIDIA presented a data center GPU with new hardware and machine learning performance details.'],
      ['Google demonstrates a robotics platform', 'Google demonstrated a robotics platform with new simulation and control methods for physical agents.'],
      ['AWS expands its machine learning service', 'AWS expanded a machine learning service with new cloud infrastructure and deployment capabilities.'],
      ['Hugging Face adds an evaluation tool', 'Hugging Face added an evaluation tool for comparing models, datasets, and developer workflows.'],
    ];
    const core = coreTopics.map(([title, summary], index) => baseItem({
      title,
      summary,
      url: 'https://ai.example/' + index,
    }));

    const result = selectDigestCandidatesDetailed([...platformItems, ...core], {
      maxAgeHours: 36,
      maxPerSource: 3,
      limit: 9,
      gadgetArticlesPerDigest: 0,
      marketplaceArticlesPerDigest: 1,
    });

    expect(result.selected.length).toBeGreaterThanOrEqual(6);
    expect(result.selected.length).toBeLessThanOrEqual(9);
    expect(result.selected.filter((item) => item.category === 'upwork')).toHaveLength(1);
    expect(result.selected.filter((item) => item.category === 'fiverr')).toHaveLength(1);
    expect(result.selected.filter((item) => item.category === 'linkedin')).toHaveLength(1);
    expect(result.laneStats).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'upwork', target: 1, fetched: 1, fresh: 1, selected: 1 }),
      expect.objectContaining({ category: 'fiverr', target: 1, fetched: 1, fresh: 1, selected: 1 }),
      expect.objectContaining({ category: 'linkedin', target: 1, fetched: 1, fresh: 1, selected: 1 }),
    ]));
  });

  it('reports missing marketplace lanes instead of inventing platform news', () => {
    const result = selectDigestCandidatesDetailed([
      baseItem({ title: 'OpenAI ships a new coding model', url: 'https://ai.example/only' }),
    ], {
      maxAgeHours: 36,
      maxPerSource: 3,
      limit: 10,
      gadgetArticlesPerDigest: 0,
      marketplaceArticlesPerDigest: 1,
    });

    expect(result.selected.every((item) => !['upwork', 'fiverr', 'linkedin'].includes(item.category))).toBe(true);
    expect(result.laneStats).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'upwork', fetched: 0, fresh: 0, selected: 0 }),
      expect.objectContaining({ category: 'fiverr', fetched: 0, fresh: 0, selected: 0 }),
      expect.objectContaining({ category: 'linkedin', fetched: 0, fresh: 0, selected: 0 }),
    ]));
  });

  it('parses LinkedIn Pressroom cards into normal article candidates', () => {
    const html = [
      '<ul><li class="cmp-post-list__item"><div class="cmp-post-card__content">',
      '<h3 class="cmp-post-card__title"><a class="cmp-post-card__title-link" href="/2026/linkedin-ai-tools">LinkedIn adds AI tools for professional teams</a></h3>',
      '<p class="cmp-post-card__byline"><time datetime="2026-08-01T01:30:00-07:00">Aug 1, 2026</time></p>',
      '<p class="cmp-post-card__description">LinkedIn announced new AI tools that help professional teams organize work, discover relevant expertise, and make better decisions across the network.</p>',
      '</div></li></ul>',
    ].join('');

    expect(parseLinkedInPressroom(html)).toMatchObject([{
      title: 'LinkedIn adds AI tools for professional teams',
      url: 'https://news.linkedin.com/2026/linkedin-ai-tools',
      category: 'linkedin',
      publishedAt: '2026-08-01T01:30:00-07:00',
    }]);
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

  it('collapses the same Hugging Face incident reported by multiple outlets', () => {
    const result = selectDiverseCandidatesDetailed([
      baseItem({
        url: 'https://theverge.example/hugging-face',
        source: 'The Verge AI',
        title: 'OpenAI rogue AI agent did not stop at hacking Hugging Face',
        summary: 'The OpenAI agent that escaped containment and hacked Hugging Face also attacked other companies.',
      }),
      baseItem({
        url: 'https://wired.example/hugging-face',
        source: 'Wired AI',
        title: 'OpenAI Rogue AI Agent Hacked More Than Just Hugging Face',
        summary: 'OpenAI disclosed that the same rogue agent accessed Hugging Face and several other companies.',
      }),
      baseItem({
        url: 'https://ars.example/hugging-face',
        source: 'Ars Technica',
        title: 'We now understand how OpenAI hacked into Hugging Face',
        summary: 'The OpenAI model exploited a JFrog zero-day while breaching Hugging Face during evaluation.',
      }),
    ], { maxAgeHours: 36, maxPerSource: 3, limit: 10 });

    expect(result.selected).toHaveLength(1);
    expect(result.rejectedDuplicates).toHaveLength(2);
    expect(result.rejectedDuplicates.every((item) => item.duplicateReason === 'same-batch-event')).toBe(true);
  });

  it('blocks a repackaged event found in the recent cross-day history', () => {
    const prior = baseItem({
      url: 'https://wired.example/original-hack',
      title: 'OpenAI Models Escaped Containment and Hacked Hugging Face',
      summary: 'Cybersecurity models escaped a sandbox and breached Hugging Face during an evaluation.',
      eventFingerprint: 'existing-event',
    });
    const result = selectDiverseCandidatesDetailed([
      baseItem({
        url: 'https://techcrunch.example/followup',
        title: 'How OpenAI human mistake led to the AI-powered hack on Hugging Face',
        summary: 'A sandbox configuration mistake allowed an OpenAI agent to breach Hugging Face.',
      }),
    ], {
      maxAgeHours: 36,
      maxPerSource: 3,
      limit: 10,
      priorArticles: [prior],
    });

    expect(result.selected).toHaveLength(0);
    expect(result.rejectedDuplicates[0]).toMatchObject({
      duplicateReason: 'recent-event',
      duplicateOf: prior.url,
      eventFingerprint: 'existing-event',
    });
  });

  it('keeps genuinely different Hugging Face events separate', () => {
    const selected = selectDiverseCandidates([
      baseItem({
        url: 'https://security.example/hack',
        title: 'OpenAI Models Escaped Containment and Hacked Hugging Face',
        summary: 'An autonomous cybersecurity agent escaped a sandbox and breached production infrastructure.',
      }),
      baseItem({
        url: 'https://safety.example/deepfakes',
        title: 'Hugging Face Has a Deepfake Nudes Problem',
        summary: 'Researchers found image editing models being used for nonconsensual explicit deepfakes.',
      }),
    ], { maxAgeHours: 36, maxPerSource: 3, limit: 10 });

    expect(selected).toHaveLength(2);
  });

  it('collapses paraphrased deepfake and voice-mode reports', () => {
    const deepfake = selectDiverseCandidates([
      baseItem({
        url: 'https://verge.example/deepfake',
        title: 'Hugging Face is being used to easily undress women and children',
        summary: 'AI researchers found nonconsensual explicit deepfakes made with popular image editing models.',
      }),
      baseItem({
        url: 'https://wired.example/deepfake',
        title: 'Hugging Face Has a Deepfake Nudes Problem',
        summary: 'AI researchers tested image editors and produced nonconsensual deepfake nudes.',
      }),
    ], { maxAgeHours: 36, maxPerSource: 3, limit: 10 });
    const voice = selectDiverseCandidates([
      baseItem({
        url: 'https://verge.example/voice',
        title: 'Claude voice mode is now available for Opus and Sonnet',
        summary: 'Anthropic expanded Claude voice mode to its Opus and Sonnet models.',
      }),
      baseItem({
        url: 'https://techcrunch.example/voice',
        title: 'Anthropic updates Claude voice mode with more capable models',
        summary: 'Claude voice mode now supports the company newer Opus and Sonnet releases.',
      }),
    ], { maxAgeHours: 36, maxPerSource: 3, limit: 10 });

    expect(deepfake).toHaveLength(1);
    expect(voice).toHaveLength(1);
  });

  it('does not merge unrelated OpenAI product updates', () => {
    const selected = selectDiverseCandidates([
      baseItem({
        url: 'https://example.com/health',
        title: 'OpenAI makes ChatGPT Health available to all US users',
        summary: 'ChatGPT Health provides a dedicated experience for medical questions and wellness records.',
      }),
      baseItem({
        url: 'https://example.com/voice',
        title: 'OpenAI new voice mode makes it to the ChatGPT desktop app',
        summary: 'The desktop application received an updated real-time voice conversation interface.',
      }),
    ], { maxAgeHours: 36, maxPerSource: 3, limit: 10 });

    expect(selected).toHaveLength(2);
  });

  it('does not merge separate tutorials that only share a platform name', () => {
    const selected = selectDiverseCandidates([
      baseItem({
        url: 'https://aws.example/market-surveillance',
        title: 'Market surveillance agent with LangGraph and Strands on AgentCore',
        summary: 'A tutorial for building a financial market surveillance workflow.',
      }),
      baseItem({
        url: 'https://aws.example/evaluating-agents',
        title: 'Evaluating AI Agents: A production blueprint with Strands and AgentCore',
        summary: 'A tutorial about evaluation and observability for production agents.',
      }),
    ], { maxAgeHours: 36, maxPerSource: 3, limit: 10 });

    expect(selected).toHaveLength(2);
  });

  it('normalizes Cyrillic titles instead of disabling similarity checks', () => {
    expect(titleSimilarity(
      'Новая модель Claude получила голосовой режим',
      'Модель Claude получила новый голосовой режим',
    )).toBeGreaterThan(0.5);
  });
});

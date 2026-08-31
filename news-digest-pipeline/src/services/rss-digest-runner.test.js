import { describe, expect, it } from 'vitest';
import {
  classifyArticleCount,
  extractArticleLead,
  extractMetaDescription,
  isGadgetItem,
  isAppleEcosystemItem,
  isFreshTechItem,
  parseFeed,
  parseLinkedInPressroom,
  promoteDigestLead,
  resolveRssSettings,
  scoreItem,
  scoreAppleImportance,
  selectDigestCandidatesDetailed,
  selectCandidatesWithFallback,
  selectDiverseCandidates,
  selectDiverseCandidatesDetailed,
  sources,
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
  it('contains the complete balanced source package and removes superseded corporate feeds', () => {
    const expected = [
      'MIT Technology Review AI',
      'Google DeepMind',
      'Google Research',
      'The Decoder',
      'Simon Willison',
      'BBC Technology',
      'The Register AI/ML',
      'BleepingComputer',
      'SecurityWeek',
      'The Hacker News',
      'Krebs on Security',
      'InfoQ',
      'Docker Blog',
      'Stack Overflow Blog',
      'The New Stack',
      'Engadget',
      '9to5Google',
      'Android Authority',
      'GSMArena',
      'The Robot Report',
      'IEEE Spectrum Robotics',
    ];
    const names = new Set(sources.map((source) => source.name));

    expect(expected.every((name) => names.has(name))).toBe(true);
    expect(names.has('AWS Machine Learning')).toBe(false);
    expect(names.has('Apple Newsroom')).toBe(false);
    expect(names.has('MacRumors')).toBe(false);
    expect(new Set(sources.map((source) => source.url)).size).toBe(sources.length);
  });

  it('supports curated feeds whose article descriptions require page enrichment', () => {
    const xml = `
      <rss><channel><item>
        <title>Google Research publishes a new AI model study</title>
        <link>https://research.google/blog/example/</link>
        <description>Generative AI</description>
        <pubDate>${freshDate}</pubDate>
      </item></channel></rss>`;
    const items = parseFeed(xml, {
      name: 'Google Research',
      minSummaryLength: 0,
      enrichArticleSummary: true,
    });

    expect(items).toHaveLength(1);
    expect(extractMetaDescription(`
      <meta property="og:description" content="A detailed AI research summary with enough factual context for the digest generator to use safely.">
    `)).toContain('detailed AI research summary');
    expect(extractArticleLead(`
      <p>August 21, 2026</p>
      <p>We introduce a multi-agent research system that evaluates wearable sensor data with statistical validation and human oversight.</p>
    `)).toContain('multi-agent research system');
  });

  it('rejects official marketplace publishers from third-party Google News lanes', () => {
    const xml = `
      <rss><channel>
        <item>
          <title>Upwork publishes an official corporate update</title>
          <link>https://news.google.com/rss/articles/official</link>
          <description>This official release contains enough marketplace and technology text to pass the normal minimum summary length filter.</description>
          <pubDate>${freshDate}</pubDate>
          <source url="https://investors.upwork.com">Upwork</source>
        </item>
        <item>
          <title>Independent outlet examines freelance demand on Upwork</title>
          <link>https://news.google.com/rss/articles/independent</link>
          <description>This independent report contains enough marketplace and technology text to pass the normal minimum summary length filter.</description>
          <pubDate>${freshDate}</pubDate>
          <source url="https://example.com">Independent Tech</source>
        </item>
      </channel></rss>`;
    const items = parseFeed(xml, {
      name: 'Google News Upwork Market',
      category: 'upwork',
      blockedPublisherDomains: ['upwork.com'],
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      publisher: 'Independent Tech',
      publisherUrl: 'https://example.com/',
    });
  });

  it('rejects user-generated social posts from every Google News market lane', () => {
    const googleNewsMarketSources = sources.filter((source) => source.name.startsWith('Google News '));

    expect(googleNewsMarketSources.length).toBeGreaterThanOrEqual(5);
    for (const source of googleNewsMarketSources) {
      expect(source.blockedPublisherDomains).toEqual(expect.arrayContaining([
        'instagram.com',
        'linkedin.com',
        'reddit.com',
        'youtube.com',
      ]));
    }

    const xml = `
      <rss><channel>
        <item>
          <title>Freelancer posts a personal Upwork anecdote</title>
          <link>https://news.google.com/rss/articles/social</link>
          <description>This social post contains enough freelance marketplace words to pass the normal summary length filter.</description>
          <pubDate>${freshDate}</pubDate>
          <source url="https://www.instagram.com">Instagram</source>
        </item>
        <item>
          <title>Independent outlet measures Upwork hiring demand</title>
          <link>https://news.google.com/rss/articles/report</link>
          <description>This independent report contains enough freelance hiring and technology detail to pass the summary length filter.</description>
          <pubDate>${freshDate}</pubDate>
          <source url="https://example.com">Independent Tech</source>
        </item>
      </channel></rss>`;
    const source = sources.find((entry) => entry.name === 'Google News Upwork Market');
    const items = parseFeed(xml, source);

    expect(items).toHaveLength(1);
    expect(items[0].publisher).toBe('Independent Tech');
  });

  it('filters broad feeds with whole-word work-market terms', () => {
    const xml = `
      <rss><channel>
        <item>
          <title>Retail chain said sales improved</title>
          <link>https://example.com/retail</link>
          <description>This unrelated retail report contains enough ordinary words to satisfy the minimum summary length.</description>
          <pubDate>${freshDate}</pubDate>
        </item>
        <item>
          <title>AI hiring demand rises for freelance automation specialists</title>
          <link>https://example.com/freelance-ai</link>
          <description>This labor market report measures freelance hiring, automation demand, skills, and contractor rates.</description>
          <pubDate>${freshDate}</pubDate>
        </item>
      </channel></rss>`;

    const items = parseFeed(xml, {
      name: 'Broad Work Feed',
      category: 'freelance-market',
      requiredAnyTerms: ['ai', 'freelance'],
    });

    expect(items.map((item) => item.url)).toEqual(['https://example.com/freelance-ai']);
  });

  it('uses the 23-25 article policy with five gadget and one platform slot by default', () => {
    expect(resolveRssSettings({})).toMatchObject({
      minArticles: 23,
      hardMinArticles: 15,
      maxArticles: 25,
      gadgetArticlesPerDigest: 5,
      appleArticlesPerDigest: 0,
      marketplaceArticlesPerDigest: 1,
      workMarketArticlesPerDigest: 7,
      workMarketMaxAgeHours: 36,
      maxAgeHours: 36,
      fallbackMaxAgeHours: 72,
      maxPerSource: 2,
      fetchRetries: 2,
    });
    expect(resolveRssSettings({}, { recoveryMode: true })).toMatchObject({
      maxPerSource: 2,
      recoveryMode: true,
    });
  });

  it('excludes Apple across gadget and core lanes by default, including product-only titles', () => {
    const items = [
      baseItem({ title: 'Mac Studio launches for AI teams', summary: 'New desktop hardware released for model inference.', category: 'gadgets' }),
      baseItem({ title: 'Siri introduces a new AI model', summary: 'New voice assistant capabilities announced.', source: 'Other' }),
      baseItem({ title: 'Open source robotics platform released', source: 'Robotics Daily' }),
    ];
    const result = selectDigestCandidatesDetailed(items, { limit: 10 });
    expect(result.selected).toHaveLength(1);
    expect(result.selected[0].title).toContain('robotics');
  });

  it('opens with a substantive core AI event without changing quotas or membership', () => {
    const gadget = baseItem({ category: 'gadgets', title: 'New smartphone launched' });
    const market = baseItem({ category: 'upwork', title: 'Automation jobs demand grows' });
    const rumor = baseItem({ title: 'Rumors about an AI launch and new model', source: 'Rumor feed' });
    const release = baseItem({ title: 'Open-source AI model released for local automation', source: 'Engineering' });
    const items = [gadget, market, rumor, release];
    const ordered = promoteDigestLead(items);
    expect(ordered[0]).toBe(release);
    expect(ordered.slice(1)).toEqual([gadget, market, rumor]);
    expect(items[0]).toBe(gadget);
    expect(new Set(ordered)).toEqual(new Set(items));
  });

  it('uses a stable non-Apple fallback when there is no core story', () => {
    const apple = baseItem({ title: 'Apple launches new iPhone', category: 'gadgets' });
    const work = baseItem({ title: 'AI automation skills demand', category: 'upwork' });
    expect(promoteDigestLead([apple, work])[0]).toBe(work);
    expect(promoteDigestLead([])).toEqual([]);
  });

  it('keeps only the highest-impact Apple story instead of banning Apple entirely', () => {
    const appleItems = [
      baseItem({
        title: "Apple's camera-equipped AirPods: all the new rumors",
        summary: 'A collection of rumors about a possible future Apple accessory and speculative camera features.',
        source: 'MacRumors',
        sourceBrand: 'MacRumors',
        category: 'gadgets',
        url: 'https://example.com/apple-rumors',
      }),
      baseItem({
        title: "10 ways to improve your iPhone's battery life",
        summary: 'Tips and settings that may extend battery life on an existing Apple phone.',
        source: 'MacRumors',
        sourceBrand: 'MacRumors',
        category: 'gadgets',
        url: 'https://example.com/iphone-tips',
      }),
      baseItem({
        title: 'Apple releases emergency iOS security patch for an exploited zero-day',
        summary: 'Apple released a major security patch for an actively exploited iPhone vulnerability.',
        source: 'SecurityWeek',
        sourceBrand: 'SecurityWeek',
        category: 'gadgets',
        url: 'https://example.com/apple-security',
      }),
    ];
    const nonAppleItems = Array.from({ length: 4 }, (_, index) => baseItem({
      title: `Android device launch ${index}`,
      summary: 'A manufacturer launched a new Android smartphone with updated hardware and security features.',
      source: `Gadget Source ${index}`,
      sourceBrand: `Gadget Source ${index}`,
      category: 'gadgets',
      url: `https://example.com/android-${index}`,
    }));
    const result = selectDigestCandidatesDetailed([...appleItems, ...nonAppleItems], {
      limit: 5,
      maxPerSource: 2,
      gadgetArticlesPerDigest: 5,
      appleArticlesPerDigest: 1,
      marketplaceArticlesPerDigest: 0,
      workMarketArticlesPerDigest: 0,
    });
    const selectedApple = result.selected.filter(isAppleEcosystemItem);

    expect(selectedApple).toHaveLength(1);
    expect(selectedApple[0].url).toBe('https://example.com/apple-security');
    expect(scoreAppleImportance(appleItems[2])).toBeGreaterThan(scoreAppleImportance(appleItems[0]));
    expect(scoreItem(appleItems[2]).score).toBeGreaterThan(scoreItem(appleItems[1]).score);
  });

  it('allows zero Apple stories when the available items are only rumors and tips', () => {
    const lowSignalApple = [
      baseItem({
        title: 'Apple leaks and AirPods rumors round-up',
        summary: 'Rumors and leaks speculate about possible future accessories without an official announcement.',
        category: 'gadgets',
        url: 'https://example.com/apple-leaks',
      }),
      baseItem({
        title: 'How to improve iPhone battery life',
        summary: 'Tips for changing settings on an existing phone to improve battery life.',
        category: 'gadgets',
        url: 'https://example.com/iphone-battery-tips',
      }),
    ];
    const nonApple = Array.from({ length: 3 }, (_, index) => baseItem({
      title: `Android hardware release ${index}`,
      summary: 'A manufacturer released a new Android device with upgraded hardware and security features.',
      category: 'gadgets',
      url: `https://example.com/non-apple-${index}`,
    }));
    const result = selectDigestCandidatesDetailed([...lowSignalApple, ...nonApple], {
      limit: 3,
      gadgetArticlesPerDigest: 3,
      appleArticlesPerDigest: 1,
      marketplaceArticlesPerDigest: 0,
      workMarketArticlesPerDigest: 0,
    });

    expect(result.selected.filter(isAppleEcosystemItem)).toHaveLength(0);
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

  it('widens only recovery collection without lowering the hard floor', () => {
    const appConfig = {
      minArticlesPerDigest: 23,
      hardMinArticlesPerDigest: 15,
      maxArticlesPerDigest: 25,
      rssMaxArticleAgeHours: 36,
      rssFallbackMaxArticleAgeHours: 72,
      rssMaxArticlesPerSource: 3,
      rssRecoveryMaxArticleAgeHours: 120,
      rssRecoveryMaxArticlesPerSource: 4,
    };

    const daily = resolveRssSettings(appConfig);
    const recovery = resolveRssSettings(appConfig, { recoveryMode: true });

    expect(daily).toMatchObject({
      hardMinArticles: 15,
      fallbackMaxAgeHours: 72,
      maxPerSource: 3,
      recoveryMode: false,
    });
    expect(recovery).toMatchObject({
      hardMinArticles: 15,
      fallbackMaxAgeHours: 120,
      maxPerSource: 4,
      recoveryMode: true,
    });
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

  it('caps a media brand shared by multiple feeds', () => {
    const selected = selectDiverseCandidates([
      baseItem({
        url: 'https://techcrunch.com/ai-one',
        title: 'OpenAI launches a new coding agent',
        source: 'TechCrunch AI',
        sourceBrand: 'TechCrunch',
      }),
      baseItem({
        url: 'https://techcrunch.com/security-two',
        title: 'Cloud security startup patches API vulnerability',
        source: 'TechCrunch Security',
        sourceBrand: 'TechCrunch',
      }),
      baseItem({
        url: 'https://techcrunch.com/gadgets-three',
        title: 'Robotics company releases a new home device',
        source: 'TechCrunch Gadgets',
        sourceBrand: 'TechCrunch',
      }),
    ], { maxAgeHours: 36, maxPerSource: 2, limit: 10 });

    expect(selected).toHaveLength(2);
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

  it('reserves up to seven fresh work-market items before filling AI news', () => {
    const platformItems = [
      ['upwork', 'Upwork reports new demand for AI automation freelancers', 'Client surveys show higher budgets for workflow specialists using n8n and APIs.'],
      ['fiverr', 'Fiverr sees more AI agent automation gigs', 'Seller data shows a rise in packaged chatbot and business process services.'],
      ['linkedin', 'LinkedIn publishes new data about AI hiring', 'Professional network data identifies changing skills and recruiting patterns.'],
      ['freelance-market', 'Independent workers adopt automation tools', 'A contractor study measures time savings from software used for invoicing and delivery.'],
      ['freelance-market', 'Consulting rates rise for machine learning skills', 'A labor report compares specialist rates across several technical disciplines.'],
      ['freelance-market', 'Remote teams change how they hire contractors', 'Companies are revising project scopes, interviews, and distributed work policies.'],
      ['freelance-market', 'Talent marketplaces test agent-assisted matching', 'New platform experiments connect client briefs with verified professional expertise.'],
      ['freelance-market', 'Creators adopt a new proposal workflow', 'Independent professionals are testing a platform for contracts, payments, and approvals.'],
    ].map(([category, title, detail], index) => baseItem({
      category,
      source: `Work Source ${index}`,
      title,
      summary: `${detail} The fresh freelance market coverage includes workforce implications for clients and professionals.`,
      url: `https://work.example/${index}`,
    }));
    const core = [
      ['OpenAI launches a coding model', 'The release adds repository tools and API controls for software teams.'],
      ['NVIDIA unveils a data center GPU', 'The chip targets machine learning training with a redesigned memory system.'],
      ['Google demonstrates a warehouse robot', 'The robotics research combines vision sensors with physical control policies.'],
      ['Cloudflare blocks a new security attack', 'The network service adds privacy protections and automated threat detection.'],
      ['Microsoft releases a quantum compiler', 'The developer tool improves circuit optimization for experimental hardware.'],
      ['Mozilla updates browser data controls', 'The software release gives users more control over tracking and local storage.'],
    ].map(([title, summary], index) => baseItem({
      source: `Core Source ${index}`,
      title,
      summary,
      url: `https://ai.example/work-quota-${index}`,
    }));

    const result = selectDigestCandidatesDetailed([...core, ...platformItems], {
      maxAgeHours: 72,
      workMarketMaxAgeHours: 36,
      maxPerSource: 3,
      limit: 10,
      gadgetArticlesPerDigest: 0,
      marketplaceArticlesPerDigest: 1,
      workMarketArticlesPerDigest: 7,
    });

    const marketSelected = result.selected.filter((item) => (
      ['upwork', 'fiverr', 'linkedin', 'freelance-market'].includes(item.category)
    ));
    expect(result.selected).toHaveLength(10);
    expect(marketSelected).toHaveLength(7);
    expect(result.laneStats).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'work-market', target: 7, selected: 7 }),
    ]));
  });

  it('does not use stale work-market items to fill the seven-item target', () => {
    const result = selectDigestCandidatesDetailed([
      baseItem({
        category: 'freelance-market',
        source: 'Fresh Work Source',
        title: 'Freelance AI automation demand rises',
        summary: 'Fresh freelance hiring and AI automation demand data for independent contractors and clients.',
        url: 'https://work.example/fresh',
      }),
      baseItem({
        category: 'freelance-market',
        source: 'Old Work Source',
        title: 'Old freelancer platform survey',
        summary: 'An old freelance workforce and hiring survey about contractors, automation, and marketplace demand.',
        publishedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toUTCString(),
        url: 'https://work.example/stale',
      }),
      baseItem({
        title: 'Anthropic publishes a fresh model evaluation',
        url: 'https://ai.example/fresh-core',
      }),
    ], {
      maxAgeHours: 72,
      workMarketMaxAgeHours: 36,
      maxPerSource: 3,
      limit: 10,
      gadgetArticlesPerDigest: 0,
      marketplaceArticlesPerDigest: 1,
      workMarketArticlesPerDigest: 7,
    });

    expect(result.selected.map((item) => item.url)).toContain('https://work.example/fresh');
    expect(result.selected.map((item) => item.url)).not.toContain('https://work.example/stale');
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

  it('keeps lexical filtering conservative and collapses only the obvious voice-mode pair', () => {
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

    // The deepfake pair is intentionally left for the update-aware LLM
    // verdict instead of being decided by one hard-coded topic word.
    expect(deepfake).toHaveLength(2);
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

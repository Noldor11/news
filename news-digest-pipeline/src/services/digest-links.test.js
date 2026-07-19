import { describe, expect, it } from 'vitest';
import { enforceCanonicalDigestLinks } from './digest-links.js';

describe('enforceCanonicalDigestLinks', () => {
  it('replaces model-written URLs with the exact collected source URLs', () => {
    const articles = [
      { title: 'MIT story', commentary: 'MIT commentary', url: 'https://news.mit.edu/2026/real-story' },
      { title: 'TechCrunch story', commentary: 'TC commentary', url: 'https://techcrunch.com/2026/real-story' },
    ];
    const draft = [
      '#новости  1. First text',
      'https://www.mit.edu/wrong-link',
      '',
      '2. Second text',
      'https://example.com/wrong-link',
      '',
      '#ИИ #технологии #новости',
    ].join('\n');

    const result = enforceCanonicalDigestLinks(draft, articles, '#ИИ #технологии #новости');

    expect(result).toContain('https://news.mit.edu/2026/real-story');
    expect(result).toContain('https://techcrunch.com/2026/real-story');
    expect(result).not.toContain('www.mit.edu/wrong-link');
    expect(result).not.toContain('example.com/wrong-link');
    expect(result).toMatch(/#ИИ #технологии #новости$/);
  });
});
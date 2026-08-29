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

  it('keeps the daily actions after the final article source and before hashtags', () => {
    const articles = [
      { title: 'First', commentary: 'First commentary', url: 'https://example.com/first' },
      { title: 'Second', commentary: 'Second commentary', url: 'https://example.com/second' },
    ];
    const draft = [
      '#новости  1. First text',
      '',
      '2. Second text',
      '',
      'Три действия из сегодняшних новостей:',
      '1) Сохранить рабочие шаблоны отдельно от одного сервиса.',
      '2) Проверить настройки приватности нового приложения.',
      '3) Сравнить независимые тесты перед покупкой.',
      'https://example.com/model-invented-action-link',
      '',
      '#ИИ #технологии #новости',
    ].join('\n');

    const result = enforceCanonicalDigestLinks(draft, articles, '#ИИ #технологии #новости');

    const sourceIndex = result.indexOf('https://example.com/second');
    const actionsIndex = result.indexOf('Три действия из сегодняшних новостей:');
    const hashtagsIndex = result.indexOf('#ИИ #технологии #новости');

    expect(sourceIndex).toBeGreaterThan(-1);
    expect(actionsIndex).toBeGreaterThan(sourceIndex);
    expect(hashtagsIndex).toBeGreaterThan(actionsIndex);
    expect(result).not.toContain('model-invented-action-link');
  });

  it('preserves the daily actions when malformed article numbering triggers fallback', () => {
    const articles = [
      { title: 'First', commentary: 'First commentary', url: 'https://example.com/first' },
      { title: 'Second', commentary: 'Second commentary', url: 'https://example.com/second' },
    ];
    const draft = [
      '#новости  1. Only one numbered item survived assembly',
      '',
      'Три действия из сегодняшних новостей:',
      '1) Сохранить полезный шаблон.',
    ].join('\n');

    const result = enforceCanonicalDigestLinks(draft, articles);

    expect(result).toContain('#новости  1. First commentary');
    expect(result).toContain('2. Second commentary');
    expect(result).toContain('Три действия из сегодняшних новостей:');
    expect(result).toContain('1) Сохранить полезный шаблон.');
  });
});

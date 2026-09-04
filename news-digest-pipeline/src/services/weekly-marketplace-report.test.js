import { describe, expect, it, vi } from 'vitest';
import {
  formatWeeklyMarketplaceReport,
  runWeeklyMarketplaceReport,
} from './weekly-marketplace-report.js';

const collected = {
  weekKey: '2026-08-03',
  disabled: false,
  errors: [],
  diagnostics: [],
  upwork: {
    itemCount: 30,
    cached: false,
    item: { summary: 'Upwork summary.' },
    highlights: [{
      title: 'Build an n8n AI agent',
      url: 'https://www.upwork.com/jobs/~01',
      applicants: 42,
      budget: 'fixed $500',
    }],
  },
  fiverr: {
    itemCount: 30,
    cached: false,
    item: { summary: 'Fiverr supply summary.' },
    highlights: [{
      title: 'Create Make.com automations',
      url: 'https://www.fiverr.com/example/gig',
      reviews: 120,
      priceFrom: '$75',
      sellerLevel: 'top_rated_seller',
    }],
  },
};

describe('weekly marketplace report', () => {
  it('clearly separates Upwork competition from Fiverr supply', () => {
    const content = formatWeeklyMarketplaceReport(collected);
    expect(content).toContain('недельный срез Upwork и Fiverr');
    expect(content).toContain('42 заявок, fixed $500');
    expect(content).toContain('120 отзывов, цена от $75');
    expect(content).toContain('не число заказов только за эту неделю');
  });

  it('publishes one combined report to the configured digest chat', async () => {
    const publish = vi.fn().mockResolvedValue({ ok: true, messageIds: ['501'] });
    const result = await runWeeklyMarketplaceReport({
      appConfig: {
        telegramBotToken: 'test-token',
        telegramPublishChatId: '-1001',
      },
      collect: vi.fn().mockResolvedValue(collected),
      publish,
    });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('test-token', '-1001', expect.stringContaining('UPWORK'));
    expect(result).toMatchObject({ ok: true, upworkItems: 30, fiverrItems: 30 });
  });

  it('publishes the available marketplace when the other source failed', async () => {
    const publish = vi.fn().mockResolvedValue({ ok: true, messageIds: ['502'] });
    const partial = { ...collected, fiverr: null, errors: ['Fiverr: timeout'] };

    const result = await runWeeklyMarketplaceReport({
      appConfig: { telegramBotToken: 'test-token', telegramPublishChatId: '-1001' },
      collect: vi.fn().mockResolvedValue(partial),
      publish,
    });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      'test-token',
      '-1001',
      expect.stringContaining('FIVERR\nДанные за неделю получить не удалось.'),
    );
    expect(result).toMatchObject({ ok: true, degraded: true, upworkItems: 30, fiverrItems: 0 });
  });

  it('does not publish an empty report when both marketplaces failed', async () => {
    const publish = vi.fn();
    const empty = { ...collected, upwork: null, fiverr: null, errors: ['Upwork: timeout', 'Fiverr: timeout'] };

    await expect(runWeeklyMarketplaceReport({
      appConfig: { telegramBotToken: 'test-token', telegramPublishChatId: '-1001' },
      collect: vi.fn().mockResolvedValue(empty),
      publish,
    })).rejects.toThrow('incomplete (Upwork, Fiverr)');
    expect(publish).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildFiverrSnapshot,
  buildUpworkSnapshot,
  kyivWeekKey,
  kyivWeekday,
} from './apify-marketplace.js';

describe('public marketplace snapshots', () => {
  it('builds a weekly Upwork competition pulse from public jobs', () => {
    const now = new Date('2026-08-09T16:00:00.000Z');
    const result = buildUpworkSnapshot([
      {
        id: '1',
        title: 'n8n automation expert',
        url: 'https://www.upwork.com/jobs/~01',
        publishTime: '2026-08-09T15:00:00.000Z',
        fixedPriceAmount: { amount: '200' },
        totalApplicants: 10,
        skills: [{ prefLabel: 'n8n' }, { prefLabel: 'API Integration' }],
      },
      {
        id: '2',
        title: 'AI agent and Make.com workflow',
        url: 'https://www.upwork.com/jobs/~02',
        publishTime: '2026-08-09T14:00:00.000Z',
        fixedPriceAmount: { amount: '100' },
        totalApplicants: 20,
        skills: [{ prefLabel: 'n8n' }, { prefLabel: 'Make.com' }],
      },
    ], now);

    expect(result.item).toMatchObject({
      category: 'upwork',
      source: 'Apify Upwork Public Jobs',
      url: 'https://www.upwork.com/jobs/~01',
    });
    expect(result.item.summary).toContain('n8n (2)');
    expect(result.item.summary).toContain('медианный fixed budget $150');
    expect(result.itemCount).toBe(2);
    expect(result.metrics.medianApplicants).toBe(15);
    expect(result.highlights[0]).toMatchObject({ applicants: 20, budget: 'fixed $100' });
  });

  it('labels Fiverr data as a supply snapshot instead of buyer demand', () => {
    const now = new Date('2026-08-10T16:00:00.000Z');
    const result = buildFiverrSnapshot([
      {
        rowType: 'gig', gigId: '1', title: 'build n8n AI automation',
        gigUrl: 'https://www.fiverr.com/seller/build-n8n-ai-automation',
        priceFrom: 50, reviewsCount: 20, sellerLevel: 'level_two_seller',
      },
      {
        rowType: 'gig', gigId: '2', title: 'create Make.com workflows',
        gigUrl: 'https://www.fiverr.com/seller/create-make-workflows',
        priceFrom: 100, reviewsCount: 0, sellerLevel: 'top_rated_seller',
      },
    ], now);

    expect(result.item.category).toBe('fiverr');
    expect(result.item.summary).toContain('срез предложения');
    expect(result.item.summary).toContain('не прямое измерение клиентского спроса');
    expect(result.item.summary).toContain('Медианная стартовая цена $75');
    expect(result.highlights[0]).toMatchObject({ reviews: 20, priceFrom: '$50' });
  });

  it('uses the Kyiv calendar for the weekly Fiverr run key', () => {
    const monday = new Date('2026-08-10T10:00:00.000Z');
    expect(kyivWeekday(monday)).toBe(1);
    expect(kyivWeekKey(monday)).toBe('2026-08-10');
  });
});

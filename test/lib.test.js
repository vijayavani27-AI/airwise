import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TtlCache } from '../src/lib/cache.js';
import { aqiCategory, cigaretteEquivalent, findCleanestWindow, findWorstHour, isRiskyFor, whoMultiple } from '../src/lib/aqi.js';
import { sanitizePlan, LIMITS } from '../src/lib/plan.js';
import { loadConfig } from '../src/config.js';

describe('TtlCache', () => {
  it('returns cached values until they expire', () => {
    let now = 0;
    const cache = new TtlCache({ ttlMs: 100, now: () => now });
    cache.set('a', 1);
    assert.equal(cache.get('a'), 1);
    now = 150;
    assert.equal(cache.get('a'), undefined);
  });

  it('evicts the least recently used entry when full', () => {
    const cache = new TtlCache({ ttlMs: 1000, maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);
    assert.equal(cache.get('b'), undefined);
    assert.equal(cache.get('a'), 1);
    assert.equal(cache.size, 2);
  });

  it('de-duplicates concurrent producers and does not cache failures', async () => {
    const cache = new TtlCache({ ttlMs: 1000 });
    let calls = 0;
    const producer = async () => {
      calls += 1;
      return 'value';
    };
    const [a, b] = await Promise.all([cache.wrap('k', producer), cache.wrap('k', producer)]);
    assert.equal(a, 'value');
    assert.equal(b, 'value');
    assert.equal(calls, 1);

    await assert.rejects(cache.wrap('bad', async () => { throw new Error('boom'); }));
    assert.equal(cache.get('bad'), undefined);
  });

  it('rejects an invalid ttl', () => {
    assert.throws(() => new TtlCache({ ttlMs: 0 }), TypeError);
  });
});

describe('AQI helpers', () => {
  it('maps AQI values to EPA categories', () => {
    assert.equal(aqiCategory(42).level, 'good');
    assert.equal(aqiCategory(100).level, 'moderate');
    assert.equal(aqiCategory(101).level, 'sensitive');
    assert.equal(aqiCategory(175).level, 'unhealthy');
    assert.equal(aqiCategory(250).level, 'very-unhealthy');
    assert.equal(aqiCategory(480).level, 'hazardous');
  });

  it('uses a stricter threshold for vulnerable households', () => {
    assert.equal(isRiskyFor(120, {}), false);
    assert.equal(isRiskyFor(120, { children: true }), true);
    assert.equal(isRiskyFor(160, {}), true);
  });

  it('computes exposure equivalents safely', () => {
    assert.equal(cigaretteEquivalent(44), 2);
    assert.equal(whoMultiple(30), 2);
    assert.equal(cigaretteEquivalent(null), 0);
    assert.equal(whoMultiple(-5), 0);
  });

  it('finds the cleanest waking-hours window and the worst hour', () => {
    const forecast = [
      { time: '2026-11-22T03:00', aqi: 10 },
      { time: '2026-11-22T04:00', aqi: 10 },
      { time: '2026-11-22T14:00', aqi: 90 },
      { time: '2026-11-22T15:00', aqi: 80 },
      { time: '2026-11-22T23:00', aqi: 300 },
    ];
    assert.deepEqual(findCleanestWindow(forecast), { start: '2026-11-22T14:00', end: '2026-11-22T15:00', avgAqi: 85, day: 'today' });
    assert.equal(findWorstHour(forecast).aqi, 300);
    assert.equal(findCleanestWindow([{ time: '2026-11-22T21:00', aqi: 50 }, { time: '2026-11-23T08:00', aqi: 40 }, { time: '2026-11-23T09:00', aqi: 40 }]).day, 'tomorrow');
    assert.equal(findCleanestWindow([]), null);
    assert.equal(findWorstHour([]), null);
  });
});

describe('sanitizePlan', () => {
  const valid = {
    summary: 'Smoggy day.',
    routine: [{ time: '14:00', activity: 'Walk', reason: 'Cleanest air' }],
    indoorTips: [{ title: 'Seal windows', detail: 'Close them', impact: 'Less PM2.5' }],
    alternatives: [{ change: 'Take metro', impact: 'Saves 10 kg CO2' }],
    healthAlerts: ['Wear N95'],
  };

  it('keeps valid content', () => {
    assert.deepEqual(sanitizePlan(valid), valid);
  });

  it('strips control characters, trims length and caps list sizes', () => {
    const plan = sanitizePlan({
      ...valid,
      summary: `Hi\u0000 there ${'x'.repeat(1000)}`,
      routine: Array.from({ length: 20 }, () => ({ time: '10:00', activity: 'Go', reason: 'r' })),
      healthAlerts: ['ok', 42, ''],
    });
    assert.ok(!plan.summary.includes('\u0000'));
    assert.ok(plan.summary.length <= 400);
    assert.equal(plan.routine.length, LIMITS.routine);
    assert.deepEqual(plan.healthAlerts, ['ok']);
  });

  it('rejects plans without a summary or routine', () => {
    assert.throws(() => sanitizePlan(null), TypeError);
    assert.throws(() => sanitizePlan({ ...valid, summary: '' }), TypeError);
    assert.throws(() => sanitizePlan({ ...valid, routine: [{ time: '', activity: '' }] }), TypeError);
  });
});

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    const config = loadConfig({});
    assert.equal(config.port, 8080);
    assert.equal(config.geminiApiKey, '');
    assert.equal(config.rateLimitPerMinute, 30);
    assert.ok(Object.isFrozen(config));
  });

  it('reads and trims environment values', () => {
    const config = loadConfig({ PORT: '3000', GEMINI_API_KEY: ' key ', RATE_LIMIT_PER_MINUTE: 'nope' });
    assert.equal(config.port, 3000);
    assert.equal(config.geminiApiKey, 'key');
    assert.equal(config.rateLimitPerMinute, 30);
  });
});

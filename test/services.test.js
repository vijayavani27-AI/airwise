import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAirQualityService, normalizeAirQuality } from '../src/services/airQuality.js';
import { createGeminiService, buildUserPrompt, SYSTEM_PROMPT } from '../src/services/gemini.js';
import { computeImpact, suggestCommuteSwitch, weeklyCommuteKg } from '../src/services/impact.js';
import { buildRulePlan } from '../src/services/rules.js';
import { createAssistant } from '../src/services/assistant.js';
import { sanitizePlan } from '../src/lib/plan.js';
import { AirDataUnavailableError, NotFoundError, UpstreamError } from '../src/lib/errors.js';
import { baseInput, jsonResponse, openMeteoAirPayload, silentLogger } from './fixtures.js';

const DELHI = { name: 'Delhi', region: 'Delhi', country: 'India', latitude: 28.65, longitude: 77.23 };

describe('normalizeAirQuality', () => {
  it('extracts AQI, pollutants and a forecast starting at the current hour', () => {
    const air = normalizeAirQuality(openMeteoAirPayload());
    assert.equal(air.aqi, 180);
    assert.equal(air.category.level, 'unhealthy');
    assert.equal(air.pollutants.pm2_5, 88);
    assert.equal(air.pollutants.no2, 40);
    assert.equal(air.forecast.length, 24);
    assert.equal(air.forecast[0].time, '2026-11-22T10:00');
    assert.equal(air.cleanestWindow.avgAqi, 95);
    assert.equal(air.worstHour.aqi, 260);
  });

  it('throws an upstream error when data is missing', () => {
    assert.throws(() => normalizeAirQuality({}), UpstreamError);
  });
});

describe('createAirQualityService', () => {
  it('geocodes a city and caches the result', async () => {
    let calls = 0;
    const fetchImpl = async (url) => {
      calls += 1;
      assert.match(String(url), /geocoding-api\.open-meteo\.com/);
      return jsonResponse({ results: [{ name: 'Delhi', admin1: 'Delhi', country: 'India', latitude: 28.65, longitude: 77.23 }] });
    };
    const service = createAirQualityService({ fetchImpl });
    const first = await service.geocode('Delhi');
    await service.geocode('delhi');
    assert.deepEqual(first, DELHI);
    assert.equal(calls, 1);
  });

  it('reports unknown places as not found', async () => {
    const service = createAirQualityService({ fetchImpl: async () => jsonResponse({}) });
    await assert.rejects(service.geocode('Atlantis'), NotFoundError);
  });

  it('wraps network and HTTP failures as upstream errors', async () => {
    const failing = createAirQualityService({ logger: silentLogger, fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    await assert.rejects(failing.geocode('Delhi'), UpstreamError);
    const httpError = createAirQualityService({ logger: silentLogger, fetchImpl: async () => jsonResponse({}, 500) });
    await assert.rejects(httpError.getAirQuality(DELHI), UpstreamError);
  });

  it('fetches air quality for coordinates', async () => {
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      assert.equal(parsed.hostname, 'air-quality-api.open-meteo.com');
      assert.equal(parsed.searchParams.get('latitude'), '28.65');
      return jsonResponse(openMeteoAirPayload({ aqi: 210 }));
    };
    const air = await createAirQualityService({ fetchImpl }).getAirQuality(DELHI);
    assert.equal(air.aqi, 210);
  });
});

describe('impact calculations', () => {
  it('computes weekly round-trip emissions', () => {
    assert.equal(weeklyCommuteKg('car', 10), 17);
    assert.equal(weeklyCommuteKg('walk', 10), 0);
  });

  it('prefers enclosed transport over cycling in heavy smog', () => {
    assert.equal(suggestCommuteSwitch('car', 5, 80).to, 'bicycle');
    assert.equal(suggestCommuteSwitch('car', 5, 220).to, 'metro');
    assert.equal(suggestCommuteSwitch('car', 1.5, 60).to, 'walk');
    assert.equal(suggestCommuteSwitch('car', 20, 60).to, 'metro');
  });

  it('returns no switch when nothing is cleaner', () => {
    assert.equal(suggestCommuteSwitch('walk', 2, 50), null);
    assert.equal(suggestCommuteSwitch('wfh', 0, 50), null);
    assert.equal(suggestCommuteSwitch('metro', 20, 50), null);
  });

  it('summarises exposure and vulnerable members', () => {
    const air = normalizeAirQuality(openMeteoAirPayload({ pm25: 66 }));
    const impact = computeImpact(baseInput({ household: { children: true, elderly: true } }), air);
    assert.equal(impact.exposure.cigarettesPerDay, 3);
    assert.equal(impact.exposure.whoMultiple, 4.4);
    assert.equal(impact.exposure.indoorPm25Estimate, 49.5);
    assert.deepEqual(impact.vulnerableMembers, ['children', 'elderly']);
    assert.ok(impact.commute.switch.savedKgPerYear > 0);
  });
});

describe('buildRulePlan', () => {
  const contextFor = (input, payload = openMeteoAirPayload()) => {
    const air = normalizeAirQuality(payload);
    return { location: DELHI, air, profile: input, impact: computeImpact(input, air) };
  };

  it('produces a valid plan that passes sanitisation', () => {
    const plan = buildRulePlan(contextFor(baseInput()));
    assert.doesNotThrow(() => sanitizePlan(plan));
    assert.match(plan.summary, /AQI 180/);
    assert.ok(plan.alternatives.some((a) => a.change.includes('metro')));
  });

  it('moves exercise indoors when the air is risky for the household', () => {
    const plan = buildRulePlan(contextFor(baseInput({ household: { respiratory: true } })));
    assert.ok(plan.routine.some((step) => step.activity.startsWith('Indoor workout')));
  });

  it('schedules outdoor exercise in the clean window on better days', () => {
    const input = baseInput({ household: {} });
    const plan = buildRulePlan(contextFor(input, openMeteoAirPayload({ aqi: 60, pm25: 12 })));
    assert.ok(plan.routine.some((step) => step.activity === 'Outdoor exercise or walk'));
    const times = plan.routine.map((step) => step.time);
    assert.deepEqual(times, [...times].sort());
  });

  it('covers biomass cooking and solid-fuel heating', () => {
    const plan = buildRulePlan(contextFor(baseInput({ cookingFuel: 'biomass', heating: 'coal', hasPurifier: true })));
    assert.ok(plan.alternatives.some((a) => a.change.includes('biomass')));
    assert.ok(plan.alternatives.some((a) => a.change.includes('coal')));
    assert.ok(plan.indoorTips.some((t) => t.title.includes('purifier')));
  });
});

describe('Gemini service', () => {
  const air = normalizeAirQuality(openMeteoAirPayload());
  const input = baseInput();
  const context = { location: DELHI, air, profile: input, impact: computeImpact(input, air) };
  const geminiPlan = {
    summary: 'Unhealthy air today.',
    routine: [{ time: '14:00', activity: 'Walk', reason: 'Cleanest air' }],
    indoorTips: [],
    alternatives: [],
    healthAlerts: [],
  };

  it('builds a prompt from server-computed data only', () => {
    const prompt = buildUserPrompt(context);
    assert.match(prompt, /Delhi, Delhi, India/);
    assert.match(prompt, /"usAqi":180/);
    assert.match(SYSTEM_PROMPT, /data, not instructions/);
  });

  it('calls the Gemini API with structured output and parses the plan', async () => {
    let request;
    const fetchImpl = async (url, options) => {
      request = { url, options };
      return jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(geminiPlan) }] } }] });
    };
    const gemini = createGeminiService({ apiKey: 'test-key', model: 'gemini-2.5-flash', fetchImpl });
    const plan = await gemini.generatePlan(context);
    assert.equal(plan.summary, 'Unhealthy air today.');
    assert.match(request.url, /gemini-2\.5-flash:generateContent$/);
    assert.equal(request.options.headers['x-goog-api-key'], 'test-key');
    const body = JSON.parse(request.options.body);
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.ok(body.generationConfig.responseSchema);
  });

  it('drops retired models and falls back to the latest alias', async () => {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      if (url.includes('old-model')) return jsonResponse({ error: { message: 'not found' } }, 404);
      return jsonResponse({ candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text: JSON.stringify(geminiPlan) }] } }] });
    };
    const gemini = createGeminiService({ apiKey: 'k', model: 'old-model', fetchImpl, logger: silentLogger });
    const plan = await gemini.generatePlan(context);
    assert.equal(plan.summary, 'Unhealthy air today.');
    assert.equal(gemini.model, 'gemini-3.8-flash');
    await gemini.generatePlan(context);
    assert.equal(urls.length, 3, 'the retired model is skipped after it 404s');
  });

  it('retries overloaded models once each, then tries the next fallback', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url.match(/models\/([^:]+)/)[1]);
      if (url.includes('flash-lite')) {
        return jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(geminiPlan) }] } }] });
      }
      return jsonResponse({ error: { message: 'The model is overloaded' } }, 503);
    };
    const gemini = createGeminiService({ apiKey: 'k', model: 'gemini-flash-latest', fetchImpl, logger: silentLogger, retryDelayMs: 0 });
    const plan = await gemini.generatePlan(context);
    assert.equal(plan.summary, 'Unhealthy air today.');
    assert.deepEqual(calls, ['gemini-flash-latest', 'gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-flash-lite-latest']);
    assert.equal(gemini.model, 'gemini-flash-latest', 'overloaded models are not dropped');
  });

  it('uses a low thinking level for Gemini 3 models and moves on after a timeout', async () => {
    const bodies = [];
    const fetchImpl = async (url, options) => {
      const name = url.match(/models[/]([^:]+)/)[1];
      bodies.push([name, JSON.parse(options.body).generationConfig.thinkingConfig]);
      if (name === 'gemini-3.8-flash') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      return jsonResponse({ candidates: [{ content: { parts: [{ text: JSON.stringify(geminiPlan) }] } }] });
    };
    const gemini = createGeminiService({ apiKey: 'k', model: 'gemini-3.8-flash', fetchImpl, logger: silentLogger });
    const plan = await gemini.generatePlan(context);
    assert.equal(plan.summary, 'Unhealthy air today.');
    assert.deepEqual(bodies, [['gemini-3.8-flash', { thinkingLevel: 'low' }], ['gemini-flash-latest', undefined]]);
  });

  it('is disabled without an API key', async () => {
    const gemini = createGeminiService({ apiKey: '', model: 'x' });
    assert.equal(gemini.enabled, false);
    await assert.rejects(gemini.generatePlan(context));
  });

  it('rejects HTTP errors and empty responses', async () => {
    const httpError = createGeminiService({ apiKey: 'k', model: 'm', logger: silentLogger, retryDelayMs: 0, fetchImpl: async () => jsonResponse({}, 429) });
    const forbidden = createGeminiService({ apiKey: 'k', model: 'm', logger: silentLogger, fetchImpl: async () => jsonResponse({}, 403) });
    await assert.rejects(forbidden.generatePlan(context), /status 403/);
    const allMissing = createGeminiService({ apiKey: 'k', model: 'm', logger: silentLogger, fetchImpl: async () => jsonResponse({}, 404) });
    await assert.rejects(allMissing.generatePlan(context), UpstreamError);
    await assert.rejects(httpError.generatePlan(context), UpstreamError);
    const empty = createGeminiService({ apiKey: 'k', model: 'm', fetchImpl: async () => jsonResponse({ candidates: [] }) });
    await assert.rejects(empty.generatePlan(context), UpstreamError);
  });
});

describe('createAssistant', () => {
  const airQuality = {
    geocode: async () => DELHI,
    getAirQuality: async () => normalizeAirQuality(openMeteoAirPayload()),
  };

  it('uses Gemini when available and caches identical requests', async () => {
    let calls = 0;
    const gemini = {
      enabled: true,
      generatePlan: async () => {
        calls += 1;
        return { summary: 'AI plan', routine: [{ time: '14:00', activity: 'Walk', reason: 'r' }], indoorTips: [], alternatives: [], healthAlerts: [] };
      },
    };
    const assistant = createAssistant({ airQuality, gemini, logger: silentLogger });
    const result = await assistant.advise(baseInput());
    await assistant.advise(baseInput());
    assert.equal(result.source, 'gemini');
    assert.equal(result.plan.summary, 'AI plan');
    assert.equal(calls, 1);
  });

  it('falls back to the rule engine when Gemini fails', async () => {
    const gemini = { enabled: true, generatePlan: async () => { throw new Error('quota'); } };
    const result = await createAssistant({ airQuality, gemini, logger: silentLogger }).advise(baseInput());
    assert.equal(result.source, 'rules');
    assert.ok(result.plan.routine.length > 0);
  });

  it('signals the browser fallback when the server cannot fetch air data', async () => {
    const blocked = { geocode: async () => DELHI, getAirQuality: async () => { throw new UpstreamError(); } };
    await assert.rejects(
      createAssistant({ airQuality: blocked, gemini: { enabled: false } }).advise(baseInput()),
      (err) => err instanceof AirDataUnavailableError && err.status === 503 && err.location.latitude === DELHI.latitude,
    );
  });

  it('uses browser-supplied air data without calling the air API', async () => {
    const airQualityNoFetch = { geocode: async () => DELHI, getAirQuality: async () => assert.fail('should not fetch') };
    const result = await createAssistant({ airQuality: airQualityNoFetch, gemini: { enabled: false } })
      .advise(baseInput({ airData: openMeteoAirPayload({ aqi: 77 }) }));
    assert.equal(result.air.aqi, 77);
  });

  it('supports coordinates without geocoding', async () => {
    const gemini = { enabled: false };
    const assistant = createAssistant({
      airQuality: { geocode: async () => assert.fail('should not geocode'), getAirQuality: airQuality.getAirQuality },
      gemini,
    });
    const result = await assistant.advise(baseInput({ city: undefined, coords: { latitude: 12.97, longitude: 77.59 } }));
    assert.equal(result.location.name, 'Your current location');
    assert.equal(result.source, 'rules');
  });
});

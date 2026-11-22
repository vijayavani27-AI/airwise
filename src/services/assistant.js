import { createHash } from 'node:crypto';
import { TtlCache } from '../lib/cache.js';
import { computeImpact } from './impact.js';
import { buildRulePlan } from './rules.js';

/**
 * Orchestrates: location -> live air quality -> impact maths -> GenAI plan
 * (with a deterministic fallback so users always get advice).
 */
export function createAssistant({
  airQuality,
  gemini,
  logger = console,
  planCache = new TtlCache({ ttlMs: 10 * 60 * 1000, maxEntries: 500 }),
}) {
  async function resolveLocation(input) {
    if (input.coords) {
      const { latitude, longitude } = input.coords;
      return { name: 'Your current location', region: '', country: '', latitude, longitude };
    }
    return airQuality.geocode(input.city);
  }

  async function advise(input) {
    const location = await resolveLocation(input);
    const air = await airQuality.getAirQuality(location);
    const impact = computeImpact(input, air);
    const context = { location, air, profile: input, impact };

    let plan = null;
    let source = 'rules';
    if (gemini.enabled) {
      const key = createHash('sha256')
        .update(JSON.stringify([location.latitude, location.longitude, air.observedAt, input]))
        .digest('hex');
      try {
        plan = await planCache.wrap(key, () => gemini.generatePlan(context));
        source = 'gemini';
      } catch (error) {
        logger.warn?.(`Gemini unavailable, using rule-based plan: ${error.message}`);
      }
    }
    plan ??= buildRulePlan(context);

    return { location, air, impact, plan, source, generatedAt: new Date().toISOString() };
  }

  return { advise };
}

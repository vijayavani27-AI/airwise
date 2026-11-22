import { TtlCache } from '../lib/cache.js';
import { aqiCategory, findCleanestWindow, findWorstHour } from '../lib/aqi.js';
import { NotFoundError, UpstreamError } from '../lib/errors.js';

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const AIR_QUALITY_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const CURRENT_VARIABLES = ['us_aqi', 'pm2_5', 'pm10', 'nitrogen_dioxide', 'ozone', 'carbon_monoxide', 'sulphur_dioxide'];
const FORECAST_HOURS = 24;

const POLLUTANT_KEYS = {
  pm2_5: 'pm2_5',
  pm10: 'pm10',
  nitrogen_dioxide: 'no2',
  ozone: 'o3',
  carbon_monoxide: 'co',
  sulphur_dioxide: 'so2',
};

const numberOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * Turn the raw Open-Meteo payload into the compact structure the app uses.
 * @param {any} data
 */
export function normalizeAirQuality(data) {
  const current = data?.current;
  if (!current || typeof current.us_aqi !== 'number') {
    throw new UpstreamError('Live air-quality data is not available for this location right now.');
  }

  const pollutants = {};
  for (const [source, key] of Object.entries(POLLUTANT_KEYS)) {
    pollutants[key] = numberOrNull(current[source]);
  }

  const times = data.hourly?.time ?? [];
  const values = data.hourly?.us_aqi ?? [];
  const currentHour = String(current.time).slice(0, 13);
  const forecast = [];
  for (let i = 0; i < times.length && forecast.length < FORECAST_HOURS; i += 1) {
    if (times[i].slice(0, 13) >= currentHour && typeof values[i] === 'number') {
      forecast.push({ time: times[i], aqi: Math.round(values[i]) });
    }
  }

  const aqi = Math.round(current.us_aqi);
  return {
    aqi,
    category: aqiCategory(aqi),
    pollutants,
    observedAt: current.time,
    timezone: data.timezone ?? 'UTC',
    forecast,
    cleanestWindow: findCleanestWindow(forecast),
    worstHour: findWorstHour(forecast),
  };
}

/**
 * Factory so tests can inject a fake fetch and deterministic caches.
 */
export function createAirQualityService({
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  geoCache = new TtlCache({ ttlMs: 24 * 60 * 60 * 1000, maxEntries: 1000 }),
  airCache = new TtlCache({ ttlMs: 15 * 60 * 1000, maxEntries: 1000 }),
} = {}) {
  async function getJson(url) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new UpstreamError();
    }
    if (!response.ok) throw new UpstreamError();
    return response.json();
  }

  /** Resolve a city name to canonical coordinates. */
  async function geocode(city) {
    return geoCache.wrap(city.toLowerCase(), async () => {
      const url = new URL(GEOCODING_URL);
      url.search = new URLSearchParams({ name: city, count: '1', language: 'en', format: 'json' }).toString();
      const data = await getJson(url);
      const match = data?.results?.[0];
      if (!match) throw new NotFoundError(`We couldn't find a place called "${city}". Try a nearby larger city.`);
      return {
        name: match.name,
        region: match.admin1 ?? '',
        country: match.country ?? '',
        latitude: match.latitude,
        longitude: match.longitude,
      };
    });
  }

  /** Fetch current air quality plus a 24h AQI forecast for coordinates. */
  async function getAirQuality({ latitude, longitude }) {
    const key = `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
    return airCache.wrap(key, async () => {
      const url = new URL(AIR_QUALITY_URL);
      url.search = new URLSearchParams({
        latitude: String(latitude),
        longitude: String(longitude),
        current: CURRENT_VARIABLES.join(','),
        hourly: 'us_aqi',
        forecast_days: '2',
        timezone: 'auto',
      }).toString();
      return normalizeAirQuality(await getJson(url));
    });
  }

  return { geocode, getAirQuality };
}

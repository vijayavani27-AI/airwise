import { ValidationError } from './errors.js';

export const OPTIONS = Object.freeze({
  commuteMode: ['car', 'motorbike', 'autorickshaw', 'bus', 'metro', 'bicycle', 'walk', 'wfh'],
  cookingFuel: ['lpg', 'png', 'electric', 'biomass'],
  heating: ['none', 'electric', 'gas', 'wood', 'coal'],
  activity: ['morning', 'evening', 'none'],
});

// Letters (any script), combining marks, spaces and a few punctuation marks only.
const CITY_PATTERN = /^[\p{L}\p{M} .,'-]{2,80}$/u;
const MAX_COMMUTE_KM = 200;

const round = (value, digits) => Number(value.toFixed(digits));

function pickEnum(value, allowed, field, errors, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string' && allowed.includes(value)) return value;
  errors.push(`${field} must be one of: ${allowed.join(', ')}`);
  return fallback;
}

const isTrue = (value) => value === true;

const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const TIMEZONE = /^[A-Za-z0-9_/+-]{1,64}$/;
const MAX_FORECAST_HOURS = 72;
const MAX_AQI = 1000;
const MAX_CONCENTRATION = 50000;
const POLLUTANT_FIELDS = ['pm2_5', 'pm10', 'nitrogen_dioxide', 'ozone', 'carbon_monoxide', 'sulphur_dioxide'];
const inRange = (value, max) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;

/**
 * Validate an Open-Meteo payload fetched by the browser (fallback when the server
 * is rate-limited). Only known fields with plausible ranges survive.
 */
export function validateAirData(raw, errors) {
  const current = raw?.current;
  const hourly = raw?.hourly;
  if (!current || typeof current.time !== 'string' || !LOCAL_TIME.test(current.time) || !inRange(current.us_aqi, MAX_AQI)) {
    errors.push('airData.current must include a local time and a us_aqi between 0 and 1000');
    return undefined;
  }
  const times = Array.isArray(hourly?.time) ? hourly.time : [];
  const values = Array.isArray(hourly?.us_aqi) ? hourly.us_aqi : [];
  if (
    times.length > MAX_FORECAST_HOURS ||
    times.length !== values.length ||
    !times.every((t) => typeof t === 'string' && LOCAL_TIME.test(t)) ||
    !values.every((v) => v === null || inRange(v, MAX_AQI))
  ) {
    errors.push(`airData.hourly must hold up to ${MAX_FORECAST_HOURS} matching time/us_aqi entries`);
    return undefined;
  }

  const cleanCurrent = { time: current.time, us_aqi: current.us_aqi };
  for (const field of POLLUTANT_FIELDS) {
    cleanCurrent[field] = inRange(current[field], MAX_CONCENTRATION) ? current[field] : null;
  }
  return {
    timezone: typeof raw.timezone === 'string' && TIMEZONE.test(raw.timezone) ? raw.timezone : 'UTC',
    current: cleanCurrent,
    hourly: { time: times, us_aqi: values },
  };
}

/**
 * Validate and normalise an assistant request. Only whitelisted, typed values
 * survive - this also keeps free text out of the LLM prompt (prompt-injection defence).
 * @param {unknown} body
 */
export function validateAdviceRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError(['Request body must be a JSON object']);
  }

  const errors = [];
  const input = {};

  const hasCoords = body.latitude !== undefined || body.longitude !== undefined;
  if (hasCoords) {
    const latitude = Number(body.latitude);
    const longitude = Number(body.longitude);
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      errors.push('latitude must be a number between -90 and 90');
    }
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      errors.push('longitude must be a number between -180 and 180');
    }
    if (errors.length === 0) {
      input.coords = { latitude: round(latitude, 3), longitude: round(longitude, 3) };
    }
  } else if (typeof body.city === 'string' && CITY_PATTERN.test(body.city.trim())) {
    input.city = body.city.trim().replace(/\s+/g, ' ');
  } else {
    errors.push('Provide a city name (2-80 letters) or your coordinates');
  }

  input.commuteMode = pickEnum(body.commuteMode, OPTIONS.commuteMode, 'commuteMode', errors, 'bus');
  input.cookingFuel = pickEnum(body.cookingFuel, OPTIONS.cookingFuel, 'cookingFuel', errors, 'lpg');
  input.heating = pickEnum(body.heating, OPTIONS.heating, 'heating', errors, 'none');
  input.activity = pickEnum(body.activity, OPTIONS.activity, 'activity', errors, 'none');

  const rawKm = body.commuteKm;
  const commuteKm = rawKm === undefined || rawKm === null || rawKm === '' ? 0 : Number(rawKm);
  if (!Number.isFinite(commuteKm) || commuteKm < 0 || commuteKm > MAX_COMMUTE_KM) {
    errors.push(`commuteKm must be a number between 0 and ${MAX_COMMUTE_KM}`);
  } else {
    input.commuteKm = input.commuteMode === 'wfh' ? 0 : round(commuteKm, 1);
  }

  const household = body.household && typeof body.household === 'object' ? body.household : {};
  input.household = {
    children: isTrue(household.children),
    elderly: isTrue(household.elderly),
    respiratory: isTrue(household.respiratory),
    pregnant: isTrue(household.pregnant),
  };
  input.hasPurifier = isTrue(body.hasPurifier);

  if (body.airData !== undefined) {
    const airData = validateAirData(body.airData, errors);
    if (airData) input.airData = airData;
  }

  if (errors.length > 0) throw new ValidationError(errors);
  return input;
}

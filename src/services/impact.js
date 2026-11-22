import { cigaretteEquivalent, whoMultiple } from '../lib/aqi.js';

/**
 * Approximate CO2e per passenger-km for Indian cities (kg).
 * Sources: India GHG Program transport factors, ICCT; rounded for clarity.
 */
export const EMISSION_FACTORS_KG_PER_KM = Object.freeze({
  car: 0.17,
  motorbike: 0.07,
  autorickshaw: 0.09,
  bus: 0.04,
  metro: 0.03,
  bicycle: 0,
  walk: 0,
  wfh: 0,
});

export const MODE_LABELS = Object.freeze({
  car: 'car',
  motorbike: 'motorbike',
  autorickshaw: 'auto-rickshaw',
  bus: 'bus',
  metro: 'metro',
  bicycle: 'bicycle',
  walk: 'walking',
  wfh: 'working from home',
});

export const COMMUTE_DAYS_PER_WEEK = 5;
const WORKING_WEEKS_PER_YEAR = 48;
// Typical indoor/outdoor PM2.5 ratio for naturally ventilated Indian homes, and
// the reduction a correctly sized HEPA purifier achieves in a closed room.
const INDOOR_OUTDOOR_RATIO = 0.75;
const PURIFIER_REDUCTION = 0.6;

const round1 = (n) => Number(n.toFixed(1));

/** Weekly round-trip commute emissions in kg CO2e. */
export function weeklyCommuteKg(mode, km) {
  const factor = EMISSION_FACTORS_KG_PER_KM[mode] ?? 0;
  return round1(factor * km * 2 * COMMUTE_DAYS_PER_WEEK);
}

/**
 * Suggest the lowest-emission realistic commute switch. During heavy smog
 * (AQI > 150) enclosed public transport beats cycling/walking for exposure.
 */
export function suggestCommuteSwitch(mode, km, aqi) {
  if (mode === 'wfh' || km <= 0) return null;
  const smoggy = aqi > 150;
  let candidates;
  if (km <= 2) candidates = smoggy ? ['metro', 'bus', 'walk'] : ['walk'];
  else if (km <= 8) candidates = smoggy ? ['metro', 'bus'] : ['bicycle', 'metro', 'bus'];
  else candidates = ['metro', 'bus'];

  const currentFactor = EMISSION_FACTORS_KG_PER_KM[mode];
  const to = candidates.find((c) => EMISSION_FACTORS_KG_PER_KM[c] < currentFactor);
  if (!to) return null;

  const currentKgPerWeek = weeklyCommuteKg(mode, km);
  const newKgPerWeek = weeklyCommuteKg(to, km);
  const savedKgPerWeek = round1(currentKgPerWeek - newKgPerWeek);
  return {
    from: mode,
    to,
    currentKgPerWeek,
    newKgPerWeek,
    savedKgPerWeek,
    savedKgPerYear: Math.round(savedKgPerWeek * WORKING_WEEKS_PER_YEAR),
  };
}

/**
 * Deterministic, explainable impact numbers. These ground the LLM so that the
 * "direct impact" it explains is based on real calculations, not guesses.
 */
export function computeImpact(input, air) {
  const pm25 = typeof air.pollutants.pm2_5 === 'number' ? air.pollutants.pm2_5 : null;
  const indoorPm25 = pm25 === null ? null : round1(pm25 * INDOOR_OUTDOOR_RATIO);

  const { household } = input;
  const vulnerableMembers = [
    household.children && 'children',
    household.elderly && 'elderly',
    household.respiratory && 'people with asthma/respiratory conditions',
    household.pregnant && 'a pregnant family member',
  ].filter(Boolean);

  return {
    commute: {
      mode: input.commuteMode,
      km: input.commuteKm,
      weeklyKgCo2: weeklyCommuteKg(input.commuteMode, input.commuteKm),
      switch: suggestCommuteSwitch(input.commuteMode, input.commuteKm, air.aqi),
    },
    exposure: {
      pm25,
      whoMultiple: whoMultiple(pm25),
      cigarettesPerDay: cigaretteEquivalent(pm25),
      indoorPm25Estimate: indoorPm25,
      indoorPm25WithPurifier: indoorPm25 === null ? null : round1(indoorPm25 * (1 - PURIFIER_REDUCTION)),
    },
    vulnerableMembers,
  };
}

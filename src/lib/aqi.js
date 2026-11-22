/**
 * Air-quality helpers based on the US EPA AQI scale (as returned by Open-Meteo)
 * and the WHO 2021 PM2.5 guideline.
 */

export const WHO_PM25_24H_GUIDELINE = 15; // µg/m³
// Berkeley Earth rule of thumb: 22 µg/m³ of PM2.5 for a day ≈ smoking one cigarette.
export const PM25_PER_CIGARETTE = 22;

const CATEGORIES = [
  { max: 50, level: 'good', label: 'Good', advice: 'Air quality is satisfactory.' },
  { max: 100, level: 'moderate', label: 'Moderate', advice: 'Unusually sensitive people should limit long outdoor exertion.' },
  { max: 150, level: 'sensitive', label: 'Unhealthy for sensitive groups', advice: 'Children, elderly and people with lung or heart conditions should reduce outdoor exertion.' },
  { max: 200, level: 'unhealthy', label: 'Unhealthy', advice: 'Everyone should reduce prolonged outdoor exertion.' },
  { max: 300, level: 'very-unhealthy', label: 'Very unhealthy', advice: 'Avoid outdoor activity; keep windows closed.' },
  { max: Infinity, level: 'hazardous', label: 'Hazardous', advice: 'Health emergency conditions - stay indoors with filtered air.' },
];

/** @param {number} aqi */
export function aqiCategory(aqi) {
  const value = Math.max(0, Math.round(aqi));
  const { level, label, advice } = CATEGORIES.find((c) => value <= c.max);
  return { level, label, advice };
}

/** True when the air is unhealthy for the given household. */
export function isRiskyFor(aqi, household = {}) {
  const sensitive = household.children || household.elderly || household.respiratory || household.pregnant;
  return aqi > (sensitive ? 100 : 150);
}

/** @param {number | null | undefined} pm25 */
export function cigaretteEquivalent(pm25) {
  if (typeof pm25 !== 'number' || pm25 <= 0) return 0;
  return Number((pm25 / PM25_PER_CIGARETTE).toFixed(1));
}

/** @param {number | null | undefined} pm25 */
export function whoMultiple(pm25) {
  if (typeof pm25 !== 'number' || pm25 <= 0) return 0;
  return Number((pm25 / WHO_PM25_24H_GUIDELINE).toFixed(1));
}

const hourOf = (isoLocal) => Number.parseInt(isoLocal.slice(11, 13), 10);

const dateOf = (isoLocal) => isoLocal.slice(0, 10);
const dayLabel = (isoLocal, forecast) => (dateOf(isoLocal) === dateOf(forecast[0].time) ? 'today' : 'tomorrow');

/**
 * Find the cleanest 2-hour window during waking hours (05:00-22:00) in the forecast.
 * @param {{ time: string, aqi: number }[]} forecast
 */
export function findCleanestWindow(forecast) {
  let best = null;
  for (let i = 0; i < forecast.length - 1; i += 1) {
    const a = forecast[i];
    const b = forecast[i + 1];
    const hour = hourOf(a.time);
    if (hour < 5 || hour > 21) continue;
    const avg = (a.aqi + b.aqi) / 2;
    if (!best || avg < best.avgAqi) {
      best = { start: a.time, end: b.time, avgAqi: Math.round(avg), day: dayLabel(a.time, forecast) };
    }
  }
  return best;
}

/** Find the worst hour in the forecast (when to stay indoors). */
export function findWorstHour(forecast) {
  const worst = forecast.reduce((acc, point) => (!acc || point.aqi > acc.aqi ? point : acc), null);
  return worst && { ...worst, day: dayLabel(worst.time, forecast) };
}

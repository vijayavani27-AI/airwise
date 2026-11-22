import { isRiskyFor } from '../lib/aqi.js';
import { MODE_LABELS } from './impact.js';

/**
 * Deterministic, offline plan generator. Used when Gemini is unavailable so the
 * assistant always gives safe, useful advice (graceful degradation).
 */

const clock = (isoLocal) => (isoLocal ? isoLocal.slice(11, 16) : '');
const dayPrefix = (day) => (day === 'tomorrow' ? 'Tomorrow ' : '');

function buildRoutine({ air, profile, impact }) {
  const routine = [];
  const risky = isRiskyFor(air.aqi, profile.household);
  const window = air.cleanestWindow;

  if (profile.activity !== 'none') {
    if (window && !risky) {
      routine.push({
        time: `${dayPrefix(window.day)}${clock(window.start)}-${clock(window.end)}`,
        activity: 'Outdoor exercise or walk',
        reason: `Cleanest air of the day (AQI ~${window.avgAqi}) - you breathe up to 2-3x more air while exercising.`,
      });
    } else {
      routine.push({
        time: profile.activity === 'morning' ? '07:00' : '18:00',
        activity: 'Indoor workout (yoga, stretching, skipping)',
        reason: `Outdoor AQI ${air.aqi} is unsafe for exercise; indoors avoids heavy-breathing exposure.`,
      });
    }
  }

  const sw = impact.commute.switch;
  if (sw) {
    routine.push({
      time: '08:30',
      activity: `Commute by ${MODE_LABELS[sw.to]} instead of ${MODE_LABELS[sw.from]}`,
      reason: `Cuts about ${sw.savedKgPerWeek} kg CO2 a week (${sw.savedKgPerYear} kg a year).`,
    });
  } else if (profile.commuteMode !== 'wfh' && profile.commuteKm > 0) {
    routine.push({
      time: '08:30',
      activity: `Commute by ${MODE_LABELS[profile.commuteMode]} - wear a well-fitted N95 mask`,
      reason: 'An N95 filters about 95% of fine particles when it seals well.',
    });
  }

  if (air.worstHour) {
    routine.push({
      time: `${dayPrefix(air.worstHour.day)}${clock(air.worstHour.time)}`,
      activity: 'Stay indoors with windows closed',
      reason: `Forecast peak pollution (AQI ${air.worstHour.aqi}).`,
    });
  }

  routine.push({
    time: '20:00',
    activity: profile.cookingFuel === 'biomass' ? 'Cook with the exhaust on or outdoors-ventilated' : 'Cook with a lid and the exhaust fan on',
    reason: 'Cooking is a major source of indoor PM2.5; ventilation clears it faster.',
  });

  // Chronological order; "Tomorrow ..." entries naturally sort last.
  return routine.sort((a, b) => a.time.localeCompare(b.time));
}

function buildIndoorTips({ air, profile, impact }) {
  const tips = [];
  const { indoorPm25Estimate, indoorPm25WithPurifier } = impact.exposure;

  if (air.aqi > 100) {
    tips.push({
      title: 'Seal the home during peak hours',
      detail: 'Keep windows shut and use wet towels or draft-stoppers under doors.',
      impact: 'Reduces outdoor smog seeping in, especially at night and early morning.',
    });
  }
  if (!profile.hasPurifier && indoorPm25Estimate !== null) {
    tips.push({
      title: 'Create one clean room',
      detail: 'Run a HEPA purifier (or a DIY box-fan + MERV-13 filter) in the bedroom with the door closed.',
      impact: `Can lower indoor PM2.5 from ~${indoorPm25Estimate} to ~${indoorPm25WithPurifier} µg/m³.`,
    });
  } else if (profile.hasPurifier) {
    tips.push({
      title: 'Get the most from your purifier',
      detail: 'Run it on high in a closed room and replace the filter on schedule.',
      impact: 'A closed room lets a purifier cut PM2.5 by roughly 60%.',
    });
  }
  tips.push({
    title: 'Avoid indoor smoke',
    detail: 'Skip incense, mosquito coils, candles and frying at high heat on smoggy days.',
    impact: 'These can push indoor PM2.5 higher than the street outside.',
  });
  tips.push({
    title: 'Clean with damp cloths',
    detail: 'Wet-mop floors and wipe surfaces instead of dry sweeping.',
    impact: 'Stops settled dust and particles being thrown back into the air.',
  });
  return tips;
}

function buildAlternatives({ profile, impact }) {
  const alternatives = [];
  const sw = impact.commute.switch;
  if (sw) {
    alternatives.push({
      change: `Switch from ${MODE_LABELS[sw.from]} to ${MODE_LABELS[sw.to]} for your ${profile.commuteKm} km commute`,
      impact: `From ${sw.currentKgPerWeek} to ${sw.newKgPerWeek} kg CO2/week - saves ~${sw.savedKgPerYear} kg a year.`,
    });
  }
  if (profile.commuteMode === 'car') {
    alternatives.push({
      change: 'Carpool with one colleague on days you must drive',
      impact: `Halves your share of commute emissions (~${(impact.commute.weeklyKgCo2 / 2).toFixed(1)} kg CO2/week saved).`,
    });
  }
  if (profile.cookingFuel === 'biomass') {
    alternatives.push({
      change: 'Move from wood/biomass to LPG or induction cooking',
      impact: 'Biomass smoke is one of the largest sources of household PM2.5 exposure in India.',
    });
  }
  if (profile.heating === 'wood' || profile.heating === 'coal') {
    alternatives.push({
      change: `Replace ${profile.heating} heating with an electric heater or warm layering`,
      impact: 'Burning solid fuel adds smoke to your home and your neighbourhood smog.',
    });
  }
  alternatives.push({
    change: 'Never burn leaves or waste - compost or use municipal pickup',
    impact: 'Open burning is a key driver of winter smog in Indian cities.',
  });
  return alternatives;
}

function buildHealthAlerts({ air, impact }) {
  const alerts = [air.category.advice];
  if (impact.exposure.cigarettesPerDay >= 1) {
    alerts.push(`Breathing this air all day is roughly like smoking ${impact.exposure.cigarettesPerDay} cigarette(s).`);
  }
  if (impact.vulnerableMembers.length > 0 && air.aqi > 100) {
    alerts.push(`Take extra care of ${impact.vulnerableMembers.join(', ')} today.`);
  }
  alerts.push('Seek medical help for breathlessness, chest pain or persistent coughing.');
  return alerts;
}

/** @param {{ location: object, air: object, profile: object, impact: object }} context */
export function buildRulePlan(context) {
  const { air, impact } = context;
  const pm = impact.exposure.whoMultiple ? ` PM2.5 is ${impact.exposure.whoMultiple}x the WHO daily guideline.` : '';
  return {
    summary: `Air quality is ${air.category.label.toLowerCase()} (AQI ${air.aqi}).${pm} Here is a low-exposure, low-emission plan for today.`,
    routine: buildRoutine(context),
    indoorTips: buildIndoorTips(context),
    alternatives: buildAlternatives(context),
    healthAlerts: buildHealthAlerts(context),
  };
}

/**
 * The shape of a personalised plan, shared by the Gemini and rule-based engines.
 * PLAN_SCHEMA is passed to Gemini as a structured-output schema; sanitizePlan()
 * re-validates whatever comes back before it ever reaches the browser.
 */

export const LIMITS = Object.freeze({
  text: 240,
  short: 40,
  routine: 8,
  indoorTips: 6,
  alternatives: 6,
  healthAlerts: 4,
});

const STRING = { type: 'STRING' };

export const PLAN_SCHEMA = Object.freeze({
  type: 'OBJECT',
  properties: {
    summary: STRING,
    routine: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { time: STRING, activity: STRING, reason: STRING },
        required: ['time', 'activity', 'reason'],
      },
    },
    indoorTips: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { title: STRING, detail: STRING, impact: STRING },
        required: ['title', 'detail', 'impact'],
      },
    },
    alternatives: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { change: STRING, impact: STRING },
        required: ['change', 'impact'],
      },
    },
    healthAlerts: { type: 'ARRAY', items: STRING },
  },
  required: ['summary', 'routine', 'indoorTips', 'alternatives', 'healthAlerts'],
});

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function cleanText(value, max = LIMITS.text) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanList(list, max, mapItem) {
  if (!Array.isArray(list)) return [];
  return list.map(mapItem).filter(Boolean).slice(0, max);
}

/**
 * @param {unknown} raw
 * @returns {{summary: string, routine: object[], indoorTips: object[], alternatives: object[], healthAlerts: string[]}}
 */
export function sanitizePlan(raw) {
  if (!raw || typeof raw !== 'object') throw new TypeError('Plan must be an object');

  const plan = {
    summary: cleanText(raw.summary, 400),
    routine: cleanList(raw.routine, LIMITS.routine, (item) => {
      const time = cleanText(item?.time, LIMITS.short);
      const activity = cleanText(item?.activity);
      return time && activity ? { time, activity, reason: cleanText(item?.reason) } : null;
    }),
    indoorTips: cleanList(raw.indoorTips, LIMITS.indoorTips, (item) => {
      const title = cleanText(item?.title, 80);
      return title ? { title, detail: cleanText(item?.detail), impact: cleanText(item?.impact) } : null;
    }),
    alternatives: cleanList(raw.alternatives, LIMITS.alternatives, (item) => {
      const change = cleanText(item?.change);
      return change ? { change, impact: cleanText(item?.impact) } : null;
    }),
    healthAlerts: cleanList(raw.healthAlerts, LIMITS.healthAlerts, (item) => cleanText(item) || null),
  };

  if (!plan.summary || plan.routine.length === 0) {
    throw new TypeError('Plan is missing a summary or routine');
  }
  return plan;
}

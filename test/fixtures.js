/** Shared test fixtures and fakes. */

export function openMeteoAirPayload({ aqi = 180, pm25 = 88 } = {}) {
  const time = [];
  const usAqi = [];
  for (let h = 0; h < 48; h += 1) {
    const day = h < 24 ? '22' : '23';
    time.push(`2026-11-${day}T${String(h % 24).padStart(2, '0')}:00`);
    // Clean mid-afternoon, dirty late night - typical winter smog curve.
    const hour = h % 24;
    usAqi.push(hour >= 13 && hour <= 16 ? 95 : hour >= 22 || hour <= 2 ? 260 : 170);
  }
  return {
    timezone: 'Asia/Kolkata',
    current: {
      time: '2026-11-22T10:15',
      us_aqi: aqi,
      pm2_5: pm25,
      pm10: 140,
      nitrogen_dioxide: 40,
      ozone: 20,
      carbon_monoxide: 900,
      sulphur_dioxide: 12,
    },
    hourly: { time, us_aqi: usAqi },
  };
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export const silentLogger = { warn() {}, error() {}, info() {}, log() {} };

export function baseInput(overrides = {}) {
  return {
    city: 'Delhi',
    commuteMode: 'car',
    commuteKm: 12,
    cookingFuel: 'lpg',
    heating: 'none',
    activity: 'morning',
    hasPurifier: false,
    household: { children: true, elderly: false, respiratory: false, pregnant: false },
    ...overrides,
  };
}

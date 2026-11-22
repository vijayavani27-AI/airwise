// AirWise front end. All server data is rendered with textContent (never innerHTML)
// to prevent XSS, and the CSP forbids inline scripts.

const form = document.getElementById('advice-form');
const submitBtn = document.getElementById('submit-btn');
const locateBtn = document.getElementById('locate-btn');
const cityInput = document.getElementById('city');
const errorBox = document.getElementById('form-error');
const results = document.getElementById('results');
const template = document.getElementById('results-template');

let coords = null;

const POLLUTANT_NAMES = {
  pm2_5: 'PM2.5',
  pm10: 'PM10',
  no2: 'NO₂',
  o3: 'Ozone',
  so2: 'SO₂',
  co: 'CO',
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function clearError() {
  errorBox.textContent = '';
  errorBox.hidden = true;
}

function setLoading(isLoading) {
  submitBtn.disabled = isLoading;
  submitBtn.textContent = isLoading ? 'Building your plan…' : 'Get my clean-air plan';
  results.setAttribute('aria-busy', String(isLoading));
}

const clock = (isoLocal) => (isoLocal ? isoLocal.slice(11, 16) : '');

function buildPayload() {
  const data = new FormData(form);
  const payload = {
    commuteMode: data.get('commuteMode'),
    commuteKm: data.get('commuteKm'),
    cookingFuel: data.get('cookingFuel'),
    heating: data.get('heating'),
    activity: data.get('activity'),
    hasPurifier: data.get('hasPurifier') === 'on',
    household: {
      children: data.get('children') === 'on',
      elderly: data.get('elderly') === 'on',
      respiratory: data.get('respiratory') === 'on',
      pregnant: data.get('pregnant') === 'on',
    },
  };
  const city = String(data.get('city') || '').trim();
  if (city) payload.city = city;
  else if (coords) Object.assign(payload, coords);
  return payload;
}

function fillList(list, items, render) {
  list.replaceChildren(...items.map(render));
}

function renderForecast(container, forecast) {
  const max = Math.max(200, ...forecast.map((p) => p.aqi));
  const bars = forecast.map((point) => {
    const bar = el('span', `bar level-${levelFor(point.aqi)}`);
    bar.style.height = `${Math.max(6, (point.aqi / max) * 100)}%`;
    bar.title = `${clock(point.time)}: AQI ${point.aqi}`;
    return bar;
  });
  container.replaceChildren(...bars);
  if (forecast.length > 0) {
    const min = Math.min(...forecast.map((p) => p.aqi));
    const peak = Math.max(...forecast.map((p) => p.aqi));
    container.setAttribute('aria-label', `Hourly AQI forecast for the next ${forecast.length} hours, ranging from ${min} to ${peak}.`);
  }
}

function levelFor(aqi) {
  if (aqi <= 50) return 'good';
  if (aqi <= 100) return 'moderate';
  if (aqi <= 150) return 'sensitive';
  if (aqi <= 200) return 'unhealthy';
  if (aqi <= 300) return 'very-unhealthy';
  return 'hazardous';
}

function renderResults(data) {
  const view = template.content.cloneNode(true);
  const field = (name) => view.querySelector(`[data-field="${name}"]`);
  const { location, air, impact, plan, source } = data;

  field('place').textContent = [location.name, location.country].filter(Boolean).join(', ');
  field('observed').textContent = air.observedAt.replace('T', ' ');
  field('aqi').textContent = String(air.aqi);
  field('badge').classList.add(`level-${air.category.level}`);
  field('badge').setAttribute('aria-label', `US AQI ${air.aqi}, ${air.category.label}`);
  field('category').textContent = `${air.category.label}. ${air.category.advice}`;

  const pollutants = field('pollutants');
  for (const [key, label] of Object.entries(POLLUTANT_NAMES)) {
    const value = air.pollutants[key];
    if (typeof value !== 'number') continue;
    const item = el('div', 'pollutant');
    item.append(el('dt', '', label), el('dd', '', `${Math.round(value)} µg/m³`));
    pollutants.append(item);
  }

  renderForecast(field('forecast'), air.forecast);
  field('window').textContent = air.cleanestWindow
    ? `Cleanest time outdoors: ${air.cleanestWindow.day} ${clock(air.cleanestWindow.start)}–${clock(air.cleanestWindow.end)} (AQI ~${air.cleanestWindow.avgAqi}).`
    : 'No forecast window available.';

  const stats = [];
  if (impact.exposure.pm25 !== null) {
    stats.push([`${impact.exposure.whoMultiple}×`, 'the WHO daily PM2.5 guideline']);
    stats.push([`${impact.exposure.cigarettesPerDay}`, 'cigarettes/day equivalent exposure']);
  }
  stats.push([`${impact.commute.weeklyKgCo2} kg`, 'CO₂ per week from your commute']);
  if (impact.commute.switch) stats.push([`${impact.commute.switch.savedKgPerYear} kg`, 'CO₂ you could save per year']);
  fillList(field('stats'), stats, ([value, label]) => {
    const li = el('li', 'stat');
    li.append(el('strong', '', value), el('span', '', label));
    return li;
  });

  field('source').textContent = source === 'gemini' ? '✨ Personalised by Gemini' : 'Rule-based plan';
  field('summary').textContent = plan.summary;

  fillList(field('routine'), plan.routine, (step) => {
    const li = el('li');
    li.append(el('span', 'time', step.time), el('strong', '', step.activity), el('p', 'small', step.reason));
    return li;
  });
  const renderTip = (title, detail, impactText) => {
    const li = el('li');
    li.append(el('strong', '', title));
    if (detail) li.append(el('p', 'small', detail));
    if (impactText) li.append(el('p', 'impact small', `Impact: ${impactText}`));
    return li;
  };
  fillList(field('indoorTips'), plan.indoorTips, (t) => renderTip(t.title, t.detail, t.impact));
  fillList(field('alternatives'), plan.alternatives, (a) => renderTip(a.change, '', a.impact));
  fillList(field('healthAlerts'), plan.healthAlerts, (text) => el('li', '', text));

  results.replaceChildren(view);
  const heading = results.querySelector('#results-title');
  heading?.focus();
}

async function submit(event) {
  event.preventDefault();
  clearError();
  const payload = buildPayload();
  if (!payload.city && payload.latitude === undefined) {
    showError('Please enter your city or use your location.');
    cityInput.focus();
    return;
  }

  setLoading(true);
  try {
    const response = await fetch('/api/advice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const details = Array.isArray(data.details) ? ` ${data.details.join('. ')}.` : '';
      throw new Error(`${data.error || 'Something went wrong.'}${details}`);
    }
    renderResults(data);
  } catch (error) {
    showError(error.message || 'Could not reach the server. Check your connection.');
  } finally {
    setLoading(false);
  }
}

function locate() {
  clearError();
  if (!('geolocation' in navigator)) {
    showError('Your browser does not support location. Please type your city.');
    return;
  }
  locateBtn.disabled = true;
  locateBtn.textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(
    (position) => {
      coords = { latitude: position.coords.latitude, longitude: position.coords.longitude };
      cityInput.value = '';
      cityInput.placeholder = 'Using your current location';
      locateBtn.textContent = 'Location set ✓';
      locateBtn.disabled = false;
    },
    () => {
      showError('We could not get your location. Please type your city instead.');
      locateBtn.textContent = 'Use my location';
      locateBtn.disabled = false;
    },
    { timeout: 10000, maximumAge: 600000 },
  );
}

cityInput.addEventListener('input', () => {
  if (cityInput.value.trim()) coords = null;
});
form.addEventListener('submit', submit);
locateBtn.addEventListener('click', locate);

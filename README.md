# 🌬️ AirWise: Urban Air Quality Assistant

**PromptWars Virtual, Challenge 6.** AirWise is a GenAI-powered assistant that helps families and communities get through severe winter smog and urban air pollution. It uses **live air-quality data** for your location and **Google Gemini** to write a personalised plan for the day:

- 🕒 **A low-emission daily routine.** Outdoor time goes in the forecast's cleanest window, peak-pollution hours are flagged, and your commute is rethought.
- 🏠 **Indoor air-quality hacks.** Clean-room setup, purifier use, avoiding indoor smoke, damp cleaning.
- ♻️ **Sustainable alternatives.** Commute switches, carpooling, cleaner cooking and heating fuels, no open burning.
- 📊 **The direct impact of each choice, in plain numbers.** kg of CO₂ saved per week and year, PM2.5 compared with the WHO guideline, cigarette-equivalent exposure, and estimated indoor PM2.5 with and without a purifier.

## How it works

```
Browser ──► POST /api/advice ──► validate (whitelist) ──► geocode city (Open-Meteo)
                                                     └──► live AQI + 24h forecast (Open-Meteo / CAMS)
                                                     └──► deterministic impact maths (CO₂, exposure)
                                                     └──► Gemini (structured JSON output) ──► sanitise ──► UI
                                                              └─(on failure)─► rule-based planner
```

1. **Grounded GenAI.** The server computes the real numbers first (emissions, exposure, cleanest window), then asks Gemini to explain and personalise them. Because Gemini uses structured output (`responseSchema`), the response is always valid JSON in a fixed shape.
2. **Graceful degradation.** If Gemini is unavailable, slow or out of quota, a deterministic rule engine produces a plan in the same shape, so users always get safe advice. If the configured model has been retired (HTTP 404), it automatically falls back to `gemini-flash-latest` and remembers the model that works.
3. **Resilient data fetching.** Free air-quality APIs often rate-limit shared cloud IPs. If the server gets a 429, it replies `503 AIR_DATA_UNAVAILABLE` with the coordinates, the browser fetches Open-Meteo itself using the user's own IP, and the server strictly validates that data. It uses it for that one request only and never caches it (no cache poisoning).
4. **Efficiency.** In-memory TTL + LRU caches with de-duplication of in-flight requests: geocoding 24h, AQI 15 min, AI plans 10 min. Also gzip compression and cached static assets.

## Google services and GenAI used

| Service | Where |
| --- | --- |
| **Gemini API** (`gemini-flash-latest` by default, via Google AI Studio) | `src/services/gemini.js`: writes the personalised routine, indoor tips, alternatives and impact explanations, with JSON-schema structured output |
| **Google Cloud Run** (deployment target) | `Dockerfile`: stateless container, listens on `$PORT`, graceful SIGTERM shutdown |
| Open-Meteo Air Quality API (Copernicus CAMS) | `src/services/airQuality.js`: live AQI, pollutants and hourly forecast |

## Evaluation criteria

| Criterion | What we did |
| --- | --- |
| **Code quality** | Small modules with a single job each and dependency injection (every service is a factory), typed errors, JSDoc, ESLint flat config, no globals |
| **Security** | Helmet with a strict CSP (no inline scripts), 10 kb body limit, per-IP rate limiting, whitelist validation, secrets only in env vars, generic error messages (no stack traces), output rendered with `textContent` (no XSS) |
| **Prompt-injection defence** | Free text never reaches the LLM. The city is resolved to a canonical geocoded name, every other field is an enum, number or boolean, the system prompt treats input as data, and the LLM output is sanitised and size-capped |
| **Efficiency** | TTL/LRU caches, request de-duplication, compression, static caching, timeouts on every upstream call (`AbortSignal.timeout`) |
| **Testing** | 67 tests with the built-in `node:test` (unit, service and HTTP integration), all network calls faked, coverage via `npm run test:coverage` |
| **Accessibility** | Semantic landmarks, skip link, labelled fieldsets, `aria-live` results, focus moved to results, colour plus text for AQI levels, 44px touch targets, visible focus ring, dark mode, `prefers-reduced-motion` |

## Run locally

```bash
npm install
cp .env.example .env    # add your GEMINI_API_KEY (free at https://aistudio.google.com/apikey)
node --env-file=.env server.js
# open http://localhost:8080
```

```bash
npm test               # run the test suite
npm run test:coverage  # with coverage
npm run lint           # ESLint
```

Without a `GEMINI_API_KEY` the app still works using the rule-based planner.

## Deploy to Google Cloud Run

```bash
gcloud run deploy airwise --source . --region asia-south1 --allow-unauthenticated \
  --set-env-vars GEMINI_MODEL=gemini-flash-latest --set-secrets GEMINI_API_KEY=gemini-api-key:latest
```

## API

`POST /api/advice`

```json
{
  "city": "Delhi",
  "commuteMode": "car",
  "commuteKm": 12,
  "cookingFuel": "lpg",
  "heating": "none",
  "activity": "morning",
  "hasPurifier": false,
  "household": { "children": true, "elderly": false, "respiratory": false, "pregnant": false }
}
```

You can send `latitude` and `longitude` instead of `city`. The response includes `location`, `air` (AQI, pollutants, forecast, cleanest window), `impact`, `plan` and `source` (`gemini` or `rules`).

## Disclaimer

The figures are estimates for guidance only, not medical advice. Emission factors are approximate Indian-city averages.

## License

MIT

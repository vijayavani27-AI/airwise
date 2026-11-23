import { loadConfig } from './src/config.js';
import { createApp } from './src/app.js';
import { createAirQualityService } from './src/services/airQuality.js';
import { createGeminiService } from './src/services/gemini.js';
import { createAssistant } from './src/services/assistant.js';

const config = loadConfig();

const gemini = createGeminiService({
  apiKey: config.geminiApiKey,
  model: config.geminiModel,
  timeoutMs: config.geminiTimeoutMs,
});
const airQuality = createAirQualityService({ timeoutMs: config.upstreamTimeoutMs });
const assistant = createAssistant({ airQuality, gemini });

const app = createApp({
  assistant,
  aiEnabled: gemini.enabled,
  rateLimitPerMinute: config.rateLimitPerMinute,
});

const server = app.listen(config.port, () => {
  console.log(`AirWise listening on port ${config.port} (Gemini ${gemini.enabled ? `enabled: ${config.geminiModel}` : 'disabled - using rule-based plans'})`);
});

// Graceful shutdown for Cloud Run / containers.
const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

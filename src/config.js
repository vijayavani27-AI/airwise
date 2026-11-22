/**
 * Centralised, validated runtime configuration.
 * All secrets come from environment variables - never from source code.
 */

const toPositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * @param {NodeJS.ProcessEnv} env
 */
export function loadConfig(env = process.env) {
  return Object.freeze({
    port: toPositiveInt(env.PORT, 8080),
    nodeEnv: env.NODE_ENV || 'development',
    geminiApiKey: (env.GEMINI_API_KEY || '').trim(),
    geminiModel: (env.GEMINI_MODEL || 'gemini-2.5-flash').trim(),
    upstreamTimeoutMs: toPositiveInt(env.UPSTREAM_TIMEOUT_MS, 15000),
    rateLimitPerMinute: toPositiveInt(env.RATE_LIMIT_PER_MINUTE, 30),
  });
}

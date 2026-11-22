import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import { rateLimit } from 'express-rate-limit';
import { validateAdviceRequest, OPTIONS } from './lib/validation.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/**
 * Build the Express app. Dependencies are injected so the HTTP layer can be
 * tested without network access.
 * @param {{ assistant: { advise: Function }, aiEnabled: boolean, rateLimitPerMinute?: number, logger?: Console }} deps
 */
export function createApp({ assistant, aiEnabled, rateLimitPerMinute = 30, logger = console }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: true,
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '10kb' }));

  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

  app.use(
    '/api',
    rateLimit({
      windowMs: 60 * 1000,
      limit: rateLimitPerMinute,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      message: { error: 'Too many requests. Please wait a minute and try again.' },
    }),
  );

  app.get('/api/meta', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json({ aiEnabled, options: OPTIONS });
  });

  app.post('/api/advice', async (req, res) => {
    const input = validateAdviceRequest(req.body);
    const result = await assistant.advise(input);
    res.set('Cache-Control', 'no-store').json(result);
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  app.use(express.static(PUBLIC_DIR, { maxAge: '1h', etag: true }));

  // Central error handler: never leak stack traces or upstream details.
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Request body must be valid JSON' });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request body is too large' });
    }
    if (err.expose && err.status >= 400 && err.status < 600) {
      return res.status(err.status).json({ error: err.message, ...(err.details && { details: err.details }) });
    }
    logger.error?.(err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return app;
}

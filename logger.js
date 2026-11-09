import pino from 'pino';

// Logs structurés (JSON, une ligne par événement) : lisibles et filtrables dans Render > Logs.
// Niveau réglable avec LOG_LEVEL (debug, info, warn, error). Silencieux pendant les tests.
export const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  base: { service: 'revisio' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: ['req.headers.authorization', '*.password', '*.token', '*.fcm_token', '*.access_token'], censor: '[masqué]' }
});

export const childLogger = (module) => logger.child({ module });

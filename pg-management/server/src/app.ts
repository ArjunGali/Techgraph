import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { query } from './db/pool.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { propertyRouter } from './modules/property/property.routes.js';
import { tenantsRouter } from './modules/tenants/tenants.routes.js';
import { vacanciesRouter } from './modules/vacancies/vacancies.routes.js';
import { pricingRouter } from './modules/pricing/pricing.routes.js';
import { metersRouter } from './modules/meters/meters.routes.js';
import { billingRouter } from './modules/billing/billing.routes.js';
import { paymentsRouter } from './modules/payments/payments.routes.js';
import { messagingRouter } from './modules/messaging/messaging.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { reportsRouter } from './modules/reports/reports.routes.js';
import { operationsRouter } from './modules/operations/operations.routes.js';
import { automationRouter } from './modules/automation/automation.routes.js';

/**
 * The API the Android app talks to.
 *
 * This is the only component with database credentials. The packaged APK holds
 * a base URL and nothing else — it authenticates as a user and every rule
 * about what that user may see or do is enforced here.
 */
export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // The client is a packaged native app rendering its own markup, so the
  // browser-oriented resource policies do not apply; the API only ever
  // returns JSON and streamed file downloads.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

  const origins = env.CORS_ORIGINS.split(',').map((origin) => origin.trim());
  app.use(
    cors({
      origin: origins.includes('*') ? true : origins,
      credentials: false,
    }),
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  app.get('/api/health', async (_req, res) => {
    try {
      await query('SELECT 1');
      res.json({ status: 'ok', database: 'connected', time: new Date().toISOString() });
    } catch (error) {
      res.status(503).json({ status: 'degraded', database: 'unreachable', error: (error as Error).message });
    }
  });

  app.get('/api/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/property', propertyRouter);
  app.use('/api/tenants', tenantsRouter);
  app.use('/api/vacancies', vacanciesRouter);
  app.use('/api/pricing', pricingRouter);
  app.use('/api/meters', metersRouter);
  app.use('/api/billing', billingRouter);
  app.use('/api/payments', paymentsRouter);
  app.use('/api/messaging', messagingRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/operations', operationsRouter);
  app.use('/api/automation', automationRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

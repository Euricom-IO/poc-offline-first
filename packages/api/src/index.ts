import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import type { AppEnv } from './auth';
import { authRoutes } from './routes/auth';
import { todoRoutes } from './routes/todos';
import { userRoutes } from './routes/users';
import { eventRoutes } from './routes/events';
import { dataRoutes } from './routes/data';
import { powersyncRoutes } from './routes/powersync';

const app = new Hono<AppEnv>();

app.use('*', logger());
app.use('/api/*', cors());

app.get('/health', (c) => c.json({ status: 'ok' }));
// Same check under /api so it is reachable through the web dev-server proxy
// (which only forwards /api/*) — used by the client sync engine's heartbeat.
app.get('/api/health', (c) => c.json({ status: 'ok' }));

app.route('/api/auth', authRoutes);

// SPA -> API
app.route('/api/todos', todoRoutes);
app.route('/api/users', userRoutes);

// SQL Electric
app.route('/api/events', eventRoutes);

// PowerSync upload endpoint (used by the web-powersync client).
app.route('/api/data', dataRoutes);

// PowerSync auth: mints short-lived sync tokens for the web-powersync client.
app.route('/api/powersync', powersyncRoutes);

const port = Number(process.env.API_PORT ?? 3000);
console.log(`🚀 API listening on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};

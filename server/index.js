import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import apiRouter from './routes/api.js';
import { closeDriver } from './config/db.js';
import { notFound, errorHandler } from './middleware/errors.js';

const app = express();

// Allow the deployed client origin in production; open in local dev.
app.use(cors({ origin: process.env.CLIENT_ORIGIN || '*' }));
app.use(express.json());

app.use('/api', apiRouter);

// Any route not handled above is a 404 — the client only ever calls /api/*.
app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => {
  console.log(`TechGraph API listening on http://localhost:${PORT}`);
});

// Drain the database connection pool on shutdown (Ctrl+C locally, SIGTERM on
// Render) so the process exits cleanly instead of leaving connections open.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.close();
    await closeDriver();
    process.exit(0);
  });
}

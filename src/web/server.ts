import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { setAuthorized } from '../database.js';
import { resolveOAuth } from '../oauth-store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function startWebServer(): void {
  const app = express();

  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/callback', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'callback.html'));
  });

  app.post('/api/store-token', (req, res) => {
    const { state, access_token } = req.body;

    if (!state || !access_token) {
      res.status(400).json({ error: 'Missing state or access_token' });
      return;
    }

    const discordId = String(state);

    try {
      setAuthorized(discordId, String(access_token));
      resolveOAuth(discordId, String(access_token));
      res.json({ ok: true });
    } catch (err) {
      console.error('[web] Failed to store token:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.listen(config.port, () => {
    console.log(`[web] OAuth callback server listening on port ${config.port}`);
  });
}

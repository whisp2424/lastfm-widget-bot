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

  app.get('/image-proxy', async (req, res) => {
    const imageUrl = req.query.url as string | undefined;
    const ts = req.query.t as string | undefined;
    if (!imageUrl) {
      res.status(400).end();
      return;
    }

    const bustedUrl = imageUrl.includes('?')
      ? `${imageUrl}&_t=${ts ?? Date.now()}`
      : `${imageUrl}?_t=${ts ?? Date.now()}`;

    try {
      const response = await fetch(bustedUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      if (!response.ok) {
        res.status(502).end();
        return;
      }

      const contentType =
        response.headers.get('content-type') ?? 'image/jpeg';
      const buffer = Buffer.from(await response.arrayBuffer());

      res.set({
        'Content-Type': contentType,
        'Content-Length': buffer.length,
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(buffer);
    } catch {
      res.status(502).end();
    }
  });

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

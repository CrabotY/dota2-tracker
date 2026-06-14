/**
 * Dota 2 Tracker — GSI receiver + live dashboard server.
 *
 * Dota 2 (via a Game State Integration config file) POSTs the full game state
 * as JSON to this server several times per second. We validate the shared auth
 * token, keep the latest snapshot, enrich it with a few derived stats, and push
 * it to every connected browser over WebSocket so the dashboard updates live.
 *
 * Usable two ways:
 *   - `node server.js`                  → runs standalone (CLI / dev)
 *   - `require('./server').startServer` → embedded by the packaged .exe launcher
 */

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

const DEFAULT_PORT = Number(process.env.PORT) || 3000;
// Shared secret. Dota sends this inside the payload under auth.token.
// Must match the token in the GSI .cfg file. Override with GSI_AUTH_TOKEN.
const DEFAULT_TOKEN = process.env.GSI_AUTH_TOKEN || 'DOTA2_TRACKER_SECRET';

/**
 * Compute a handful of stats Dota doesn't send directly but players expect:
 * KDA ratio, a net-worth fallback, and readable alive/respawn flags.
 */
function enrich(raw) {
  const out = { ...raw, derived: {} };
  const p = raw.player || {};
  const h = raw.hero || {};

  if (typeof p.kills === 'number') {
    const deaths = p.deaths || 0;
    out.derived.kda = deaths === 0
      ? (p.kills + (p.assists || 0)).toFixed(1)
      : ((p.kills + (p.assists || 0)) / deaths).toFixed(2);
  }

  if (typeof p.net_worth === 'number') {
    out.derived.netWorth = p.net_worth;
  } else if (typeof p.gold === 'number') {
    out.derived.netWorth = p.gold;
  }

  if (h && typeof h.alive === 'boolean') {
    out.derived.alive = h.alive;
    out.derived.respawnSeconds = h.respawn_seconds || 0;
  }

  out.derived.receivedAt = Date.now();
  return out;
}

/**
 * Build and start the tracker HTTP + WebSocket server.
 * @param {object} [opts]
 * @param {number} [opts.port]       Listen port (default 3000 / $PORT).
 * @param {string} [opts.token]      Expected GSI auth token.
 * @param {string} [opts.publicDir]  Folder to serve the dashboard from.
 * @param {boolean}[opts.quiet]      Suppress the startup banner.
 * @returns {Promise<{server: http.Server, port: number}>}
 */
function startServer(opts = {}) {
  const port = opts.port || DEFAULT_PORT;
  const token = opts.token || DEFAULT_TOKEN;
  const publicDir = opts.publicDir || path.join(__dirname, 'public');

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(publicDir));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  // ws attaches to the http server and re-emits its 'error' (e.g. EADDRINUSE)
  // on itself. Without a handler that throws and crashes the process, which
  // would defeat the launcher's "try the next free port" retry. Swallow it
  // here — the http server's own 'error' below rejects the start promise.
  wss.on('error', () => {});

  let latestState = null; // replayed to any browser that connects

  function broadcast(obj) {
    const data = JSON.stringify(obj);
    for (const client of wss.clients) {
      if (client.readyState === 1 /* OPEN */) client.send(data);
    }
  }

  function handleGsi(req, res) {
    const body = req.body || {};
    const sent = body.auth && body.auth.token;
    if (sent !== token) {
      console.warn('[GSI] Rejected payload: bad auth token');
      return res.status(403).json({ error: 'invalid auth token' });
    }
    const enriched = enrich(body);
    latestState = enriched;
    broadcast({ type: 'state', payload: enriched });

    const clock = body.map && body.map.clock_time;
    const hero = body.hero && body.hero.name;
    if (hero) console.log(`[GSI] ${hero} @ clock ${clock ?? '?'}s`);
    res.json({ ok: true });
  }

  app.post('/', handleGsi);
  app.post('/gsi', handleGsi);

  app.get('/status', (_req, res) => {
    res.json({
      connectedBrowsers: wss.clients.size,
      hasState: latestState !== null,
      lastUpdate: latestState ? latestState.derived.receivedAt : null,
    });
  });

  wss.on('connection', (socket) => {
    console.log(`[WS] Browser connected (${wss.clients.size} total)`);
    socket.send(JSON.stringify(
      latestState ? { type: 'state', payload: latestState } : { type: 'waiting' }
    ));
    socket.on('close', () =>
      console.log(`[WS] Browser disconnected (${wss.clients.size} total)`));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      if (!opts.quiet) {
        console.log('────────────────────────────────────────────────');
        console.log(' Dota 2 Tracker is running');
        console.log(`  Dashboard:    http://localhost:${port}`);
        console.log(`  GSI endpoint: http://localhost:${port}/  (POST)`);
        console.log(`  Auth token:   ${token}`);
        console.log('────────────────────────────────────────────────');
        console.log(' Waiting for Dota 2 to send game state...');
      }
      resolve({ server, port });
    });
  });
}

module.exports = { startServer, enrich };

// Run standalone when invoked directly (`node server.js`).
if (require.main === module) {
  startServer().catch((err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`\n❌ Port ${DEFAULT_PORT} is already in use.`);
      console.error('   Set a different port:  PORT=3001 npm start\n');
    } else {
      console.error('Failed to start server:', err);
    }
    process.exit(1);
  });
}

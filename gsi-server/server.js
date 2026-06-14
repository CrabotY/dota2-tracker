// gsi-server/server.js
// Base: ReXaXeR's OpenDota/Valve scouting server.
// Merged in (from CrabotY's tracker): live GSI is now the PRIMARY data source —
// the full game-state payload is enriched and pushed to the UI over WebSocket,
// so in-game stats update several times per second (the original only polled
// external APIs that have no live data for ordinary matches).
const path = require('path');
const fs   = require('fs');

require('dotenv').config({ path: path.join(__dirname, '../.env') });
if (process.env.USER_ENV_PATH && fs.existsSync(process.env.USER_ENV_PATH)) {
  require('dotenv').config({ path: process.env.USER_ENV_PATH, override: true });
}

const express = require('express');
const http    = require('http');
const axios   = require('axios');
const { WebSocketServer } = require('ws');
const { findSteamId, steam64ToAccountId } = require('../lib/steam-id');

const app    = express();
const server = http.createServer(app);

const PORT       = Number(process.env.GSI_PORT) || 3001;
// Shared secret — must match the token in the GSI .cfg. Empty string disables
// the check (kept lax because GSI only ever talks to localhost).
const AUTH_TOKEN = process.env.GSI_AUTH_TOKEN ?? 'DOTA2_TRACKER_SECRET';

app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const OPENDOTA = 'https://api.opendota.com/api';

let currentState   = null;   // full enriched GSI snapshot (live)
let playerCache    = {};
let heroesCache    = {};
let currentMatchId = null;

// ─── Кто "я" — определяется автоматически ─────────────────────────────────────
// Приоритет: account id из живого GSI > SteamID из локального логина Steam.
let liveAccountId  = null;   // из текущего матча (GSI)
let localAccountId = null;   // из <steam>/config/loginusers.vdf
function detectLocalSteam() {
  try {
    const sid = findSteamId();
    if (sid) {
      localAccountId = steam64ToAccountId(sid);
      console.log(`[Steam] Аккаунт определён автоматически: ${localAccountId} (SteamID ${sid})`);
    } else {
      console.log('[Steam] Не удалось определить аккаунт из Steam — заработает по данным матча.');
    }
  } catch (e) { console.error('[Steam] detect:', e.message); }
}
function myAccountId() { return liveAccountId || localAccountId; }

// ─── WebSocket: live push to the overlay ──────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('error', () => {}); // don't crash on bind races
function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
}
wss.on('connection', (socket) => {
  socket.send(JSON.stringify(
    currentState ? { type: 'state', payload: currentState } : { type: 'waiting' }
  ));
});

// Derive the handful of stats Dota doesn't send but players expect.
function enrich(raw) {
  const out = { ...raw, derived: {} };
  const p = raw.player || {};
  const h = raw.hero || {};
  if (typeof p.kills === 'number') {
    const d = p.deaths || 0;
    out.derived.kda = d === 0
      ? (p.kills + (p.assists || 0)).toFixed(1)
      : ((p.kills + (p.assists || 0)) / d).toFixed(2);
  }
  out.derived.netWorth = typeof p.net_worth === 'number' ? p.net_worth
    : (typeof p.gold === 'number' ? p.gold : 0);
  if (h && typeof h.alive === 'boolean') {
    out.derived.alive = h.alive;
    out.derived.respawnSeconds = h.respawn_seconds || 0;
  }
  out.derived.receivedAt = Date.now();
  return out;
}

// ─── Герои ────────────────────────────────────────────────────────────────────
async function loadHeroes() {
  try {
    const { data } = await axios.get(`${OPENDOTA}/heroes`, { timeout: 8000 });
    data.forEach(h => { heroesCache[h.id] = h.localized_name; });
    console.log(`[OpenDota] Загружено ${data.length} героев`);
  } catch (e) {
    console.error('[OpenDota] Ошибка загрузки героев:', e.message);
  }
}

// ─── Профиль игрока ───────────────────────────────────────────────────────────
async function fetchPlayerProfile(accountId) {
  if (!accountId || accountId === 0) return null;
  const id = Number(accountId);
  if (playerCache[id]) return playerCache[id];

  try {
    const [profile, wl, recent, heroes] = await Promise.allSettled([
      axios.get(`${OPENDOTA}/players/${id}`,             { timeout: 8000 }),
      axios.get(`${OPENDOTA}/players/${id}/wl?limit=20`, { timeout: 8000 }),
      axios.get(`${OPENDOTA}/players/${id}/recentMatches`,{ timeout: 8000 }),
      axios.get(`${OPENDOTA}/players/${id}/heroes?limit=5`,{ timeout: 8000 }),
    ]);

    const p    = profile.value?.data;
    const wlD  = wl.value?.data;
    const rec  = recent.value?.data?.slice(0, 10) || [];
    const heroList = heroes.value?.data?.slice(0, 5) || [];

    const wins  = wlD?.win  || 0;
    const losses= wlD?.lose || 0;
    const total = wins + losses;
    const wr    = total > 0 ? Math.round(wins / total * 100) : null;

    const avg = (arr, fn) => arr.length
      ? +(arr.reduce((s, x) => s + (fn(x) || 0), 0) / arr.length).toFixed(1) : 0;

    const avgKDA = rec.length ? {
      k: avg(rec, x => x.kills),
      d: avg(rec, x => x.deaths),
      a: avg(rec, x => x.assists),
    } : null;

    const avgGPM = Math.round(avg(rec, x => x.gold_per_min));
    const avgXPM = Math.round(avg(rec, x => x.xp_per_min));

    const laneRoles = rec.map(m => m.lane_role).filter(Boolean);
    const mostCommonRole = laneRoles.length
      ? [1,2,3,4,5].sort((a,b) =>
          laneRoles.filter(r=>r===b).length - laneRoles.filter(r=>r===a).length
        )[0]
      : null;

    const topHeroes = heroList.map(h => ({
      name:    heroesCache[h.hero_id] || `Hero ${h.hero_id}`,
      games:   h.games,
      winrate: h.games > 0 ? Math.round(h.win / h.games * 100) : 0,
    }));

    const result = {
      accountId: id,
      name:     p?.profile?.personaname || 'Аноним',
      avatar:   p?.profile?.avatarmedium || null,
      rank:     p?.rank_tier || null,
      winrate: wr, totalGames: total, wins, losses,
      avgKDA, avgGPM, avgXPM,
      mostCommonRole,
      topHeroes,
      profileUrl: `https://www.opendota.com/players/${id}`,
    };

    playerCache[id] = result;
    return result;
  } catch (e) {
    console.error(`[OpenDota] Профиль ${accountId}:`, e.message);
    return { accountId: id, name: 'Ошибка загрузки', winrate: null, avgKDA: null };
  }
}

// ─── Матч (пост-гейм, OpenDota) ───────────────────────────────────────────────
async function fetchMatch(matchId) {
  const { data } = await axios.get(`${OPENDOTA}/matches/${matchId}`, { timeout: 15000 });
  if (!data?.players) throw new Error('Матч не найден или не спарсен');

  const profiles = await Promise.all(data.players.map(p => fetchPlayerProfile(p.account_id)));

  const players = data.players.map((p, i) => ({
    account_id:   p.account_id,
    personaname:  p.personaname || 'Аноним',
    hero_id:      p.hero_id,
    heroName:     heroesCache[p.hero_id] || `Hero ${p.hero_id}`,
    team_number:  p.player_slot < 128 ? 0 : 1,
    player_slot:  p.player_slot,
    lane_role:    p.lane_role,
    is_roaming:   p.is_roaming,
    kills:        p.kills,
    deaths:       p.deaths,
    assists:      p.assists,
    gold_per_min: p.gold_per_min,
    xp_per_min:   p.xp_per_min,
    net_worth:    p.net_worth,
    hero_damage:  p.hero_damage,
    tower_damage: p.tower_damage,
    hero_healing: p.hero_healing,
    last_hits:    p.last_hits,
    denies:       p.denies,
    win:          data.radiant_win ? (p.player_slot < 128) : (p.player_slot >= 128),
    rank_tier:    p.rank_tier,
    profile:      profiles[i],
  }));

  return {
    match_id:    data.match_id,
    radiant_win: data.radiant_win,
    duration:    data.duration,
    game_mode:   data.game_mode,
    players,
  };
}

// ─── Live матч через Valve WebAPI (нужен STEAM_API_KEY) ───────────────────────
async function fetchLiveMatch(matchId) {
  const key = process.env.STEAM_API_KEY || '';
  if (!key) throw new Error('STEAM_API_KEY не задан');

  const { data } = await axios.get('https://api.steampowered.com/IDOTA2Match_570/GetMatchDetails/v1/', {
    params: { match_id: matchId, key },
    timeout: 8000,
  });

  const match = data?.result;
  if (!match || match.error) throw new Error(match?.error || 'Матч не найден в Valve API');

  const profiles = await Promise.all(
    (match.players || []).map(p => fetchPlayerProfile(p.account_id))
  );

  const players = (match.players || []).map((p, i) => ({
    account_id:   p.account_id,
    hero_id:      p.hero_id,
    heroName:     heroesCache[p.hero_id] || `Hero ${p.hero_id}`,
    team_number:  p.player_slot < 128 ? 0 : 1,
    player_slot:  p.player_slot,
    kills:        p.kills,
    deaths:       p.deaths,
    assists:      p.assists,
    gold_per_min: p.gold_per_min,
    xp_per_min:   p.xp_per_min,
    net_worth:    p.net_worth,
    hero_damage:  p.hero_damage,
    last_hits:    p.last_hits,
    denies:       p.denies,
    personaname:  profiles[i]?.name || 'Игрок',
    rank_tier:    profiles[i]?.rank,
    profile:      profiles[i],
  }));

  return { match_id: Number(matchId), radiant_win: match.radiant_win, duration: match.duration, game_mode: match.game_mode, live: true, players };
}

// ─── Live через OpenDota /live (без ключа; только публичные трансляции) ────────
async function fetchLiveOpenDota(matchId) {
  const { data } = await axios.get(`${OPENDOTA}/live`, { timeout: 8000 });
  const liveMatch = data?.find(m => String(m.match_id) === String(matchId) || String(m.lobby_id) === String(matchId));
  if (!liveMatch) throw new Error('Матч не транслируется live');

  const allPlayers = [
    ...(liveMatch.players || []),
    ...(liveMatch.radiant_team?.players || []),
    ...(liveMatch.dire_team?.players   || []),
  ].filter(p => p.account_id);
  if (!allPlayers.length) throw new Error('Нет данных об игроках');

  const profiles = await Promise.all(allPlayers.map(p => fetchPlayerProfile(p.account_id)));
  const players = allPlayers.map((p, i) => ({
    account_id:   p.account_id,
    hero_id:      p.hero_id,
    heroName:     heroesCache[p.hero_id] || `Hero ${p.hero_id}`,
    team_number:  p.team === 'radiant' || p.is_radiant ? 0 : 1,
    player_slot:  i,
    kills:        p.kills || 0,
    deaths:       p.deaths || 0,
    assists:      p.assists || 0,
    gold_per_min: p.gold_per_min || 0,
    net_worth:    p.net_worth || 0,
    hero_damage:  p.hero_damage || 0,
    last_hits:    p.last_hits || 0,
    personaname:  profiles[i]?.name || 'Игрок',
    rank_tier:    profiles[i]?.rank,
    profile:      profiles[i],
  }));
  return { match_id: Number(matchId), radiant_win: null, duration: liveMatch.duration, live: true, players };
}

// ─── GSI endpoint — PRIMARY live source ───────────────────────────────────────
app.post('/gsi', (req, res) => {
  const body = req.body || {};
  if (AUTH_TOKEN && body.auth?.token !== AUTH_TOKEN) {
    return res.status(403).json({ error: 'invalid auth token' });
  }

  currentState = enrich(body);

  // Learn who "I" am from the live feed (works even without any Steam key).
  const pl = body.player || {};
  if (pl.accountid) liveAccountId = String(pl.accountid);
  else if (pl.steamid) liveAccountId = steam64ToAccountId(pl.steamid);

  const matchId = body.map?.matchid;
  if (matchId && matchId !== currentMatchId && matchId !== '0') {
    currentMatchId = matchId;
    playerCache = {};
    console.log(`[GSI] Новый матч: ${currentMatchId}`);
  }
  // Push the full live state to every open overlay.
  broadcast({ type: 'state', payload: currentState });
  res.sendStatus(200);
});

app.get('/state',   (req, res) => res.json(currentState || { gameState: 'WAITING' }));
app.get('/health',  (req, res) => res.json({ ok: true, matchId: currentMatchId, browsers: wss.clients.size, me: myAccountId() }));

// «Я» — автоматически определённый профиль текущего игрока (без ручного ввода).
app.get('/me', async (req, res) => {
  const id = myAccountId();
  if (!id) return res.status(404).json({ error: 'Аккаунт ещё не определён — зайди в матч или открой Steam.' });
  const profile = await fetchPlayerProfile(id);
  if (!profile) return res.status(404).json({ error: 'Профиль не найден' });
  res.json({ ...profile, source: liveAccountId ? 'gsi' : 'steam' });
});

app.get('/profile/:id', async (req, res) => {
  const raw = req.params.id;
  const id = raw.length > 12 ? String(BigInt(raw) - BigInt('76561197960265728')) : raw;
  const profile = await fetchPlayerProfile(id);
  res.json(profile || { error: 'не найден' });
});

app.get('/live/:matchId', async (req, res) => {
  const matchId = req.params.matchId;
  console.log(`[Live] Запрос live данных для матча ${matchId}`);
  if (process.env.STEAM_API_KEY) {
    try { return res.json(await fetchLiveMatch(matchId)); }
    catch (e) { console.log(`[Live] Valve API: ${e.message}, пробуем OpenDota live...`); }
  }
  try { return res.json(await fetchLiveOpenDota(matchId)); }
  catch (e) { console.log(`[Live] OpenDota live: ${e.message}`); }

  // Фоллбэк — твой игрок из живого GSI (всегда доступен).
  if (currentState?.player?.steamid) {
    try {
      const accountId = String(BigInt(currentState.player.steamid) - BigInt('76561197960265728'));
      const profile = await fetchPlayerProfile(accountId);
      return res.json({
        match_id: Number(matchId), live: true, partial: true,
        players: [{
          account_id: Number(accountId), personaname: profile?.name || 'Ты',
          heroName: heroesCache[currentState.hero?.id] || currentState.hero?.name || '—',
          hero_id: currentState.hero?.id, team_number: 0, player_slot: 0,
          kills: currentState.player.kills || 0, deaths: currentState.player.deaths || 0,
          assists: currentState.player.assists || 0, gold_per_min: currentState.player.gpm || 0,
          net_worth: currentState.player.net_worth || 0, hero_damage: currentState.player.hero_damage || 0,
          last_hits: currentState.player.last_hits || 0, profile,
        }],
      });
    } catch (e) { console.error('[Live] Фоллбэк:', e.message); }
  }
  res.status(404).json({ error: 'Live данные недоступны — матч не транслируется публично' });
});

app.get('/match/:matchId', async (req, res) => {
  try { res.json(await fetchMatch(req.params.matchId)); }
  catch (e) { console.error('[Match]', e.message); res.status(404).json({ error: e.message }); }
});

app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Нет q' });
  try {
    if (/^\d+$/.test(q.trim())) {
      const p = await fetchPlayerProfile(q.trim());
      return res.json(p ? [{ account_id: p.accountId, personaname: p.name, avatar: p.avatar }] : []);
    }
    const { data } = await axios.get(`${OPENDOTA}/search?q=${encodeURIComponent(q)}`, { timeout: 8000 });
    res.json(data.slice(0, 8));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/ai/analyze', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Нет prompt' });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(503).json({ error: 'ANTHROPIC_API_KEY не задан' });
  try {
    const { data } = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-sonnet-4-20250514', max_tokens: 600,
      system: 'Ты тренер по Dota 2. 5 пунктов с эмодзи на русском. Коротко и конкретно.',
      messages: [{ role: 'user', content: prompt }]
    }, { headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
    res.json({ text: data.content?.find(c => c.type === 'text')?.text || '' });
  } catch (e) { res.status(500).json({ error: e.response?.data?.error?.message || e.message }); }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[FATAL] Порт ${PORT} занят — вероятно, уже запущен другой Dota 2 Tracker ` +
      `(или старая версия). Закрой его в трее и перезапусти. Сервер не стартовал.`);
  } else {
    console.error('[FATAL] Сервер не смог запуститься:', err.message);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════╗');
  console.log('║  Dota 2 Tracker — GSI + OpenDota server ║');
  console.log(`║  http://localhost:${PORT}  (live via /ws) ║`);
  console.log('╚═══════════════════════════════════════╝');
  console.log('');
  loadHeroes();
  detectLocalSteam();
});

module.exports = {};

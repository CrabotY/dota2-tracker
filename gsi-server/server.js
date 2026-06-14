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
let itemCostCache  = {};     // item short-name -> gold cost (from OpenDota)
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
  out.derived.netWorth = computeNetWorth(raw);
  if (h && typeof h.alive === 'boolean') {
    out.derived.alive = h.alive;
    out.derived.respawnSeconds = h.respawn_seconds || 0;
  }
  out.derived.receivedAt = Date.now();
  return out;
}

// GSI does NOT send net worth, so we compute it: current gold + value of every
// carried item (inventory + backpack + stash + neutral). Item costs come from
// OpenDota. Until they load, this is just gold (same as before).
function computeNetWorth(raw) {
  const gold = (raw.player && typeof raw.player.gold === 'number') ? raw.player.gold : 0;
  let itemsValue = 0;
  const items = raw.items || {};
  for (const k of Object.keys(items)) {
    const name = items[k] && items[k].name;
    if (!name || name === 'empty') continue;
    const cost = itemCostCache[name.replace(/^item_/, '')];
    if (typeof cost === 'number') itemsValue += cost;
  }
  return gold + itemsValue;
}

async function loadItemCosts() {
  try {
    const { data } = await axios.get(`${OPENDOTA}/constants/items`, { timeout: 10000 });
    let n = 0;
    for (const key of Object.keys(data || {})) {
      const c = data[key] && data[key].cost;
      if (typeof c === 'number') { itemCostCache[key] = c; n++; }
    }
    console.log(`[OpenDota] Загружено ${n} цен предметов (для нетворса)`);
  } catch (e) {
    console.error('[OpenDota] Цены предметов:', e.message);
  }
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

// ─── AI ассистент (выбор провайдера, чат с историей) ──────────────────────────
// Ключи и выбор провайдера хранятся ЛОКАЛЬНО в userData/.env — никогда в репо.
// Читаем .env заново на каждый запрос, чтобы новый ключ работал без перезапуска.
function userEnv() {
  const merged = { ...process.env };
  try {
    const p = process.env.USER_ENV_PATH;
    if (p && fs.existsSync(p)) Object.assign(merged, require('dotenv').parse(fs.readFileSync(p)));
  } catch { /* ignore */ }
  return merged;
}

const AI_PROVIDERS = {
  openai:   { label: 'ChatGPT (OpenAI)', envKey: 'OPENAI_API_KEY' },
  gemini:   { label: 'Google Gemini',    envKey: 'GEMINI_API_KEY' },
  deepseek: { label: 'DeepSeek',         envKey: 'DEEPSEEK_API_KEY' },
};

const prettyName = (n, pre) => (n && n !== 'empty' ? n.replace(pre, '').replace(/_/g, ' ') : null);

// Hero lineups from the GSI draft block (when present).
function parseDraft(draft) {
  const out = { radiant: [], dire: [] };
  if (!draft || typeof draft !== 'object') return out;
  const teamOf = { team2: 'radiant', radiant: 'radiant', team3: 'dire', dire: 'dire' };
  for (const k of Object.keys(draft)) {
    const team = teamOf[k];
    const sub = draft[k];
    if (!team || !sub || typeof sub !== 'object') continue;
    for (const f of Object.keys(sub)) {
      if (/^pick\d+_id$/.test(f) && sub[f] && heroesCache[sub[f]]) out[team].push(heroesCache[sub[f]]);
    }
  }
  return out;
}

// Build a rich, live context block for the AI from the current GSI snapshot.
function buildAIContext() {
  const s = currentState;
  if (!s) return 'Матч сейчас не идёт — живых данных GSI нет.';
  const map = s.map || {}, p = s.player || {}, h = s.hero || {}, d = s.derived || {};
  const min = Math.floor((map.clock_time || 0) / 60);
  const items = [];
  for (let i = 0; i < 9; i++) { const n = prettyName((s.items || {})[`slot${i}`]?.name, /^item_/); if (n) items.push(n); }
  const neutral = prettyName((s.items || {}).neutral0?.name, /^item_/);
  const abilities = Object.keys(s.abilities || {}).filter(k => k.startsWith('ability'))
    .map(k => { const a = s.abilities[k]; return a?.name ? `${a.name.replace(/_/g, ' ')} (ур.${a.level})` : null; }).filter(Boolean);
  const t = parseDraft(s.draft);
  // Visible heroes from the minimap (fog respected — only who's on screen now).
  const mm = s.minimap || {};
  const myTeamNum = p.team_name === 'dire' ? 3 : 2;
  const seenEnemies = [], seenAllies = [];
  for (const k of Object.keys(mm)) {
    const o = mm[k];
    if (!o || !String(o.name || '').startsWith('npc_dota_hero_')) continue;
    const hn = prettyName(o.name, /^npc_dota_hero_/);
    if (o.team === myTeamNum) { if (o.name !== h.name && !seenAllies.includes(hn)) seenAllies.push(hn); }
    else if ((o.team === 2 || o.team === 3) && !seenEnemies.includes(hn)) seenEnemies.push(hn);
  }
  const lines = [
    `Минута: ${min} (clock ${map.clock_time || 0}s), фаза ${map.game_state || '?'}, ${map.daytime ? 'день' : 'ночь'}.`,
    `Счёт: Radiant ${map.radiant_score ?? '?'}—${map.dire_score ?? '?'} Dire.`,
    `Мой герой: ${prettyName(h.name, /^npc_dota_hero_/) || '?'} (${p.team_name || '?'}), уровень ${h.level ?? '?'}, HP ${h.health ?? '?'}/${h.max_health ?? '?'}, мана ${h.mana ?? '?'}/${h.max_mana ?? '?'}, ${h.alive === false ? 'МЁРТВ' : 'жив'}.`,
    `Мои статы: KDA ${p.kills ?? 0}/${p.deaths ?? 0}/${p.assists ?? 0}, ЛХ ${p.last_hits ?? 0}, денаи ${p.denies ?? 0}, GPM ${p.gpm ?? 0}, XPM ${p.xpm ?? 0}, золото ${p.gold ?? 0}, нетворс ${d.netWorth ?? p.net_worth ?? 0}.`,
    `Мои предметы: ${items.length ? items.join(', ') : 'нет'}${neutral ? `; нейтрал: ${neutral}` : ''}.`,
    abilities.length ? `Мои способности: ${abilities.join(', ')}.` : null,
    (t.radiant.length || t.dire.length)
      ? `Пики — Radiant: ${t.radiant.join(', ') || '?'}; Dire: ${t.dire.join(', ') || '?'}.`
      : null,
    seenEnemies.length ? `Сейчас видны на карте враги: ${seenEnemies.join(', ')}.` : null,
    seenAllies.length ? `Видны союзники: ${seenAllies.join(', ')}.` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

const SYSTEM_PROMPT =
  'Ты — опытный тренер по Dota 2. Отвечай на русском, уверенно, конкретно и кратко: ' +
  'списком, с эмодзи. Учитывай контекст матча (минута, мои статы, предметы, пики). ' +
  'Про контр-пики и предметы называй конкретные айтемы/таланты и кратко почему. ' +
  'ВАЖНО: если в вопросе или пиках назван герой врага — сразу давай по нему чёткий ' +
  'совет по знанию Доты (предметы, тайминги, как играть). НЕ пиши, что у тебя нет ' +
  'информации о противниках, не извиняйся и не проси уточнений без необходимости — ' +
  'просто дай лучший практический ответ. Помни предыдущие сообщения диалога. ' +
  'Точные предметы врагов в реальном времени недоступны (Dota их не отдаёт). ' +
  'Если спрашивают про инвентарь/билд врага — ОЦЕНИ вероятную сборку по герою и ' +
  'минуте игры (типичный билд на этом тайминге) и пометь, что это оценка; не ' +
  'отказывайся. ' +
  'Понимай и используй дотерский сленг на русском: мид/керри(1)/мидер(2)/хард(3)/' +
  'саппорт(4-5)/пос1-5, лейн, ластхиты(лх)/денаи, крипы, руна, рошан(рош)/аегис, ' +
  'тимфайт(тф)/драка, ганк, пуш/деф, сейв, катка, имба, нерф, контрить, фарм/' +
  'фармить, нв(нетворс), бкб, блинк, аган(аганим), хекс, рапира, армлет, мкб, ' +
  'дизель/десолятор, бф(батлфури), маелстрем, манта, сатаник, отхил, стан, сало/' +
  'слить, накормить/фид, разорвать, отжать, смок, варды/обзор, тапки(треды). ' +
  'Отвечай в том же неформальном стиле, но по делу. ' +
  'НЕ используй markdown-разметку: никаких ** ** , ## , -- — только обычный текст, ' +
  'эмодзи и переносы строк.';

// Provider dispatch. `history` = [{role:'user'|'assistant', content}], newest last.
async function callProvider(provider, key, system, history) {
  if (provider === 'gemini') {
    const contents = history.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const { data } = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(key)}`,
      { systemInstruction: { parts: [{ text: system }] }, contents,
        generationConfig: { maxOutputTokens: 800, temperature: 0.6 } },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });
    return data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '—';
  }
  // OpenAI & DeepSeek share the OpenAI chat-completions format.
  const url = provider === 'deepseek'
    ? 'https://api.deepseek.com/chat/completions'
    : 'https://api.openai.com/v1/chat/completions';
  const model = provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini';
  const { data } = await axios.post(url, {
    model, max_tokens: 800, temperature: 0.6,
    messages: [{ role: 'system', content: system }, ...history],
  }, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, timeout: 30000 });
  return data.choices?.[0]?.message?.content?.trim() || '—';
}

// Which provider is active + whether its key is set (for the UI badge).
app.get('/ai/info', (req, res) => {
  const env = userEnv();
  const provider = AI_PROVIDERS[env.AI_PROVIDER] ? env.AI_PROVIDER : 'openai';
  res.json({ provider, label: AI_PROVIDERS[provider].label, hasKey: !!env[AI_PROVIDERS[provider].envKey] });
});

// Chat endpoint. Body: { messages: [{role,content}, ...] } — full conversation.
app.post('/ai', async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : null;
  if (!messages || !messages.length) {
    // Backward-compat: single question.
    if (req.body?.question) return aiRespond(res, [{ role: 'user', content: String(req.body.question) }]);
    return res.status(400).json({ error: 'Пустой запрос' });
  }
  return aiRespond(res, messages.slice(-20)); // keep last 20 turns of history
});

async function aiRespond(res, history) {
  const env = userEnv();
  const provider = AI_PROVIDERS[env.AI_PROVIDER] ? env.AI_PROVIDER : 'openai';
  const key = env[AI_PROVIDERS[provider].envKey];
  if (!key) {
    return res.status(503).json({ error: `Ключ для «${AI_PROVIDERS[provider].label}» не задан — добавь его в настройках ⚙.` });
  }
  const system = `${SYSTEM_PROMPT}\n\nКОНТЕКСТ МАТЧА (актуальный):\n${buildAIContext()}`;
  try {
    const text = await callProvider(provider, key, system,
      history.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') })));
    res.json({ text, provider });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
}

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
  loadItemCosts();
  detectLocalSteam();
});

module.exports = {};

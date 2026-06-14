/* Dota 2 Tracker — overlay UI.
 * Live in-game stats come from the GSI server over WebSocket (primary source);
 * the Scouting tab and AI button use the OpenDota/AI HTTP endpoints. */

const API = 'http://localhost:3001';
const WS  = 'ws://localhost:3001/ws';
const api = window.electronAPI; // undefined when opened in a plain browser (dev/test)
const $ = (id) => document.getElementById(id);

// ── Window controls + tabs ──────────────────────────────────────────────────
$('btn-settings').onclick = () => api?.openSettings();
$('btn-logs').onclick     = () => api?.openLogs();
$('btn-min').onclick      = () => api?.minimize();
$('btn-close').onclick    = () => api?.close();

document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('tab--active'));
    t.classList.add('tab--active');
    const tab = t.dataset.tab;
    $('tab-match').classList.toggle('hidden', tab !== 'match');
    $('tab-scout').classList.toggle('hidden', tab !== 'scout');
  };
});

// ── Name prettifiers (npc_dota_hero_x / item_x → readable) ───────────────────
function pretty(name, prefix) {
  if (!name || name === 'empty') return '';
  let s = name.startsWith(prefix) ? name.slice(prefix.length) : name;
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}
const heroName = (n) => pretty(n, 'npc_dota_hero_');
const itemName = (n) => pretty(n, 'item_');
const abilityName = (n) => pretty(n, '');
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '0');

function clockStr(s) {
  if (typeof s !== 'number') return '0:00';
  const neg = s < 0, a = Math.abs(Math.floor(s));
  return `${neg ? '-' : ''}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
}
const GAME_STATE = {
  DOTA_GAMERULES_STATE_HERO_SELECTION: 'Пик',
  DOTA_GAMERULES_STATE_STRATEGY_TIME: 'Стратегия',
  DOTA_GAMERULES_STATE_PRE_GAME: 'Пре-гейм',
  DOTA_GAMERULES_STATE_GAME_IN_PROGRESS: 'Игра',
  DOTA_GAMERULES_STATE_POST_GAME: 'Пост-гейм',
};
const STATUS_FLAGS = [
  ['stunned', 'Стан'], ['silenced', 'Сайленс'], ['hexed', 'Хекс'],
  ['disarmed', 'Disarm'], ['muted', 'Mute'], ['break', 'Break'],
  ['magicimmune', 'BKB'], ['smoked', 'Смок'], ['has_debuff', 'Дебафф'],
];

let lastState = null;

function render(s) {
  lastState = s;
  $('waiting').classList.add('hidden');
  $('live').classList.remove('hidden');

  const map = s.map || {}, p = s.player || {}, h = s.hero || {}, d = s.derived || {};
  // Scoreboard
  $('clock').textContent = clockStr(map.clock_time);
  $('radiant-score').textContent = map.radiant_score ?? 0;
  $('dire-score').textContent = map.dire_score ?? 0;
  $('game-state').textContent = GAME_STATE[map.game_state] || '—';
  $('daytime').textContent = map.daytime ? '☀' : '🌙';

  // Player
  $('kda').textContent = `${p.kills ?? 0}/${p.deaths ?? 0}/${p.assists ?? 0}`;
  $('kda-ratio').textContent = d.kda ?? '0.0';
  $('cs').textContent = p.last_hits ?? 0;
  $('denies').textContent = p.denies ?? 0;
  $('gpm').textContent = p.gpm ?? 0;
  $('xpm').textContent = p.xpm ?? 0;
  $('gold').textContent = fmt(p.gold ?? 0);
  $('networth').textContent = fmt(d.netWorth ?? p.net_worth ?? 0);
  $('hero-dmg').textContent = fmt(p.hero_damage ?? 0);
  $('tower-dmg').textContent = fmt(p.tower_damage ?? 0);

  // Hero
  $('hero-name').textContent = heroName(h.name) || '—';
  $('hero-level').textContent = h.level ?? 0;
  const hpPct = h.max_health ? (h.health / h.max_health) * 100 : 0;
  const mpPct = h.max_mana ? (h.mana / h.max_mana) * 100 : 0;
  $('hp-fill').style.width = `${hpPct}%`;
  $('mana-fill').style.width = `${mpPct}%`;
  $('hp-text').textContent = `${fmt(h.health ?? 0)} / ${fmt(h.max_health ?? 0)}`;
  $('mana-text').textContent = `${fmt(h.mana ?? 0)} / ${fmt(h.max_mana ?? 0)}`;

  const row = $('hero-status');
  row.innerHTML = '';
  const active = STATUS_FLAGS.filter(([k]) => h[k]);
  if (h.alive === false) {
    $('respawn').classList.remove('hidden');
    $('respawn-sec').textContent = h.respawn_seconds ?? 0;
  } else {
    $('respawn').classList.add('hidden');
    if (!active.length) row.innerHTML = '<span class="status-tag status-tag--ok">OK</span>';
  }
  for (const [, label] of active) {
    const t = document.createElement('span');
    t.className = 'status-tag'; t.textContent = label; row.appendChild(t);
  }

  renderItems(s.items);
  renderAbilities(s.abilities);
  renderBuildings(s.buildings);
}

function renderItems(items) {
  const grid = $('items'); grid.innerHTML = '';
  for (let i = 0; i < 9; i++) {
    const it = items && items[`slot${i}`];
    const empty = !it || it.name === 'empty';
    const div = document.createElement('div');
    div.className = `item-slot${empty ? ' empty' : ''}`;
    if (empty) { div.textContent = '·'; }
    else {
      div.textContent = itemName(it.name);
      if (it.cooldown > 0) { const c = document.createElement('span'); c.className = 'cd'; c.textContent = `${Math.ceil(it.cooldown)}s`; div.appendChild(c); }
      if (it.charges) { const c = document.createElement('span'); c.className = 'charges'; c.textContent = it.charges; div.appendChild(c); }
    }
    grid.appendChild(div);
  }
  const n = items && items.neutral0;
  $('neutral-item').textContent = n && n.name !== 'empty' ? itemName(n.name) : '—';
}

function renderAbilities(ab) {
  const row = $('abilities'); row.innerHTML = '';
  if (!ab) return;
  Object.keys(ab).filter((k) => k.startsWith('ability')).forEach((k) => {
    const a = ab[k]; if (!a || !a.name) return;
    const div = document.createElement('div');
    div.className = `ability${a.ultimate ? ' ultimate' : ''}${a.cooldown > 0 ? ' on-cd' : ''}`;
    const nm = document.createElement('div'); nm.className = 'ability-name'; nm.textContent = abilityName(a.name); div.appendChild(nm);
    const lv = document.createElement('div'); lv.className = 'ability-level'; lv.textContent = a.passive ? `${a.level}·P` : `Lv ${a.level}`; div.appendChild(lv);
    if (a.cooldown > 0) { const c = document.createElement('span'); c.className = 'ability-cd'; c.textContent = Math.ceil(a.cooldown); div.appendChild(c); }
    row.appendChild(div);
  });
}

function towerLabel(k) { const m = k.match(/tower\d+_(\w+)/); return m ? m[1].toUpperCase() : k; }
function renderBuildings(b) {
  for (const [side, id] of [['radiant', 'radiant-buildings'], ['dire', 'dire-buildings']]) {
    const el = $(id); el.innerHTML = '';
    const g = (b && b[side]) || {};
    Object.keys(g).filter((k) => k.includes('tower1')).forEach((k) => {
      const t = g[k], pct = t.max_health ? (t.health / t.max_health) * 100 : 0, dead = t.health <= 0;
      const r = document.createElement('div'); r.className = `b-row${dead ? ' dead' : ''}`;
      r.innerHTML = `<div class="b-label"><span>${towerLabel(k)}</span><span>${dead ? '✕' : Math.round(pct) + '%'}</span></div><div class="b-bar"><div class="b-bar-fill" style="width:${pct}%"></div></div>`;
      el.appendChild(r);
    });
  }
}

// ── WebSocket (live) ─────────────────────────────────────────────────────────
function setConn(on) {
  $('conn').className = `conn ${on ? 'conn--on' : 'conn--off'}`;
  $('conn-text').textContent = on ? 'live' : '…';
}
let ws;
function connect() {
  ws = new WebSocket(WS);
  ws.onopen = () => setConn(true);
  ws.onclose = () => { setConn(false); setTimeout(connect, 1500); };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'state') render(m.payload);
  };
}
connect();

// ── AI coach ─────────────────────────────────────────────────────────────────
$('btn-ai').onclick = async () => {
  const out = $('ai-out'); out.classList.remove('hidden'); out.textContent = 'Думаю…';
  const p = lastState?.player || {}, h = lastState?.hero || {};
  const prompt = `Я играю ${heroName(h.name) || 'героя'}, уровень ${h.level || 0}, ` +
    `${p.kills || 0}/${p.deaths || 0}/${p.assists || 0}, ${p.last_hits || 0} ласт-хитов, ` +
    `GPM ${p.gpm || 0}, нетворс ${lastState?.derived?.netWorth || 0}, время ${clockStr(lastState?.map?.clock_time)}. ` +
    `Дай 5 коротких советов что делать дальше.`;
  try {
    const r = await fetch(`${API}/ai/analyze`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }),
    });
    const data = await r.json();
    out.textContent = r.ok ? (data.text || '—') : (data.error || 'Ошибка. Добавь Anthropic API ключ в настройках.');
  } catch (e) { out.textContent = 'Сервер недоступен: ' + e.message; }
};

// ── Scouting ─────────────────────────────────────────────────────────────────
const rankName = (t) => {
  if (!t) return '—';
  const med = ['Herald','Guardian','Crusader','Archon','Legend','Ancient','Divine','Immortal'];
  return `${med[Math.floor(t / 10) - 1] || '?'} ${t % 10 || ''}`.trim();
};
async function scout(q) {
  const box = $('scout-result'); box.innerHTML = '<div class="muted">Ищу…</div>';
  try {
    let id = q.trim();
    if (!/^\d+$/.test(id)) {
      const sr = await (await fetch(`${API}/search?q=${encodeURIComponent(id)}`)).json();
      if (!Array.isArray(sr) || !sr.length) { box.innerHTML = '<div class="muted">Не найдено</div>'; return; }
      id = sr[0].account_id;
    }
    const p = await (await fetch(`${API}/profile/${id}`)).json();
    if (!p || p.error) { box.innerHTML = '<div class="muted">Профиль не найден</div>'; return; }
    const wrCls = p.winrate >= 50 ? 'wr-good' : 'wr-bad';
    box.innerHTML = `
      <div class="profile-card">
        ${p.avatar ? `<img src="${p.avatar}" />` : ''}
        <div>
          <div class="profile-name">${p.name || '—'}</div>
          <div class="profile-sub">${rankName(p.rank)} · WR <span class="${wrCls}">${p.winrate ?? '—'}%</span> (${p.totalGames || 0} игр)</div>
          ${p.avgKDA ? `<div class="profile-sub">Сред. KDA ${p.avgKDA.k}/${p.avgKDA.d}/${p.avgKDA.a} · GPM ${p.avgGPM} · XPM ${p.avgXPM}</div>` : ''}
        </div>
      </div>
      <div class="card-title">Топ герои</div>
      ${(p.topHeroes || []).map((h) => `<div class="top-hero"><span>${h.name}</span><span class="muted">${h.games} игр · ${h.winrate}%</span></div>`).join('') || '<div class="muted">—</div>'}`;
  } catch (e) { box.innerHTML = `<div class="muted">Ошибка: ${e.message}</div>`; }
}
$('scout-go').onclick = () => { const v = $('scout-input').value; if (v.trim()) scout(v); };
$('scout-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('scout-go').click(); });

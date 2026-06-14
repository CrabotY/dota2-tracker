/* Dota 2 Tracker — browser client.
 * Connects to the server over WebSocket and renders the live game state. */

const $ = (id) => document.getElementById(id);

// ---- Name prettifiers ------------------------------------------------------
// GSI sends internal names like "npc_dota_hero_juggernaut" / "item_bfury".
// Strip the known prefixes and title-case the rest so it works for ANY
// hero/item/ability without a giant lookup table.
function pretty(name, ...prefixes) {
  if (!name || name === 'empty') return '';
  let s = name;
  for (const p of prefixes) {
    if (s.startsWith(p)) { s = s.slice(p.length); break; }
  }
  return s
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}
const heroName = (n) => pretty(n, 'npc_dota_hero_');
const itemName = (n) => pretty(n, 'item_');
const abilityName = (n) => pretty(n, '');

function fmt(n) {
  if (typeof n !== 'number') return '0';
  return n.toLocaleString('en-US');
}

function clockStr(seconds) {
  if (typeof seconds !== 'number') return '0:00';
  const neg = seconds < 0;
  const s = Math.abs(Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = String(s % 60).padStart(2, '0');
  return `${neg ? '-' : ''}${m}:${r}`;
}

const GAME_STATE_LABELS = {
  DOTA_GAMERULES_STATE_INIT: 'Init',
  DOTA_GAMERULES_STATE_WAIT_FOR_PLAYERS_TO_LOAD: 'Loading',
  DOTA_GAMERULES_STATE_HERO_SELECTION: 'Hero Selection',
  DOTA_GAMERULES_STATE_STRATEGY_TIME: 'Strategy',
  DOTA_GAMERULES_STATE_TEAM_SHOWCASE: 'Showcase',
  DOTA_GAMERULES_STATE_PRE_GAME: 'Pre-Game',
  DOTA_GAMERULES_STATE_GAME_IN_PROGRESS: 'In Progress',
  DOTA_GAMERULES_STATE_POST_GAME: 'Post-Game',
};

// ---- Renderers -------------------------------------------------------------
function renderMap(map) {
  if (!map) return;
  $('clock').textContent = clockStr(map.clock_time);
  $('radiant-score').textContent = map.radiant_score ?? 0;
  $('dire-score').textContent = map.dire_score ?? 0;
  $('game-state').textContent = GAME_STATE_LABELS[map.game_state] || '—';
  if (map.paused) $('game-state').textContent += ' (PAUSED)';
  $('daytime').textContent = map.daytime ? '☀ Day' : '🌙 Night';
}

function renderPlayer(p, derived) {
  if (!p) return;
  $('player-name').textContent = p.name || '—';
  $('kda').textContent = `${p.kills ?? 0}/${p.deaths ?? 0}/${p.assists ?? 0}`;
  $('kda-ratio').textContent = derived?.kda ?? '0.0';
  $('cs').textContent = p.last_hits ?? 0;
  $('denies').textContent = p.denies ?? 0;
  $('gpm').textContent = p.gpm ?? 0;
  $('xpm').textContent = p.xpm ?? 0;
  $('gold').textContent = fmt(p.gold ?? 0);
  $('networth').textContent = fmt(derived?.netWorth ?? p.net_worth ?? 0);
  $('hero-dmg').textContent = fmt(p.hero_damage ?? 0);
  $('tower-dmg').textContent = fmt(p.tower_damage ?? 0);
}

const STATUS_FLAGS = [
  ['stunned', 'Stunned'], ['silenced', 'Silenced'], ['hexed', 'Hexed'],
  ['disarmed', 'Disarmed'], ['muted', 'Muted'], ['break', 'Break'],
  ['magicimmune', 'Magic Immune'], ['smoked', 'Smoked'], ['has_debuff', 'Debuffed'],
];

function renderHero(h) {
  if (!h) return;
  $('hero-name').textContent = heroName(h.name) || '—';
  $('hero-level').textContent = h.level ?? 0;

  const hpPct = h.max_health ? (h.health / h.max_health) * 100 : 0;
  const manaPct = h.max_mana ? (h.mana / h.max_mana) * 100 : 0;
  $('hp-fill').style.width = `${hpPct}%`;
  $('mana-fill').style.width = `${manaPct}%`;
  $('hp-text').textContent = `${fmt(h.health ?? 0)} / ${fmt(h.max_health ?? 0)}`;
  $('mana-text').textContent = `${fmt(h.mana ?? 0)} / ${fmt(h.max_mana ?? 0)}`;

  // Status effects.
  const row = $('hero-status');
  row.innerHTML = '';
  const active = STATUS_FLAGS.filter(([k]) => h[k]);
  if (h.alive === false) {
    const sec = h.respawn_seconds ?? 0;
    $('respawn').classList.remove('hidden');
    $('respawn-sec').textContent = sec;
  } else {
    $('respawn').classList.add('hidden');
    if (active.length === 0) {
      row.innerHTML = '<span class="status-tag status-tag--ok">OK</span>';
    }
  }
  for (const [, label] of active) {
    const tag = document.createElement('span');
    tag.className = 'status-tag';
    tag.textContent = label;
    row.appendChild(tag);
  }
}

function renderItems(items) {
  if (!items) return;
  const grid = $('items');
  grid.innerHTML = '';
  // Main 6 inventory slots + 3 backpack slots.
  for (let i = 0; i < 9; i++) {
    const it = items[`slot${i}`];
    const div = document.createElement('div');
    const empty = !it || it.name === 'empty';
    div.className = `item-slot${empty ? ' empty' : ''}`;
    if (empty) {
      div.textContent = '·';
    } else {
      div.textContent = itemName(it.name);
      if (it.cooldown > 0) {
        const cd = document.createElement('span');
        cd.className = 'cd';
        cd.textContent = `${Math.ceil(it.cooldown)}s`;
        div.appendChild(cd);
      }
      if (it.charges) {
        const ch = document.createElement('span');
        ch.className = 'charges';
        ch.textContent = it.charges;
        div.appendChild(ch);
      }
    }
    grid.appendChild(div);
  }
  const neutral = items.neutral0;
  $('neutral-item').textContent =
    neutral && neutral.name !== 'empty' ? itemName(neutral.name) : '—';
}

function renderAbilities(abilities) {
  if (!abilities) return;
  const row = $('abilities');
  row.innerHTML = '';
  Object.keys(abilities)
    .filter((k) => k.startsWith('ability'))
    .forEach((k) => {
      const a = abilities[k];
      if (!a || !a.name) return;
      const div = document.createElement('div');
      div.className = `ability${a.ultimate ? ' ultimate' : ''}${a.cooldown > 0 ? ' on-cd' : ''}`;
      const name = document.createElement('div');
      name.className = 'ability-name';
      name.textContent = abilityName(a.name);
      div.appendChild(name);
      const lvl = document.createElement('div');
      lvl.className = 'ability-level';
      lvl.textContent = a.passive ? `Lv ${a.level} ·P` : `Lv ${a.level}`;
      div.appendChild(lvl);
      if (a.cooldown > 0) {
        const cd = document.createElement('span');
        cd.className = 'ability-cd';
        cd.textContent = `${Math.ceil(a.cooldown)}`;
        div.appendChild(cd);
      }
      row.appendChild(div);
    });
}

function towerLabel(key) {
  // dota_goodguys_tower1_mid -> "Mid"
  const m = key.match(/tower\d+_(\w+)/);
  return m ? m[1].toUpperCase() : key;
}

function renderBuildings(buildings) {
  if (!buildings) return;
  for (const [side, elId] of [['radiant', 'radiant-buildings'], ['dire', 'dire-buildings']]) {
    const el = $(elId);
    el.innerHTML = '';
    const group = buildings[side] || {};
    Object.keys(group)
      .filter((k) => k.includes('tower1'))
      .forEach((k) => {
        const b = group[k];
        const pct = b.max_health ? (b.health / b.max_health) * 100 : 0;
        const dead = b.health <= 0;
        const row = document.createElement('div');
        row.className = `b-row${dead ? ' dead' : ''}`;
        row.innerHTML = `
          <div class="b-label"><span>${towerLabel(k)}</span><span>${dead ? 'DOWN' : Math.round(pct) + '%'}</span></div>
          <div class="b-bar"><div class="b-bar-fill" style="width:${pct}%"></div></div>`;
        el.appendChild(row);
      });
  }
}

function render(state) {
  $('waiting').classList.add('hidden');
  $('dashboard').classList.remove('hidden');
  renderMap(state.map);
  renderPlayer(state.player, state.derived);
  renderHero(state.hero);
  renderItems(state.items);
  renderAbilities(state.abilities);
  renderBuildings(state.buildings);
}

// ---- WebSocket with auto-reconnect ----------------------------------------
function setConn(on) {
  const el = $('conn');
  el.className = `conn ${on ? 'conn--on' : 'conn--off'}`;
  $('conn-text').textContent = on ? 'Connected' : 'Reconnecting…';
}

let ws;
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => setConn(true);
  ws.onclose = () => { setConn(false); setTimeout(connect, 1500); };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'state') render(msg.payload);
    // 'waiting' keeps the waiting screen visible.
  };
}

connect();

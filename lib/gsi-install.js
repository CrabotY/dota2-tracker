/**
 * Shared helpers for locating the Dota 2 GSI config folder and installing the
 * tracker's .cfg into it. Used by both the CLI installer and the .exe launcher.
 *
 * Dota only loads GSI configs from:
 *   <steam>/steamapps/common/dota 2 beta/game/dota/cfg/gamestate_integration/
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REL = path.join(
  'steamapps', 'common', 'dota 2 beta',
  'game', 'dota', 'cfg', 'gamestate_integration'
);

function candidateSteamRoots() {
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return [
        'C:\\Program Files (x86)\\Steam',
        'C:\\Program Files\\Steam',
        'C:\\Steam',
        'D:\\Steam',
        'D:\\SteamLibrary',
        'E:\\Steam',
        'E:\\SteamLibrary',
        'F:\\SteamLibrary',
        path.join(home, 'Steam'),
      ];
    case 'darwin':
      return [path.join(home, 'Library', 'Application Support', 'Steam')];
    default: // linux
      return [
        path.join(home, '.steam', 'steam'),
        path.join(home, '.local', 'share', 'Steam'),
        path.join(home, '.steam', 'root'),
        '/usr/share/steam',
      ];
  }
}

/** Return the gamestate_integration dir if a Dota install is found, else null. */
function findDotaCfgDir() {
  for (const root of candidateSteamRoots()) {
    const dotaBeta = path.join(root, 'steamapps', 'common', 'dota 2 beta');
    if (fs.existsSync(dotaBeta)) return path.join(root, REL);
  }
  return null;
}

/**
 * Copy a .cfg into the Dota GSI folder.
 * @returns {{ok: true, dest: string} | {ok: false, reason: string}}
 */
function installConfig(sourceCfgPath, cfgName = 'gamestate_integration_tracker.cfg') {
  if (!fs.existsSync(sourceCfgPath)) {
    return { ok: false, reason: `source config missing: ${sourceCfgPath}` };
  }
  const target = findDotaCfgDir();
  if (!target) return { ok: false, reason: 'dota-not-found' };

  fs.mkdirSync(target, { recursive: true });
  const dest = path.join(target, cfgName);
  fs.copyFileSync(sourceCfgPath, dest);
  return { ok: true, dest };
}

module.exports = { findDotaCfgDir, installConfig, candidateSteamRoots };

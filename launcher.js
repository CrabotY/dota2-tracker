#!/usr/bin/env node
/**
 * Dota 2 Tracker — packaged launcher (entry point for the .exe build).
 *
 * When the user double-clicks Dota2Tracker.exe this:
 *   1. Extracts the bundled dashboard + GSI config to a temp folder on disk
 *      (reading from the pkg snapshot, writing to real fs — avoids fs quirks).
 *   2. Installs the GSI config into the Dota 2 folder (auto-detecting Steam).
 *   3. Starts the tracker server on the first free port (3000, 3001, …).
 *   4. Opens the dashboard in the default browser.
 *   5. Stays open showing live status until the window is closed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { startServer } = require('./server');
const { installConfig } = require('./lib/gsi-install');

const CFG_NAME = 'gamestate_integration_tracker.cfg';
const PUBLIC_FILES = ['index.html', 'style.css', 'app.js'];
const PREFERRED_PORTS = [3000, 3001, 3002, 3003, 3009, 8123];

function banner() {
  console.log('');
  console.log('  ████████╗ Dota 2 Tracker');
  console.log('  Live in-game stats via Valve Game State Integration');
  console.log('  ─────────────────────────────────────────────────────');
}

/**
 * Copy bundled assets out of the snapshot into a real temp dir and return it.
 * Falls back to the on-disk ./public when running unpacked (node launcher.js).
 */
function extractAssets() {
  const srcPublic = path.join(__dirname, 'public');
  // Unpacked (plain node run): just serve the real folder.
  if (!process.pkg) {
    return { publicDir: srcPublic, cfgPath: path.join(__dirname, CFG_NAME) };
  }
  const outDir = path.join(os.tmpdir(), 'dota2-tracker');
  const outPublic = path.join(outDir, 'public');
  fs.mkdirSync(outPublic, { recursive: true });

  for (const name of PUBLIC_FILES) {
    const data = fs.readFileSync(path.join(srcPublic, name));
    fs.writeFileSync(path.join(outPublic, name), data);
  }
  const cfgData = fs.readFileSync(path.join(__dirname, CFG_NAME));
  const cfgPath = path.join(outDir, CFG_NAME);
  fs.writeFileSync(cfgPath, cfgData);

  return { publicDir: outPublic, cfgPath };
}

function openBrowser(url) {
  let child;
  try {
    if (process.platform === 'win32') {
      child = spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      child = spawn('open', [url], { detached: true, stdio: 'ignore' });
    } else {
      child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
    // spawn errors (e.g. opener not installed) arrive asynchronously as an
    // 'error' event — without a listener that throws and crashes the tracker.
    child.on('error', () => {});
    child.unref();
  } catch {
    /* best-effort; the URL is printed for the user anyway */
  }
}

async function listenOnFreePort(opts) {
  for (const port of PREFERRED_PORTS) {
    try {
      return await startServer({ ...opts, port, quiet: true });
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') continue;
      throw err;
    }
  }
  throw new Error('No free port found in ' + PREFERRED_PORTS.join(', '));
}

async function main() {
  banner();

  const { publicDir, cfgPath } = extractAssets();

  // 1. Install the GSI config into Dota.
  const res = installConfig(cfgPath, CFG_NAME);
  if (res.ok) {
    console.log('  ✅ GSI config installed into Dota 2:');
    console.log('     ' + res.dest);
    console.log('  ⚠  Restart Dota 2 if it is currently running (configs load at launch).');
  } else if (res.reason === 'dota-not-found') {
    console.log('  ⚠  Dota 2 install not found automatically.');
    console.log('     Copy this file into your Dota GSI folder manually:');
    console.log('     ' + cfgPath);
    console.log('     → <Steam>\\steamapps\\common\\dota 2 beta\\game\\dota\\cfg\\gamestate_integration\\');
  } else {
    console.log('  ⚠  Could not install config: ' + res.reason);
  }
  console.log('  ─────────────────────────────────────────────────────');

  // 2. Start the server.
  const { port } = await listenOnFreePort({ publicDir });
  const url = `http://localhost:${port}`;
  console.log('  ✅ Tracker running:  ' + url);
  console.log('  Waiting for Dota 2 to send game state...');
  console.log('  (Load a match, bot game, or hero demo.)');
  console.log('  ─────────────────────────────────────────────────────');
  console.log('  Keep this window open. Close it to stop the tracker.');

  // 3. Open the dashboard.
  openBrowser(url);
}

main().catch((err) => {
  console.error('\n  ❌ Fatal error:', err.message);
  console.error('  Press Ctrl+C to close.');
});

// Keep the process alive even if everything is idle.
process.stdin.resume();

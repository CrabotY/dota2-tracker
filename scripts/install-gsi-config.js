#!/usr/bin/env node
/**
 * Copies gamestate_integration_tracker.cfg into the Dota 2 GSI config folder.
 * Tries the common Steam install locations; prints manual steps if not found.
 */

const path = require('path');
const { installConfig } = require('../lib/gsi-install');

const CFG_NAME = 'gamestate_integration_tracker.cfg';
const SOURCE = path.join(__dirname, '..', CFG_NAME);

const result = installConfig(SOURCE, CFG_NAME);

if (result.ok) {
  console.log('\n✅ Installed GSI config:');
  console.log(`   ${result.dest}\n`);
  console.log('Next steps:');
  console.log('  1. Fully restart Dota 2 (configs load at launch).');
  console.log('  2. Start the tracker:  npm start');
  console.log('  3. Open http://localhost:3000 and jump into a match / demo.\n');
} else if (result.reason === 'dota-not-found') {
  console.error('\n❌ Could not locate your Dota 2 install automatically.\n');
  console.error('Copy this file manually:');
  console.error(`  FROM: ${SOURCE}`);
  console.error('  TO:   <Steam>/steamapps/common/dota 2 beta/game/dota/cfg/gamestate_integration/');
  console.error('\n(Create the "gamestate_integration" folder if it does not exist.)\n');
  process.exit(1);
} else {
  console.error(`\n❌ ${result.reason}\n`);
  process.exit(1);
}

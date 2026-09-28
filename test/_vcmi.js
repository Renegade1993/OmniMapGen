/**
 * _vcmi.js - the VCMI install the test suite generates against, named once.
 *
 * The generator never guesses where VCMI lives (locateVcmiRoots in
 * src/parser/modCrawler.js), so a test that runs generate-cli has to say so.
 * VMAPGEN_TEST_ROOT and VMAPGEN_TEST_USER_DIR win when set. Otherwise the
 * install is DMB's test build beside this folder (..\VCMI\dmbtest in the
 * project's layout): it carries the MapGen tab, the engine's own templates and
 * DMB's (Golem Foundry), and the match chain never redeploys it the way it
 * does testinstall. The fork's source tree was the install until DMB made
 * MapGen a mod (fork c5519a7a7, September 26th): its templates left the tree,
 * and two tests could no longer find Golem Foundry. No user folder by
 * default, so the suite reads no one's installed mods and gives the same maps
 * on any machine.
 */
'use strict';

const TEST_ROOT = process.env.VMAPGEN_TEST_ROOT
	|| require('path').join(__dirname, '..', '..', 'VCMI', 'dmbtest');
const TEST_USER_DIR = process.env.VMAPGEN_TEST_USER_DIR || null;

/** Environment for a spawned generate-cli: the test install, nothing else. */
function genEnv(extra = {}) {
	const env = { ...process.env, ...extra, VCMI_ROOT: TEST_ROOT };
	if (TEST_USER_DIR) env.VCMI_USER_DIR = TEST_USER_DIR;
	else delete env.VCMI_USER_DIR;
	return env;
}

/** Point this test process itself at the test install (for listTemplates). */
function useTestRoots() {
	process.env.VCMI_ROOT = TEST_ROOT;
	if (TEST_USER_DIR) process.env.VCMI_USER_DIR = TEST_USER_DIR;
	else delete process.env.VCMI_USER_DIR;
}

/**
 * Where tests put fixtures and output maps: VCMIMapGen\.tmp\test, never the
 * user's TEMP. K's rule (2026-09-26): files go in the project folder or DMB's
 * own program and user folders, not in a place a framework picks by default.
 */
function testTmp() {
	const dir = require('path').join(__dirname, '..', '.tmp', 'test');
	require('fs').mkdirSync(dir, { recursive: true });
	return dir;
}

module.exports = { TEST_ROOT, TEST_USER_DIR, genEnv, useTestRoots, testTmp };

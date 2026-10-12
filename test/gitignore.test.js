/**
 * gitignore.test.js - a generated map, a picture or a binary dropped anywhere outside the existing ignores is caught by .gitignore (the lead, 2026-10-11), and ordinary
 * source files are not.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');
const root = path.join(__dirname, '..');

const ignored = f => { try { execFileSync('git', ['check-ignore', '-q', f], { cwd: root, stdio: 'ignore' }); return true; } catch (e) { return false; } };

test('.gitignore catches a dropped map, picture, archive or binary, and lets source through', () => {
	for (const f of ['tools/harness/dropped.vmap', 'tools/harness/dropped.vmap.zones.json', 'tools/harness/dropped.vmap.log', 'tools/dropped.png', 'src/dropped.h3m', 'dropped.zip', 'tools/dropped.exe'])
		assert.ok(ignored(f), `${f} is not ignored`);
	for (const f of ['tools/harness/lever_test.js', 'test/gitignore.test.js', 'src/main/generate-cli.js', '.gitignore'])
		assert.ok(!ignored(f), `${f} must not be ignored`);
});

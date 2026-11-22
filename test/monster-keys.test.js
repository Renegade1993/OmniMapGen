/**
 * monster-keys.test.js - the overhauled monster controls, generator side (S387 step 1, K: "i give you permission to overhaul the monster sliders and menu yes. just don't make
 * duplicative sliders"). Each of the five newer keys stands for earlier keys (src/biome/monsterKeys.js); a map made with the newer key is the map made with the earlier keys, and
 * an earlier key given alone reads as it always did.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { genEnv } = require('./_vcmi');
const sight = require('../tools/mapsight/lib/sight');
const { NEW_KEYS, earlierKeysOf, translate } = require('../src/biome/monsterKeys');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'src', 'main', 'generate-cli.js');

test('every newer key translates to the earlier keys the proposal names, and an earlier key alone is left as it is', () => {
	assert.deepStrictEqual(Object.keys(NEW_KEYS).sort(), ['bottleneckGuards', 'dwellingGuards', 'guardStrengthByDistance', 'mineGuards', 'treasureGuards']);
	assert.deepStrictEqual(earlierKeysOf('treasureGuards', 2), { guardTreasure: 1, lootGuardWeight: 2 });
	assert.deepStrictEqual(earlierKeysOf('treasureGuards', 0), { guardTreasure: 0 }, '0 is none: the old switch Off');
	assert.deepStrictEqual(earlierKeysOf('dwellingGuards', 1.5), { guardDwellings: 1, dwellingGuardWeight: 1.5 });
	assert.deepStrictEqual(earlierKeysOf('dwellingGuards', 0), { guardDwellings: 0 });
	assert.deepStrictEqual(earlierKeysOf('mineGuards', 0.5), { guardMines: 1, mineGuardWeight: 0.5 });
	assert.deepStrictEqual(earlierKeysOf('mineGuards', 0), { guardMines: 0 });
	assert.deepStrictEqual(earlierKeysOf('bottleneckGuards', 0.3), { guardBottlenecks: 1, chokeGuardRatio: 0.3 });
	assert.deepStrictEqual(earlierKeysOf('bottleneckGuards', 0), { guardBottlenecks: 0 });
	assert.deepStrictEqual(earlierKeysOf('guardStrengthByDistance', 0.4), { guardDistance: 0.4, guardGradient: 0.4 });
	const t = translate({ treasureGuards: '2', guardMines: '0', lootGuardWeight: '3', subterraneanNarrow: '0.2' });
	assert.deepStrictEqual(t.bio, { guardTreasure: '1', lootGuardWeight: '2', guardMines: '0', subterraneanNarrow: '0.2' }, 'the newer key wins over an earlier key beside it');
	assert.deepStrictEqual(t.translated, ['treasureGuards']);
	assert.deepStrictEqual(translate({ guardMines: '0', guardGradient: '0.5' }).bio, { guardMines: '0', guardGradient: '0.5' }, 'an earlier key alone is untouched');
	assert.deepStrictEqual(translate({ mineGuards: '-1' }).bio, {}, 'below the range is Template: nothing is set');
});

test('a map made with a newer key is the map made with the earlier keys it stands for', { timeout: 1800000 }, () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'monster-keys-'));
	const hash = f => {
		const M = sight.load(f);
		return M.objs.map(x => [x.type, x.subtype, x.l, x.x, x.y, (x.options && x.options.amount) || ''].join(',')).sort().join('|') + '#' + M.terr.join('') + '#' + Array.from(M.road).join('');
	};
	const make = (tag, args) => {
		const out = path.join(tmp, tag + '.vmap');
		const r = spawnSync(process.execPath, [CLI, '--w', '72', '--h', '72', '--players', '4', '--seed', '1', '--underground', '1', '--declaremods', '0', ...args, '--out', out],
			{ encoding: 'utf8', cwd: ROOT, env: genEnv(), windowsHide: true, timeout: 280000, maxBuffer: 1 << 28 });
		assert.strictEqual(r.status, 0, (r.stderr || '').slice(-400));
		return hash(out);
	};
	const base = make('base', []);
	const pairs = [
		[['--bio.treasureGuards', '2'], ['--bio.lootGuardWeight', '2', '--bio.guardTreasure', '1']],
		[['--bio.mineGuards', '0'], ['--bio.guardMines', '0']],
		[['--bio.dwellingGuards', '0'], ['--bio.guardDwellings', '0']],
		[['--bio.bottleneckGuards', '0.3'], ['--bio.chokeGuardRatio', '0.3', '--bio.guardBottlenecks', '1']],
		[['--bio.guardStrengthByDistance', '0.5'], ['--bio.guardDistance', '0.5', '--bio.guardGradient', '0.5']],
	];
	for (const [i, [a, b]] of pairs.entries()) {
		const ha = make('a' + i, a), hb = make('b' + i, b);
		assert.strictEqual(ha, hb, `${a.join(' ')} gives the map of ${b.join(' ')}`);
		assert.notStrictEqual(ha, base, `${a.join(' ')} changes the map`);
	}
	fs.rmSync(tmp, { recursive: true, force: true });
});

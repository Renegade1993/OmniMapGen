'use strict';
/**
 * neutral_measure.js - what a named template gives by itself at a map size and a player count (S386, K: "template for the numerical sliders should be a numerical setting
 * that represents what the template defaults to at that given size, so the player can easily adjust it up or down from there").
 *
 *   node tools/neutral_measure.js "Template name" [sizes] [players]     one JSON line per size and player count, for neutral_merge.js
 *   node tools/neutral_merge.js lines.jsonl ...                          writes them into mod/template-info.json under templates.<name>.neutral
 *
 * Read from the layout the generator makes (--layout 1, the plan only, seed 1, one level, the template as it is at its defaults): zoneCells is the mean land of the
 * zones that are not starts, startZoneShare the share of the land the start zones take, zoneCap the zones a level has. Water is not read (a dry map).
 * VCMI_ROOT (or --vcmiroot through the environment) names the VCMI install the generator reads, as for every run.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SIZES = [36, 72, 108, 144, 180, 216, 252];
const PLAYERS = [2, 4, 6, 8];

function measure(template, size, players) {
	const r = spawnSync(process.execPath, [path.join(ROOT, 'src', 'main', 'generate-cli.js'), '--layout', '1', '--w', String(size), '--h', String(size), '--players', String(players), '--seed', '1',
		'--template', template, '--accommodate', 'size,players,humans,underground'], { encoding: 'utf8', cwd: ROOT, timeout: 900000, windowsHide: true, maxBuffer: 1 << 28 });
	const line = (r.stdout || '').split('\n').find(l => l.startsWith('{"plan"'));
	if (!line) return { template, size, players, error: ((r.stderr || '') + (r.stdout || '')).slice(-160).replace(/\s+/g, ' ') };
	const j = JSON.parse(line), p = j.plan[0];
	const start = [], neutral = [];
	p.types.forEach((t, i) => (/start/i.test(t) ? start : neutral).push(p.zoneLand[i]));
	const sum = a => a.reduce((x, y) => x + y, 0);
	return { template, size, players, levels: j.plan.length, zoneCap: p.types.length,
		zoneCells: neutral.length ? Math.round(sum(neutral) / neutral.length) : null,
		startZoneShare: +(sum(start) / Math.max(1, sum(p.zoneLand))).toFixed(3) };
}

if (require.main === module) {
	const template = process.argv[2];
	if (!template) { console.error('usage: node tools/neutral_measure.js "Template name" [sizes 36,72,...] [players 2,4,...]'); process.exit(2); }
	const sizes = process.argv[3] ? process.argv[3].split(',').map(Number) : SIZES;
	const players = process.argv[4] ? process.argv[4].split(',').map(Number) : PLAYERS;
	for (const s of sizes) for (const n of players) console.log(JSON.stringify(measure(template, s, n)));
}

module.exports = { measure, SIZES, PLAYERS };

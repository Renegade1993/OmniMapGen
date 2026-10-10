'use strict';
/**
 * template_report.js - every comparison of our maps against the engine's for one template and setting, in one markdown
 * file, so whoever works the template runs one command after each change and reads one page. Each section is one of
 * the tools beside this file; the report says what each number means and what the engine's side is.
 *
 *   node tools/geometry/template_report.js --engine E.vmap... --ours O.vmap... --out REPORT.md [--rich 17,18] [--quick]
 *
 * --quick skips the slow sections (per-kind object mix, road shape). The engine's maps must be made with the mods the
 * map is for (.tmp\opus-seeing\eng_k.py); both sides need zone sidecars (.zones.json beside each map).
 * Sections: checks (mapsight check per map of ours), zone areas, per-zone loot and guards (zrate), zone-type fit
 * (classfit), object kinds furthest from the engine's (ztypes), dwellings and rich-zone dwellings, road loops, scenery
 * repetition (decorrepeat), road shape (capture.js summary lines).
 * K, 2026-10-03: "it's more important for you to take your time and build the best processes, tools, and documentation
 * for future agents ... The goal is to have a sonnett model do the next template to perfection in half the time".
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const opt = (a, n) => { const out = []; const i = a.indexOf(n); if (i >= 0) for (let j = i + 1; j < a.length && !a[j].startsWith('--'); j++) out.push(a[j]); return out; };

function run(script, args, timeoutS = 900) {
	const r = spawnSync(process.execPath, [path.join(ROOT, script), ...args], { encoding: 'utf8', cwd: ROOT, timeout: timeoutS * 1000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
	if (r.error) return `(${script} failed: ${r.error.message})`;
	return ((r.stdout || '') + (r.status ? `\n(${script} exit ${r.status}: ${(r.stderr || '').slice(-300)})` : '')).trimEnd();
}

function zoneList(files) {
	const sight = require('../mapsight/lib/sight');
	const zs = new Set();
	for (const f of files.slice(0, 2)) { const M = sight.load(f); for (const [id] of (M.zones && M.zones.zones) || []) zs.add(Number(id)); }
	return [...zs].sort((a, b) => a - b).join(',');
}

function main(a) {
	const E = opt(a, '--engine'), O = opt(a, '--ours'), out = opt(a, '--out')[0] || 'template_report.md';
	const rich = opt(a, '--rich')[0], quick = a.includes('--quick');
	if (!E.length || !O.length) { console.error('need --engine and --ours maps'); process.exit(2); }
	const zones = zoneList(E);
	const L = [];
	const sec = (title, what, body) => { L.push(`## ${title}`, '', what, '', '```', body, '```', ''); console.error(`[report] ${title}`); };
	L.push(`# Template report`, '', `Engine maps: ${E.length} (${path.basename(E[0])} ...). Ours: ${O.length} (${path.basename(O[0])} ...).`,
		`Made ${new Date().toISOString().slice(0, 16).replace('T', ' ')} by tools/geometry/template_report.js.`, '');

	sec('Checks', 'mapsight check on each map of ours: road ends, reachability, structure. Every map must PASS before any number below matters.',
		O.map(f => run('tools/mapsight/mapsight.js', ['check', f], 300).split('\n')[0]).join('\n'));
	sec('Zone areas', 'Tiles of each template zone per map (u = underground only, #N = split into N pieces, which the engine\'s zones never are). A zone far outside the engine\'s spread drags every per-zone count with it; fix areas first.',
		run('tools/geometry/zonearea.js', [...E.slice(0, 6), ...O]));
	sec('Per zone: guards, high and low loot per 100 zone tiles', 'Engine mean (min-max) against ours. Per ZONE tile: an open-tile count moves with our own scenery.',
		run('tools/geometry/zrate.js', [zones, '--engine', ...E, '--ours', ...O]));
	sec('Zone types: ours over the engine\'s', 'One line per zone type (from the sidecar), and one error number to compare runs by (sum of |log ratio|; five seeds read noise of about 0.4).',
		run('tools/geometry/classfit.js', ['--engine', ...E, '--ours', ...O]));
	sec('Dwellings', 'Per map; "rich zones" are junctions, or the zones named with --rich. A template\'s signature dwellings belong here.',
		run('tools/geometry/dwellings.js', [...(rich ? ['--rich', rich] : []), ...E.slice(0, 6), ...O]));
	sec('Loot by map block', 'Pickups and treasure per 100 open tiles in a 4x4 grid per level, engine / ours. A hot corner or edge is a pass that dumps leftovers, or a zone whose open ground is too small for what it holds (K, 2026-10-03: corners stacked).',
		run('tools/geometry/lootgrid.js', ['--engine', ...E, '--ours', ...O]));
	sec('Road loops', 'Independent loops per level. The engine\'s roads are trees between nodes; Coldshadow\'s engine maps: surface 0, underground 1-3.',
		run('tools/geometry/roadloops.js', [...E.slice(0, 4), ...O]));
	sec('Scenery repetition', 'clump: identical pieces within 6 tiles, per piece; kinds/100: variety. The engine\'s numbers are the target.',
		run('tools/geometry/decorrepeat.js', [...E.slice(0, 4), ...O]));
	if (!quick) {
		sec('Object kinds furthest from the engine\'s (whole map, per 1000 tiles)', 'The 30 largest gaps. A kind the engine has and ours never shows is usually a placement or a pool bug, not a rate.',
			run('tools/geometry/ztypes.js', [zones, '--engine', ...E, '--ours', ...O]).split('\n').slice(0, 30).join('\n'));
		const tmp = path.join(require('os').tmpdir(), `treport_${process.pid}`);
		sec('Road shape', 'capture.js per map: edges, joints, ends by what they touch; straightness, mean straight run, stair share (engine Coldshadow: 0.72-0.74, 2.6-2.8, 0.94-0.97).',
			run('tools/geometry/capture.js', [...E.slice(0, 2), ...O.slice(0, 3), '--out', tmp], 1200).split('\n').filter(l => /road edges|ends|\.vmap/.test(l)).join('\n'));
	}
	fs.writeFileSync(out, L.join('\n'));
	console.log(`wrote ${out}`);
}

if (require.main === module) main(process.argv.slice(2));

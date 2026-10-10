'use strict';
/**
 * load.js - does the real game load and play the map? K, 2026-10-01: "engineer these gaps away" (nothing checked that
 * the game shows what the file says). Wraps the team's real-engine loader, `.tmp\opus\modmap_load.py`: it copies the map
 * into VCMI\dmbtest, starts the client with --testmap on an invisible desktop (kill-on-close job, hard deadline 150 s)
 * and reads the client log: objects or templates the engine refused, errors, whether the AI plays.
 *
 *   mapsight load <map.vmap>... [--wait 45]
 *
 * One map at a time (the client is heavy); each is summed up in a line: started, AI moves, problems (refused objects
 * and errors, the first few quoted). A map the game refuses, or one where objects are dropped, fails.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT = path.resolve(__dirname, '..', '..', '..', '..');
const LOADER = path.join(PROJECT, '.tmp', 'opus', 'modmap_load.py');

function main(args) {
	const maps = args.filter(a => /\.vmap$/i.test(a));
	const wi = args.indexOf('--wait'), wait = wi >= 0 ? args[wi + 1] : '45';
	if (!maps.length) { console.log('load needs one or more .vmap files'); process.exitCode = 2; return; }
	if (!fs.existsSync(LOADER)) { console.log(`the loader is missing: ${LOADER}`); process.exitCode = 2; return; }
	let bad = 0;
	for (const m of maps) {
		const r = spawnSync('py', [LOADER, path.resolve(m), '--wait', wait], { encoding: 'utf8', timeout: 200000, windowsHide: true });
		let res = null;
		try { const s = r.stdout || ''; res = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); } catch (e) { res = null; }
		if (!res) { bad++; console.log(`FAIL ${path.basename(m)}: no result from the loader (${(r.stderr || r.error || '').toString().slice(0, 200)})`); continue; }
		const listed = Array.isArray(res.first_problems) ? res.first_problems : Array.isArray(res.problems) ? res.problems : [];
		const problems = listed.filter(p => !/Cannot answer the query|Goal Invalid/.test(p));
		const nProblems = typeof res.problems === 'number' ? res.problems : problems.length;
		const ok = res.started && (res.ai_moves || 0) > 0 && !problems.some(p => /ERROR|refus|unknown|failed|cannot/i.test(p));
		if (!ok) bad++;
		console.log(`${ok ? 'OK  ' : 'FAIL'} ${path.basename(m)}: started ${!!res.started}, AI moves ${res.ai_moves || 0}, problems ${nProblems} (${problems.length} shown apart from AI chatter)`
			+ (problems.length ? `: ${problems.slice(0, 3).map(p => p.replace(/^\S+\]\s*/, '').slice(0, 140)).join(' | ')}` : ''));
	}
	process.exitCode = bad ? 1 : 0;
}

module.exports = { main };

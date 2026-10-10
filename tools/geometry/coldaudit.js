// tools/geometry/coldaudit.js MAP...: what K checks on a Coldshadow map. Neutral dragon dwellings by type and level, towns per start
// zone (the template gives each start zone its player town and one more), which starts are underground.
const sight = require('../mapsight/lib/sight');
for (const f of process.argv.slice(2)) {
	const M = sight.load(f);
	const dr = M.objs.filter(o => /sulfurousLair|crystalCavern|frozenCliffs|magicForest/.test(String(o.subtype)) && o.type !== 'mine');
	const byT = {};
	for (const o of dr) { const k = `${o.subtype}@L${o.l}`; byT[k] = (byT[k] || 0) + 1; }
	const towns = M.objs.filter(o => o.cls === 'town');
	const starts = towns.filter(o => o.options && o.options.owner);
	const perStart = starts.map(s => {
		const z = M.zoneAt ? M.zoneAt(s.l, s.at[0], s.at[1]) : undefined;
		const n = z === undefined ? '?' : towns.filter(t => t.l === s.l && M.zoneAt(t.l, t.at[0], t.at[1]) === z).length;
		return `${s.options.owner}${s.l ? '(u)' : ''}:${n}`;
	});
	console.log(`${f.split(/[\\/]/).pop()} | dragon dwellings ${dr.length} ${JSON.stringify(byT)} | towns ${towns.length} | towns in each start zone ${perStart.join(' ')}`);
}

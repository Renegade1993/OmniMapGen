// tools/geometry/kaudit.js: K's newest generated maps, per map: size, levels, neutral dragon dwellings (by level), starts (by level),
// towns per start zone. node kaudit.js [N]
const fs = require('fs'), path = require('path');
const sight = require('../mapsight/lib/sight');
const dir = path.join(process.env.DMB_USER_DIR || path.join(require('os').homedir(), 'Documents', 'My Games', "Dead Man's Boots"), 'Maps', 'RandomMaps');
const n = Number(process.argv[2] || 8);
const files = fs.readdirSync(dir).filter(f => f.endsWith('.vmap')).map(f => path.join(dir, f))
	.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs).slice(0, n);
for (const f of files) {
	try {
		const M = sight.load(f);
		const dr = M.objs.filter(o => /sulfurousLair|crystalCavern|frozenCliffs|magicForest/.test(String(o.subtype)) && o.type !== 'mine');
		const towns = M.objs.filter(o => o.cls === 'town');
		const st = towns.filter(o => o.options && o.options.owner);
		const byL = {};
		for (const o of dr) byL['L' + o.l] = (byL['L' + o.l] || 0) + 1;
		const t = new Date(fs.statSync(f).mtimeMs).toTimeString().slice(0, 5);
		let zinfo = '';
		const zf = f + '.zones.json';
		if (fs.existsSync(zf)) {
			const z = JSON.parse(fs.readFileSync(zf, 'utf8'));
			zinfo = ' zones.json keys ' + Object.keys(z).slice(0, 6).join(',');
		}
		console.log(`${t} ${path.basename(f)} ${M.W}x${M.H} levels ${M.L || (M.objs.some(o => o.l === 1) ? 2 : 1)} | dragon dwellings ${dr.length} ${JSON.stringify(byL)} ${[...new Set(dr.map(o => o.subtype))].join(',')} | starts ${st.map(o => o.options.owner + (o.l ? '(u)' : '')).join(' ')} | towns ${towns.length}${zinfo}`);
	} catch (e) { console.log(path.basename(f), 'ERR', e.message.split('\n')[0]); }
}

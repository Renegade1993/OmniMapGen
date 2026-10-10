// openshare.js MAP...: share of land tiles a hero can stand on (not blocked by scenery or objects), whole map and the
// four lowest zones (mapsight check's openGround, which notes the engine's figures)
const s = require('../mapsight/lib/sight');
const { openGround } = require('../mapsight/lib/check');
for (const f of process.argv.slice(2)) {
	const g = openGround(s.load(f));
	console.log(f.split(/[\/\\]/).pop().padEnd(28), 'open', (100 * g.share).toFixed(0) + '%', ' lowest zones', g.zones.slice(0, 4).map(e => `z${e.zone} ${(100 * e.share).toFixed(0)}%`).join(' '));
}

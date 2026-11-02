'use strict';
/**
 * srcTrace.js - VMAPGEN_SRC_TRACE only: a monster entry records the tile it was posted on and every later move with the caller
 * that made it (monster stacking, K, 2026-10-31: "still have a lot of monster stacking"). x and y become accessors on the traced
 * entry; nothing changes when the variable is unset.
 */
function caller() {
	return new Error().stack.split('\n').slice(3, 6).map(s => (/at (\S+)/.exec(s) || [])[1]).join('<');
}
function traceMoves(entry) {
	let x = entry.x, y = entry.y;
	entry.__at0 = (entry.l || 0) + ',' + x + ',' + y;
	Object.defineProperty(entry, '__moves', { value: [], enumerable: false, writable: true });
	Object.defineProperty(entry, 'x', { enumerable: true, configurable: true, get: () => x,
		set: v => { if (v !== x) entry.__moves.push(`x ${x}>${v} ${caller()}`); x = v; } });
	Object.defineProperty(entry, 'y', { enumerable: true, configurable: true, get: () => y,
		set: v => { if (v !== y) entry.__moves.push(`y ${y}>${v} ${caller()}`); y = v; } });
	return entry;
}
module.exports = { traceMoves };

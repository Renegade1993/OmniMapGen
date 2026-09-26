/**
 * palette.js - terrain/object colors for the headless PNG renderer
 * (generate-cli --render). Pure CommonJS: no canvas, no DOM.
 *
 * Terrain ids are moddable, so anything unknown falls back to a deterministic
 * hash color - same map always gets the same color.
 */
'use strict';

const TERRAIN_COLORS = {
	dt: [181, 154, 108], gr: [74, 125, 58], sn: [216, 221, 226],
	sw: [61, 107, 53], sa: [217, 194, 122], ro: [107, 107, 107],
	lv: [194, 80, 30], sb: [58, 77, 92], wa: [34, 85, 170],
	pd: [122, 106, 85], hg: [93, 125, 74], wl: [77, 93, 58],
};

function terrainColor(shortId) {
	if (TERRAIN_COLORS[shortId]) return TERRAIN_COLORS[shortId];
	let h = 0;
	for (const c of String(shortId)) h = (h * 31 + c.charCodeAt(0)) | 0;
	const hue = ((h % 360) + 360) % 360;
	// hsl(35% sat, 40% light) -> rgb
	const s = 0.35, l = 0.40;
	const k = n => (n + hue / 30) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return [f(0) * 255 | 0, f(8) * 255 | 0, f(4) * 255 | 0];
}

const PLAYER_RGB = {
	red: [255, 60, 60], blue: [60, 110, 255], tan: [210, 180, 120],
	green: [60, 180, 60], orange: [255, 140, 40], purple: [170, 80, 220],
	teal: [40, 200, 200], pink: [255, 130, 180],
};

/**
 * Object -> {color, size} for the preview. size is the marker half-extent in
 * cells: towns are big, a resource pile is a pinprick. Anything not listed
 * draws as a 1-cell dark dot.
 */
const OBJECT_STYLES = {
	randomTown: { color: [255, 255, 255], size: 3, ring: true },
	randomHero: { color: [255, 220, 60], size: 2 },
	randomDwelling: { color: [220, 130, 255], size: 1 },
	mine: { color: [255, 200, 0], size: 1 },
	monolithTwoWay: { color: [60, 220, 255], size: 1 },
	subterraneanGate: { color: [255, 255, 255], size: 2, ring: true },
	subterraneanGateUnder: { color: [255, 255, 255], size: 2, ring: true },
	creatureBank: { color: [255, 100, 40], size: 1 },
	pandoraBox: { color: [180, 60, 220], size: 1 },
	prison: { color: [120, 60, 200], size: 1 },
	obelisk: { color: [240, 240, 240], size: 1 },
	grail: { color: [255, 215, 0], size: 2, ring: true },
	// water (waterfill.js)
	boat: { color: [150, 90, 30], size: 1, ring: true },
	shipyard: { color: [150, 90, 30], size: 2, ring: true },
	flotsam: { color: [255, 230, 120], size: 0 },
	seaChest: { color: [255, 230, 120], size: 1 },
	shipwreckSurvivor: { color: [255, 230, 120], size: 1 },
	buoy: { color: [255, 255, 255], size: 0 },
	mermaids: { color: [120, 255, 200], size: 1 },
	derelictShip: { color: [255, 100, 40], size: 1 },
	shipwreck: { color: [255, 100, 40], size: 1 },
	reef: { color: [70, 60, 50], size: 0 },
	rock: { color: [70, 60, 50], size: 0 },
	kelp: { color: [40, 110, 70], size: 0 },
};

function objectStyle(o) {
	if (OBJECT_STYLES[o.type]) return OBJECT_STYLES[o.type];
	if (o.type === 'monster' || o.type.startsWith('randomMonsterLevel'))
		return { color: [230, 50, 50], size: 0 };
	if (o.type.startsWith('randomArtifact'))
		return { color: [0, 0, 0], size: 0 };
	return { color: [30, 30, 30], size: 0 };
}

/** Player color for a town marker: explicit owner wins, else the alignment. */
function townOwnerColor(o) {
	const c = (o.options && (o.options.owner || o.options.alignmentToPlayer)) || null;
	return c && PLAYER_RGB[c] ? PLAYER_RGB[c] : null;
}

const FLIP_CHARS = new Set(['_', '-', '|', '+']);

/**
 * "<terr><view><flip>[road<2ch><dir><flip>][river...]" ->
 * {terr, road, river}. Shared by the canvas preview and the PNG renderer.
 */
function parseTileCode(code) {
	code = String(code);
	const terr = code.slice(0, 2);
	let i = 2;
	while (i < code.length && /[0-9]/.test(code[i])) i++;
	if (FLIP_CHARS.has(code[i])) i++;
	const extras = [];
	while (i + 2 < code.length) {
		const kind = code.slice(i, i + 2);
		let j = i + 2;
		while (j < code.length && /[0-9]/.test(code[j])) j++;
		if (!FLIP_CHARS.has(code[j])) break;
		extras.push(kind);
		i = j + 1;
	}
	return { terr, road: extras[0] || null, river: extras[1] || null };
}

module.exports = { TERRAIN_COLORS, terrainColor, PLAYER_RGB,
	OBJECT_STYLES, objectStyle, townOwnerColor, parseTileCode };

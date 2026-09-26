/**
 * terrainView.js - pick the terrain sprite for every tile.
 *
 * `terView` in a tile code is the frame index the renderer uses directly
 * (MapRenderer.cpp:162); nothing recomputes it at load. Which frame is right
 * depends on what surrounds the tile: a grass tile in open grass uses a plain
 * ground frame, a grass tile beside sand uses the frame that draws the sand
 * edge on that side. Get it wrong and every border on the map reads as a hard
 * line, or worse, the whole map reads as border fragments, which is what the
 * generator did before 2026-09-21.
 *
 * This is a transcription of VCMI's own algorithm, from
 * `CDrawTerrainOperation::updateTerrainViews` and `validateTerrainViewInner`
 * in lib/mapping/CMapOperation.cpp, over the table in
 * config/terrainViewPatterns.json. The table is bundled beside this file and
 * the live install's copy is preferred when one is passed in.
 *
 * Three things in the original are easy to get wrong and are reproduced here
 * deliberately:
 *
 *  - **The flip list is built by mutating one pattern in place** (the engine
 *    carries a FIXME about it). Each step flips horizontally and step 2 also
 *    flips vertically, so the list is [P, H(P), V(P), H(V(P))]: all four
 *    orientations, in the order whose index the engine stores. (Until
 *    2026-09-24 this file applied the vertical flip at step 3 too, which
 *    lost the half turn; see buildPatterns.)
 *  - **Out-of-map neighbours take the terrain of the tile between them and the
 *    map**, or the centre tile's own terrain at a corner, rather than counting
 *    as alien.
 *  - **A rule naming another pattern recurses** into that pattern at the
 *    neighbour's position, once only, and only when the neighbour is native or
 *    the centre is dirt beside something that needs no transition.
 */
'use strict';

const RULE_DIRT = 'D', RULE_SAND = 'S', RULE_TRANSITION = 'T';
const RULE_NATIVE = 'N', RULE_NATIVE_STRONG = 'N!', RULE_ANY = '?';
const STANDARD = new Set([RULE_ANY, RULE_DIRT, RULE_NATIVE, RULE_SAND,
	RULE_TRANSITION, RULE_NATIVE_STRONG]);

function parseRule(text) {
	const parts = text.split('-');
	const name = parts[0];
	return {
		name,
		points: parts.length > 1 ? parseInt(parts[1], 10) : 0,
		standard: STANDARD.has(name),
		any: name === RULE_ANY,
		dirt: name === RULE_DIRT,
		sand: name === RULE_SAND,
		transition: name === RULE_TRANSITION,
		nativeStrong: name === RULE_NATIVE_STRONG,
		native: name === RULE_NATIVE,
	};
}

/** The rule a non-standard reference collapses to once recursion is refused. */
const NATIVE_RULE = { name: RULE_NATIVE, points: 0, standard: true, any: false,
	dirt: false, sand: false, transition: false, nativeStrong: false, native: true };

function parseData(data) {
	return data.map(cell => cell.replace(/ /g, '').split(',').map(parseRule));
}

/** Horizontal then, at step 2 only, vertical. Mutates, as the engine does. */
function flipInPlace(data) {
	for (let i = 0; i < 3; i++) {
		const y = i * 3;
		const t = data[y]; data[y] = data[y + 2]; data[y + 2] = t;
	}
}
function flipVerticalInPlace(data) {
	for (let i = 0; i < 3; i++) {
		const t = data[i]; data[i] = data[i + 6]; data[i + 6] = t;
	}
}

function parseMapping(text) {
	const clean = text.replace(/ /g, '');
	const colon = clean.indexOf(':');
	const flipMode = colon >= 0 ? clean.slice(0, colon) : '';
	const diffImages = flipMode.endsWith('D');
	const rotationTypesCount = diffImages ? parseInt(flipMode.slice(0, -1), 10) : 0;
	const body = colon >= 0 ? clean.slice(colon + 1) : clean;
	const ranges = body.split(',').map(r => {
		const parts = r.split('-');
		return [parseInt(parts[0], 10), parseInt(parts.length > 1 ? parts[1] : parts[0], 10)];
	});
	return { diffImages, rotationTypesCount, ranges };
}

/**
 * Build the per-group pattern lists from the engine's JSON.
 * Returns {byGroup: Map<group, pattern[][]>, byId: Map<id, pattern[]>}.
 */
function buildPatterns(config) {
	const byGroup = new Map();
	const byId = new Map();

	for (const node of config.terrainView || []) {
		const base = {
			id: node.id,
			decoration: !!node.decoration,
			minPoints: node.minPoints ? Number(node.minPoints) : 0,
			maxPoints: node.maxPoints ? Number(node.maxPoints) : Infinity,
		};
		for (const [group, text] of Object.entries(node.mapping || {})) {
			const m = parseMapping(String(text));
			// One shared data array, mutated between pushes, as the engine does
			// (MapEditUtils.cpp:250-256): flipPattern(p, i) always flips
			// horizontally and adds the vertical flip only when i is 2
			// (FLIP_PATTERN_VERTICAL). In place that gives P, H(P), V(P) and
			// H(V(P)): all four orientations. This used to add the vertical
			// flip at step 3 as well, which made the fourth entry a copy of
			// H(P), so no pattern ever matched turned half way round: every
			// corner facing one way went unmatched (a square lake drew three
			// of its corners, a diagonal coast running one way drew none).
			const data = parseData(node.data);
			const flips = [{ ...base, ...m, data: data.slice() }];
			flipInPlace(data);
			flips.push({ ...base, ...m, data: data.slice() });
			flipInPlace(data); flipVerticalInPlace(data);
			flips.push({ ...base, ...m, data: data.slice() });
			flipInPlace(data);
			flips.push({ ...base, ...m, data: data.slice() });
			if (!byGroup.has(group)) byGroup.set(group, []);
			byGroup.get(group).push(flips);
		}
	}

	// A rule that names another pattern resolves inside the NEIGHBOUR terrain's
	// own view-pattern group, which is what getTerrainViewPatternsById does:
	// it calls getTerrainViewPatterns(terrain) and searches that list by id.
	// The separate "terrainType" section of the file shares several ids with
	// the view patterns (n1, s1, s2) and belongs to a different lookup
	// entirely; resolving references against it silently matched the wrong
	// pattern and cost about three points of agreement with the engine.
	for (const [group, list] of byGroup) {
		const ids = new Map();
		for (const flipSet of list) ids.set(flipSet[0].id, flipSet);
		byId.set(group, ids);
	}

	return { byGroup, byId };
}

/**
 * Assign a view and flip to every cell of one level.
 *
 * terrainAt(x, y) must return
 *   {id, group, transitionRequired, passable, isDirt, isSand}
 * for an in-map cell. rng is () => [0,1).
 *
 * Returns {views: Int32Array, flips: Uint8Array, unmatched: number}.
 */
function assignTerrainViews(W, H, terrainAt, patterns, rng, decorationPercent = 15,
	report = null) {
	const views = new Int32Array(W * H);
	const flips = new Uint8Array(W * H);
	const unmatchedCells = new Uint8Array(W * H);
	let unmatched = 0;

	// Which terrain a neighbour off the edge of the map counts as: the engine
	// borrows the tile between it and the map, or the centre at a corner.
	const neighbourTerrain = (x, y, cx, cy, centre) => {
		if (cx >= 0 && cy >= 0 && cx < W && cy < H) return terrainAt(cx, cy);
		const tooRight = cx >= W, tooLeft = cx < 0;
		const tooLow = cy >= H, tooHigh = cy < 0;
		if ((tooRight || tooLeft) && (tooLow || tooHigh)) return centre;
		if (tooRight) return terrainAt(cx - 1, cy);
		if (tooLow) return terrainAt(cx, cy - 1);
		if (tooLeft) return terrainAt(cx + 1, cy);
		if (tooHigh) return terrainAt(cx, cy + 1);
		return centre;
	};

	function validateInner(x, y, pattern, recDepth) {
		const centre = terrainAt(x, y);
		let totalPoints = 0;
		let transitionReplacement = '';

		for (let i = 0; i < 9; i++) {
			if (i === 4) continue;
			const cx = x + (i % 3) - 1;
			const cy = y + ((i / 3) | 0) - 1;
			const inMap = cx >= 0 && cy >= 0 && cx < W && cy < H;
			const terType = neighbourTerrain(x, y, cx, cy, centre);
			const isAlien = inMap && terType.id !== centre.id
				&& (terType.passable || centre.passable);

			let topPoints = -1;
			for (const raw of pattern.data[i]) {
				let rule = raw;
				if (!rule.standard) {
					if (recDepth === 0 && inMap) {
						if (centre.id === terType.id
							|| (centre.isDirt && !terType.transitionRequired)) {
							const ids = patterns.byId.get(terType.group)
								|| patterns.byId.get('normal');
							const flipSet = ids && ids.get(rule.name);
							if (flipSet) {
								const r = validate(cx, cy, flipSet, 1);
								if (r.ok) topPoints = Math.max(topPoints, rule.points);
							}
						}
						continue;
					}
					rule = { ...NATIVE_RULE, points: rule.points };
				}

				const apply = ok => { if (ok) topPoints = Math.max(topPoints, rule.points); };
				const nativeStrongOk = (rule.nativeStrong || rule.native) && !isAlien;
				let nativeOk = nativeStrongOk;

				if (centre.isDirt) {
					nativeOk = rule.native && !terType.transitionRequired;
					const sandOk = (rule.sand || rule.transition) && terType.transitionRequired;
					apply(rule.any || sandOk || nativeOk || nativeStrongOk);
				} else if (centre.isSand) {
					apply(true);
				} else if (centre.transitionRequired) {
					const sandOk = (rule.sand || rule.transition) && isAlien;
					apply(rule.any || sandOk || nativeOk);
				} else {
					const dirtOk = (rule.dirt || rule.transition) && isAlien
						&& !terType.transitionRequired;
					const sandOk = (rule.sand || rule.transition) && terType.transitionRequired;
					if (!transitionReplacement && rule.transition && (dirtOk || sandOk))
						transitionReplacement = dirtOk ? RULE_DIRT : RULE_SAND;
					if (rule.transition)
						apply((dirtOk && transitionReplacement !== RULE_SAND)
							|| (sandOk && transitionReplacement !== RULE_DIRT));
					else
						apply(rule.any || dirtOk || sandOk || nativeOk);
				}
			}

			if (topPoints === -1) return { ok: false, transitionReplacement: '' };
			totalPoints += topPoints;
		}

		if (totalPoints >= pattern.minPoints && totalPoints <= pattern.maxPoints)
			return { ok: true, transitionReplacement };
		return { ok: false, transitionReplacement: '' };
	}

	function validate(x, y, flipSet, recDepth) {
		for (let flip = 0; flip < 4; flip++) {
			const r = validateInner(x, y, flipSet[flip], recDepth);
			if (r.ok) return { ok: true, flip, transitionReplacement: r.transitionReplacement };
		}
		return { ok: false, flip: 0, transitionReplacement: '' };
	}

	for (let y = 0; y < H; y++) {
		for (let x = 0; x < W; x++) {
			const centre = terrainAt(x, y);
			const groupPatterns = patterns.byGroup.get(centre.group)
				|| patterns.byGroup.get('normal') || [];
			let best = null, result = null;
			for (const flipSet of groupPatterns) {
				const r = validate(x, y, flipSet, 0);
				if (r.ok) { best = flipSet; result = r; break; }
			}
			const cell = y * W + x;
			if (!best) {
				// the engine logs and leaves the tile alone; plain ground is a
				// better answer than whatever was there before
				unmatched++;
				unmatchedCells[cell] = 1;
				const fallback = patterns.byGroup.get(centre.group)
					|| patterns.byGroup.get('normal');
				const n1 = fallback && fallback.find(f => f[0].id === 'n1');
				views[cell] = n1 ? n1[0].ranges[0][0] : 0;
				flips[cell] = 0;
				continue;
			}
			const pattern = best[result.flip];
			if (report) report[cell] = { id: pattern.id, flip: result.flip,
				ranges: pattern.ranges, diffImages: pattern.diffImages,
				rotationTypesCount: pattern.rotationTypesCount };
			let range = pattern.ranges[0];
			if (pattern.decoration)
				range = (pattern.ranges.length < 2 || rng() * 100 > decorationPercent)
					? pattern.ranges[0] : pattern.ranges[1];
			if (result.transitionReplacement && pattern.ranges.length > 1)
				range = result.transitionReplacement === RULE_DIRT
					? pattern.ranges[0] : pattern.ranges[1];

			if (!pattern.diffImages) {
				views[cell] = range[0] + ((rng() * (range[1] - range[0] + 1)) | 0);
				flips[cell] = result.flip;
			} else {
				const framesPerRot = ((range[1] - range[0] + 1) / pattern.rotationTypesCount) | 0;
				const flip = (pattern.rotationTypesCount === 2 && result.flip === 2)
					? 1 : result.flip;
				const first = range[0] + flip * framesPerRot;
				views[cell] = first + ((rng() * framesPerRot) | 0);
				flips[cell] = 0;
			}
		}
	}
	return { views, flips, unmatched, unmatchedCells };
}

/**
 * Nudge terrain so every tile has a pattern that fits it.
 *
 * The pattern table cannot express every arrangement of terrain. VCMI's own
 * draw operation gets around that by CHANGING the terrain until it can: it
 * hunts down tiles whose neighbourhood no pattern covers, most often two
 * terrains meeting only at a diagonal corner, and reshapes them. Our biome
 * edges are sharp Voronoi lines, so we produced more of those than a real map
 * does: 4.2% of a 72x72 against roughly 1% on the installed corpus.
 *
 * This is the cheap version of the same idea. A tile with no matching pattern
 * takes the most common terrain among its eight neighbours, which smooths the
 * awkward corner away, and the pass repeats while it keeps helping. Terrain
 * type has no effect on movement beyond native-terrain bonuses, and the object
 * layer was placed against the biome grid rather than this one, so moving a
 * boundary by a tile changes nothing but the picture.
 *
 * `cells` is a mutable array of terrain keys, one per cell. `terrainOf(key)`
 * returns the properties assignTerrainViews needs.
 */
const DIAGONALS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

function smoothForPatterns(W, H, cells, terrainOf, patterns, rounds = 6, frozen = null, extras = null) {
	// `frozen(cell)` marks ground the smoothing may neither change nor spread.
	// It exists for the solid rock an underground level is carved out of:
	// smoothing knows nothing about caves, so it happily turned a carved cell
	// into rock because most of its neighbours were rock, sealing pockets the
	// planner had checked and signed off. A 108x108 two level map shipped with
	// 137 underground cells nobody could reach and six objects inside them.
	const locked = frozen || (() => false);
	let changedTotal = 0;

	// Pass 1, which does nearly all the work: a foreign tile touching only at a
	// corner. Dumping the unmatched tiles of a 72x72 map showed every one of
	// them was this, a lone dirt tile at the corner of an otherwise unbroken
	// field of grass or rough:
	//
	//     dt gr gr        rg rg rg
	//     gr gr gr        rg rg rg
	//     gr gr gr        rg rg dt
	//
	// The pattern table has no entry for it because the engine does not allow
	// the arrangement to exist: its draw operation hunts these down and
	// reshapes the terrain. Absorbing the corner tile into the field around it
	// is the same answer and needs no second algorithm.
	// The tile absorbed has to be a SPUR: one with no orthogonal neighbour of
	// its own terrain. Without that test the rule eats real regions. A big
	// grass area whose corner happens to touch dirt diagonally would lose that
	// corner, then the new corner, and so on: a 72x72 map lost two thirds of
	// its grass, 1112 tiles down to 382. A corner where two real regions meet
	// is something the pattern table handles perfectly well anyway.
	const isSpur = (x, y) => {
		const k = cells[y * W + x];
		for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
			const nx = x + dx, ny = y + dy;
			if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
			if (cells[ny * W + nx] === k) return false;
		}
		return true;
	};
	for (let round = 0; round < rounds; round++) {
		let changed = 0;
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const here = cells[y * W + x];
				if (locked(y * W + x)) continue;
				for (const [dx, dy] of DIAGONALS) {
					const nx = x + dx, ny = y + dy;
					if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
					if (locked(ny * W + nx)) continue;
					const there = cells[ny * W + nx];
					if (there === here) continue;
					// both cells sharing that corner must be ours, or this is a
					// real edge rather than a corner-only touch
					if (cells[y * W + nx] !== here) continue;
					if (cells[ny * W + x] !== here) continue;
					// Only a lone tile is absorbed. Two other rules were tried
					// and both measured worse. Absorbing any corner eats real
					// regions a tile at a time: a 72x72 map lost two thirds of
					// its grass, 1112 tiles down to 382. Growing the region
					// sideways instead never settles, because each new edge
					// makes another corner: the same map changed 11244 tiles,
					// more than twice what it has, and finished with MORE
					// unmatched than it started with.
					if (!isSpur(nx, ny)) continue;
					cells[ny * W + nx] = here;
					changed++;
				}
			}
		changedTotal += changed;
		if (!changed) break;
	}

	// Pass 2: anything the table still cannot express takes the majority
	// terrain around it. Rare, and a safety net rather than the mechanism.
	for (let round = 0; round < rounds; round++) {
		const at = (x, y) => terrainOf(cells[y * W + x]);
		const probe = assignTerrainViews(W, H, at, patterns, () => 0);
		if (!probe.unmatched) break;
		const next = cells.slice();
		let changed = 0;
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const cell = y * W + x;
				if (!probe.unmatchedCells || !probe.unmatchedCells[cell]) continue;
				if (locked(cell)) continue;
				const tally = new Map();
				for (let dy = -1; dy <= 1; dy++)
					for (let dx = -1; dx <= 1; dx++) {
						if (!dx && !dy) continue;
						const nx = x + dx, ny = y + dy;
						if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
						if (locked(ny * W + nx)) continue;
						const k = cells[ny * W + nx];
						tally.set(k, (tally.get(k) || 0) + 1);
					}
				let best = cells[cell], bestN = -1;
				for (const [k, n] of tally) if (n > bestN) { best = k; bestN = n; }
				if (best !== cells[cell]) { next[cell] = best; changed++; }
			}
		if (!changed) break;
		cells.splice(0, cells.length, ...next);
		changedTotal += changed;
	}

	// Pass 3 (queue 28): what the vote leaves. At a shore corner the vote
	// picks the tile's own terrain and changes nothing: to a land tile's
	// patterns a water neighbour reads as sand and another land terrain as
	// dirt, and no pattern mixes the two that way round (normal oow/ooo/oon).
	// Each candidate (the unlocked neighbours' terrains, and `extras`, the
	// transition terrains the layer allows) is scored by the tiles no pattern
	// fits within two cells of the change, the reach of the matcher's
	// recursive neighbour check; the crop is two cells wider again so every
	// scored tile sees exactly what it sees on the whole map. The best
	// candidate is kept only if it scores strictly lower.
	if (extras)
		for (let round = 0; round < rounds; round++) {
			const probe = assignTerrainViews(W, H, (x, y) => terrainOf(cells[y * W + x]), patterns, () => 0);
			if (!probe.unmatched) break;
			let changed = 0;
			for (let cell = 0; cell < W * H; cell++) {
				if (!probe.unmatchedCells[cell] || locked(cell)) continue;
				const x = cell % W, y = (cell / W) | 0;
				const x0 = Math.max(0, x - 4), y0 = Math.max(0, y - 4);
				const cw = Math.min(W - 1, x + 4) - x0 + 1, ch = Math.min(H - 1, y + 4) - y0 + 1;
				const score = () => {
					const r = assignTerrainViews(cw, ch, (u, v) => terrainOf(cells[(y0 + v) * W + x0 + u]), patterns, () => 0);
					let n = 0;
					for (let v = Math.max(0, y - 2); v <= Math.min(H - 1, y + 2); v++)
						for (let u = Math.max(0, x - 2); u <= Math.min(W - 1, x + 2); u++)
							if (r.unmatchedCells[(v - y0) * cw + u - x0]) n++;
					return n;
				};
				const orig = cells[cell];
				const cands = new Set(extras);
				for (let dy = -1; dy <= 1; dy++)
					for (let dx = -1; dx <= 1; dx++) {
						const nx = x + dx, ny = y + dy;
						if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H || locked(ny * W + nx)) continue;
						cands.add(cells[ny * W + nx]);
					}
				cands.delete(orig);
				let best = orig, bestN = score();
				for (const k of cands) {
					cells[cell] = k;
					const n = score();
					if (n < bestN) { best = k; bestN = n; }
				}
				cells[cell] = best;
				if (best !== orig) changed++;
			}
			changedTotal += changed;
			if (!changed) break;
		}
	return changedTotal;
}

module.exports = { buildPatterns, assignTerrainViews, smoothForPatterns,
	parseMapping, parseData };

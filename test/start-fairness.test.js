/**
 * start-fairness.test.js - the starts' cheapest ways out evened out
 * (src/main/startFairness.js), on maps drawn by hand: rooms opening on a
 * shared hall through one guarded gap each.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { evenStarts } = require('../src/main/startFairness');

// rooms side by side on rows 0-6, walled from each other and from the hall
// (rows 8-11) but for one gap in row 7, a monster standing in it
function world(rooms) {
	const W = 10 * rooms.length, H = 12;
	const wall = new Uint8Array(W * H);
	const objects = [], starts = [], links = [];
	rooms.forEach((r, i) => {
		const x0 = i * 10;
		for (let y = 0; y <= 7; y++) wall[y * W + x0 + 9] = 1;
		for (let x = x0; x < x0 + 10; x++) wall[7 * W + x] = 1;
		// a room smaller than the rest: its far part walled off
		for (let y = 0; y < 7; y++)
			for (let x = x0; x < x0 + 9; x++)
				if (r.small && (y < 4 || x < x0 + 2 || x > x0 + 6)) wall[y * W + x] = 1;
		const gx = x0 + 4;
		wall[7 * W + gx] = 0;
		objects.push({ type: 'monster', subtype: 'dragonfly', l: 0, x: gx, y: 7, options: { amount: r.amount } });
		starts.push({ color: r.color, l: 0, from: [5 * W + gx] });
		// a monolith pair from the room's corner to the hall below it
		if (r.portal) links.push({ a: [1 * W + x0 + 1], b: [10 * W + x0 + 1], va: [0 * W + x0 + 1], vb: [11 * W + x0 + 1] });
		// a monster beside the portal's entrance in the room
		if (r.portalGuard) objects.push({ type: 'monster', subtype: 'imp', l: 0, x: x0 + 2, y: 1, options: { amount: r.portalGuard } });
	});
	return {
		W, H, objects, starts, links,
		blockedAt: (l, c) => !!wall[c],
		removable: o => o.type === 'monster',
		strengthOf: o => o.options.amount * 100,
		setStrength: (o, v) => { o.options.amount = Math.max(1, Math.floor(v / 100)); },
	};
}

test('a gate far dearer than the others is cut to one and a half times the median', () => {
	const w = world([{ color: 'red', amount: 10 }, { color: 'blue', amount: 12 }, { color: 'tan', amount: 200 }]);
	const r = evenStarts(w);
	assert.deepStrictEqual(r.starts.map(s => s.gate), [1000, 1200, 20000]);
	assert.strictEqual(r.cuts.length, 1);
	assert.deepStrictEqual(r.cuts[0], { color: 'tan', from: 20000, to: 1800, boxed: false });
	assert.strictEqual(w.objects[2].options.amount, 18);
	assert.strictEqual(w.objects[0].options.amount, 10, 'the others as they were');
});

test('a boxed-in start leaves by the cheapest gate on the map', () => {
	const w = world([{ color: 'red', amount: 10 }, { color: 'blue', amount: 14 }, { color: 'tan', amount: 12, small: true }]);
	const r = evenStarts(w);
	const tan = r.starts.find(s => s.color === 'tan');
	assert.ok(tan.home < 0.5 * r.starts.find(s => s.color === 'red').home, 'tan is boxed in');
	assert.deepStrictEqual(r.cuts, [{ color: 'tan', from: 1200, to: 1000, boxed: true }]);
});

test('fair starts are left alone, and a single start too', () => {
	const w = world([{ color: 'red', amount: 10 }, { color: 'blue', amount: 13 }]);
	assert.strictEqual(evenStarts(w).cuts.length, 0);
	const one = world([{ color: 'red', amount: 500 }]);
	assert.strictEqual(evenStarts(one).cuts.length, 0);
});

test('a start with a portal onto open ground has that way out, whatever its land guard', () => {
	const w = world([{ color: 'red', amount: 10 }, { color: 'blue', amount: 12 }, { color: 'tan', amount: 200, portal: true }]);
	const r = evenStarts(w);
	const tan = r.starts.find(s => s.color === 'tan');
	assert.ok(tan.home > r.starts.find(s => s.color === 'red').home, 'the hall is part of its home');
	assert.strictEqual(tan.gate, 1000, 'its way on is the gap into the red room, from the hall');
	assert.strictEqual(r.cuts.length, 0);
	assert.strictEqual(w.objects[2].options.amount, 200, 'its own guard as the template set it');
});

test('a portal with a monster beside its entrance is a fight on the way, not a free way', () => {
	const w = world([{ color: 'red', amount: 10 }, { color: 'blue', amount: 12 }, { color: 'tan', amount: 200, portal: true, portalGuard: 50 }]);
	const r = evenStarts(w);
	const tan = r.starts.find(s => s.color === 'tan');
	assert.ok(tan.home < r.starts.find(s => s.color === 'red').home, 'the hall is past the fight');
	assert.strictEqual(tan.gate, 5000, 'the portal guard, weaker than the land one');
	assert.deepStrictEqual(r.cuts, [{ color: 'tan', from: 5000, to: 1800, boxed: false }]);
	assert.strictEqual(w.objects[3].options.amount, 18, 'the portal guard cut');
	assert.strictEqual(w.objects[2].options.amount, 200, 'the land guard left');
});

test('a gate far cheaper than the others is raised to the median over one and a half', () => {
	// free 72x72 two-level seed 5: one start out past 525, the others 2,100 to 2,990
	const w = world([{ color: 'red', amount: 5 }, { color: 'blue', amount: 21 }, { color: 'tan', amount: 25 }, { color: 'green', amount: 30 }]);
	const r = evenStarts(w);
	assert.deepStrictEqual(r.cuts, [{ color: 'red', from: 500, to: 2300 / 1.5, raised: true }]);
	assert.strictEqual(w.objects[0].options.amount, 15, 'its guard now costs about the floor');
	assert.ok(r.starts.find(s => s.color === 'red').gate >= 1500, 'measured again after the raise');
	assert.strictEqual(w.objects[1].options.amount, 21, 'the others as they were');
});

test('two starts: the median is their mean, so the dearer one is cut and the cheaper one raised', () => {
	const w = world([{ color: 'red', amount: 5 }, { color: 'blue', amount: 30 }]);
	const r = evenStarts(w);
	assert.deepStrictEqual(r.cuts.map(c => [c.color, c.to]), [['blue', 1.5 * 1750], ['red', 1750 / 1.5]]);
});

/**
 * portals.js - the map's monolith channels, and which zones its links join.
 *
 * The engine joins every two-way monolith of one subtype into one network
 * (CGMonolith::initObj: a channel per object type and subtype), so two links
 * given the same subtype become one hub, any end leading to any other. The
 * generator used to hand out monolith1-6 in turn, and a map with more portal
 * links than that merged unrelated links: on [HotA] Nostalgia 144x2, 16 portal
 * links in six hubs, a start walked through one into the other start's zone
 * without a fight. All of them also wore the first channel's art, so a player
 * could not tell the ends apart.
 *
 * The core has eight channels (config/objects/moddables.json monolithTwoWay,
 * monolith1-8), each with its own art in the base game's OBJECTS.TXT (class
 * 45, subtypes 0-7), and each channel goes to one link. The engine's own
 * generator stops there too (CMapGenerator::getNextMonlithIndex throws past
 * the last one). Past it, a link whose zones are already joined some other
 * way is left out, and only a link that would leave its zones apart shares
 * the least-used channel.
 */
'use strict';

const VISIT = ['---', '+-+', '+++'];
const CHANNELS = [
	['monolith1', 'AVXmn2g0', ['VV', 'VA']],
	['monolith2', 'AVXmn2o0', ['VV', 'VA']],
	['monolith3', 'AVXmn2p0', ['VV', 'VA']],
	['monolith4', 'AVXmn4b0', ['V', 'A']],
	['monolith5', 'AVXmn5b0', ['VVV', 'VAB']],
	['monolith6', 'AVXmn6b0', ['VVV', 'VAB']],
	['monolith7', 'AVXmn7b0', ['VVV', 'VAB']],
	['monolith8', 'AVXmn8b0', ['VVV', 'VAB']],
].map(([subtype, animation, mask]) => ({ subtype, tpl: { animation, mask, visitableFrom: VISIT } }));

/**
 * One map's book of links. Zones are named `${level}:${zone}`.
 *   next(): the next free channel, or null (not yet taken);
 *   take(ch): the channel is used by one more link;
 *   shared(): the least-used channel, for a link that cannot be left out;
 *   join(a, b), joined(a, b): which zones reach each other by the links so far.
 */
function linkBook() {
	let free = 0;
	const uses = new Map();
	const parent = new Map();
	const find = k => {
		if (!parent.has(k)) parent.set(k, k);
		while (parent.get(k) !== k) {
			parent.set(k, parent.get(parent.get(k)));
			k = parent.get(k);
		}
		return k;
	};
	return {
		next: () => (free < CHANNELS.length ? CHANNELS[free] : null),
		take(ch) {
			if (ch === CHANNELS[free]) free++;
			uses.set(ch.subtype, (uses.get(ch.subtype) || 0) + 1);
		},
		shared() {
			let best = CHANNELS[0];
			for (const ch of CHANNELS) if ((uses.get(ch.subtype) || 0) < (uses.get(best.subtype) || 0)) best = ch;
			return best;
		},
		left: () => CHANNELS.length - free,
		join(a, b) { parent.set(find(a), find(b)); },
		joined: (a, b) => find(a) === find(b),
	};
}

module.exports = { CHANNELS, linkBook };

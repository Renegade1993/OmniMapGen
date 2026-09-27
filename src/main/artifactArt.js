/**
 * artifactArt.js - a concrete artifact wears its own art.
 *
 * The fill writes a concrete artifact (type "artifact", subtype a named one)
 * with the random artifact's template, AVArand, the yellow "ART" token. The
 * engine swaps the art only when it rolls a random artifact, never on a
 * concrete one (CGArtifact::pickRandomObject), so the token stayed on the map:
 * K found a Helm of the Alabaster Unicorn drawn that way (2026-09-27).
 *
 * A core artifact takes H3's own template, OBJECTS.TXT object 5 at its number
 * (h3data.js h3ObjectTemplates); an artifact whose config names its own map art
 * takes that. One with neither goes out as a random artifact, which the engine
 * rolls and draws properly, never as a wrong picture. Artifacts that already
 * carry art of their own are left as they are.
 */
'use strict';

const FROM_ANYWHERE = ['+++', '+-+', '+++'];

/**
 * objects: the map's objects, changed in place. artifacts: the asset index's
 * artifact map (id -> {h3Index, mapArt}). h3Arts: H3 number -> template.
 * Returns { fixed, rolled }.
 */
function giveArtifactsTheirArt(objects, artifacts, h3Arts) {
	let fixed = 0, rolled = 0;
	for (const o of objects) {
		if (o.type !== 'artifact') continue;
		const anim = o.template && o.template.animation;
		if (anim && !/^avarand$/i.test(String(anim))) continue;
		const id = String(o.subtype || '');
		const a = artifacts && artifacts.get(id.includes(':') ? id : `core:${id}`);
		const t = a && a.mapArt
			? { animation: String(a.mapArt).replace(/\.def$/i, ''), mask: ['VA'], visitableFrom: FROM_ANYWHERE }
			: a && typeof a.h3Index === 'number' && h3Arts ? h3Arts.get(a.h3Index) : null;
		if (t) {
			o.template = { ...(o.template || {}), animation: t.animation, mask: [...t.mask],
				visitableFrom: [...(t.visitableFrom || FROM_ANYWHERE)] };
			fixed++;
		} else {
			o.type = 'randomArtifact';
			o.subtype = 'object';
			rolled++;
		}
	}
	return { fixed, rolled };
}

module.exports = { giveArtifactsTheirArt };

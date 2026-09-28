/**
 * phases.js - the generator's real stages, in the order it goes through them,
 * with the words the game's load screen shows for each.
 *
 * K (2026-09-27): the load screen's bar can sit still long enough to look
 * broken while a map is made; he wants flavour text that follows the real
 * work, one line per stage ("Founding Towns", "Sculpting Erathia",
 * "Engineering Roads", "Discovering Resources"). As the generator enters a
 * stage it writes `[phase] <n>/<total> <id>` to stderr (phase below). The
 * mod's translations carry each text as vcmi.mapGen.phase.<id>
 * (tools/gen_vcmi_ui.js), and DMB's load screen shows it and sets its bar to
 * n/total. Each stage is written once and in this order, so the bar never
 * goes back: a stage a map does not have (no water, one level) is skipped,
 * and a second level's run through the same stages stays on the first's.
 */
'use strict';

const PHASES = [
	['lore', 'Gathering the Lore of the Realm'],     // the mods read and indexed
	['charter', 'Consulting the Cartographers'],     // the template and its zones
	['seas', 'Filling the Seas'],                    // where the water goes
	['sculpt', 'Sculpting Erathia'],                 // the zones laid out
	['lands', 'Painting the Lands'],                 // each zone's terrain
	['borders', 'Raising the Borders'],              // zone walls and the passages through them
	['capitals', 'Founding the Capitals'],           // the players' own towns
	['towns', 'Founding Towns'],                     // every other town
	['harbours', 'Building the Harbours'],           // shipyards and boats
	['monoliths', 'Binding the Monoliths'],          // portal pairs
	['roads', 'Engineering Roads'],
	['mountains', 'Heaving Up the Mountains'],       // the walls turned to scenery
	['valleys', 'Carving the Valleys'],              // ridges and scenery inside the zones
	['underworld', 'Opening the Ways Below'],        // the gates between levels
	['resources', 'Discovering Resources'],          // mines, treasure, dwellings, banks, guards
	['edges', 'Sealing the Edge of the World'],      // the map's rim
	['paths', 'Walking Every Path'],                 // every start, town and pile reachable
	['forests', 'Planting the Forests'],             // the scenery's art chosen
	['weave', 'Weaving the Terrain'],                // the terrain tiles solved
	['guards', 'Mustering the Guards'],              // each guard's creature
	['shores', 'Smoothing the Shores'],              // terrain edges the art can draw
	['rivers', 'Carving the Rivers'],
	['ink', 'Inking the Map'],                       // the map file written
];

let reached = -1;

/** Enter stage `id`: write its line once, and never one before it. */
function phase(id) {
	const i = PHASES.findIndex(p => p[0] === id);
	if (i <= reached) return;
	reached = i;
	process.stderr.write(`[phase] ${i + 1}/${PHASES.length} ${id}\n`);
}

/** Start a new run's count (a process that makes more than one map). */
function resetPhases() {
	reached = -1;
}

module.exports = { PHASES, phase, resetPhases };

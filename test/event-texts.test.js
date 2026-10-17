/**
 * event-texts.test.js - the module writes the stock triggered-event texts (MapGen Dev, 2026-10-17; K's picture of a blank line shown to the other players when someone is
 * eliminated). Stock: lib/mapping/CMapHeader.cpp setupEvents and config/mapOverrides.json: toOtherMessage core.genrltxt.8 (defeat) and .5 (victory), the winner's text .659.
 * DMB Dev read the three ids in a running client on 2026-10-17: .5 'has been vanquished', .8 'heroes have abandoned him, and he is banished', .659 'Congratulations! ...'.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('the writer sends the stock ids: 8 and 5 to the other players, 659 to the winner, never an empty text', () => {
	const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'exporter', 'vmapWriter.js'), 'utf8');
	assert.match(src, /messageToSend: \{[^}]*'core\.genrltxt\.8'\] \}, type: 'defeat'/);
	assert.match(src, /messageToSend: \{[^}]*'core\.genrltxt\.5'\] \}, type: 'victory'/);
	assert.match(src, /stringsTextID: \['core\.genrltxt\.659'\]/);
	assert.doesNotMatch(src, /messageToSend: emptyText/);
});

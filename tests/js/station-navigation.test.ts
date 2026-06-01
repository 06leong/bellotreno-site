import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createStationBoardUrl,
    normalizeStationBoardType
} from '../../src/client/station-navigation.ts';

test('station board navigation builds canonical departure URLs', () => {
    assert.equal(
        createStationBoardUrl({ stationId: 'S03317', stationName: 'TRIESTE CENTRALE' }),
        '/station?id=S03317&name=TRIESTE+CENTRALE&type=partenze'
    );
});

test('station board navigation preserves arrival board type', () => {
    assert.equal(
        createStationBoardUrl({ stationId: 'S01700', stationName: 'Milano Centrale', type: 'arrivi' }),
        '/station?id=S01700&name=Milano+Centrale&type=arrivi'
    );
});

test('station board navigation rejects empty station ids', () => {
    assert.equal(createStationBoardUrl({ stationId: '', stationName: 'Trieste Centrale' }), null);
    assert.equal(createStationBoardUrl({ stationId: null, stationName: 'Trieste Centrale' }), null);
});

test('station board type normalization falls back to departures', () => {
    assert.equal(normalizeStationBoardType('arrivi'), 'arrivi');
    assert.equal(normalizeStationBoardType('partenze'), 'partenze');
    assert.equal(normalizeStationBoardType('invalid'), 'partenze');
    assert.equal(normalizeStationBoardType(null), 'partenze');
});

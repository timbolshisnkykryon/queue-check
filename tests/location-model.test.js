import { strict as assert } from 'node:assert';
import {
    MAX_VISIT_HISTORY,
    sanitizeCoords,
    normalizeVisitEntry,
    normalizeLocationRecord,
    prepareCheckInUpdate
} from '../app/location-model.js';

function testSanitizeCoords() {
    assert.equal(sanitizeCoords(null), null, 'null coords should return null');
    assert.equal(sanitizeCoords({}), null, 'missing values should return null');

    assert.deepEqual(
        sanitizeCoords({ lat: 32.1, lon: 34.8 }),
        { lat: 32.1, lon: 34.8 }
    );

    assert.deepEqual(
        sanitizeCoords({ latitude: '32.2', longitude: '34.7' }),
        { lat: 32.2, lon: 34.7 }
    );
}

function testNormalizeVisitEntry() {
    const baseNow = new Date('2024-01-01T12:00:00Z');
    const normalized = normalizeVisitEntry({
        timestamp: '2024-01-01T10:00:00Z',
        waitSeconds: 120,
        dayOfWeek: 2,
        hourOfDay: 10
    }, { now: baseNow });

    assert.equal(normalized.timestamp, '2024-01-01T10:00:00.000Z');
    assert.equal(normalized.waitSeconds, 120);

    const fallback = normalizeVisitEntry({ waitSeconds: 60 }, { now: baseNow });
    assert.equal(fallback.dayOfWeek, baseNow.getDay());
    assert.equal(fallback.hourOfDay, baseNow.getHours());

    assert.equal(normalizeVisitEntry({ waitSeconds: 0 }), null);
}

function testNormalizeLocationRecord() {
    const record = normalizeLocationRecord('loc1', {
        name: 'Test',
        coords: { lat: '32.3', lon: '34.7' },
        totalCheckIns: '5',
        totalWaitSeconds: '500',
        avgWaitSeconds: '100',
        visits: [
            { waitSeconds: 200, timestamp: '2024-01-02T10:00:00Z', dayOfWeek: 2, hourOfDay: 10 },
            { waitSeconds: 'bad' }
        ]
    });

    assert.equal(record.id, 'loc1');
    assert.equal(record.visits.length, 1);
    assert.equal(record.totalCheckIns, 5);
    assert.equal(record.avgWaitSeconds, 100);
}

function testPrepareCheckInUpdate() {
    const existing = normalizeLocationRecord('loc1', {
        name: 'Existing Name',
        coords: { lat: 32.3, lon: 34.7 },
        totalCheckIns: 2,
        totalWaitSeconds: 300,
        avgWaitSeconds: 150,
        visits: []
    });

    const now = new Date('2024-01-03T15:30:00Z');
    const { data } = prepareCheckInUpdate(existing, {
        waitSeconds: 90,
        now,
        name: 'Override',
        coords: { latitude: 32.31, longitude: 34.71 }
    });

    assert.equal(data.totalCheckIns, 3);
    assert.equal(data.totalWaitSeconds, 390);
    assert.equal(Math.round(data.avgWaitSeconds), 130);
    assert.equal(data.visits.length, 1);
    assert.equal(data.visits[0].dayOfWeek, now.getDay());
    assert.equal(data.visits[0].hourOfDay, now.getHours());
}

function testPrepareCheckInUpdateHistoryLimit() {
    const existingVisits = Array.from({ length: MAX_VISIT_HISTORY }, (_, idx) => ({
        timestamp: new Date(2024, 0, 1, idx).toISOString(),
        waitSeconds: 60 + idx,
        dayOfWeek: idx % 7,
        hourOfDay: idx % 24
    }));

    const { data } = prepareCheckInUpdate({
        visits: existingVisits,
        totalCheckIns: MAX_VISIT_HISTORY,
        totalWaitSeconds: 1000
    }, { waitSeconds: 120, now: new Date('2024-01-05T09:00:00Z') });

    assert.equal(data.visits.length, MAX_VISIT_HISTORY);
    assert.equal(data.visits[0].waitSeconds, 120);
}

function runTests() {
    const tests = [
        testSanitizeCoords,
        testNormalizeVisitEntry,
        testNormalizeLocationRecord,
        testPrepareCheckInUpdate,
        testPrepareCheckInUpdateHistoryLimit
    ];

    tests.forEach((fn) => {
        fn();
        console.log(`✓ ${fn.name}`);
    });

    console.log('All location-model tests passed.');
}

runTests();

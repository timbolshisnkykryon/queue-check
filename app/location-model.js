export const MAX_VISIT_HISTORY = 20;

const PARTY_SIZE_CATEGORIES = Object.freeze([
    { key: 'small', label: '1-3', max: 3, estimate: 2 },
    { key: 'medium', label: '4-6', max: 6, estimate: 5 },
    { key: 'large', label: '7+', max: Infinity, estimate: 8 }
]);

const PARTY_SIZE_CATEGORY_MAP = PARTY_SIZE_CATEGORIES.reduce((acc, entry) => {
    acc[entry.key] = entry;
    return acc;
}, {});

function categorizePartySizeValue(size) {
    if (!Number.isFinite(size) || size <= 0) {
        return 'small';
    }

    if (size <= PARTY_SIZE_CATEGORY_MAP.small.max) {
        return 'small';
    }

    if (size <= PARTY_SIZE_CATEGORY_MAP.medium.max) {
        return 'medium';
    }

    return 'large';
}

function normalizePartySizeCategory(category, fallbackSize) {
    const normalized = typeof category === 'string' ? category.trim().toLowerCase() : '';
    if (normalized && PARTY_SIZE_CATEGORY_MAP[normalized]) {
        return normalized;
    }

    if (Number.isFinite(fallbackSize) && fallbackSize > 0) {
        return categorizePartySizeValue(fallbackSize);
    }

    return 'small';
}

function normalizePartySizeRange(range, categoryKey) {
    const candidate = typeof range === 'string' ? range.trim() : '';
    if (candidate.length > 0) {
        return candidate;
    }

    const category = PARTY_SIZE_CATEGORY_MAP[categoryKey] || PARTY_SIZE_CATEGORY_MAP.small;
    return category.label;
}

function normalizeLiveQueueEntry(entry) {
    if (!entry || typeof entry !== 'object') {
        return null;
    }

    const sessionId = typeof entry.id === 'string' ? entry.id.trim() : '';
    const rawCategory = typeof entry.category === 'string' ? entry.category.trim().toLowerCase() : '';

    if (!sessionId || !rawCategory || !PARTY_SIZE_CATEGORY_MAP[rawCategory]) {
        return null;
    }

    const sizeCandidate = Number(entry.size);
    const normalizedSize = Number.isFinite(sizeCandidate) && sizeCandidate > 0
        ? sizeCandidate
        : PARTY_SIZE_CATEGORY_MAP[rawCategory].estimate;

    const enteredAt = normalizeTimestamp(entry.enteredAt);

    return {
        id: sessionId,
        category: rawCategory,
        size: normalizedSize,
        enteredAt
    };
}

export function normalizeLiveQueueRecord(rawQueue) {
    if (!rawQueue || typeof rawQueue !== 'object') {
        return {
            version: 1,
            entries: [],
            updatedAt: null
        };
    }

    const version = Number.isInteger(rawQueue.version) ? rawQueue.version : 1;
    const updatedAt = normalizeTimestamp(rawQueue.updatedAt);

    const entries = Array.isArray(rawQueue.entries)
        ? rawQueue.entries.map(normalizeLiveQueueEntry).filter(Boolean)
        : [];

    entries.sort((a, b) => {
        const aTime = a.enteredAt ? new Date(a.enteredAt).getTime() : 0;
        const bTime = b.enteredAt ? new Date(b.enteredAt).getTime() : 0;
        return aTime - bTime;
    });

    return {
        version,
        entries,
        updatedAt
    };
}

function resolvePartySizeSelection(partySizeKey) {
    const key = typeof partySizeKey === 'string' ? partySizeKey.trim().toLowerCase() : '';
    const category = PARTY_SIZE_CATEGORY_MAP[key] || PARTY_SIZE_CATEGORY_MAP.small;

    return {
        category: category.key,
        size: category.estimate,
        range: category.label
    };
}

function normalizeTimestamp(value) {
    if (!value) return null;

    if (typeof value.toDate === 'function') {
        try {
            return value.toDate().toISOString();
        } catch (error) {
            return null;
        }
    }

    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }

    if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
    }

    return null;
}

function normalizeIntelRecord(rawIntel) {
    if (!rawIntel || typeof rawIntel !== 'object') {
        return null;
    }

    const text = typeof rawIntel.text === 'string' ? rawIntel.text : '';
    const html = typeof rawIntel.html === 'string' ? rawIntel.html : '';
    const locale = typeof rawIntel.locale === 'string' ? rawIntel.locale : null;
    const sources = Array.isArray(rawIntel.sources)
        ? rawIntel.sources
            .map((source) => ({
                title: typeof source?.title === 'string' ? source.title : '',
                uri: typeof source?.uri === 'string' ? source.uri : ''
            }))
            .filter((source) => source.title && source.uri)
        : [];

    const createdAt = normalizeTimestamp(rawIntel.createdAt);
    const updatedAt = normalizeTimestamp(rawIntel.updatedAt);

    if (!text && !html && sources.length === 0) {
        return null;
    }

    return {
        text: text || null,
        html: html || null,
        sources,
        locale,
        createdAt,
        updatedAt
    };
}

export function sanitizeCoords(coords) {
    if (!coords || typeof coords !== 'object') {
        return null;
    }

    const candidates = {
        lat: coords.lat ?? coords.latitude ?? coords.Latitude,
        lon: coords.lon ?? coords.lng ?? coords.longitude ?? coords.Longitude
    };

    const lat = typeof candidates.lat === 'number' ? candidates.lat : parseFloat(candidates.lat);
    const lon = typeof candidates.lon === 'number' ? candidates.lon : parseFloat(candidates.lon);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return null;
    }

    return { lat, lon };
}

export function normalizeVisitEntry(entry, { now = new Date() } = {}) {
    if (!entry || typeof entry !== 'object') {
        return null;
    }

    const visit = { ...entry };

    if (visit.timestamp && typeof visit.timestamp.toDate === 'function') {
        visit.timestamp = visit.timestamp.toDate().toISOString();
    } else if (visit.timestamp instanceof Date) {
        visit.timestamp = visit.timestamp.toISOString();
    } else if (typeof visit.timestamp === 'string') {
        const parsed = new Date(visit.timestamp);
        visit.timestamp = Number.isNaN(parsed.getTime()) ? now.toISOString() : parsed.toISOString();
    } else {
        visit.timestamp = now.toISOString();
    }

    const waitSeconds = Number(visit.waitSeconds);
    if (!Number.isFinite(waitSeconds) || waitSeconds <= 0) {
        return null;
    }

    const partyCandidates = [
        visit.partySize,
        visit.groupSize,
        visit.peopleCount,
        visit.people,
        visit.size,
        visit.partySizeEstimate
    ];
    let partySize = null;
    for (const candidate of partyCandidates) {
        const numeric = Number(candidate);
        if (Number.isFinite(numeric) && numeric > 0) {
            partySize = numeric;
            break;
        }
    }

    if (!Number.isFinite(partySize) || partySize <= 0) {
        partySize = 1;
    }

    const partySizeCategory = normalizePartySizeCategory(visit.partySizeCategory, partySize);
    const partySizeRange = normalizePartySizeRange(visit.partySizeRange, partySizeCategory);
    const categoryMeta = PARTY_SIZE_CATEGORY_MAP[partySizeCategory] || PARTY_SIZE_CATEGORY_MAP.small;
    const normalizedPartySize = Number.isFinite(partySize) && partySize > 0
        ? partySize
        : categoryMeta.estimate;

    if (!Number.isInteger(visit.dayOfWeek) || visit.dayOfWeek < 0 || visit.dayOfWeek > 6) {
        const derivedDate = new Date(visit.timestamp);
        visit.dayOfWeek = derivedDate.getDay();
    }

    if (!Number.isInteger(visit.hourOfDay) || visit.hourOfDay < 0 || visit.hourOfDay > 23) {
        const derivedDate = new Date(visit.timestamp);
        visit.hourOfDay = derivedDate.getHours();
    }

    return {
        timestamp: visit.timestamp,
        waitSeconds,
        partySize: normalizedPartySize,
        partySizeCategory,
        partySizeRange,
        dayOfWeek: visit.dayOfWeek,
        hourOfDay: visit.hourOfDay
    };
}

export function normalizeLocationRecord(id, data = {}, options = {}) {
    const coords = sanitizeCoords(data.coords);

    const visits = Array.isArray(data.visits)
        ? data.visits.map((entry) => normalizeVisitEntry(entry, options)).filter(Boolean)
        : [];

    const intel = normalizeIntelRecord(data.intel);

    return {
        id,
        name: typeof data.name === 'string' && data.name.trim().length > 0 ? data.name : 'מיקום ללא שם',
        coords,
        totalCheckIns: Number.isFinite(Number(data.totalCheckIns)) ? Number(data.totalCheckIns) : 0,
        totalWaitSeconds: Number.isFinite(Number(data.totalWaitSeconds)) ? Number(data.totalWaitSeconds) : 0,
        avgWaitSeconds: Number.isFinite(Number(data.avgWaitSeconds)) ? Number(data.avgWaitSeconds) : 0,
        visits: visits.slice(0, options.maxVisitHistory ?? MAX_VISIT_HISTORY),
        lastUpdatedAt: data.lastUpdatedAt ?? null,
        intel,
        liveQueue: normalizeLiveQueueRecord(data.liveQueue)
    };
}

export function prepareCheckInUpdate(existingRecord = {}, payload = {}) {
    const {
        waitSeconds,
        now = new Date(),
        coords = null,
        name = null,
        maxVisitHistory = MAX_VISIT_HISTORY,
        partySizeKey = 'small'
    } = payload;

    const normalizedExisting = {
        totalCheckIns: Number(existingRecord.totalCheckIns) || 0,
        totalWaitSeconds: Number(existingRecord.totalWaitSeconds) || 0,
        avgWaitSeconds: Number(existingRecord.avgWaitSeconds) || 0,
        visits: Array.isArray(existingRecord.visits) ? existingRecord.visits.map((entry) => normalizeVisitEntry(entry, { now })).filter(Boolean) : [],
        coords: sanitizeCoords(existingRecord.coords),
        name: typeof existingRecord.name === 'string' ? existingRecord.name : ''
    };

    if (!Number.isFinite(Number(waitSeconds)) || Number(waitSeconds) <= 0) {
        throw new Error('waitSeconds must be a positive number');
    }

    const dayIndex = now.getDay();
    const hourIndex = now.getHours();
    const partySelection = resolvePartySizeSelection(partySizeKey);
    const newVisit = {
        timestamp: now.toISOString(),
        waitSeconds: Number(waitSeconds),
        dayOfWeek: dayIndex,
        hourOfDay: hourIndex,
        partySize: partySelection.size,
        partySizeCategory: partySelection.category,
        partySizeRange: partySelection.range
    };

    const updatedVisits = [newVisit, ...normalizedExisting.visits].slice(0, maxVisitHistory);

    const totalCheckIns = normalizedExisting.totalCheckIns + 1;
    const totalWaitSeconds = normalizedExisting.totalWaitSeconds + Number(waitSeconds);
    const avgWaitSeconds = totalWaitSeconds / totalCheckIns;

    const resolvedCoords = sanitizeCoords(coords) || normalizedExisting.coords || null;
    const resolvedName = (typeof name === 'string' && name.trim().length > 0)
        ? name
        : (normalizedExisting.name || 'מיקום ללא שם');

    return {
        data: {
            name: resolvedName,
            coords: resolvedCoords,
            totalCheckIns,
            totalWaitSeconds,
            avgWaitSeconds,
            visits: updatedVisits,
            lastVisitAt: newVisit.timestamp
        },
        newVisit
    };
}

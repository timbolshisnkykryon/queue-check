export const MAX_VISIT_HISTORY = 20;

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
        dayOfWeek: visit.dayOfWeek,
        hourOfDay: visit.hourOfDay
    };
}

export function normalizeLocationRecord(id, data = {}, options = {}) {
    const coords = sanitizeCoords(data.coords);

    const visits = Array.isArray(data.visits)
        ? data.visits.map((entry) => normalizeVisitEntry(entry, options)).filter(Boolean)
        : [];

    return {
        id,
        name: typeof data.name === 'string' && data.name.trim().length > 0 ? data.name : 'מיקום ללא שם',
        coords,
        totalCheckIns: Number.isFinite(Number(data.totalCheckIns)) ? Number(data.totalCheckIns) : 0,
        totalWaitSeconds: Number.isFinite(Number(data.totalWaitSeconds)) ? Number(data.totalWaitSeconds) : 0,
        avgWaitSeconds: Number.isFinite(Number(data.avgWaitSeconds)) ? Number(data.avgWaitSeconds) : 0,
        visits: visits.slice(0, options.maxVisitHistory ?? MAX_VISIT_HISTORY),
        lastUpdatedAt: data.lastUpdatedAt ?? null
    };
}

export function prepareCheckInUpdate(existingRecord = {}, payload = {}) {
    const {
        waitSeconds,
        now = new Date(),
        coords = null,
        name = null,
        maxVisitHistory = MAX_VISIT_HISTORY
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
    const newVisit = {
        timestamp: now.toISOString(),
        waitSeconds: Number(waitSeconds),
        dayOfWeek: dayIndex,
        hourOfDay: hourIndex
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

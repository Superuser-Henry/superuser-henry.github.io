import { SMART_ADSB_CONFIG } from "./smartADSB-config.js";

// Preprocessing cleans obviously bad samples, orders the file chronologically, and computes sample spacing.
function isCoordinateValid(value, min, max) {
  return value == null || (Number.isFinite(value) && value >= min && value <= max);
}

function isReasonablePoint(point, config) {
  if (!(point.time instanceof Date) || Number.isNaN(point.time.getTime())) {
    return false;
  }

  if (point.altFt != null && (!Number.isFinite(point.altFt) || point.altFt < -1000 || point.altFt > config.maxAltitudeFt)) {
    return false;
  }

  if (
    point.groundSpeedKt != null &&
    (!Number.isFinite(point.groundSpeedKt) || point.groundSpeedKt < 0 || point.groundSpeedKt > config.maxGroundSpeedKt)
  ) {
    return false;
  }

  return (
    isCoordinateValid(point.lat, config.minLat, config.maxLat) &&
    isCoordinateValid(point.lon, config.minLon, config.maxLon)
  );
}

function scorePoint(point) {
  return [point.lat, point.lon, point.altFt, point.groundSpeedKt, point.trackDeg].filter((value) => value != null).length;
}

function dedupeByTimestamp(points) {
  const byTimestamp = new Map();

  points.forEach((point) => {
    const key = point.time.getTime();
    const existing = byTimestamp.get(key);
    if (!existing || scorePoint(point) > scorePoint(existing)) {
      byTimestamp.set(key, point);
    }
  });

  return Array.from(byTimestamp.values());
}

function isCoreFlightPoint(point, config) {
  const altitude = point.altFtSmoothed ?? point.altFt;
  const speed = point.groundSpeedKtSmoothed ?? point.groundSpeedKt;
  const verticalRate = Math.abs(point.verticalRateFpmSmoothed ?? point.verticalRateFpm ?? 0);

  return (
    (altitude != null && altitude >= config.coreMinAltitudeFt) ||
    verticalRate >= config.coreMinVerticalRateAbsFpm ||
    (
      speed != null &&
      altitude != null &&
      speed >= config.coreMinSpeedKt &&
      altitude >= config.lowAltitudeSupportFt
    )
  );
}

function expandSessionBounds(points, startIndex, endIndex, config) {
  const coreStartMs = points[startIndex].time.getTime();
  const coreEndMs = points[endIndex].time.getTime();
  let expandedStartIndex = startIndex;
  let expandedEndIndex = endIndex;

  while (expandedStartIndex > 0) {
    const candidate = points[expandedStartIndex - 1];
    if (coreStartMs - candidate.time.getTime() > config.padBeforeSec * 1000) {
      break;
    }
    expandedStartIndex -= 1;
  }

  while (expandedEndIndex < points.length - 1) {
    const candidate = points[expandedEndIndex + 1];
    if (candidate.time.getTime() - coreEndMs > config.padAfterSec * 1000) {
      break;
    }
    expandedEndIndex += 1;
  }

  return { expandedStartIndex, expandedEndIndex };
}

function mergeAdjacentSessions(rawSessions, points, config) {
  if (rawSessions.length <= 1) {
    return rawSessions;
  }

  const merged = [rawSessions[0]];

  for (let index = 1; index < rawSessions.length; index += 1) {
    const previous = merged[merged.length - 1];
    const current = rawSessions[index];
    const gapSec =
      (points[current.startIndex].time.getTime() - points[previous.endIndex].time.getTime()) / 1000;

    if (gapSec <= config.mergeAdjacentGapSec) {
      previous.endIndex = current.endIndex;
      previous.coreStartIndex = Math.min(previous.coreStartIndex, current.coreStartIndex);
      previous.coreEndIndex = Math.max(previous.coreEndIndex, current.coreEndIndex);
      continue;
    }

    merged.push(current);
  }

  return merged;
}

function summarizeSession(points, session, sessionId) {
  const startPoint = points[session.startIndex];
  const endPoint = points[session.endIndex];
  const coreStartPoint = points[session.coreStartIndex];
  const coreEndPoint = points[session.coreEndIndex];
  const durationSec = Math.max(0, (endPoint.time.getTime() - startPoint.time.getTime()) / 1000);

  return {
    sessionId,
    startIndex: session.startIndex,
    endIndex: session.endIndex,
    coreStartIndex: session.coreStartIndex,
    coreEndIndex: session.coreEndIndex,
    startTime: startPoint.time,
    endTime: endPoint.time,
    coreStartTime: coreStartPoint.time,
    coreEndTime: coreEndPoint.time,
    durationSec,
    pointCount: session.endIndex - session.startIndex + 1
  };
}

export function preprocessPoints(rawPoints, userConfig = SMART_ADSB_CONFIG.preprocess) {
  const config = { ...SMART_ADSB_CONFIG.preprocess, ...userConfig };
  const notes = [];

  const filtered = rawPoints.filter((point) => isReasonablePoint(point, config));
  const invalidRowsRemoved = rawPoints.length - filtered.length;
  if (invalidRowsRemoved > 0) {
    notes.push(`${invalidRowsRemoved} rows were removed as obviously invalid.`);
  }

  const sorted = filtered.sort((a, b) => a.time - b.time);
  const deduped = dedupeByTimestamp(sorted);
  const duplicateRowsRemoved = sorted.length - deduped.length;
  if (duplicateRowsRemoved > 0) {
    notes.push(`${duplicateRowsRemoved} duplicate timestamp rows were collapsed.`);
  }

  const points = deduped.map((point, index) => {
    const previous = deduped[index - 1];
    const dtSec = previous ? (point.time.getTime() - previous.time.getTime()) / 1000 : null;
    return {
      ...point,
      dtSec: dtSec != null && dtSec > 0 && dtSec <= config.maxReasonableDtSec ? dtSec : null
    };
  });

  const largeGapCount = points.filter((point) => point.dtSec == null && point !== points[0]).length;
  if (largeGapCount > 0) {
    notes.push(`${largeGapCount} sample gaps were too large or irregular for direct rate calculations.`);
  }

  return {
    points,
    meta: {
      validPointCount: points.length,
      invalidRowsRemoved,
      duplicateRowsRemoved,
      largeGapCount,
      notes
    }
  };
}

// Day-long files are reduced to candidate flight windows so users can analyze one sortie at a time.
export function detectFlightSessions(points, userConfig = SMART_ADSB_CONFIG.sessions) {
  const config = { ...SMART_ADSB_CONFIG.sessions, ...userConfig };
  const coreRanges = [];
  let activeStartIndex = null;
  let lastCoreIndex = null;

  points.forEach((point, index) => {
    if (!isCoreFlightPoint(point, config)) {
      return;
    }

    if (activeStartIndex == null) {
      activeStartIndex = index;
      lastCoreIndex = index;
      return;
    }

    const gapSec = (point.time.getTime() - points[lastCoreIndex].time.getTime()) / 1000;
    if (gapSec <= config.maxCoreGapSec) {
      lastCoreIndex = index;
      return;
    }

    coreRanges.push({
      coreStartIndex: activeStartIndex,
      coreEndIndex: lastCoreIndex
    });
    activeStartIndex = index;
    lastCoreIndex = index;
  });

  if (activeStartIndex != null && lastCoreIndex != null) {
    coreRanges.push({
      coreStartIndex: activeStartIndex,
      coreEndIndex: lastCoreIndex
    });
  }

  const expandedSessions = coreRanges.map((range) => {
    const bounds = expandSessionBounds(points, range.coreStartIndex, range.coreEndIndex, config);
    return {
      startIndex: bounds.expandedStartIndex,
      endIndex: bounds.expandedEndIndex,
      coreStartIndex: range.coreStartIndex,
      coreEndIndex: range.coreEndIndex
    };
  });

  const mergedSessions = mergeAdjacentSessions(expandedSessions, points, config)
    .map((session, index) => summarizeSession(points, session, index + 1))
    .filter(
      (session) =>
        session.durationSec >= config.minSessionDurationSec &&
        session.pointCount >= config.minSessionPoints
    );

  return {
    sessions: mergedSessions,
    meta: {
      detectedCoreRanges: coreRanges.length,
      returnedSessionCount: mergedSessions.length
    }
  };
}

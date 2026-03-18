import { SMART_ADSB_CONFIG } from "./smartADSB-config.js";

// Segment building converts pointwise states into contiguous flight phases while suppressing brief state flapping.
function average(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (filtered.length === 0) {
    return null;
  }
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function min(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  return filtered.length ? Math.min(...filtered) : null;
}

function max(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  return filtered.length ? Math.max(...filtered) : null;
}

function buildRawSegments(points) {
  const segments = [];
  let activeSegment = null;

  points.forEach((point, index) => {
    if (!point.state) {
      activeSegment = null;
      return;
    }

    if (!activeSegment || activeSegment.phase !== point.state) {
      if (activeSegment) {
        segments.push(activeSegment);
      }

      activeSegment = {
        phase: point.state,
        startIndex: index,
        endIndex: index,
        points: [point]
      };
      return;
    }

    activeSegment.endIndex = index;
    activeSegment.points.push(point);
  });

  if (activeSegment) {
    segments.push(activeSegment);
  }

  return segments;
}

function summarizeSegment(segment, segmentId) {
  const altitudes = segment.points.map((point) => point.altFtSmoothed ?? point.altFt);
  const speeds = segment.points.map((point) => point.groundSpeedKtSmoothed ?? point.groundSpeedKt);
  const verticalRates = segment.points.map((point) => point.verticalRateFpmSmoothed ?? point.verticalRateFpm);
  const startTime = segment.points[0].time;
  const endTime = segment.points[segment.points.length - 1].time;

  return {
    segmentId,
    phase: segment.phase,
    startTime,
    endTime,
    durationSec: Math.max(0, (endTime.getTime() - startTime.getTime()) / 1000),
    startIndex: segment.startIndex,
    endIndex: segment.endIndex,
    pointCount: segment.points.length,
    minAltFt: min(altitudes),
    maxAltFt: max(altitudes),
    avgGroundSpeedKt: average(speeds),
    avgVerticalRateFpm: average(verticalRates)
  };
}

function relabelRange(points, startIndex, endIndex, phase) {
  for (let index = startIndex; index <= endIndex; index += 1) {
    points[index] = {
      ...points[index],
      state: phase
    };
  }
}

function smoothSegmentJitter(points, config) {
  let adjustedPoints = points.map((point) => ({ ...point }));

  for (let pass = 0; pass < config.smoothingPasses; pass += 1) {
    const segments = buildRawSegments(adjustedPoints).map((segment, index) => summarizeSegment(segment, index + 1));

    segments.forEach((segment, index) => {
      // Short middle segments are usually ADS-B noise, so merge them only when neighbors provide clear context.
      if (segment.durationSec > config.minSegmentDurationSec && segment.pointCount > config.minSegmentPoints) {
        return;
      }

      const previous = segments[index - 1];
      const next = segments[index + 1];
      if (!previous || !next) {
        return;
      }

      if (previous.phase === next.phase) {
        relabelRange(adjustedPoints, segment.startIndex, segment.endIndex, previous.phase);
        return;
      }

      if (segment.durationSec <= config.aggressiveMergeDurationSec) {
        const target = previous.durationSec >= next.durationSec ? previous : next;
        relabelRange(adjustedPoints, segment.startIndex, segment.endIndex, target.phase);
      }
    });
  }

  return adjustedPoints;
}

export function buildSegments(points, userConfig = SMART_ADSB_CONFIG.segments) {
  const config = { ...SMART_ADSB_CONFIG.segments, ...userConfig };
  const smoothedPoints = smoothSegmentJitter(points, config);
  const rawSegments = buildRawSegments(smoothedPoints);
  const segments = rawSegments.map((segment, index) => summarizeSegment(segment, index + 1));

  return {
    points: smoothedPoints,
    segments
  };
}

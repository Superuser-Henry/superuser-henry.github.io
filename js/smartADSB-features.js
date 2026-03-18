import { SMART_ADSB_CONFIG } from "./smartADSB-config.js";

// Feature generation smooths noisy ADS-B values before rate-based classification rules are applied.
function median(values) {
  const filtered = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (filtered.length === 0) {
    return null;
  }

  const midpoint = Math.floor(filtered.length / 2);
  return filtered.length % 2 === 0
    ? (filtered[midpoint - 1] + filtered[midpoint]) / 2
    : filtered[midpoint];
}

function centeredWindow(points, index, key, radius) {
  const values = [];
  const start = Math.max(0, index - radius);
  const end = Math.min(points.length - 1, index + radius);
  for (let cursor = start; cursor <= end; cursor += 1) {
    values.push(points[cursor][key]);
  }
  return values;
}

function computeRollingMedian(points, key, windowSize) {
  const radius = Math.floor(windowSize / 2);
  return points.map((point, index) => median(centeredWindow(points, index, key, radius)));
}

function computeVerticalRate(points) {
  return points.map((point, index) => {
    if (index === 0) {
      return null;
    }

    const previous = points[index - 1];
    if (point.dtSec == null || point.dtSec <= 0) {
      return null;
    }

    if (point.altFtSmoothed == null || previous.altFtSmoothed == null) {
      return null;
    }

    return ((point.altFtSmoothed - previous.altFtSmoothed) / point.dtSec) * 60;
  });
}

function shortestAngleDelta(fromDeg, toDeg) {
  if (fromDeg == null || toDeg == null) {
    return null;
  }

  return ((toDeg - fromDeg + 540) % 360) - 180;
}

function computeTurnRate(points) {
  return points.map((point, index) => {
    if (index === 0) {
      return null;
    }

    const previous = points[index - 1];
    if (point.dtSec == null || point.dtSec <= 0) {
      return null;
    }

    const trackDeltaDeg = shortestAngleDelta(previous.trackDeg, point.trackDeg);
    if (trackDeltaDeg == null) {
      return null;
    }

    return trackDeltaDeg / point.dtSec;
  });
}

export function computeFeatures(points, userConfig = SMART_ADSB_CONFIG.features) {
  const config = { ...SMART_ADSB_CONFIG.features, ...userConfig };
  const altFtSmoothed = computeRollingMedian(points, "altFt", config.smoothingWindow);
  const groundSpeedKtSmoothed = computeRollingMedian(points, "groundSpeedKt", config.smoothingWindow);

  const withSmoothedPrimary = points.map((point, index) => ({
    ...point,
    altFtSmoothed: altFtSmoothed[index],
    groundSpeedKtSmoothed: groundSpeedKtSmoothed[index]
  }));

  const verticalRateFpm = computeVerticalRate(withSmoothedPrimary);
  const verticalRateFpmSmoothed = computeRollingMedian(
    withSmoothedPrimary.map((point, index) => ({ ...point, verticalRateFpm: verticalRateFpm[index] })),
    "verticalRateFpm",
    config.verticalRateWindow
  );
  const turnRateDegPerSec = computeTurnRate(withSmoothedPrimary);
  const turnRateDegPerSecSmoothed = computeRollingMedian(
    withSmoothedPrimary.map((point, index) => ({ ...point, turnRateDegPerSec: turnRateDegPerSec[index] })),
    "turnRateDegPerSec",
    config.turnRateWindow
  );

  return {
    points: withSmoothedPrimary.map((point, index) => ({
      ...point,
      verticalRateFpm: verticalRateFpm[index],
      verticalRateFpmSmoothed: verticalRateFpmSmoothed[index],
      turnRateDegPerSec: turnRateDegPerSec[index],
      turnRateDegPerSecSmoothed: turnRateDegPerSecSmoothed[index]
    })),
    meta: {
      smoothingWindow: config.smoothingWindow,
      verticalRateWindow: config.verticalRateWindow,
      turnRateWindow: config.turnRateWindow
    }
  };
}

import { SMART_ADSB_CONFIG, SMART_ADSB_STATES } from "./smartADSB-config.js";

// Version 1 keeps the classifier intentionally simple so state assignments remain easy to inspect and tune.
function classifyPoint(point, config) {
  const speed = point.groundSpeedKtSmoothed ?? point.groundSpeedKt;
  const verticalRate = point.verticalRateFpmSmoothed ?? point.verticalRateFpm;

  if (speed != null) {
    const absVerticalRate = Math.abs(verticalRate ?? 0);
    if (speed < config.groundSpeedMaxKt && absVerticalRate < config.groundVerticalRateAbsMaxFpm) {
      return SMART_ADSB_STATES.GROUND;
    }
  }

  if (verticalRate == null) {
    return speed != null && speed < config.groundSpeedMaxKt ? SMART_ADSB_STATES.GROUND : SMART_ADSB_STATES.LEVEL;
  }

  if (verticalRate > config.climbMinFpm) {
    return SMART_ADSB_STATES.CLIMB;
  }

  if (verticalRate < config.descentMaxFpm) {
    return SMART_ADSB_STATES.DESCENT;
  }

  return SMART_ADSB_STATES.LEVEL;
}

export function classifyPoints(points, userConfig = SMART_ADSB_CONFIG.classifier) {
  const config = { ...SMART_ADSB_CONFIG.classifier, ...userConfig };
  return {
    points: points.map((point) => ({
      ...point,
      state: classifyPoint(point, config)
    }))
  };
}

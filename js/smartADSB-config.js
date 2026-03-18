// Centralized thresholds and aliases keep the rule-based analysis tunable and explainable.
export const SMART_ADSB_CONFIG = Object.freeze({
  parser: {
    delimiter: ",",
    minUsablePoints: 12,
    timeAliases: ["utc", "time", "timestamp", "datetime", "date", "eventtime"],
    latAliases: ["latitude", "lat"],
    lonAliases: ["longitude", "lon", "lng"],
    altitudeAliases: ["altitude", "altitudebaro", "baroaltitude", "alt", "altft"],
    speedAliases: ["groundspeed", "groundspeedkt", "groundspeedkts", "groundspeedknots", "groundspeedkt", "groundspeedkn", "groundspeedknot", "groundspeedktas", "groundspeedias", "groundspeedgs", "groundspeedmph", "ground_speed", "gs", "speed"],
    trackAliases: ["track", "heading", "direction", "course", "trackdeg"],
    positionAliases: ["position", "latlon", "coordinates", "coord", "location"],
    callsignAliases: ["callsign", "flight", "ident"]
  },
  preprocess: {
    maxReasonableDtSec: 300,
    maxAltitudeFt: 60000,
    maxGroundSpeedKt: 450,
    minLat: -90,
    maxLat: 90,
    minLon: -180,
    maxLon: 180
  },
  features: {
    smoothingWindow: 5,
    verticalRateWindow: 5,
    turnRateWindow: 5
  },
  sessions: {
    coreMinAltitudeFt: 500,
    coreMinVerticalRateAbsFpm: 250,
    coreMinSpeedKt: 65,
    lowAltitudeSupportFt: 150,
    maxCoreGapSec: 900,
    padBeforeSec: 180,
    padAfterSec: 240,
    mergeAdjacentGapSec: 300,
    minSessionDurationSec: 300,
    minSessionPoints: 20
  },
  classifier: {
    groundSpeedMaxKt: 30,
    groundVerticalRateAbsMaxFpm: 100,
    climbMinFpm: 300,
    descentMaxFpm: -300
  },
  segments: {
    minSegmentDurationSec: 18,
    minSegmentPoints: 2,
    aggressiveMergeDurationSec: 10,
    smoothingPasses: 2
  },
  events: {
    touchAndGoGroundMaxDurationSec: 90,
    touchAndGoGroundMaxAltitudeFt: 250,
    maneuverLowAltitudeThresholdFt: 400,
    maneuverLowAltitudeMinDurationSec: 15,
    maneuverAltitudeBreakMergeSec: 20,
    maneuverPatternLookaroundSec: 480,
    maneuverRecoveryLookaheadSec: 180,
    maneuverRecoveryAltitudeFt: 600,
    maneuverPatternAltitudeFt: 800,
    maneuverTruncatedTailSec: 90,
    maneuverPatternSeriesMinCount: 3,
    maneuverTruncatedTouchAndGoMinPriorCount: 3,
    stableTurnMinAltitudeFt: 800,
    stableTurnMaxVerticalRateFpm: 250,
    stableTurnMaxAltitudeBandFt: 400,
    stableTurnGapToleranceSec: 20,
    stableTurnMinDurationSec: 20,
    stableTurnMinAvgTurnRateDegPerSec: 0.45,
    stableTurnMinAbsTurn90Deg: 70,
    stableTurnMaxAbsTurn90Deg: 150,
    stableTurnMinAbsTurn180Deg: 150,
    stableTurnMaxAbsTurn180Deg: 260,
    stableTurnMinAbsTurn360Deg: 300,
    stableTurnMaxAbsTurn360Deg: 540,
    stableTurnNetToleranceDeg: 110,
    airworkMinAltitudeFt: 900,
    airworkMinDurationSec: 70,
    airworkMaxDurationSec: 210,
    airworkStridePoints: 6,
    airworkMaxAltitudeBandFt: 1200,
    airworkMaxVerticalRateFpm: 700,
    airwork360MinAbsTurnDeg: 300,
    airwork180MinAbsTurnDeg: 150,
    airworkIrregularMinAbsTurnDeg: 150,
    airworkIrregularMinReversals: 3,
    airwork360MaxBoxSpanNm: 3.5,
    airwork180MaxBoxSpanNm: 6,
    airworkIrregularMaxBoxSpanNm: 6.5
  }
});

export const SMART_ADSB_STATES = Object.freeze({
  GROUND: "GROUND",
  CLIMB: "CLIMB",
  LEVEL: "LEVEL",
  DESCENT: "DESCENT"
});

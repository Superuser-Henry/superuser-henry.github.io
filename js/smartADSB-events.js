import { SMART_ADSB_CONFIG, SMART_ADSB_STATES } from "./smartADSB-config.js";

// Event detection stays heuristic and conservative so higher-level conclusions remain explainable.
function altitudeOf(point) {
  return point.altFtSmoothed ?? point.altFt;
}

function verticalRateOf(point) {
  return point.verticalRateFpmSmoothed ?? point.verticalRateFpm;
}

function turnRateOf(point) {
  return point.turnRateDegPerSecSmoothed ?? point.turnRateDegPerSec;
}

function shortestAngleDelta(fromDeg, toDeg) {
  if (fromDeg == null || toDeg == null) {
    return null;
  }

  return ((toDeg - fromDeg + 540) % 360) - 180;
}

function countByPhase(segments) {
  const counts = {
    [SMART_ADSB_STATES.GROUND]: 0,
    [SMART_ADSB_STATES.CLIMB]: 0,
    [SMART_ADSB_STATES.LEVEL]: 0,
    [SMART_ADSB_STATES.DESCENT]: 0
  };

  segments.forEach((segment) => {
    if (counts[segment.phase] != null) {
      counts[segment.phase] += 1;
    }
  });

  return counts;
}

function detectTouchAndGoCandidates(segments, config) {
  const candidates = [];

  for (let index = 0; index < segments.length - 2; index += 1) {
    const first = segments[index];
    const second = segments[index + 1];
    const third = segments[index + 2];

    const isCandidate =
      first.phase === SMART_ADSB_STATES.DESCENT &&
      second.phase === SMART_ADSB_STATES.GROUND &&
      third.phase === SMART_ADSB_STATES.CLIMB &&
      second.durationSec <= config.touchAndGoGroundMaxDurationSec &&
      (second.maxAltFt == null || second.maxAltFt <= config.touchAndGoGroundMaxAltitudeFt);

    if (isCandidate) {
      candidates.push({
        startTime: first.startTime,
        groundStartTime: second.startTime,
        endTime: third.endTime,
        groundDurationSec: second.durationSec,
        descentSegmentId: first.segmentId,
        groundSegmentId: second.segmentId,
        climbSegmentId: third.segmentId
      });
    }
  }

  return candidates;
}

function detectLowAltitudeWindows(points, config) {
  const windows = [];
  let activeWindow = null;
  let breakStartTime = null;

  points.forEach((point, index) => {
    const altitude = altitudeOf(point);
    const isLowAltitude = altitude != null && altitude <= config.maneuverLowAltitudeThresholdFt;

    if (isLowAltitude) {
      if (!activeWindow) {
        activeWindow = {
          startIndex: index,
          endIndex: index
        };
      } else {
        activeWindow.endIndex = index;
      }
      breakStartTime = null;
      return;
    }

    if (!activeWindow) {
      return;
    }

    if (breakStartTime == null) {
      breakStartTime = point.time.getTime();
      return;
    }

    const breakSec = (point.time.getTime() - breakStartTime) / 1000;
    if (breakSec <= config.maneuverAltitudeBreakMergeSec) {
      return;
    }

    windows.push(activeWindow);
    activeWindow = null;
    breakStartTime = null;
  });

  if (activeWindow) {
    windows.push(activeWindow);
  }

  return windows
    .map((window, index) => {
      const startPoint = points[window.startIndex];
      const endPoint = points[window.endIndex];
      const durationSec = Math.max(0, (endPoint.time.getTime() - startPoint.time.getTime()) / 1000);
      const altitudeSeries = points
        .slice(window.startIndex, window.endIndex + 1)
        .map((point) => altitudeOf(point))
        .filter((value) => value != null);

      return {
        maneuverId: index + 1,
        startIndex: window.startIndex,
        endIndex: window.endIndex,
        startTime: startPoint.time,
        endTime: endPoint.time,
        durationSec,
        minAltFt: altitudeSeries.length ? Math.min(...altitudeSeries) : null,
        maxAltFt: altitudeSeries.length ? Math.max(...altitudeSeries) : null
      };
    })
    .filter((window) => window.durationSec >= config.maneuverLowAltitudeMinDurationSec);
}

function maxAltitudeInRange(points, startIndex, endIndex) {
  let maxAltitude = null;
  for (let index = startIndex; index <= endIndex; index += 1) {
    const altitude = altitudeOf(points[index]);
    if (altitude == null) {
      continue;
    }
    maxAltitude = maxAltitude == null ? altitude : Math.max(maxAltitude, altitude);
  }
  return maxAltitude;
}

function maxVerticalRateInRange(points, startIndex, endIndex) {
  let maxVerticalRate = null;
  for (let index = startIndex; index <= endIndex; index += 1) {
    const verticalRate = verticalRateOf(points[index]);
    if (verticalRate == null) {
      continue;
    }
    maxVerticalRate = maxVerticalRate == null ? verticalRate : Math.max(maxVerticalRate, verticalRate);
  }
  return maxVerticalRate;
}

function estimateBoundingBoxSpanNm(points, startIndex, endIndex) {
  let minLat = null;
  let maxLat = null;
  let minLon = null;
  let maxLon = null;

  for (let index = startIndex; index <= endIndex; index += 1) {
    const point = points[index];
    if (point.lat != null) {
      minLat = minLat == null ? point.lat : Math.min(minLat, point.lat);
      maxLat = maxLat == null ? point.lat : Math.max(maxLat, point.lat);
    }
    if (point.lon != null) {
      minLon = minLon == null ? point.lon : Math.min(minLon, point.lon);
      maxLon = maxLon == null ? point.lon : Math.max(maxLon, point.lon);
    }
  }

  if (minLat == null || maxLat == null || minLon == null || maxLon == null) {
    return null;
  }

  const avgLatRad = ((minLat + maxLat) / 2) * (Math.PI / 180);
  const latSpanNm = (maxLat - minLat) * 60;
  const lonSpanNm = (maxLon - minLon) * 60 * Math.cos(avgLatRad);

  return Math.max(Math.abs(latSpanNm), Math.abs(lonSpanNm));
}

function mergeCountMaps(...maps) {
  const merged = {};
  maps.forEach((map) => {
    Object.entries(map || {}).forEach(([key, value]) => {
      merged[key] = (merged[key] || 0) + value;
    });
  });
  return merged;
}

function enrichLowAltitudeWindows(points, windows, config) {
  return windows.map((window) => {
    let lookbackStart = window.startIndex;
    while (
      lookbackStart > 0 &&
      (points[window.startIndex].time.getTime() - points[lookbackStart - 1].time.getTime()) / 1000 <=
        config.maneuverPatternLookaroundSec
    ) {
      lookbackStart -= 1;
    }

    let lookaheadEnd = window.endIndex;
    while (
      lookaheadEnd < points.length - 1 &&
      (points[lookaheadEnd + 1].time.getTime() - points[window.endIndex].time.getTime()) / 1000 <=
        config.maneuverPatternLookaroundSec
    ) {
      lookaheadEnd += 1;
    }

    let recoveryIndex = null;
    for (let index = window.endIndex + 1; index < points.length; index += 1) {
      const elapsedSec = (points[index].time.getTime() - window.endTime.getTime()) / 1000;
      if (elapsedSec > config.maneuverRecoveryLookaheadSec) {
        break;
      }

      const altitude = altitudeOf(points[index]);
      if (altitude != null && altitude >= config.maneuverRecoveryAltitudeFt) {
        recoveryIndex = index;
        break;
      }
    }

    const maxAltBeforeFt = maxAltitudeInRange(points, lookbackStart, Math.max(lookbackStart, window.startIndex - 1));
    const maxAltAfterFt = maxAltitudeInRange(points, Math.min(points.length - 1, window.endIndex + 1), lookaheadEnd);
    const maxClimbAfterFpm = maxVerticalRateInRange(
      points,
      Math.min(points.length - 1, window.endIndex + 1),
      lookaheadEnd
    );
    const sessionTailSec =
      (points[points.length - 1].time.getTime() - window.endTime.getTime()) / 1000;

    return {
      ...window,
      maxAltBeforeFt,
      maxAltAfterFt,
      maxClimbAfterFpm,
      recoveryTime: recoveryIndex != null ? points[recoveryIndex].time : null,
      recoveredToPattern:
        recoveryIndex != null &&
        maxAltAfterFt != null &&
        maxAltAfterFt >= config.maneuverPatternAltitudeFt,
      nearSessionEnd: sessionTailSec <= config.maneuverTruncatedTailSec,
      sessionTailSec
    };
  });
}

function classifyLowAltitudeManeuvers(windows, config) {
  const maneuverCounts = {};
  const maneuvers = windows.map((window) => ({
    ...window,
    type: "LOW_ALTITUDE_RUNWAY_CYCLE",
    confidence: "medium",
    description: "Low-altitude runway-adjacent cycle detected."
  }));

  maneuvers.forEach((maneuver, index) => {
    const hasPatternContext =
      (maneuver.maxAltBeforeFt ?? -Infinity) >= config.maneuverPatternAltitudeFt;
    const hasRecovery = maneuver.recoveredToPattern || (maneuver.maxClimbAfterFpm ?? -Infinity) >= 500;

    if (hasPatternContext && hasRecovery) {
      maneuver.type = "TOUCH_AND_GO_CANDIDATE";
      maneuver.confidence = "high";
      maneuver.description = "Low-altitude runway cycle followed by a prompt climb back into the traffic pattern.";
      return;
    }

    if (hasPatternContext && maneuver.nearSessionEnd) {
      maneuver.type = "TERMINAL_RUNWAY_EVENT";
      maneuver.confidence = "low";
      maneuver.description = "Low-altitude runway cycle at the end of the available session with no visible recovery climb.";
      return;
    }

    if (hasPatternContext) {
      maneuver.type = "LANDING_CANDIDATE";
      maneuver.confidence = "medium";
      maneuver.description = "Approach-like low-altitude cycle without a clear climb back to pattern altitude.";
    }
  });

  const confirmedTouchAndGoCount = maneuvers.filter(
    (maneuver) => maneuver.type === "TOUCH_AND_GO_CANDIDATE"
  ).length;

  maneuvers.forEach((maneuver) => {
    if (
      maneuver.type === "TERMINAL_RUNWAY_EVENT" &&
      confirmedTouchAndGoCount >= config.maneuverTruncatedTouchAndGoMinPriorCount
    ) {
      maneuver.type = "TOUCH_AND_GO_CANDIDATE_TRUNCATED";
      maneuver.confidence = "medium";
      maneuver.description =
        "End-of-session runway cycle inferred as a likely touch-and-go because it continues a repeated pattern series, but the recovery climb is truncated in the available data.";
    }
  });

  maneuvers.forEach((maneuver) => {
    maneuverCounts[maneuver.type] = (maneuverCounts[maneuver.type] || 0) + 1;
  });

  const lowAltitudeCycleCount = maneuvers.length;
  const touchAndGoCandidates = maneuvers.filter((maneuver) =>
    maneuver.type === "TOUCH_AND_GO_CANDIDATE" || maneuver.type === "TOUCH_AND_GO_CANDIDATE_TRUNCATED"
  );

  return {
    maneuvers,
    maneuverCounts,
    lowAltitudeCycleCount,
    touchAndGoCandidates,
    landingCandidates: maneuvers.filter((maneuver) => maneuver.type === "LANDING_CANDIDATE"),
    runwayPatternSeries:
      lowAltitudeCycleCount >= config.maneuverPatternSeriesMinCount &&
      touchAndGoCandidates.length >= config.maneuverPatternSeriesMinCount
  };
}

function detectStableTurnWindows(points, config) {
  const windows = [];
  let activeWindow = null;

  points.forEach((point, index) => {
    const altitude = altitudeOf(point);
    const verticalRate = Math.abs(verticalRateOf(point) ?? 0);
    const hasTrack = point.trackDeg != null;
    const isStableTurnCandidate =
      altitude != null &&
      altitude >= config.stableTurnMinAltitudeFt &&
      verticalRate <= config.stableTurnMaxVerticalRateFpm &&
      hasTrack;

    if (isStableTurnCandidate) {
      if (!activeWindow) {
        activeWindow = {
          startIndex: index,
          endIndex: index
        };
      } else {
        const gapSec = (point.time.getTime() - points[activeWindow.endIndex].time.getTime()) / 1000;
        if (gapSec <= config.stableTurnGapToleranceSec) {
          activeWindow.endIndex = index;
        } else {
          windows.push(activeWindow);
          activeWindow = {
            startIndex: index,
            endIndex: index
          };
        }
      }
      return;
    }

    if (activeWindow) {
      windows.push(activeWindow);
      activeWindow = null;
    }
  });

  if (activeWindow) {
    windows.push(activeWindow);
  }

  return windows
    .map((window) => {
      const startPoint = points[window.startIndex];
      const endPoint = points[window.endIndex];
      const durationSec = Math.max(0, (endPoint.time.getTime() - startPoint.time.getTime()) / 1000);
      const altitudes = [];
      let cumulativeAbsTurnDeg = 0;
      let netTurnDeg = 0;

      for (let index = window.startIndex; index <= window.endIndex; index += 1) {
        const altitude = altitudeOf(points[index]);
        if (altitude != null) {
          altitudes.push(altitude);
        }

        if (index === window.startIndex) {
          continue;
        }

        const trackDeltaDeg = shortestAngleDelta(points[index - 1].trackDeg, points[index].trackDeg);
        if (trackDeltaDeg == null) {
          continue;
        }

        cumulativeAbsTurnDeg += Math.abs(trackDeltaDeg);
        netTurnDeg += trackDeltaDeg;
      }

      const altitudeBandFt =
        altitudes.length > 0 ? Math.max(...altitudes) - Math.min(...altitudes) : null;
      const avgAbsTurnRateDegPerSec =
        durationSec > 0 ? cumulativeAbsTurnDeg / durationSec : 0;

      return {
        startIndex: window.startIndex,
        endIndex: window.endIndex,
        startTime: startPoint.time,
        endTime: endPoint.time,
        durationSec,
        minAltFt: altitudes.length ? Math.min(...altitudes) : null,
        maxAltFt: altitudes.length ? Math.max(...altitudes) : null,
        altitudeBandFt,
        cumulativeAbsTurnDeg,
        netTurnDeg,
        avgAbsTurnRateDegPerSec
      };
    })
    .filter(
      (window) =>
        window.durationSec >= config.stableTurnMinDurationSec &&
        window.altitudeBandFt != null &&
        window.altitudeBandFt <= config.stableTurnMaxAltitudeBandFt &&
        window.avgAbsTurnRateDegPerSec >= config.stableTurnMinAvgTurnRateDegPerSec &&
        window.cumulativeAbsTurnDeg >= config.stableTurnMinAbsTurn90Deg
    );
}

function classifyStableTurnManeuvers(windows, config) {
  const maneuverCounts = {};
  const maneuvers = [];

  windows.forEach((window) => {
    let type = null;
    let description = null;
    let confidence = "medium";
    const absNetTurnDeg = Math.abs(window.netTurnDeg);

    if (
      window.cumulativeAbsTurnDeg >= config.stableTurnMinAbsTurn360Deg &&
      window.cumulativeAbsTurnDeg <= config.stableTurnMaxAbsTurn360Deg &&
      (
        absNetTurnDeg <= config.stableTurnNetToleranceDeg ||
        Math.abs(absNetTurnDeg - 360) <= config.stableTurnNetToleranceDeg
      )
    ) {
      type = "STABLE_360_TURN_CANDIDATE";
      description = "Sustained, altitude-stable turn accumulation consistent with a 360-degree turn or orbit.";
      confidence = "high";
    } else if (
      window.cumulativeAbsTurnDeg >= config.stableTurnMinAbsTurn180Deg &&
      window.cumulativeAbsTurnDeg <= config.stableTurnMaxAbsTurn180Deg
    ) {
      type = "STABLE_180_TURN_CANDIDATE";
      description = "Altitude-stable course reversal or extended 180-degree turn detected.";
    } else if (
      window.cumulativeAbsTurnDeg >= config.stableTurnMinAbsTurn90Deg &&
      window.cumulativeAbsTurnDeg <= config.stableTurnMaxAbsTurn90Deg
    ) {
      type = "STABLE_90_TURN_CANDIDATE";
      description = "Altitude-stable heading change consistent with a 90-degree maneuvering turn.";
    }

    if (!type) {
      return;
    }

    const maneuver = {
      ...window,
      type,
      description,
      confidence
    };

    maneuvers.push(maneuver);
    maneuverCounts[type] = (maneuverCounts[type] || 0) + 1;
  });

  return {
    stableTurnManeuvers: maneuvers,
    stableTurnCounts: maneuverCounts
  };
}

function detectAirworkManeuvers(points, config) {
  const candidates = [];

  for (let startIndex = 0; startIndex < points.length - 5; startIndex += config.airworkStridePoints) {
    let cumulativeAbsTurnDeg = 0;
    let netTurnDeg = 0;
    let reversalCount = 0;
    let previousTurnSign = 0;
    let minAltitudeFt = null;
    let maxAltitudeFt = null;
    let maxAbsVerticalRateFpm = 0;

    for (let endIndex = startIndex + 1; endIndex < points.length; endIndex += 1) {
      const durationSec =
        (points[endIndex].time.getTime() - points[startIndex].time.getTime()) / 1000;
      if (durationSec > config.airworkMaxDurationSec) {
        break;
      }

      const altitude = altitudeOf(points[endIndex]);
      if (altitude != null) {
        minAltitudeFt = minAltitudeFt == null ? altitude : Math.min(minAltitudeFt, altitude);
        maxAltitudeFt = maxAltitudeFt == null ? altitude : Math.max(maxAltitudeFt, altitude);
      }

      maxAbsVerticalRateFpm = Math.max(
        maxAbsVerticalRateFpm,
        Math.abs(verticalRateOf(points[endIndex]) ?? 0)
      );

      const trackDeltaDeg = shortestAngleDelta(points[endIndex - 1].trackDeg, points[endIndex].trackDeg);
      if (trackDeltaDeg != null) {
        cumulativeAbsTurnDeg += Math.abs(trackDeltaDeg);
        netTurnDeg += trackDeltaDeg;
      }

      const turnRate = turnRateOf(points[endIndex]) ?? 0;
      const turnSign = turnRate > 0.8 ? 1 : turnRate < -0.8 ? -1 : 0;
      if (turnSign !== 0 && previousTurnSign !== 0 && turnSign !== previousTurnSign) {
        reversalCount += 1;
      }
      if (turnSign !== 0) {
        previousTurnSign = turnSign;
      }

      if (durationSec < config.airworkMinDurationSec) {
        continue;
      }

      const altitudeBandFt =
        minAltitudeFt != null && maxAltitudeFt != null ? maxAltitudeFt - minAltitudeFt : null;
      const meanAltitudeFt =
        minAltitudeFt != null && maxAltitudeFt != null ? (minAltitudeFt + maxAltitudeFt) / 2 : null;
      const boxSpanNm = estimateBoundingBoxSpanNm(points, startIndex, endIndex);

      if (
        meanAltitudeFt == null ||
        meanAltitudeFt < config.airworkMinAltitudeFt ||
        altitudeBandFt == null ||
        altitudeBandFt > config.airworkMaxAltitudeBandFt ||
        maxAbsVerticalRateFpm > config.airworkMaxVerticalRateFpm ||
        boxSpanNm == null
      ) {
        continue;
      }

      let type = null;
      let description = null;
      let confidence = "medium";

      if (
        cumulativeAbsTurnDeg >= config.airwork360MinAbsTurnDeg &&
        boxSpanNm <= config.airwork360MaxBoxSpanNm
      ) {
        type = "AIRWORK_360_TURN_CANDIDATE";
        description = "Compact local turning maneuver with cumulative heading change consistent with a 360-degree airwork turn.";
        confidence = "high";
      } else if (
        cumulativeAbsTurnDeg >= config.airwork180MinAbsTurnDeg &&
        boxSpanNm <= config.airwork180MaxBoxSpanNm &&
        reversalCount <= 2
      ) {
        type = "AIRWORK_180_TURN_CANDIDATE";
        description = "Local airwork turn or course reversal detected at maneuvering altitude.";
      } else if (
        cumulativeAbsTurnDeg >= config.airworkIrregularMinAbsTurnDeg &&
        reversalCount >= config.airworkIrregularMinReversals &&
        boxSpanNm <= config.airworkIrregularMaxBoxSpanNm
      ) {
        type = "AIRWORK_IRREGULAR_TURNING";
        description = "Irregular local turning maneuver detected, consistent with student airwork and repeated correction inputs.";
      }

      if (!type) {
        continue;
      }

      candidates.push({
        startIndex,
        endIndex,
        startTime: points[startIndex].time,
        endTime: points[endIndex].time,
        durationSec,
        minAltFt: minAltitudeFt,
        maxAltFt: maxAltitudeFt,
        altitudeBandFt,
        cumulativeAbsTurnDeg,
        netTurnDeg,
        reversalCount,
        boxSpanNm,
        type,
        description,
        confidence,
        score:
          cumulativeAbsTurnDeg +
          (type === "AIRWORK_360_TURN_CANDIDATE" ? 250 : 0) +
          reversalCount * 20 -
          altitudeBandFt / 4 -
          boxSpanNm * 25
      });
    }
  }

  const selected = [];
  candidates
    .sort((left, right) => right.score - left.score)
    .forEach((candidate) => {
      const overlapsExisting = selected.some(
        (existing) =>
          candidate.startIndex <= existing.endIndex &&
          candidate.endIndex >= existing.startIndex
      );
      if (!overlapsExisting) {
        selected.push(candidate);
      }
    });

  const maneuverCounts = {};
  const maneuvers = selected
    .sort((left, right) => left.startTime - right.startTime)
    .map((maneuver) => {
      maneuverCounts[maneuver.type] = (maneuverCounts[maneuver.type] || 0) + 1;
      return maneuver;
    });

  return {
    airworkManeuvers: maneuvers,
    airworkCounts: maneuverCounts
  };
}

function assessOperationalStyle({ runwayPatternSeries, touchAndGoCandidates, stableTurnCounts, lowAltitudeCycleCount }) {
  const stableTurn90Count = stableTurnCounts.STABLE_90_TURN_CANDIDATE || 0;
  const stableTurn180Count = stableTurnCounts.STABLE_180_TURN_CANDIDATE || 0;
  const stableTurn360Count = stableTurnCounts.STABLE_360_TURN_CANDIDATE || 0;
  const airwork180Count = stableTurnCounts.AIRWORK_180_TURN_CANDIDATE || 0;
  const airwork360Count = stableTurnCounts.AIRWORK_360_TURN_CANDIDATE || 0;
  const airworkIrregularCount = stableTurnCounts.AIRWORK_IRREGULAR_TURNING || 0;
  const totalAirworkCount = airwork180Count + airwork360Count + airworkIrregularCount;

  let vfrScore = 0;
  let ifrScore = 0;
  const reasons = [];

  if (runwayPatternSeries) {
    vfrScore += 3;
    reasons.push("repeated traffic-pattern cycles");
  }
  if (touchAndGoCandidates.length >= 2) {
    vfrScore += 2;
  }
  if (lowAltitudeCycleCount >= 1) {
    vfrScore += 1;
  }

  if (stableTurn360Count >= 1) {
    ifrScore += 2;
    reasons.push("stable-altitude 360-degree turn/orbit evidence");
  }
  if (stableTurn90Count + stableTurn180Count >= 2) {
    ifrScore += 1;
  }
  if (lowAltitudeCycleCount === 0 && stableTurn90Count + stableTurn180Count + stableTurn360Count >= 1) {
    ifrScore += 2;
  }

  if (airwork360Count + airwork180Count + airworkIrregularCount >= 2) {
    vfrScore += 2;
    reasons.push("local airwork maneuver practice");
  }
  if (airworkIrregularCount >= 1) {
    vfrScore += 1;
  }

  if (vfrScore >= 4 && vfrScore >= ifrScore + 2) {
    return {
      label: "LIKELY_VFR",
      text: "Likely VFR-style training profile.",
      vfrScore,
      ifrScore,
      reasons
    };
  }

  if (vfrScore >= 3 && ifrScore === 0 && totalAirworkCount >= 2) {
    return {
      label: "LIKELY_VFR",
      text: "Likely VFR-style maneuver practice profile.",
      vfrScore,
      ifrScore,
      reasons
    };
  }

  if (ifrScore >= 4 && ifrScore >= vfrScore + 2) {
    return {
      label: "LIKELY_IFR",
      text: "Likely IFR-style training profile.",
      vfrScore,
      ifrScore,
      reasons
    };
  }

  if (vfrScore >= 3 && ifrScore >= 2) {
    return {
      label: "MIXED_VFR_IFR",
      text: "Mixed VFR/IFR-style indications were detected.",
      vfrScore,
      ifrScore,
      reasons
    };
  }

  return {
    label: "UNDETERMINED",
    text: "VFR/IFR style is not strongly distinguishable from the available heuristics.",
    vfrScore,
    ifrScore,
    reasons
  };
}

export function detectEvents(points, segments, userConfig = SMART_ADSB_CONFIG.events) {
  const config = { ...SMART_ADSB_CONFIG.events, ...userConfig };
  const segmentCounts = countByPhase(segments);
  const touchAndGoCandidates = detectTouchAndGoCandidates(segments, config);
  const lowAltitudeWindows = enrichLowAltitudeWindows(
    points,
    detectLowAltitudeWindows(points, config),
    config
  );
  const maneuverSummary = classifyLowAltitudeManeuvers(lowAltitudeWindows, config);
  const stableTurnSummary = classifyStableTurnManeuvers(
    detectStableTurnWindows(points, config),
    config
  );
  const airworkSummary = detectAirworkManeuvers(points, config);
  const maneuverCounts = mergeCountMaps(
    maneuverSummary.maneuverCounts,
    stableTurnSummary.stableTurnCounts,
    airworkSummary.airworkCounts
  );
  const maneuvers = [
    ...maneuverSummary.maneuvers,
    ...stableTurnSummary.stableTurnManeuvers,
    ...airworkSummary.airworkManeuvers
  ]
    .sort((left, right) => left.startTime - right.startTime)
    .map((maneuver, index) => ({
      ...maneuver,
      maneuverId: index + 1
    }));
  const styleAssessment = assessOperationalStyle({
    runwayPatternSeries: maneuverSummary.runwayPatternSeries,
    touchAndGoCandidates: maneuverSummary.touchAndGoCandidates,
    stableTurnCounts: maneuverCounts,
    lowAltitudeCycleCount: maneuverSummary.lowAltitudeCycleCount
  });

  return {
    counts: segmentCounts,
    repeatedClimbSegments: Math.max(0, segmentCounts[SMART_ADSB_STATES.CLIMB] - 1),
    repeatedDescentSegments: Math.max(0, segmentCounts[SMART_ADSB_STATES.DESCENT] - 1),
    touchAndGoCandidates:
      maneuverSummary.touchAndGoCandidates.length > 0
        ? maneuverSummary.touchAndGoCandidates
        : touchAndGoCandidates,
    segmentTouchAndGoCandidates: touchAndGoCandidates,
    lowAltitudeWindows,
    stableTurnManeuvers: stableTurnSummary.stableTurnManeuvers,
    airworkManeuvers: airworkSummary.airworkManeuvers,
    maneuvers,
    maneuverCounts,
    landingCandidates: maneuverSummary.landingCandidates,
    runwayPatternSeries: maneuverSummary.runwayPatternSeries,
    lowAltitudeCycleCount: maneuverSummary.lowAltitudeCycleCount,
    styleAssessment,
    trainingIndicators: [
      segmentCounts[SMART_ADSB_STATES.CLIMB] > 1 ? "multiple climb segments" : null,
      segmentCounts[SMART_ADSB_STATES.DESCENT] > 1 ? "multiple descent segments" : null,
      maneuverSummary.touchAndGoCandidates.length > 0 ? "touch-and-go candidate sequence" : null,
      maneuverSummary.runwayPatternSeries ? "repeated traffic-pattern cycles" : null,
      stableTurnSummary.stableTurnManeuvers.length > 0 ? "stable-altitude turn maneuvers" : null
    ].filter(Boolean)
  };
}

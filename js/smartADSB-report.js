import { SMART_ADSB_STATES } from "./smartADSB-config.js";

// The report favors restrained natural language over dense diagnostics so the main output is immediately usable.
const ENGLISH_LOCALE = "en-US";

function formatDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return "0m";
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.round(totalSeconds % 60);
  const parts = [];

  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 || hours > 0) {
    parts.push(`${minutes}m`);
  }
  parts.push(`${seconds}s`);

  return parts.join(" ");
}

function median(values) {
  const filtered = values
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (filtered.length === 0) {
    return null;
  }

  const midpoint = Math.floor(filtered.length / 2);
  return filtered.length % 2 === 0
    ? (filtered[midpoint - 1] + filtered[midpoint]) / 2
    : filtered[midpoint];
}

function inferTimeZoneFromCoordinates(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return {
      timeZone: "UTC",
      source: "fallback"
    };
  }

  if (lat >= 18 && lat <= 23 && lon >= -161.5 && lon <= -154) {
    return {
      timeZone: "Pacific/Honolulu",
      source: "coordinate-heuristic"
    };
  }

  if (lat >= 51 && lon <= -130) {
    return {
      timeZone: lon <= -169 ? "America/Adak" : "America/Anchorage",
      source: "coordinate-heuristic"
    };
  }

  if (lat >= 31 && lat <= 37.5 && lon >= -115.5 && lon <= -109) {
    return {
      timeZone: "America/Phoenix",
      source: "coordinate-heuristic"
    };
  }

  if (lon <= -114) {
    return {
      timeZone: "America/Los_Angeles",
      source: "coordinate-heuristic"
    };
  }

  if (lon <= -100) {
    return {
      timeZone: "America/Denver",
      source: "coordinate-heuristic"
    };
  }

  if (lon <= -85) {
    return {
      timeZone: "America/Chicago",
      source: "coordinate-heuristic"
    };
  }

  if (lon <= -66) {
    return {
      timeZone: "America/New_York",
      source: "coordinate-heuristic"
    };
  }

  const utcOffsetHours = Math.round(lon / 15);
  const etcOffset = utcOffsetHours <= 0 ? `+${Math.abs(utcOffsetHours)}` : `-${utcOffsetHours}`;
  return {
    timeZone: `Etc/GMT${etcOffset}`,
    source: "longitude-fallback"
  };
}

export function inferAnalysisTimeContext(points) {
  const lats = points.map((point) => point.lat);
  const lons = points.map((point) => point.lon);
  const lat = median(lats);
  const lon = median(lons);
  const inferred = inferTimeZoneFromCoordinates(lat, lon);

  return {
    ...inferred,
    lat,
    lon
  };
}

export function formatTimestampEnglish(date, options = {}) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "unknown time";
  }

  const {
    timeZone = "UTC",
    includeZone = true
  } = options;

  return date.toLocaleString(ENGLISH_LOCALE, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone,
    timeZoneName: includeZone ? "short" : undefined
  });
}

function buildStyleAssessmentLines(events) {
  const assessment = events.styleAssessment || {
    text: "VFR/IFR style is not strongly distinguishable from the available heuristics.",
    reasons: []
  };

  const lines = [
    "Operational Style Assessment",
    assessment.text
  ];

  if (assessment.reasons?.length) {
    lines.push(`Primary signals: ${assessment.reasons.join(", ")}.`);
  }

  return lines;
}

function buildInterpretationLines({ events, segments, dataQuality, timeContext }) {
  const lines = [];

  if (events.counts[SMART_ADSB_STATES.CLIMB] > 1 && events.counts[SMART_ADSB_STATES.DESCENT] > 1) {
    lines.push("Multiple climb and descent cycles were detected, which is consistent with local training activity.");
  } else if (events.trainingIndicators.length > 0) {
    lines.push("The detected state changes suggest activity that is more varied than a simple out-and-back profile.");
  } else {
    lines.push("The detected state sequence is relatively simple, with no strong repeated training pattern in version 1 heuristics.");
  }

  if (events.runwayPatternSeries) {
    lines.push(
      `Repeated near-runway cycles were detected, which strongly suggests sustained traffic-pattern work.`
    );
  }

  if (events.touchAndGoCandidates.length > 0) {
    const firstCandidate = events.touchAndGoCandidates[0];
    lines.push(
      `Likely touch-and-go activity was identified around ${formatTimestampEnglish(firstCandidate.startTime, { timeZone: timeContext.timeZone })}; ${events.touchAndGoCandidates.length} candidate runway cycle(s) match the current heuristic.`
    );
  } else if (events.counts[SMART_ADSB_STATES.GROUND] > 1) {
    lines.push("Multiple ground segments were present, but no descent-ground-climb touch-and-go sequence met the configured thresholds.");
  } else {
    lines.push("No likely touch-and-go candidate was identified under the current thresholds.");
  }

  const stableTurn90Count = events.maneuverCounts?.STABLE_90_TURN_CANDIDATE || 0;
  const stableTurn180Count = events.maneuverCounts?.STABLE_180_TURN_CANDIDATE || 0;
  const stableTurn360Count = events.maneuverCounts?.STABLE_360_TURN_CANDIDATE || 0;
  const airwork180Count = events.maneuverCounts?.AIRWORK_180_TURN_CANDIDATE || 0;
  const airwork360Count = events.maneuverCounts?.AIRWORK_360_TURN_CANDIDATE || 0;
  const airworkIrregularCount = events.maneuverCounts?.AIRWORK_IRREGULAR_TURNING || 0;
  if (stableTurn90Count + stableTurn180Count + stableTurn360Count > 0) {
    lines.push(
      `Stable-altitude maneuvering turns were detected at training altitude, including ${stableTurn90Count} quarter-turn, ${stableTurn180Count} course-reversal, and ${stableTurn360Count} full-circle candidate(s).`
    );
  }
  if (airwork180Count + airwork360Count + airworkIrregularCount > 0) {
    lines.push(
      `Broader local airwork maneuvers were also detected, including ${airwork180Count} extended turn, ${airwork360Count} 360-degree, and ${airworkIrregularCount} irregular student-style turning candidate(s).`
    );
  }

  if (segments.length <= 2) {
    lines.push("Few segments were available, so the interpretation should be treated cautiously.");
  }

  if (dataQuality.largeGapCount > 0) {
    lines.push("Irregular sample gaps reduced confidence in fine-grained transition timing.");
  }

  return lines;
}

function buildManeuverLines(events) {
  const lines = [];
  lines.push(`Low-altitude runway cycles: ${events.lowAltitudeCycleCount || 0}`);
  lines.push(`Likely touch-and-go candidates: ${events.touchAndGoCandidates.length}`);
  lines.push(`Landing/full-stop candidates: ${events.landingCandidates?.length || 0}`);
  lines.push(`Stable 90-degree turns: ${events.maneuverCounts?.STABLE_90_TURN_CANDIDATE || 0}`);
  lines.push(`Stable 180-degree turns: ${events.maneuverCounts?.STABLE_180_TURN_CANDIDATE || 0}`);
  lines.push(`Stable 360-degree turns/orbits: ${events.maneuverCounts?.STABLE_360_TURN_CANDIDATE || 0}`);
  lines.push(`Airwork 180-degree turns: ${events.maneuverCounts?.AIRWORK_180_TURN_CANDIDATE || 0}`);
  lines.push(`Airwork 360-degree turns/orbits: ${events.maneuverCounts?.AIRWORK_360_TURN_CANDIDATE || 0}`);
  lines.push(`Airwork irregular turning maneuvers: ${events.maneuverCounts?.AIRWORK_IRREGULAR_TURNING || 0}`);

  const maneuverTypes = Object.entries(events.maneuverCounts || {});
  lines.push(
    maneuverTypes.length > 0
      ? `Maneuver categories: ${maneuverTypes.map(([type, count]) => `${type}=${count}`).join(", ")}`
      : "Maneuver categories: none"
  );

  return lines;
}

function buildDataQualityLines({ parserMeta, preprocessMeta, classifiedPointCount, segmentCount }) {
  const lines = [];

  const mappedColumns = Object.entries(parserMeta.columnMapping)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key} <= ${value}`);
  lines.push(`Recognized columns: ${mappedColumns.length ? mappedColumns.join(", ") : "none"}.`);

  if (parserMeta.discardedRows > 0) {
    lines.push(`${parserMeta.discardedRows} row(s) were dropped because the timestamp could not be parsed.`);
  }

  if (preprocessMeta.invalidRowsRemoved > 0 || preprocessMeta.duplicateRowsRemoved > 0) {
    lines.push(
      `${preprocessMeta.invalidRowsRemoved} obviously invalid row(s) and ${preprocessMeta.duplicateRowsRemoved} duplicate timestamp row(s) were removed.`
    );
  }

  if (parserMeta.warnings.length > 0) {
    parserMeta.warnings.forEach((warning) => lines.push(warning));
  }

  lines.push(`Classified points: ${classifiedPointCount}. Segment count after jitter suppression: ${segmentCount}.`);
  return lines;
}

export function generateTextReport(analysis) {
  const {
    parserMeta,
    preprocessMeta,
    classifiedPoints,
    segments,
    events,
    selectedSession,
    timeContext = inferAnalysisTimeContext(classifiedPoints)
  } = analysis;

  const startTime = classifiedPoints[0]?.time ?? null;
  const endTime = classifiedPoints[classifiedPoints.length - 1]?.time ?? null;
  const totalDurationSec =
    startTime && endTime ? Math.max(0, (endTime.getTime() - startTime.getTime()) / 1000) : 0;

  const summaryLines = [
    ...buildStyleAssessmentLines(events),
    "",
    "Flight Analysis Summary",
    `Coordinate-inferred local timezone: ${timeContext.timeZone}`,
    `Time range (Local): ${formatTimestampEnglish(startTime, { timeZone: timeContext.timeZone })} to ${formatTimestampEnglish(endTime, { timeZone: timeContext.timeZone })}`,
    `Time range (UTC): ${formatTimestampEnglish(startTime, { timeZone: "UTC" })} to ${formatTimestampEnglish(endTime, { timeZone: "UTC" })}`,
    `Duration: ${formatDuration(totalDurationSec)}`,
    `Ground segments: ${events.counts[SMART_ADSB_STATES.GROUND]}`,
    `Climb segments: ${events.counts[SMART_ADSB_STATES.CLIMB]}`,
    `Level segments: ${events.counts[SMART_ADSB_STATES.LEVEL]}`,
    `Descent segments: ${events.counts[SMART_ADSB_STATES.DESCENT]}`,
    `Likely touch-and-go candidates: ${events.touchAndGoCandidates.length}`
  ];

  const interpretationLines = ["", "Interpretation", ...buildInterpretationLines({
    events,
    segments,
    dataQuality: preprocessMeta,
    timeContext
  })];

  const maneuverLines = ["", "Maneuver Summary", ...buildManeuverLines(events)];

  const qualityLines = ["", "Data Quality Notes", ...buildDataQualityLines({
    parserMeta,
    preprocessMeta,
    classifiedPointCount: classifiedPoints.length,
    segmentCount: segments.length
  })];

  return [...summaryLines, ...interpretationLines, ...maneuverLines, ...qualityLines].join("\n");
}

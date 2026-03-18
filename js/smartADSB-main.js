import { SMART_ADSB_CONFIG } from "./smartADSB-config.js";
import { readCsvFile, parseCsvText } from "./smartADSB-parser.js";
import { detectFlightSessions, preprocessPoints } from "./smartADSB-preprocess.js";
import { computeFeatures } from "./smartADSB-features.js";
import { classifyPoints } from "./smartADSB-classifier.js";
import { buildSegments } from "./smartADSB-segments.js";
import { detectEvents } from "./smartADSB-events.js";
import {
  formatTimestampEnglish,
  generateTextReport,
  inferAnalysisTimeContext
} from "./smartADSB-report.js";

// The main module is intentionally thin: it wires the isolated page UI to the analysis pipeline.
function $(id) {
  return document.getElementById(id);
}

function setStatus(message, variant = "neutral") {
  const statusEl = $("smartadsb-status");
  statusEl.textContent = message;
  if (variant === "neutral") {
    statusEl.removeAttribute("data-variant");
    return;
  }
  statusEl.setAttribute("data-variant", variant);
}

function renderDebugSummary(summary) {
  $("smartadsb-debug-output").textContent = summary;
}

function setVisualMeta(message) {
  $("smartadsb-visual-meta").textContent = message;
}

function setAnalyzeEnabled(enabled) {
  $("smartadsb-analyze-button").disabled = !enabled;
}

function resetSessionPicker(message = "Upload a file and detect flight windows first") {
  const selectEl = $("smartadsb-session-select");
  selectEl.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = message;
  selectEl.appendChild(placeholder);
  selectEl.disabled = true;
  setAnalyzeEnabled(false);
  $("smartadsb-session-summary").textContent =
    "smartADSB will split day-long files into candidate flight windows, then analyze only the selected window.";
}

function formatDurationShort(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) {
    return "0m";
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatClockTime(date, timeZone) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return "unknown time";
  }

  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone
  }).format(date);
}

function formatTimeForOption(date) {
  return formatClockTime(date, "UTC");
}

function formatDateTimeForDebug(date, timeZone = "UTC") {
  return formatTimestampEnglish(date, {
    timeZone
  });
}

function formatColumnMapping(columnMapping) {
  const lines = [];
  Object.entries(columnMapping).forEach(([key, value]) => {
    lines.push(`${key}: ${value || "(not found)"}`);
  });
  return lines.join("\n");
}

function setPercentSliderValueLabel(elementId, value) {
  const labelEl = $(elementId);
  if (labelEl) {
    labelEl.textContent = `${Math.round(value)}%`;
  }
}

function setMultiplierSliderValueLabel(elementId, value) {
  const labelEl = $(elementId);
  if (labelEl) {
    labelEl.textContent = `${Number(value).toFixed(1)}x`;
  }
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

function createCanvasMessage(canvas, message) {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const width = canvas.width;
  const height = canvas.height;
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#0d1a22";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "rgba(230, 245, 252, 0.84)";
  context.font = `${Math.max(14, Math.round(width / 38))}px Avenir Next, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(message, width / 2, height / 2);
}

function resizeTrajectoryCanvas() {
  const canvas = $("smartadsb-trajectory-canvas");
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  return {
    width,
    height,
    ratio
  };
}

function prepareTrajectoryGeometry(points) {
  const usablePoints = points.filter(
    (point) => Number.isFinite(point.lat) && Number.isFinite(point.lon)
  );

  if (usablePoints.length < 2) {
    return null;
  }

  const centerLat = median(usablePoints.map((point) => point.lat));
  const centerLon = median(usablePoints.map((point) => point.lon));
  const firstAltitudeFt = usablePoints[0].altFtSmoothed ?? usablePoints[0].altFt ?? 0;
  const latScaleMeters = 111320;
  const lonScaleMeters = 111320 * Math.cos((centerLat * Math.PI) / 180);

  const samples = usablePoints.map((point) => ({
    x: (point.lon - centerLon) * lonScaleMeters,
    y: (point.lat - centerLat) * latScaleMeters,
    z: ((point.altFtSmoothed ?? point.altFt ?? firstAltitudeFt) - firstAltitudeFt) * 0.3048,
    time: point.time
  }));

  const horizontalRadius = Math.max(
    1,
    ...samples.map((sample) => Math.hypot(sample.x, sample.y))
  );
  const verticalExtent = Math.max(
    1,
    ...samples.map((sample) => Math.abs(sample.z))
  );

  return {
    samples,
    horizontalRadius,
    verticalExtent,
    centerLat,
    centerLon,
    firstAltitudeFt
  };
}

function smoothProjectedPath(points, smoothnessFactor) {
  if (points.length < 3 || smoothnessFactor <= 0) {
    return points;
  }

  const iterations = Math.max(1, Math.round(smoothnessFactor * 4));
  const blend = 0.12 + smoothnessFactor * 0.42;
  let current = points.map((point) => ({ ...point }));

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = [{ ...current[0] }];
    for (let index = 1; index < current.length - 1; index += 1) {
      const previous = current[index - 1];
      const point = current[index];
      const nextPoint = current[index + 1];
      const averaged = {
        x: (previous.x + point.x * 2 + nextPoint.x) / 4,
        y: (previous.y + point.y * 2 + nextPoint.y) / 4
      };
      next.push({
        x: point.x * (1 - blend) + averaged.x * blend,
        y: point.y * (1 - blend) + averaged.y * blend
      });
    }
    next.push({ ...current[current.length - 1] });
    current = next;
  }

  return current;
}

function strokeAnisotropicPath(context, points, dimensions, style) {
  if (points.length < 2) {
    return;
  }

  const widthPx = Math.max(1, dimensions.widthPx);
  const heightPx = Math.max(0.6, dimensions.heightPx);
  const scaleY = heightPx / widthPx;

  context.save();
  context.scale(1, scaleY);
  context.strokeStyle = style.strokeStyle;
  context.lineWidth = widthPx;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.shadowColor = style.shadowColor ?? "transparent";
  context.shadowBlur = style.shadowBlur ?? 0;
  context.beginPath();
  points.forEach((point, index) => {
    if (index === 0) {
      context.moveTo(point.x, point.y / scaleY);
    } else {
      context.lineTo(point.x, point.y / scaleY);
    }
  });
  context.stroke();
  context.restore();
}

function ensureTrajectoryViewState(canvasMetrics) {
  const geometry = appState.trajectoryGeometry;
  if (!geometry) {
    appState.trajectoryViewState = null;
    return null;
  }

  const cache = appState.trajectoryViewState;
  const needsRefresh =
    !cache ||
    cache.width !== canvasMetrics.width ||
    cache.height !== canvasMetrics.height;

  if (!needsRefresh) {
    return cache;
  }

  const pitchFactor = 0.1;
  const altitudeFactor = 0.78 * appState.heightExaggerationFactor;
  const width = canvasMetrics.width;
  const height = canvasMetrics.height;
  const horizontalScale = (width * 0.39) / Math.max(1, geometry.horizontalRadius);
  const verticalScale = (height * 0.3) / Math.max(1, geometry.verticalExtent * altitudeFactor);
  const scale = Math.min(horizontalScale, verticalScale) * appState.zoomFactor;

  appState.trajectoryViewState = {
    width,
    height,
    pitchFactor: appState.viewAngleFactor,
    altitudeFactor,
    scale,
    originX: width / 2,
    originY: height * 0.62
  };

  return appState.trajectoryViewState;
}

function drawTrajectoryFrame(timestampMs) {
  const geometry = appState.trajectoryGeometry;
  const canvas = $("smartadsb-trajectory-canvas");
  if (!geometry) {
    const { width, height } = resizeTrajectoryCanvas();
    createCanvasMessage(canvas, "Select a flight window to render the trajectory.");
    appState.animationFrameId = window.requestAnimationFrame(drawTrajectoryFrame);
    return;
  }

  const { width, height, ratio } = resizeTrajectoryCanvas();
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  const viewState = ensureTrajectoryViewState({ width, height });
  if (!viewState) {
    return;
  }

  context.clearRect(0, 0, width, height);
  context.fillStyle = "#0b1820";
  context.fillRect(0, 0, width, height);

  const orbitAngleRad = ((timestampMs % 15000) / 15000) * Math.PI * 2;
  const projected = geometry.samples.map((sample) => {
    const rotatedX = sample.x * Math.cos(orbitAngleRad) - sample.y * Math.sin(orbitAngleRad);
    const rotatedY = sample.x * Math.sin(orbitAngleRad) + sample.y * Math.cos(orbitAngleRad);
    return {
      x: rotatedX,
      y: rotatedY * viewState.pitchFactor + sample.z * viewState.altitudeFactor
    };
  });

  const scale = viewState.scale;
  const originX = viewState.originX;
  const originY = viewState.originY;
  const screenPoints = projected.map((point) => ({
    x: originX + point.x * scale,
    y: originY - point.y * scale
  }));
  const smoothedScreenPoints = smoothProjectedPath(screenPoints, appState.pathSmoothnessFactor);

  const lineWidthPx = appState.lineWidthPx * ratio;
  const lineHeightPx = appState.lineHeightPx * ratio;
  strokeAnisotropicPath(
    context,
    smoothedScreenPoints,
    {
      widthPx: lineWidthPx,
      heightPx: lineHeightPx
    },
    {
      strokeStyle: "rgba(135, 206, 250, 0.65)"
    }
  );
  strokeAnisotropicPath(
    context,
    smoothedScreenPoints,
    {
      widthPx: Math.max(1 * ratio, 1 * ratio),
      heightPx: Math.max(1 * ratio, 1 * ratio)
    },
    {
      strokeStyle: "rgba(54, 108, 168, 0.9)"
    }
  );

  if (smoothedScreenPoints.length > 0) {
    const first = smoothedScreenPoints[0];
    const last = smoothedScreenPoints[smoothedScreenPoints.length - 1];
    context.fillStyle = "rgba(255, 255, 255, 0.92)";
    context.beginPath();
    context.ellipse(first.x, first.y, Math.max(2.4, lineWidthPx * 0.24), Math.max(1.4, lineHeightPx * 0.38), 0, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "rgba(135, 206, 250, 0.96)";
    context.beginPath();
    context.ellipse(last.x, last.y, Math.max(2.8, lineWidthPx * 0.28), Math.max(1.7, lineHeightPx * 0.45), 0, 0, Math.PI * 2);
    context.fill();
  }

  appState.animationFrameId = window.requestAnimationFrame(drawTrajectoryFrame);
}

function startTrajectoryLoop() {
  if (appState.animationFrameId != null) {
    window.cancelAnimationFrame(appState.animationFrameId);
  }
  appState.animationFrameId = window.requestAnimationFrame(drawTrajectoryFrame);
}

function updateTrajectoryForPoints(points, selectedSession) {
  appState.trajectoryGeometry = prepareTrajectoryGeometry(points);
  appState.trajectoryViewState = null;
  if (!appState.trajectoryGeometry) {
    setVisualMeta("This flight window does not contain enough latitude/longitude data to render a 3D trajectory.");
  } else if (selectedSession) {
    setVisualMeta(
      `Rendering Session ${selectedSession.sessionId} in a wider top-down orbit view. Height exaggeration ${appState.heightExaggerationFactor}x, with the first valid sample fixed at z=0. Local ${formatClockTime(selectedSession.startTime, appState.timeContext.timeZone)}-${formatClockTime(selectedSession.endTime, appState.timeContext.timeZone)} · UTC ${formatTimeForOption(selectedSession.startTime)}-${formatTimeForOption(selectedSession.endTime)}.`
    );
  }
  startTrajectoryLoop();
}

function summarizeSegmentsByPhase(segments) {
  const phaseCounts = new Map();
  segments.forEach((segment) => {
    phaseCounts.set(segment.phase, (phaseCounts.get(segment.phase) || 0) + 1);
  });

  return Array.from(phaseCounts.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([phase, count]) => `${phase}: ${count}`)
    .join("\n");
}

function summarizeSessions(sessions, timeContext) {
  if (!sessions.length) {
    return "No flight windows detected.";
  }

  return sessions
    .map((session) =>
      `Session ${session.sessionId}: Local ${formatDateTimeForDebug(session.startTime, timeContext.timeZone)} -> ${formatDateTimeForDebug(session.endTime, timeContext.timeZone)} | UTC ${formatDateTimeForDebug(session.startTime, "UTC")} -> ${formatDateTimeForDebug(session.endTime, "UTC")} | ${formatDurationShort(session.durationSec)} | ${session.pointCount} pts`
    )
    .join("\n");
}

function buildSessionOptionLabel(session, timeContext) {
  return `Session ${session.sessionId}: Local ${formatClockTime(session.startTime, timeContext.timeZone)} - ${formatClockTime(session.endTime, timeContext.timeZone)} | UTC ${formatTimeForOption(session.startTime)} - ${formatTimeForOption(session.endTime)} (${formatDurationShort(session.durationSec)})`;
}

function populateSessionPicker(sessions, timeContext) {
  const selectEl = $("smartadsb-session-select");
  selectEl.innerHTML = "";

  sessions.forEach((session, index) => {
    const option = document.createElement("option");
    option.value = String(session.sessionId);
    option.textContent = buildSessionOptionLabel(session, timeContext);
    if (index === 0) {
      option.selected = true;
    }
    selectEl.appendChild(option);
  });

  selectEl.disabled = sessions.length === 0;
  setAnalyzeEnabled(sessions.length > 0);
  $("smartadsb-session-summary").textContent =
    sessions.length > 0
      ? `${sessions.length} candidate flight window(s) detected. Choose one time range before running analysis.`
      : "No candidate flight windows were detected with the current heuristics.";
}

function buildDebugText({ parserMeta, preprocessMeta, segments, events, sessions, selectedSession, timeContext }) {
  const maneuverCounts = Object.entries(events.maneuverCounts || {})
    .map(([type, count]) => `${type}: ${count}`)
    .join("\n");

  return [
    "Operational Style Assessment",
    events.styleAssessment?.text || "No style assessment yet.",
    `VFR score: ${events.styleAssessment?.vfrScore ?? 0}`,
    `IFR score: ${events.styleAssessment?.ifrScore ?? 0}`,
    `Coordinate-inferred local timezone: ${timeContext?.timeZone || "UTC"}`,
    "",
    "Column Mapping",
    formatColumnMapping(parserMeta.columnMapping),
    "",
    "Pipeline Summary",
    `Source rows: ${parserMeta.sourceRowCount}`,
    `Timestamp-valid rows: ${parserMeta.validRowCount}`,
    `Discarded timestamp rows: ${parserMeta.discardedRows}`,
    `Invalid rows removed: ${preprocessMeta.invalidRowsRemoved}`,
    `Duplicate timestamps collapsed: ${preprocessMeta.duplicateRowsRemoved}`,
    `Large/irregular gaps: ${preprocessMeta.largeGapCount}`,
    "",
    "Detected Flight Windows",
    summarizeSessions(sessions, timeContext || { timeZone: "UTC" }),
    "",
    "Selected Window",
    selectedSession
      ? `Session ${selectedSession.sessionId}: Local ${formatDateTimeForDebug(selectedSession.startTime, timeContext?.timeZone || "UTC")} -> ${formatDateTimeForDebug(selectedSession.endTime, timeContext?.timeZone || "UTC")} | UTC ${formatDateTimeForDebug(selectedSession.startTime, "UTC")} -> ${formatDateTimeForDebug(selectedSession.endTime, "UTC")}`
      : "No session selected yet.",
    "",
    "Segments By Phase",
    summarizeSegmentsByPhase(segments) || "No segments built.",
    "",
    "Events",
    `Likely touch-and-go candidates: ${events.touchAndGoCandidates.length}`,
    `Low-altitude runway cycles: ${events.lowAltitudeCycleCount || 0}`,
    `Landing/full-stop candidates: ${events.landingCandidates?.length || 0}`,
    `Stable 90-degree turns: ${events.maneuverCounts?.STABLE_90_TURN_CANDIDATE || 0}`,
    `Stable 180-degree turns: ${events.maneuverCounts?.STABLE_180_TURN_CANDIDATE || 0}`,
    `Stable 360-degree turns/orbits: ${events.maneuverCounts?.STABLE_360_TURN_CANDIDATE || 0}`,
    `Airwork 180-degree turns: ${events.maneuverCounts?.AIRWORK_180_TURN_CANDIDATE || 0}`,
    `Airwork 360-degree turns/orbits: ${events.maneuverCounts?.AIRWORK_360_TURN_CANDIDATE || 0}`,
    `Airwork irregular turning maneuvers: ${events.maneuverCounts?.AIRWORK_IRREGULAR_TURNING || 0}`,
    `Repeated climb segments beyond first: ${events.repeatedClimbSegments}`,
    `Repeated descent segments beyond first: ${events.repeatedDescentSegments}`,
    `Runway pattern series detected: ${events.runwayPatternSeries ? "yes" : "no"}`,
    "Maneuver Counts",
    maneuverCounts || "No maneuver categories."
  ].join("\n");
}

const appState = {
  fileName: null,
  parsed: null,
  preprocessed: null,
  sessions: [],
  trajectoryGeometry: null,
  trajectoryViewState: null,
  animationFrameId: null,
  heightExaggerationFactor: 6,
  viewAngleFactor: 0.2,
  zoomFactor: 1,
  lineWidthPx: 18,
  lineHeightPx: 2.5,
  pathSmoothnessFactor: 0.65,
  timeContext: {
    timeZone: "UTC"
  }
};

function clearCachedFileState() {
  appState.fileName = null;
  appState.parsed = null;
  appState.preprocessed = null;
  appState.sessions = [];
  appState.trajectoryGeometry = null;
  appState.trajectoryViewState = null;
  appState.heightExaggerationFactor = 6;
  appState.viewAngleFactor = 0.2;
  appState.zoomFactor = 1;
  appState.lineWidthPx = 18;
  appState.lineHeightPx = 2.5;
  appState.pathSmoothnessFactor = 0.65;
  appState.timeContext = {
    timeZone: "UTC"
  };
  const heightSlider = $("smartadsb-height-exaggeration-slider");
  const viewAngleSlider = $("smartadsb-view-angle-slider");
  const zoomSlider = $("smartadsb-zoom-slider");
  if (heightSlider) {
    heightSlider.value = "6";
  }
  if (viewAngleSlider) {
    viewAngleSlider.value = "20";
  }
  if (zoomSlider) {
    zoomSlider.value = "100";
  }
  setMultiplierSliderValueLabel("smartadsb-height-exaggeration-slider-value", 6);
  setPercentSliderValueLabel("smartadsb-view-angle-slider-value", 20);
  setPercentSliderValueLabel("smartadsb-zoom-slider-value", 100);
  resetSessionPicker();
  $("smartadsb-report-output").textContent =
    "Flight Analysis Summary\nTotal valid data points: --\nAnalyzed duration: --\nGround segments: --\nClimb segments: --\nLevel segments: --\nDescent segments: --\nLikely touch-and-go candidates: --\n\nInterpretation\nUpload a CSV, detect flight windows, choose one time range, and run analysis to replace this placeholder with a live training-flight summary.\n\nData Quality Notes\nColumn mapping, dropped rows, and confidence notes will appear here after analysis.";
  setVisualMeta("No flight window selected yet. Detect sessions and choose one to render the trajectory.");
  renderDebugSummary("No analysis has been run yet.");
  startTrajectoryLoop();
}

async function detectSessionsFromFile() {
  const fileInput = $("smartadsb-file-input");
  const detectButton = $("smartadsb-detect-button");
  const reportEl = $("smartadsb-report-output");
  const file = fileInput.files?.[0];

  if (!file) {
    setStatus("Select a CSV file before detecting flight windows.", "error");
    return;
  }

  detectButton.disabled = true;
  setAnalyzeEnabled(false);
  setStatus(`Reading ${file.name} and detecting candidate flight windows locally in the browser...`);

  try {
    const csvText = await readCsvFile(file);
    const parsed = parseCsvText(csvText, SMART_ADSB_CONFIG.parser);
    const preprocessed = preprocessPoints(parsed.points, SMART_ADSB_CONFIG.preprocess);

    if (preprocessed.points.length < SMART_ADSB_CONFIG.parser.minUsablePoints) {
      throw new Error(
        `Only ${preprocessed.points.length} usable points remained after cleaning. At least ${SMART_ADSB_CONFIG.parser.minUsablePoints} are required.`
      );
    }

    const featured = computeFeatures(preprocessed.points, SMART_ADSB_CONFIG.features);
    const timeContext = inferAnalysisTimeContext(preprocessed.points);
    const detectedSessions = detectFlightSessions(featured.points, SMART_ADSB_CONFIG.sessions);
    const sessions =
      detectedSessions.sessions.length > 0
        ? detectedSessions.sessions
        : [{
            sessionId: 1,
            startIndex: 0,
            endIndex: preprocessed.points.length - 1,
            coreStartIndex: 0,
            coreEndIndex: preprocessed.points.length - 1,
            startTime: preprocessed.points[0].time,
            endTime: preprocessed.points[preprocessed.points.length - 1].time,
            coreStartTime: preprocessed.points[0].time,
            coreEndTime: preprocessed.points[preprocessed.points.length - 1].time,
            durationSec: (preprocessed.points[preprocessed.points.length - 1].time.getTime() - preprocessed.points[0].time.getTime()) / 1000,
            pointCount: preprocessed.points.length
          }];

    appState.fileName = file.name;
    appState.parsed = parsed;
    appState.preprocessed = preprocessed;
    appState.sessions = sessions;
    appState.timeContext = timeContext;

    populateSessionPicker(sessions, timeContext);
    const defaultSession = sessions[0];
    if (defaultSession) {
      updateTrajectoryForPoints(
        preprocessed.points.slice(defaultSession.startIndex, defaultSession.endIndex + 1),
        defaultSession
      );
    }
    reportEl.textContent =
      "Flight Analysis Summary\nSelect one of the detected flight windows above, then click Analyze Selected Window.\n\nInterpretation\nDay-long ADS-B files are now split before analysis so one sortie does not contaminate another.\n\nData Quality Notes\nWindow detection completed locally in your browser.";
    renderDebugSummary(buildDebugText({
      parserMeta: parsed.meta,
      preprocessMeta: preprocessed.meta,
      segments: [],
      events: {
        touchAndGoCandidates: [],
        landingCandidates: [],
        lowAltitudeCycleCount: 0,
        maneuverCounts: {},
        styleAssessment: {
          text: "No style assessment yet.",
          vfrScore: 0,
          ifrScore: 0
        },
        runwayPatternSeries: false,
        repeatedClimbSegments: 0,
        repeatedDescentSegments: 0
      },
      sessions,
      selectedSession: null,
      timeContext
    }));
    setStatus(
      detectedSessions.sessions.length > 0
        ? `${sessions.length} candidate flight window(s) detected. Choose one time range and run analysis.`
        : "No distinct windows were detected under the current heuristics, so the full cleaned dataset was loaded as one analysis window.",
      "success"
    );
  } catch (error) {
    reportEl.textContent = "Analysis did not complete.\n\nReview the error message above, then try another CSV or adjust the input data.";
    renderDebugSummary(`Last error:\n${error.message}`);
    setStatus(error.message || "Analysis failed due to malformed input.", "error");
  } finally {
    detectButton.disabled = false;
  }
}

function getSelectedSession() {
  const selectedValue = $("smartadsb-session-select").value;
  return appState.sessions.find((session) => String(session.sessionId) === selectedValue) || null;
}

async function runAnalysis() {
  const reportEl = $("smartadsb-report-output");
  const analyzeButton = $("smartadsb-analyze-button");

  if (!appState.preprocessed || !appState.parsed) {
    setStatus("Detect flight windows before running analysis.", "error");
    return;
  }

  const selectedSession = getSelectedSession();
  if (!selectedSession) {
    setStatus("Choose a detected flight window before running analysis.", "error");
    return;
  }

  analyzeButton.disabled = true;
  setStatus(
    `Analyzing Session ${selectedSession.sessionId} from ${formatTimeForOption(selectedSession.startTime)} to ${formatTimeForOption(selectedSession.endTime)} locally in the browser...`
  );

  try {
    const sessionPoints = appState.preprocessed.points.slice(
      selectedSession.startIndex,
      selectedSession.endIndex + 1
    );

    if (sessionPoints.length < SMART_ADSB_CONFIG.parser.minUsablePoints) {
      throw new Error(
        `The selected flight window only contains ${sessionPoints.length} usable points. At least ${SMART_ADSB_CONFIG.parser.minUsablePoints} are required.`
      );
    }

    const featured = computeFeatures(sessionPoints, SMART_ADSB_CONFIG.features);
    const classified = classifyPoints(featured.points, SMART_ADSB_CONFIG.classifier);
    const segmented = buildSegments(classified.points, SMART_ADSB_CONFIG.segments);
    const events = detectEvents(segmented.points, segmented.segments, SMART_ADSB_CONFIG.events);

    const analysis = {
      parserMeta: appState.parsed.meta,
      preprocessMeta: appState.preprocessed.meta,
      classifiedPoints: segmented.points,
      segments: segmented.segments,
      events,
      selectedSession,
      timeContext: appState.timeContext
    };

    reportEl.textContent = generateTextReport(analysis);
    updateTrajectoryForPoints(sessionPoints, selectedSession);
    renderDebugSummary(buildDebugText({
      parserMeta: appState.parsed.meta,
      preprocessMeta: appState.preprocessed.meta,
      segments: segmented.segments,
      events,
      sessions: appState.sessions,
      selectedSession,
      timeContext: appState.timeContext
    }));
    setStatus(
      `Analysis complete for Session ${selectedSession.sessionId}. ${segmented.points.length} points and ${segmented.segments.length} segments were processed locally in your browser.`,
      "success"
    );
  } catch (error) {
    reportEl.textContent = "Analysis did not complete.\n\nReview the error message above, then try another CSV or adjust the selected time range.";
    renderDebugSummary(`Last error:\n${error.message}`);
    setStatus(error.message || "Analysis failed due to malformed input.", "error");
  } finally {
    analyzeButton.disabled = false;
  }
}

function initSmartADSB() {
  $("smartadsb-file-input").addEventListener("change", () => {
    clearCachedFileState();
    setStatus("File selected. Detect flight windows to populate time-range options.");
  });
  $("smartadsb-detect-button").addEventListener("click", detectSessionsFromFile);
  $("smartadsb-analyze-button").addEventListener("click", runAnalysis);
  $("smartadsb-session-select").addEventListener("change", () => {
    const selectedSession = getSelectedSession();
    if (selectedSession) {
      const sessionPoints = appState.preprocessed?.points.slice(
        selectedSession.startIndex,
        selectedSession.endIndex + 1
      );
      if (sessionPoints?.length) {
        updateTrajectoryForPoints(sessionPoints, selectedSession);
      }
      setStatus(
        `Selected Session ${selectedSession.sessionId}: Local ${formatClockTime(selectedSession.startTime, appState.timeContext.timeZone)} - ${formatClockTime(selectedSession.endTime, appState.timeContext.timeZone)} | UTC ${formatTimeForOption(selectedSession.startTime)} - ${formatTimeForOption(selectedSession.endTime)}. Click Analyze Selected Window to continue.`
      );
    }
  });
  $("smartadsb-view-angle-slider").addEventListener("input", (event) => {
    const sliderValue = Number(event.target.value);
    appState.viewAngleFactor = sliderValue / 100;
    appState.trajectoryViewState = null;
    setPercentSliderValueLabel("smartadsb-view-angle-slider-value", sliderValue);
    startTrajectoryLoop();
  });
  $("smartadsb-height-exaggeration-slider").addEventListener("input", (event) => {
    const sliderValue = Number(event.target.value);
    appState.heightExaggerationFactor = sliderValue;
    appState.trajectoryViewState = null;
    setMultiplierSliderValueLabel("smartadsb-height-exaggeration-slider-value", sliderValue);
    startTrajectoryLoop();
  });
  $("smartadsb-zoom-slider").addEventListener("input", (event) => {
    const sliderValue = Number(event.target.value);
    appState.zoomFactor = sliderValue / 100;
    appState.trajectoryViewState = null;
    setPercentSliderValueLabel("smartadsb-zoom-slider-value", sliderValue);
    startTrajectoryLoop();
  });
  setMultiplierSliderValueLabel("smartadsb-height-exaggeration-slider-value", 6);
  setPercentSliderValueLabel("smartadsb-view-angle-slider-value", 20);
  setPercentSliderValueLabel("smartadsb-zoom-slider-value", 100);
  window.addEventListener("resize", startTrajectoryLoop);
  startTrajectoryLoop();
}

initSmartADSB();

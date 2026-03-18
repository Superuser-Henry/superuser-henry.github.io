import { SMART_ADSB_CONFIG } from "./smartADSB-config.js";

// The parser accepts loose ADS-B CSV schemas and normalizes them into one internal point format.
function normalizeHeaderName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function splitCsvLine(line, delimiter) {
  const values = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const nextChar = line[index + 1];

    if (char === "\"") {
      if (inQuotes && nextChar === "\"") {
        current += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values.map((value) => value.trim());
}

function parseCsvTextToRows(text, delimiter) {
  const lines = String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (lines.length < 2) {
    throw new Error("The CSV must include a header row and at least one data row.");
  }

  const headers = splitCsvLine(lines[0], delimiter);
  const rows = [];

  for (let index = 1; index < lines.length; index += 1) {
    const values = splitCsvLine(lines[index], delimiter);
    const row = {};

    headers.forEach((header, headerIndex) => {
      row[header] = values[headerIndex] ?? "";
    });

    rows.push(row);
  }

  return { headers, rows };
}

function findColumn(headers, aliases) {
  const headerMap = new Map(headers.map((header) => [normalizeHeaderName(header), header]));
  for (const alias of aliases.map((value) => normalizeHeaderName(value))) {
    const match = headerMap.get(alias);
    if (match) {
      return match;
    }
  }
  return null;
}

function buildColumnMapping(headers, config) {
  return {
    time: findColumn(headers, config.timeAliases),
    lat: findColumn(headers, config.latAliases),
    lon: findColumn(headers, config.lonAliases),
    altFt: findColumn(headers, config.altitudeAliases),
    groundSpeedKt: findColumn(headers, config.speedAliases),
    trackDeg: findColumn(headers, config.trackAliases),
    position: findColumn(headers, config.positionAliases),
    callsign: findColumn(headers, config.callsignAliases)
  };
}

function parseNumeric(value) {
  if (value == null || value === "") {
    return null;
  }

  const numericValue = Number.parseFloat(String(value).replace(/,/g, ""));
  return Number.isFinite(numericValue) ? numericValue : null;
}

function parseTimestamp(value) {
  if (value == null || String(value).trim() === "") {
    return null;
  }

  const raw = String(value).trim();
  if (/^\d{10}(\.\d+)?$/.test(raw)) {
    const epochSeconds = Number(raw);
    return Number.isFinite(epochSeconds) ? new Date(epochSeconds * 1000) : null;
  }

  if (/^\d{13}$/.test(raw)) {
    const epochMs = Number(raw);
    return Number.isFinite(epochMs) ? new Date(epochMs) : null;
  }

  const parsedMs = Date.parse(raw);
  if (!Number.isNaN(parsedMs)) {
    return new Date(parsedMs);
  }

  return null;
}

function parsePositionCell(value) {
  if (!value) {
    return { lat: null, lon: null };
  }

  const parts = String(value)
    .split(",")
    .map((part) => parseNumeric(part));

  if (parts.length < 2) {
    return { lat: null, lon: null };
  }

  return {
    lat: parts[0],
    lon: parts[1]
  };
}

function scorePointCompleteness(point) {
  return [
    point.lat,
    point.lon,
    point.altFt,
    point.groundSpeedKt,
    point.trackDeg
  ].filter((value) => value != null).length;
}

export async function readCsvFile(file) {
  if (!file) {
    throw new Error("No file selected.");
  }

  const text = await file.text();
  if (!text.trim()) {
    throw new Error("The selected file is empty.");
  }

  return text;
}

export function parseCsvText(text, userConfig = SMART_ADSB_CONFIG.parser) {
  const parserConfig = { ...SMART_ADSB_CONFIG.parser, ...userConfig };
  const { headers, rows } = parseCsvTextToRows(text, parserConfig.delimiter);
  const columnMapping = buildColumnMapping(headers, parserConfig);

  if (!columnMapping.time) {
    throw new Error("Missing a recognizable time column. Expected aliases like UTC, time, or timestamp.");
  }

  const warnings = [];
  if (!columnMapping.altFt) {
    warnings.push("No recognized altitude column was found. Climb and descent detection may be limited.");
  }
  if (!columnMapping.groundSpeedKt) {
    warnings.push("No recognized ground speed column was found. Ground-state detection may be limited.");
  }

  const points = [];
  let discardedRows = 0;

  rows.forEach((row, rowIndex) => {
    const time = parseTimestamp(row[columnMapping.time]);
    if (!time) {
      discardedRows += 1;
      return;
    }

    const explicitLat = columnMapping.lat ? parseNumeric(row[columnMapping.lat]) : null;
    const explicitLon = columnMapping.lon ? parseNumeric(row[columnMapping.lon]) : null;
    const combinedPosition = columnMapping.position ? parsePositionCell(row[columnMapping.position]) : null;
    const lat = explicitLat ?? combinedPosition?.lat ?? null;
    const lon = explicitLon ?? combinedPosition?.lon ?? null;

    const point = {
      time,
      lat,
      lon,
      altFt: columnMapping.altFt ? parseNumeric(row[columnMapping.altFt]) : null,
      groundSpeedKt: columnMapping.groundSpeedKt ? parseNumeric(row[columnMapping.groundSpeedKt]) : null,
      trackDeg: columnMapping.trackDeg ? parseNumeric(row[columnMapping.trackDeg]) : null,
      dtSec: null,
      verticalRateFpm: null,
      state: null,
      rawRowNumber: rowIndex + 2,
      callsign: columnMapping.callsign ? String(row[columnMapping.callsign] || "").trim() || null : null
    };

    points.push(point);
  });

  if (points.length < parserConfig.minUsablePoints) {
    throw new Error(
      `Only ${points.length} usable data points were found after timestamp parsing. At least ${parserConfig.minUsablePoints} are required.`
    );
  }

  return {
    points,
    meta: {
      headers,
      columnMapping,
      sourceRowCount: rows.length,
      validRowCount: points.length,
      discardedRows,
      warnings,
      completenessPreview: points.slice(0, 20).map(scorePointCompleteness)
    }
  };
}

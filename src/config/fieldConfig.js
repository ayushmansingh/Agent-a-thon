import raw from "./field_config.json";

// Categories that carry a fixed fallback value at index 1.
export const SHEET_KEYS = ["Product", "Rateplan", "Price"];

// Normalize a sheet header ("TnC [Use ~ as Sep.]") to a config key ("TnC").
export function normalizeHeader(header) {
  return String(header)
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// For a sheet, return { normalizedHeader -> { key, category, meta } }.
export function buildConfigIndex(sheetName) {
  const section = raw[sheetName] || {};
  const index = {};
  for (const [key, arr] of Object.entries(section)) {
    if (key.startsWith("__")) continue; // __UNTRACED_55_COLS__ marker
    index[normalizeHeader(key)] = {
      key,
      category: arr[0],
      meta: arr.slice(1),
    };
  }
  return index;
}

// Field lists grouped by UI band for a sheet.
export function fieldsByCategory(sheetName) {
  const section = raw[sheetName] || {};
  const out = {
    vendor_config: [],
    package_input: [],
    lookup: [],
    system_id: [],
  };
  for (const [key, arr] of Object.entries(section)) {
    if (key.startsWith("__")) continue;
    const cat = arr[0];
    if (out[cat]) out[cat].push({ key, meta: arr.slice(1) });
  }
  return out;
}

// Default value for a `default` field, or "" otherwise.
export function defaultValue(sheetName, key) {
  const arr = (raw[sheetName] || {})[key];
  if (arr && arr[0] === "default") return arr[1] ?? "";
  return "";
}

export function getLegend() {
  return raw._legend || {};
}

export default raw;

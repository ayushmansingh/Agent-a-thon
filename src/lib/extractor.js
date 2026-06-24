// =============================================================================
// EXTRACTOR — single swappable module.
//
//   extract(vendorRows, classifications?) -> { product, rateplan, price }
//
// Two layers, merged per row:
//   1. Deterministic transforms (separator swaps, lat/long parse, day math,
//      passthrough/clean) — REAL, see ./transforms.js.
//   2. LLM-classification fields (Type, Sub-Type, Sub-Category, Short Desc,
//      meal/private-shared/time-of-day/suitable-for/unit-type) — inferred by
//      Claude in ./llmExtractor.js. Pass the per-row `classifications` array and
//      each field overlays the deterministic stub default.
//
// `classifications` is optional: omit it (or pass []) and every classification
// field falls back to its hardcoded stub, so the deterministic path still works
// offline / without an API key.
// =============================================================================

import {
  stripSIC,
  cleanWs,
  passthrough,
  bulletToTilde,
  toInt,
  toNumber,
  daysMinusUnavailable,
  parseBlackout,
  scheduleStart,
  scheduleEnd,
  slotTimeRanges,
  expandPaxTypes,
  unitTypeToCms,
  firstSentence,
  timeOfDay,
} from "./transforms.js";

// Resolve a vendor cell by header name (exact, else normalized contains).
export function makeVendorGetter(row) {
  const keys = Object.keys(row);
  const norm = (s) =>
    String(s)
      .replace(/^\*+/, "")
      .replace(/\([^)]*\)/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  return (name) => {
    if (row[name] != null) return row[name];
    const target = norm(name);
    const hit = keys.find((k) => norm(k) === target);
    if (hit) return row[hit];
    const partial = keys.find(
      (k) => norm(k).includes(target) || target.includes(norm(k))
    );
    return partial ? row[partial] : "";
  };
}

// Use the LLM value when present and non-empty, else the deterministic stub.
const pick = (llmVal, stub) =>
  llmVal != null && String(llmVal).trim() !== "" ? llmVal : stub;

// ---- PRODUCT -----------------------------------------------------------------
function deriveProduct(row, cls = {}) {
  const g = makeVendorGetter(row);
  return {
    "Product name": stripSIC(g("Package Name")),
    Type: pick(cls.type, "ACTIVITY"), // LLM class (stub: ACTIVITY)
    "Sub-Type": pick(cls.subType, "SIGHTSEEING"), // LLM class (stub: SIGHTSEEING)
    Description: cleanWs(g("**description of the activity")),
    "Short Desc": pick(cls.shortDesc, firstSentence(g("**description of the activity"))), // LLM (stub: first sentence)
    TnC: passthrough(g("**Terms & Conditions")),
    "Activity Highlights": bulletToTilde(g("Why should I do this ?")),
    "Sub-Category": pick(cls.subCategory, "City Tour"), // LLM class (stub: City Tour)
    "City Code": "", // populated by async Redash hp_city lookup in App.jsx
  };
}

// ---- RATEPLAN ----------------------------------------------------------------
function deriveRateplan(row, cls = {}) {
  const g = makeVendorGetter(row);
  const pkg = g("Package Name");
  const schedule = g("**schedule");
  const pickupPoint = g("**pickup Point");
  return {
    "Rateplan name": `${stripSIC(pkg)} - Shared Transfers`,
    "Rateplan description": cleanWs(g("**description of the activity")),
    "Currency code": passthrough(g("**currency")).toUpperCase(),
    "Unit Type": pick(cls.unitType, unitTypeToCms(g("**Unit Type"))), // LLM (stub: per_person)
    "Min Pax": toInt(g("**min PaxCount")),
    "Max Pax": toInt(g("**max PaxCount")),
    "Valid Days Of Week": pick(cls.validDays, daysMinusUnavailable(g("**List of unavailable days"))), // LLM (stub: 7 days minus unavailable)
    "Blackout Date Start": parseBlackout(g("**List of unavailable dates")),
    "Blackout Date End": parseBlackout(g("**List of unavailable dates")),
    "Suitable for": pick(cls.suitableFor, expandPaxTypes(g("**Unit Type"))), // LLM (stub: pax-type split)
    Inclusions: bulletToTilde(g("**inclusion")),
    Exclusions: bulletToTilde(g("**exclusion")),
    "Duration(in minutes)": passthrough(g("**Duration of the Activity (in minutes)")), // FLAG
    "Is meal included": pick(cls.isMealIncluded, "FALSE"), // LLM reads inclusions (stub: FALSE)
    "Time of day": pick(cls.timeOfDay, timeOfDay(schedule)), // LLM (stub: from schedule hour)
    "Schedule start time": scheduleStart(schedule),
    "Schedule end time": scheduleEnd(schedule),
    "Is pickup included": pick(cls.isPickupIncluded, pickupPoint && String(pickupPoint).trim() ? "TRUE" : "FALSE"), // LLM (stub: TRUE if pickup present)
    "Pickup timings": "", // vendor "**Slot Time" present but blank in sample row
    "Is dropoff included": pick(cls.isDropoffIncluded, "TRUE"), // LLM (stub: TRUE)
    "Drop off timings": "", // derived_vendor_optional — absent this vendor
    "Type of vehicle": "", // derived_vendor_optional — absent this vendor
    "Private/ Shared": pick(cls.privateOrShared, /\(\s*SIC\s*\)/i.test(String(pkg)) ? "SHARED" : "PRIVATE"), // LLM (stub: SIC regex)
    "Sightseeing ID for ticket": "",
  };
}

// ---- PRICE -------------------------------------------------------------------
function derivePrice(row, cls = {}) {
  const g = makeVendorGetter(row);
  const schedule = g("**schedule");
  return {
    "Slot Time Ranges": slotTimeRanges(schedule),
    "Run On Days": pick(cls.validDays, daysMinusUnavailable(g("**List of unavailable days"))), // LLM (stub: 7 minus unavailable)
    "Min pax": toInt(g("**min PaxCount")),
    "Max pax": toInt(g("**max PaxCount")),
    "Adult price": toNumber(g("Adult")), // COST in vendor currency (MYR)
    "Child price": toNumber(g("Child")), // COST in vendor currency (MYR)
  };
}

export function extract(vendorRows, classifications = []) {
  const rows = Array.isArray(vendorRows) ? vendorRows : [];
  const cls = Array.isArray(classifications) ? classifications : [];
  return {
    product: rows.map((r, i) => deriveProduct(r, cls[i] || {})),
    rateplan: rows.map((r, i) => deriveRateplan(r, cls[i] || {})),
    price: rows.map((r, i) => derivePrice(r, cls[i] || {})),
  };
}

// Flags surfaced in the UI (issue tracking, not silent).
export function computeFlags(vendorRows) {
  const flags = [];
  (vendorRows || []).forEach((row, i) => {
    const g = makeVendorGetter(row);
    const dur = toInt(g("**Duration of the Activity (in minutes)"));
    if (dur !== "" && dur !== 180) {
      flags.push({
        sheet: "Rateplan",
        rowIndex: i,
        field: "Duration(in minutes)",
        message: `Duration passthrough = ${dur} min (sample rateplan shows 180). Review before upload.`,
      });
    }
  });
  return flags;
}

export default extract;

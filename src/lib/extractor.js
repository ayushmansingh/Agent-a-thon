// =============================================================================
// EXTRACTOR — single swappable module.
//
//   extract(vendorRows) -> { product, rateplan, price }
//
// In the POC this is a STUB for the LLM-classification fields only. The
// deterministic transforms (separator swaps, lat/long parse, day math,
// passthrough/clean) are REAL — see ./transforms.js.
//
// To go live: replace `extract` with a single API call to the real Sonnet
// extractor. The return shape (per-sheet arrays of { configKey: value }) must
// stay the same and the UI will not need to change.
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
import { lookupCityCode } from "../config/cityMaster.js";

// Resolve a vendor cell by header name (exact, else normalized contains).
function makeVendorGetter(row) {
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

// ---- PRODUCT -----------------------------------------------------------------
function deriveProduct(row) {
  const g = makeVendorGetter(row);
  return {
    "Product name": stripSIC(g("Package Name")),
    Type: "ACTIVITY", // hardcoded (LLM class)
    "Sub-Type": "SIGHTSEEING", // hardcoded (LLM class)
    Description: cleanWs(g("**description of the activity")),
    "Short Desc": firstSentence(g("**description of the activity")), // rule stub
    TnC: passthrough(g("**Terms & Conditions")),
    "Activity Highlights": bulletToTilde(g("Why should I do this ?")),
    "Sub-Category": "City Tour", // hardcoded (LLM class)
    "City Code": lookupCityCode(g("destination Name")), // lookup
  };
}

// ---- RATEPLAN ----------------------------------------------------------------
function deriveRateplan(row) {
  const g = makeVendorGetter(row);
  const pkg = g("Package Name");
  const schedule = g("**schedule");
  const pickupPoint = g("**pickup Point");
  return {
    "Rateplan name": `${stripSIC(pkg)} - Shared Transfers`,
    "Rateplan description": cleanWs(g("**description of the activity")),
    "Currency code": passthrough(g("**currency")).toUpperCase(),
    "Unit Type": unitTypeToCms(g("**Unit Type")), // rule stub
    "Min Pax": toInt(g("**min PaxCount")),
    "Max Pax": toInt(g("**max PaxCount")),
    "Valid Days Of Week": daysMinusUnavailable(g("**List of unavailable days")),
    "Blackout Date Start": parseBlackout(g("**List of unavailable dates")),
    "Blackout Date End": parseBlackout(g("**List of unavailable dates")),
    "Suitable for": expandPaxTypes(g("**Unit Type")), // rule stub
    Inclusions: bulletToTilde(g("**inclusion")),
    Exclusions: bulletToTilde(g("**exclusion")),
    "Duration(in minutes)": passthrough(g("**Duration of the Activity (in minutes)")), // FLAG
    "Is meal included": "FALSE", // rule stub default
    "Time of day": timeOfDay(schedule), // rule stub
    "Schedule start time": scheduleStart(schedule),
    "Schedule end time": scheduleEnd(schedule),
    "Is pickup included": pickupPoint && String(pickupPoint).trim() ? "TRUE" : "FALSE", // rule stub
    "Pickup timings": "", // vendor "**Slot Time" present but blank in sample row
    "Is dropoff included": "TRUE", // rule stub
    "Drop off timings": "", // derived_vendor_optional — absent this vendor
    "Type of vehicle": "", // derived_vendor_optional — absent this vendor
    "Private/ Shared": /\(\s*SIC\s*\)/i.test(String(pkg)) ? "SHARED" : "PRIVATE", // rule stub
    "Sightseeing ID for ticket": "",
  };
}

// ---- PRICE -------------------------------------------------------------------
function derivePrice(row) {
  const g = makeVendorGetter(row);
  const schedule = g("**schedule");
  return {
    "Slot Time Ranges": slotTimeRanges(schedule),
    "Run On Days": daysMinusUnavailable(g("**List of unavailable days")),
    "Min pax": toInt(g("**min PaxCount")),
    "Max pax": toInt(g("**max PaxCount")),
    "Adult price": toNumber(g("Adult")), // COST in vendor currency (MYR)
    "Child price": toNumber(g("Child")), // COST in vendor currency (MYR)
  };
}

export function extract(vendorRows) {
  const rows = Array.isArray(vendorRows) ? vendorRows : [];
  return {
    product: rows.map(deriveProduct),
    rateplan: rows.map(deriveRateplan),
    price: rows.map(derivePrice),
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

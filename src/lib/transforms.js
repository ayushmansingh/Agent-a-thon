// Deterministic transforms — these are REAL in the POC (not stubbed).
// The LLM-classification fields (Type, Sub-Type, Short Desc, etc.) are the only
// hardcoded ones; everything here is honest data manipulation.

const DAYS = [
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
  "SUNDAY",
];

const NIL = new Set(["", "nil", "n/a", "na", "none", "-"]);

function isNil(v) {
  return v == null || NIL.has(String(v).trim().toLowerCase());
}

// "Kuala Lumpur City Tour (SIC)" -> "Kuala Lumpur City Tour"
export function stripSIC(s) {
  if (s == null) return "";
  return String(s)
    .replace(/\s*\(\s*SIC\s*\)\s*/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Collapse runs of whitespace / newlines into single spaces, trim.
export function cleanWs(s) {
  if (s == null) return "";
  return String(s).replace(/\s+/g, " ").trim();
}

export function passthrough(s) {
  return s == null ? "" : String(s).trim();
}

// Bullet list -> "~" separated.  "• A\n• B\n" -> "A~B"
// Separator swaps requested by the brief:  • -> ~ , - -> ~ , / -> |
export function bulletToTilde(s) {
  if (s == null) return "";
  return String(s)
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s•\-*]+/, "").trim())
    .filter((line) => line.length > 0)
    .join("~");
}

export function toInt(v) {
  if (v == null || v === "") return "";
  const n = parseInt(String(v).replace(/[^\d-]/g, ""), 10);
  return Number.isNaN(n) ? "" : n;
}

export function toNumber(v) {
  if (v == null || v === "") return "";
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isNaN(n) ? "" : n;
}

// "3.1390° N" -> 3.1390  ;  "101.6869° E" -> 101.6869 (W/S -> negative)
export function parseLatLong(v) {
  if (v == null || v === "") return "";
  const m = String(v).match(/(-?\d+(?:\.\d+)?)\s*°?\s*([NSEW])?/i);
  if (!m) return "";
  let val = parseFloat(m[1]);
  const dir = (m[2] || "").toUpperCase();
  if (dir === "S" || dir === "W") val = -val;
  return val;
}

// 7 days minus the vendor's "List of unavailable days".  nil -> all 7.
export function daysMinusUnavailable(unavailable) {
  if (isNil(unavailable)) return DAYS.join("~");
  const bad = String(unavailable)
    .split(/[,~/]|\r?\n/)
    .map((d) => d.trim().toUpperCase())
    .filter(Boolean);
  return DAYS.filter((d) => !bad.some((b) => d.startsWith(b) || b.startsWith(d))).join(
    "~"
  );
}

// Blackout dates parse; nil -> blank.  (Vendor "**List of unavailable dates")
export function parseBlackout(v) {
  if (isNil(v)) return "";
  return String(v).trim();
}

// Schedule "08:30-11:30 / 12:30-15:30" -> first start "08:30"
export function scheduleStart(schedule) {
  if (isNil(schedule)) return "";
  const m = String(schedule).match(/(\d{1,2}:\d{2})/);
  return m ? m[1] : "";
}

// Schedule "08:30-11:30 / 12:30-15:30" -> last end "15:30"
export function scheduleEnd(schedule) {
  if (isNil(schedule)) return "";
  const all = String(schedule).match(/\d{1,2}:\d{2}/g);
  return all && all.length ? all[all.length - 1] : "";
}

// Price "Slot Time Ranges":  '-' -> '~' ,  ' / ' -> '|'
// "08:30-11:30 / 12:30-15:30" -> "08:30~11:30|12:30~15:30"
export function slotTimeRanges(schedule) {
  if (isNil(schedule)) return "";
  return String(schedule)
    .replace(/\s*\/\s*/g, "|")
    .replace(/\s*-\s*/g, "~")
    .trim();
}

// "Adult & Child" -> "ADULT~CHILD"
export function expandPaxTypes(unitType) {
  if (isNil(unitType)) return "";
  return String(unitType)
    .split(/&|,|and|\+/i)
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean)
    .join("~");
}

// Unit Type mapping stub: "Adult & Child" -> per_person
export function unitTypeToCms(unitType) {
  if (isNil(unitType)) return "per_person";
  return "per_person";
}

// First sentence of a description (Short Desc rule stub).
export function firstSentence(s) {
  if (s == null) return "";
  const clean = cleanWs(s);
  const m = clean.match(/^(.*?[.!?])(\s|$)/);
  return m ? m[1].trim() : clean;
}

// Time-of-day classifier stub from a schedule's first start.
export function timeOfDay(schedule) {
  const start = scheduleStart(schedule);
  if (!start) return "ANYTIME";
  const hour = parseInt(start.split(":")[0], 10);
  if (hour < 12) return "MORNING";
  if (hour < 17) return "AFTERNOON";
  return "EVENING";
}

export { isNil, DAYS };

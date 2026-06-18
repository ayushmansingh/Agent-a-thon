// =============================================================================
// LLM EXTRACTOR — the real intelligence.
//
// classifyActivities(vendorRows, { apiKey }) -> { classifications, error }
//
// One Claude (Sonnet 4.6) call classifies every vendor activity in a single
// batch, returning the per-activity taxonomy + judgment fields that used to be
// hardcoded stubs. The deterministic transforms in ./extractor.js stay intact;
// these values overlay them (see extractor.js → `pick`).
//
// Browser-direct: the key comes from VITE_ANTHROPIC_API_KEY (Vite env) or an
// in-app field. `dangerouslyAllowBrowser` is required because there is no
// backend — acceptable for a POC/demo with your own key, NOT for a public
// deploy (the key ships to the client). For production, move this call behind a
// serverless proxy and drop the flag.
// =============================================================================

import Anthropic from "@anthropic-ai/sdk";
import { makeVendorGetter } from "./extractor.js";

const MODEL = "claude-sonnet-4-6";

// Controlled vocabularies — SEEDED FROM THE PRODUCT SAMPLE SHEET (5 rows).
// The model free-styled plausible-but-nonconforming tokens (e.g. Type "TOUR"
// instead of "ACTIVITY") until these were enum-constrained. The sample is a
// small slice, so these lists are almost certainly incomplete.
// TODO: replace with the full canonical CMS allowed-value lists.
const TYPE_VALUES = ["ACTIVITY", "TRANSFER"]; // sample had only ACTIVITY; TRANSFER per field_config note
const SUBTYPE_VALUES = ["SIGHTSEEING", "ATTRACTIONS"];
const SUBCATEGORY_VALUES = ["City Tour", "Half Day Tours", "Sightseeing Packages"];
const UNIT_TYPE_VALUES = ["per_person", "per_group", "per_vehicle", "per_unit"];

// JSON schema the model is constrained to (structured outputs).
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    activities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          type: {
            type: "string",
            enum: TYPE_VALUES,
            description: "Top-level CMS product type. Most sightseeing/tour products are ACTIVITY.",
          },
          subType: {
            type: "string",
            enum: SUBTYPE_VALUES,
            description:
              "CMS sub-type. SIGHTSEEING for city/area tours; ATTRACTIONS when the focus is a specific named site/landmark/ticketed attraction.",
          },
          subCategory: {
            type: "string",
            enum: SUBCATEGORY_VALUES,
            description:
              "CMS category, chosen by FORMAT/DURATION, not theme: 'City Tour' for a single-city sightseeing tour, 'Half Day Tours' for short (~half-day) outings, 'Sightseeing Packages' for full-day or multi-stop packages.",
          },
          shortDesc: {
            type: "string",
            description:
              "One punchy marketing sentence (<= 120 chars) summarising the activity. No trailing period required.",
          },
          isMealIncluded: {
            type: "string",
            enum: ["TRUE", "FALSE"],
            description:
              "TRUE only if the inclusions mention food/meal/lunch/dinner/breakfast/refreshments; else FALSE.",
          },
          privateOrShared: {
            type: "string",
            enum: ["PRIVATE", "SHARED"],
            description:
              "SHARED for SIC / join-in / group departures; PRIVATE for exclusive/private transfers.",
          },
          timeOfDay: {
            type: "string",
            enum: ["MORNING", "AFTERNOON", "EVENING", "FULL_DAY", "ANYTIME"],
            description: "Best fit for the schedule; FULL_DAY if it spans morning to evening.",
          },
          suitableFor: {
            type: "string",
            description:
              "Tilde-separated pax types in SCREAMING_SNAKE, e.g. 'ADULT~CHILD' or 'ADULT~CHILD~INFANT'.",
          },
          unitType: {
            type: "string",
            enum: UNIT_TYPE_VALUES,
            description:
              "CMS pricing unit. per_person when priced per adult/child; per_group/per_vehicle for private exclusive bookings.",
          },
          validDays: {
            type: "string",
            description:
              "Days the activity runs: the full week minus any day listed in unavailableDays. " +
              "Tilde-separated, full day names UPPERCASE, Monday-first order, e.g. " +
              "'MONDAY~TUESDAY~WEDNESDAY~THURSDAY~FRIDAY~SATURDAY~SUNDAY'. If unavailableDays " +
              "is empty/nil, return all seven. Used for both Valid Days Of Week and Run On Days.",
          },
          isPickupIncluded: {
            type: "string",
            enum: ["TRUE", "FALSE"],
            description:
              "TRUE if pickupPoint is present / non-empty, else FALSE.",
          },
          isDropoffIncluded: {
            type: "string",
            enum: ["TRUE", "FALSE"],
            description:
              "Whether dropoff is included. Default TRUE unless the activity data clearly indicates no dropoff.",
          },
        },
        required: [
          "type",
          "subType",
          "subCategory",
          "shortDesc",
          "isMealIncluded",
          "privateOrShared",
          "timeOfDay",
          "suitableFor",
          "unitType",
          "validDays",
          "isPickupIncluded",
          "isDropoffIncluded",
        ],
      },
    },
  },
  required: ["activities"],
};

const SYSTEM = `You are a product-cataloguing assistant for MMT Holidays' CMS. You receive raw vendor tariff activities and classify each one into the CMS taxonomy and a few judgment fields. Base every decision strictly on the vendor data provided — do not invent details. Return one classification object per activity, in the same order as the input. Be consistent: identical activities must get identical classifications.

Use ONLY these controlled vocabularies — pick the single closest fit, never invent a new value:
- Type: ${TYPE_VALUES.join(" | ")}  (sightseeing/tour products are ACTIVITY)
- Sub-Type: ${SUBTYPE_VALUES.join(" | ")}  (SIGHTSEEING = touring an area; ATTRACTIONS = focus on a named site/landmark/ticket)
- Sub-Category: ${SUBCATEGORY_VALUES.join(" | ")}  (choose by FORMAT/DURATION — half-day vs full-day/multi-stop — NOT by theme)
- Unit Type: ${UNIT_TYPE_VALUES.join(" | ")}`;

// Compact per-activity payload the model reasons over.
function toActivityInput(row, i) {
  const g = makeVendorGetter(row);
  return {
    index: i,
    packageName: g("Package Name"),
    destination: g("destination Name"),
    description: g("**description of the activity"),
    whyDoThis: g("Why should I do this ?"),
    inclusions: g("**inclusion"),
    exclusions: g("**exclusion"),
    schedule: g("**schedule"),
    vendorUnitType: g("**Unit Type"),
    durationMinutes: g("**Duration of the Activity (in minutes)"),
    pickupPoint: g("**pickup Point"),
    unavailableDays: g("**List of unavailable days"),
  };
}

export function getEnvApiKey() {
  return (import.meta.env && import.meta.env.VITE_ANTHROPIC_API_KEY) || "";
}

// Returns { classifications: Array<obj>, error: string|null }.
// error === "no-key" when no key is available (caller falls back to stubs).
export async function classifyActivities(vendorRows, opts = {}) {
  const rows = Array.isArray(vendorRows) ? vendorRows : [];
  if (!rows.length) return { classifications: [], error: null };

  const apiKey = (opts.apiKey || getEnvApiKey()).trim();
  if (!apiKey) return { classifications: [], error: "no-key" };

  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  const activities = rows.map(toActivityInput);

  try {
    const resp = await client.messages.create({
      model: opts.model || MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content:
            `Classify these ${activities.length} vendor activities. ` +
            `Return exactly ${activities.length} objects in the same order.\n\n` +
            JSON.stringify(activities, null, 2),
        },
      ],
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
    });

    const text = resp.content.find((b) => b.type === "text")?.text ?? "";
    const parsed = JSON.parse(text);
    const out = Array.isArray(parsed.activities) ? parsed.activities : [];
    return {
      classifications: out,
      error: out.length === rows.length ? null : "count-mismatch",
    };
  } catch (e) {
    return { classifications: [], error: e?.message || String(e) };
  }
}

export default classifyActivities;

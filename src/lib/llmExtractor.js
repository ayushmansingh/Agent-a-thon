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

// ---------------------------------------------------------------------------
// Controlled vocabularies — sourced from the CMS Dictionary sheets
// (Product_2.xlsx / Rateplan_1_1.xlsx Dictionary tab, all rows).
// ---------------------------------------------------------------------------

const TYPE_VALUES = [
  "ACTIVITY", "MEALS", "OTHERS", "PACKAGE_ADDON", "TRANSFER",
];

// Valid Sub-Type values when Type = ACTIVITY (SubType_ACTIVITY column).
const SUBTYPE_ACTIVITY_VALUES = ["ATTRACTIONS", "SIGHTSEEING", "TICKET_ONLY"];

// Full Sub-Category list from the Dictionary SubCategory Name column.
const SUBCATEGORY_VALUES = [
  "3D Show","4WD Tours","4WD, ATV & Off-Road Tours","Adrenaline & Extreme",
  "Adults-only Shows","Adventure","Afternoon Teas","Air Activities","Air Tours",
  "Air Transfers","Airport & Ground Transfers","Airport Lounges","Airport Services",
  "Airport Transfers","Airport to Hotel","Archaeology","Archaeology Tours",
  "Arts & Culture","Attraction Tickets","Attractions","Audio Guide Tour",
  "Balloon Rides","Bar","Bar, Club & Pub Tours","Beauty/Spa/Massage",
  "Beer & Brewery Tours","Bike & Mountain Bike Tours","Bird Watching","Boat Rental",
  "Boat Rides","Bungee Jumping","Bus & Minivan Tours","Bus Services","Cabaret",
  "Cable Car","Camping & Motor-homes","City Sightseeing","City Tour","City Tours",
  "Coffee & Tea Tours","Comedy","Concerts & Special Events","Cooking",
  "Cooking Classes","Cruise & Meal","Cruises","Cruises, Sailing & Water Tours",
  "Cruising","Culinary","Cultural & Theme Tours","Cultural Experiences",
  "Cultural Tours","Custom Private Tours","Cycling","Cycling Tours","Day Cruises",
  "Day Trips","Dining Experiences","Dinner Packages","Dinner Theater",
  "Dolphin & Whale Watching","Duck Tours","Eco Tours","Eco-Tours",
  "Entertainment Packages","Evening Tour","Events","Events & Shows",
  "Extreme Adventure","Family Attraction","Family Friendly Tours & Activities",
  "Festivals","Fishing","Fishing Charters & Tours","Food Tours","Full Day Tours",
  "Full-day Tours","Golf","Golf Tours & Tee Times","Half Day Tours","Half-day Tours",
  "Helicopter Tour","Helicopter Tours","Hiking & Camping",
  "Hiking, Camping & Trekking","Historic Tours","Historical",
  "Historical & Heritage Tours","Historical Sites","Hop-on Hop-off Tours",
  "Horse Riding","Hot Air Balloon","Hot Air Balloon Flights","Hot Air Ballooning",
  "Hotel to Airport","Hotel to Hotel","Island Tour","Jet Boats & Speed Boats",
  "Kayaking & Canoeing","Land Transfers","Literary, Art & Music Tours",
  "Luxury Tours","Luxury Trains","Museum","Museum Tickets & Passes",
  "Nature & Wildlife","Night Cruises","Night Tours","Nightlife","Observation deck",
  "Off-Road Tours","Other Water Sports","Overnight Tours","Package Addon",
  "Parasailing & Paragliding","Photography Tours","Port Transfers",
  "Ports of Call Tours","Private & Custom Tours","Private Day Trips","Private Tours",
  "Rail Tours","River Rafting","River Rafting & Tubing","Romantic Experiences",
  "Romantic Tours","Running Tours","Safari","Safaris","Sailing",
  "Sailing & Yachting","Scenic Flights","Scenic Train","Scuba & Snorkeling",
  "Scuba & Snorkelling","Segway Tours","Self-Drive","Self-Drive Tours",
  "Self-guided Tours & Rentals","Shopping","Shopping Tours",
  "Show/Concert & Meal","Sightseeing & City Passes","Sightseeing Packages",
  "Ski","Ski & Snow","Skip-the-Line Tours","Spa","Sport",
  "Sporting Events & Packages","Sports Activities","Submarine","Submarine Tours",
  "Sunrise/Sunset Tour","Surfing & Windsurfing","Swim with Dolphins",
  "Theater, Shows & Musicals","Theme Park","Theme Park Tickets & Tours",
  "Theme Parks","Thermal Spas & Hot Springs","Transfers","Transport",
  "Trekking & Hiking","Walking Tours","Water Experiences","Water Parks",
  "Water Sports","Water Transfers","Waterskiing & Jet skiing","Wedding Packages",
  "Wellness","Wine Tasting","Wine Tasting & Winery Tours","Ziplines",
  "Zoo Tickets & Passes",
];

// Unit Type values from Dictionary UnitType column.
const UNIT_TYPE_VALUES = ["per_person", "per_unit"];

// Time of day values from Dictionary TimeOfDay column.
const TIME_OF_DAY_VALUES = ["MORNING", "AFTERNOON", "EVENING", "NIGHT", "ANYTIME"];

// Suitable-for individual tokens from Dictionary Suitable for column.
// The field value is tilde-separated, e.g. "ADULT~CHILD".
const SUITABLE_FOR_TOKENS = ["ADULT", "CHILD", "GROUP", "INFANT", "SENIOR", "YOUTH"];

// ---------------------------------------------------------------------------
// JSON schema the model is constrained to (structured outputs).
// ---------------------------------------------------------------------------
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
            description:
              "Top-level CMS product type. Sightseeing/tour/experience products are ACTIVITY; " +
              "airport/hotel/point transfers are TRANSFER; food-only are MEALS.",
          },
          subType: {
            type: "string",
            enum: SUBTYPE_ACTIVITY_VALUES,
            description:
              "CMS sub-type for ACTIVITY: SIGHTSEEING for guided area/city tours; " +
              "ATTRACTIONS when the focus is a specific named site, landmark, or ticketed venue; " +
              "TICKET_ONLY for entry tickets with no accompanying guide/transport.",
          },
          subCategory: {
            type: "string",
            enum: SUBCATEGORY_VALUES,
            description:
              "CMS sub-category. Pick by activity format/duration first: " +
              "'City Tour' for a single-city guided sightseeing drive; " +
              "'Half Day Tours' for outings under ~4 h; " +
              "'Full Day Tours' / 'Full-day Tours' for full-day outings; " +
              "'Airport Transfers' for airport ↔ city bus/limousine products; " +
              "'Attraction Tickets' for entry-only tickets. " +
              "Choose the closest from the enum — never invent a new value.",
          },
          shortDesc: {
            type: "string",
            description:
              "One punchy marketing sentence (≤ 120 chars) capturing the core appeal. " +
              "No trailing period required.",
          },
          isMealIncluded: {
            type: "string",
            enum: ["TRUE", "FALSE"],
            description:
              "TRUE only if the inclusions text explicitly mentions food, meal, lunch, " +
              "dinner, breakfast, or refreshments; else FALSE.",
          },
          privateOrShared: {
            type: "string",
            enum: ["PRIVATE", "SHARED"],
            description:
              "SHARED for SIC / join-in / group/shared departures (look for 'SIC', " +
              "'shared', 'group tour', 'join-in' in the name or description); " +
              "PRIVATE for exclusive/private hire.",
          },
          timeOfDay: {
            type: "string",
            enum: TIME_OF_DAY_VALUES,
            description:
              "Best fit for when the activity runs. Derive from schedule start time: " +
              "before 12:00 → MORNING; 12:00–17:00 → AFTERNOON; 17:00–21:00 → EVENING; " +
              "after 21:00 → NIGHT; no schedule or all-day → ANYTIME.",
          },
          suitableFor: {
            type: "string",
            description:
              `Tilde-separated pax types from [${SUITABLE_FOR_TOKENS.join(", ")}]. ` +
              "Use the vendor's Unit Type field and description: 'Adult & Child' → 'ADULT~CHILD'. " +
              "Include INFANT/SENIOR/YOUTH only if explicitly mentioned.",
          },
          unitType: {
            type: "string",
            enum: UNIT_TYPE_VALUES,
            description:
              "CMS pricing unit. per_person when priced individually (adult/child rates); " +
              "per_unit for whole-vehicle/whole-group pricing.",
          },
          validDays: {
            type: "string",
            description:
              "Days the activity runs: all seven days minus any day listed in unavailableDays. " +
              "Tilde-separated UPPERCASE full day names, Monday-first: " +
              "'MONDAY~TUESDAY~WEDNESDAY~THURSDAY~FRIDAY~SATURDAY~SUNDAY'. " +
              "If unavailableDays is empty/nil return all seven.",
          },
          isPickupIncluded: {
            type: "string",
            enum: ["TRUE", "FALSE"],
            description: "TRUE if pickupPoint is present and non-empty; else FALSE.",
          },
          isDropoffIncluded: {
            type: "string",
            enum: ["TRUE", "FALSE"],
            description:
              "Whether drop-off is included. Default TRUE unless the data clearly indicates no dropoff.",
          },
        },
        required: [
          "type","subType","subCategory","shortDesc","isMealIncluded",
          "privateOrShared","timeOfDay","suitableFor","unitType",
          "validDays","isPickupIncluded","isDropoffIncluded",
        ],
      },
    },
  },
  required: ["activities"],
};

const SYSTEM =
  `You are a product-cataloguing assistant for MMT Holidays' CMS. ` +
  `You receive raw vendor tariff activities and classify each one into the CMS taxonomy ` +
  `and a few judgment fields. Base every decision strictly on the vendor data provided — ` +
  `do not invent details. Return one classification object per activity, in the same order ` +
  `as the input. Be consistent: identical activities must get identical classifications.\n\n` +
  `Use ONLY the controlled vocabularies defined in the JSON schema — pick the single closest ` +
  `fit, never invent a new value.\n\n` +
  `Few-shot examples:\n` +
  `1. "Kuala Lumpur City Tour (SIC)" — guided city tour, SIC/shared, 08:30-11:30/12:30-15:30, ` +
  `   no meals, hotel pickup included → type:ACTIVITY, subType:SIGHTSEEING, subCategory:"City Tour", ` +
  `   privateOrShared:SHARED, timeOfDay:MORNING, isPickupIncluded:TRUE\n` +
  `2. "Airport Limousine Bus: Haneda Airport to/from Tokyo Area" — airport transfer bus, ` +
  `   shared, no schedule → type:ACTIVITY, subType:ATTRACTIONS, subCategory:"Airport Transfers", ` +
  `   privateOrShared:SHARED, timeOfDay:ANYTIME, isPickupIncluded:FALSE`;

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

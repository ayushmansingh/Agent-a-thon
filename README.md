# Vendor Tariff → Product / Rateplan / Price Ingestion (POC)

A pure-frontend web app that turns a **vendor tariff Excel** into the three MMT
Holidays CMS upload sheets — **Product**, **Rateplan**, **Price** — auto-filling
what it can, letting a PM tweak a small set of business fields, and downloading
the sheets in the strict order the CMS requires.

React + Vite + [SheetJS](https://sheetjs.com) (`xlsx`). Parsing and Excel
generation happen in the browser. City Code is fetched from the Redash source
link for query `162593`, with `p_city_name` set per product row.
The app calls Redash API `refresh`, polls the job, then reads the query result.
In local dev, Vite proxies `/redash-api` to Redash to avoid browser CORS.
The mock CMS handoff is implemented as local Vite dev middleware under `/mock-cms`.

## Run

```bash
npm install
cp .env.example .env.local   # then paste your Anthropic key (see "AI extraction")
# set VITE_REDASH_CITY_LOOKUP_URL and REDASH_KEY for the hp_city Redash lookup
npm run dev      # http://localhost:5173
npm run build    # static build into dist/
```

## AI extraction (Claude)

The classification fields are inferred by **Claude (Sonnet 4.6)** via the official
`@anthropic-ai/sdk`, called **directly from the browser** (the app stays a static
site — no backend). Provide a key one of two ways:

- **Env var** — put `VITE_ANTHROPIC_API_KEY=sk-ant-...` in `.env.local`
  (git-ignored via `*.local`), or
- **In-app** — paste a key into the field on the page (kept in memory only).

On upload the app shows the deterministic output instantly, then one batched
Claude call classifies every activity and the fields update in place. With **no
key**, it falls back to the deterministic stub defaults — nothing breaks.
Claude also returns a 0.0-1.0 confidence score per AI-filled field. Preview
cells for those fields show a compact red-to-green confidence bar.

> ⚠️ Because the call is browser-direct (`dangerouslyAllowBrowser`), the key is
> visible to anyone using the page. Fine for a local demo with your own key —
> for a public deploy, move the call behind a serverless proxy and drop the flag.

## The flow — IDs are the baton

The three stages are gated so the CMS load-order dependency is enforced by the
UI, not left to the user:

1. **Product** - upload vendor tariff -> sheets auto-fill in memory -> download
   the Product sheet. The mock CMS returns Product IDs like `ACME000001`.
2. **Rateplan** - Product IDs are injected automatically. Download the Rateplan
   sheet; the mock CMS returns Rateplan IDs like `RP0001_ACME000001`.
3. **Price** - Rateplan IDs are injected automatically -> download Price.

The auto-generated Product and Rateplan IDs remain editable before the next
stage, so a user can override mock values when needed.
Generated preview cells are also editable; edits there are applied to the
downloaded workbook for that sheet.

Each section has two editable bands:

- **Vendor defaults** (`vendor_config`) — set once per vendor, applied to every
  package (e.g. dynamic-inventory toggles).
- **Per-package** (`package_input`) — differs per activity (Rank, Highlighted,
  Visibility Bit, Channel, SEO, Salience, hotel link, Labels, validity dates,
  image link...).

## The extractor — two layers, merged per row

```js
classifyActivities(vendorRows, { apiKey }) -> { classifications: [...] }   // Claude
extract(vendorRows, classifications?)       -> { product, rateplan, price } // merge
```

- **Deterministic transforms are REAL** ([`src/lib/transforms.js`](src/lib/transforms.js)):
  separator swaps (`•`/`-` → `~`, `/` → `|`), lat/long parsing (`3.1390° N` →
  `3.1390`), `(SIC)` stripping, whitespace cleaning, day-of-week math, schedule
  parsing, pax/int/number coercion, passthrough.
- **All 13 `derived_rule_stub` fields are inferred by Claude**
  ([`src/lib/llmExtractor.js`](src/lib/llmExtractor.js)): Type, Sub-Type,
  Sub-Category, Short Desc, Unit Type, Suitable-for, Is-meal-included, Time of
  day, Private/Shared, Valid Days Of Week, Run On Days, Is-pickup-included, and
  Is-dropoff-included — one batched Sonnet 4.6 call with a JSON-schema structured
  output, read from each activity's description / inclusions / schedule /
  unavailable-days.

[`extract()`](src/lib/extractor.js) overlays each Claude value onto the
deterministic output (`pick(llmVal, stub)`); pass `[]` (or omit it) and every
classification field falls back to its stub default, so the deterministic path
still works with no API key. To run the classifier elsewhere (a serverless
proxy), swap `llmExtractor.js` — `extract()` and the UI stay the same.

## Field handling

[`src/config/field_config.json`](src/config/field_config.json) is the source of
truth — every target column is tagged with a category:

| category | handling |
| --- | --- |
| `derived_vendor` | pulled from a vendor column + a real transform |
| `derived_rule_stub` | LLM/heuristic → hardcoded in the POC |
| `default` | fixed business fallback (e.g. Affiliate `Holidays`, Star Rating `5`) |
| `vendor_config` | "Vendor defaults" band |
| `package_input` | "Per-package" band |
| `lookup` | City Code via Redash query `162593` source (`p_city_name` -> `city_code`) |
| `system_id` | injected from editable mock CMS Product/Rateplan IDs |
| `blank` | shipped empty (business-confirmed) |
| `ship_sample` | the ~55 untraced Rateplan columns — copied **verbatim** from the sample row until the trace is completed |

## Output structure (matches the samples exactly)

The sample workbooks in [`public/`](public/) are fetched at runtime and used as
templates, so headers, the format/legend row, and the untraced columns are
always verbatim:

- **Row 1** — headers (incl. the `[Use ~ as Sep.]` hints)
- **Row 2** — format/legend row (the CMS expects it; it is **not** data)
- **Row 3+** — generated data, one row per vendor activity

Counts: Product 43 cols, Rateplan 106 cols (50 traced + 56 shipped from sample),
Price 21 cols. The Price tab is named **`Pricing`**.

## Known issues surfaced in the UI (not silently swallowed)

- **Pricing = COST only**, in vendor currency (MYR). No FX, no GST — a
  downstream system handles that. Shown as a read-only banner on the Price
  section.
- **Duration discrepancy** — vendor values (e.g. 120) vs the sample rateplan's
  180. Any passed-through Duration is flagged for review.
- **Rateplan trace incomplete** — 50 of 105 columns mapped; a notice explains
  the rest ship from the sample row.

## Out of scope (POC)

Real LLM extraction, real CMS upload/auth, the 55 untraced Rateplan columns,
multi-vendor format variation, validation/confidence gating, and the human
review queue — all next phase.

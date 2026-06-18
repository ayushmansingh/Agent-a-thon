# Vendor Tariff → Product / Rateplan / Price Ingestion (POC)

A pure-frontend web app that turns a **vendor tariff Excel** into the three MMT
Holidays CMS upload sheets — **Product**, **Rateplan**, **Price** — auto-filling
what it can, letting a PM tweak a small set of business fields, and downloading
the sheets in the strict order the CMS requires.

No backend. React + Vite + [SheetJS](https://sheetjs.com) (`xlsx`). Parsing and
Excel generation happen entirely in the browser, so it deploys later as a static
site (Vercel).

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static build into dist/
```

## The flow — IDs are the baton

The three stages are gated so the CMS load-order dependency is enforced by the
UI, not left to the user:

1. **Product** — upload vendor tariff → sheets auto-fill in memory → download
   the Product sheet. (Rateplan & Price are locked.)
2. **Rateplan** — upload Product sheet to the CMS *outside this app*, paste the
   returned **Product ID(s)** back in. The app injects them into the Rateplan
   rows and unlocks the Rateplan download.
3. **Price** — paste the returned **Rateplan ID(s)** → injected into Price rows
   → download Price.

Each section has two editable bands:

- **Vendor defaults** (`vendor_config`) — set once per vendor, applied to every
  package (e.g. Visibility Bit, Channel, dynamic-inventory toggles).
- **Per-package** (`package_input`) — differs per activity (Rank, Highlighted,
  Salience, hotel link, Labels, validity dates, image link…).

## The extractor is one swappable module

```js
extract(vendorRows) -> { product: [...], rateplan: [...], price: [...] }
```

Lives in [`src/lib/extractor.js`](src/lib/extractor.js). In this POC:

- **Deterministic transforms are REAL** (`src/lib/transforms.js`): separator
  swaps (`•`/`-` → `~`, `/` → `|`), lat/long parsing (`3.1390° N` → `3.1390`),
  `(SIC)` stripping, whitespace cleaning, day-of-week math, schedule parsing,
  pax/int/number coercion, passthrough.
- **LLM-classification fields are hardcoded stubs** (Type → `ACTIVITY`,
  Sub-Type → `SIGHTSEEING`, Sub-Category → `City Tour`, Short Desc → first
  sentence, Time of day → from schedule, etc.).

To go live, replace the body of `extract()` with a single API call to the real
extractor. The return shape and the UI stay exactly the same.

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
| `lookup` | City Code via the `city_master` stub (`src/config/cityMaster.js`) |
| `system_id` | injected from pasted Product/Rateplan IDs |
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

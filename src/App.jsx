import { useEffect, useMemo, useState } from "react";
import "./App.css";
import { extract, computeFlags, makeVendorGetter } from "./lib/extractor.js";
import { classifyActivities, getEnvApiKey } from "./lib/llmExtractor.js";
import {
  loadAllTemplates,
  parseVendorFile,
  buildAoa,
  downloadSheet,
} from "./lib/sheets.js";
import { createMockProducts, createMockRateplans } from "./lib/mockCms.js";
import { fieldsByCategory, normalizeHeader } from "./config/fieldConfig.js";
import { lookupCityCodes } from "./config/cityMaster.js";

// ---- helpers ----------------------------------------------------------------
function vcOptions(meta) {
  const hint = String(meta?.[0] ?? "");
  if (hint.toLowerCase().startsWith("enum:"))
    return hint.slice(hint.indexOf(":") + 1).split("|").map((s) => s.trim());
  if (hint.toLowerCase() === "bool") return ["TRUE", "FALSE"];
  if (/^\s*\d+(\s*\|\s*\d+)+\s*$/.test(hint))
    return hint.split("|").map((s) => s.trim());
  return null;
}

function defaultVendorConfig(sheetName) {
  const out = {};
  for (const f of fieldsByCategory(sheetName).vendor_config) {
    const opts = vcOptions(f.meta);
    out[f.key] = opts ? opts[0] : "";
  }
  return out;
}

const PRODUCT_DEFAULTED_PACKAGE_FIELDS = new Set([
  "Visibility Bit",
  "Channel",
  "Seo Enabled",
]);

function defaultPackageInput(sheetName) {
  const out = {};
  for (const f of fieldsByCategory(sheetName).package_input) {
    if (sheetName !== "Product" || !PRODUCT_DEFAULTED_PACKAGE_FIELDS.has(f.key)) {
      continue;
    }
    const opts = vcOptions(f.meta);
    out[f.key] = opts ? opts[0] : "";
  }
  return out;
}

function cityNameForRow(row) {
  return makeVendorGetter(row || {})("destination Name");
}

const BAND_HINT = {
  vendor_config: "Set once per vendor — applies to every package.",
  package_input: "Differs per package — fill in for each activity below.",
};

const AI_CONFIDENCE_BY_SHEET = {
  Product: {
    [normalizeHeader("Type")]: "type",
    [normalizeHeader("Sub-Type")]: "subType",
    [normalizeHeader("Short Desc")]: "shortDesc",
    [normalizeHeader("Sub-Category")]: "subCategory",
  },
  Rateplan: {
    [normalizeHeader("Unit Type")]: "unitType",
    [normalizeHeader("Valid Days Of Week")]: "validDays",
    [normalizeHeader("Suitable for")]: "suitableFor",
    [normalizeHeader("Is meal included")]: "isMealIncluded",
    [normalizeHeader("Time of day")]: "timeOfDay",
    [normalizeHeader("Is pickup included")]: "isPickupIncluded",
    [normalizeHeader("Is dropoff included")]: "isDropoffIncluded",
    [normalizeHeader("Private/ Shared")]: "privateOrShared",
  },
  Price: {
    [normalizeHeader("Run On Days")]: "validDays",
  },
};

// ---- small components -------------------------------------------------------
function Band({ title, hint, children }) {
  return (
    <div className="band">
      <div className="band-head">
        <span className="band-title">{title}</span>
        {hint && <span className="band-hint">{hint}</span>}
      </div>
      <div className="band-body">{children}</div>
    </div>
  );
}

function VendorConfigBand({ sheetName, values, onChange }) {
  const fields = fieldsByCategory(sheetName).vendor_config;
  if (!fields.length) return null;
  return (
    <Band title="Vendor defaults" hint={BAND_HINT.vendor_config}>
      <div className="grid">
        {fields.map((f) => {
          const opts = vcOptions(f.meta);
          return (
            <label className="field" key={f.key}>
              <span className="field-label">{f.key}</span>
              {opts ? (
                <select
                  value={values[f.key] ?? ""}
                  onChange={(e) => onChange(f.key, e.target.value)}
                >
                  {opts.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={values[f.key] ?? ""}
                  placeholder={f.meta?.[0] || ""}
                  onChange={(e) => onChange(f.key, e.target.value)}
                />
              )}
            </label>
          );
        })}
      </div>
    </Band>
  );
}

function PackageInputBand({ sheetName, rows, perRow, onChange }) {
  const fields = fieldsByCategory(sheetName).package_input;
  if (!fields.length) return null;
  return (
    <Band title="Per-package" hint={BAND_HINT.package_input}>
      {rows.map((label, rowIdx) => (
        <div className="pkg-card" key={rowIdx}>
          <div className="pkg-name">{label || `Package ${rowIdx + 1}`}</div>
          <div className="grid">
            {fields.map((f) => {
              const opts = vcOptions(f.meta);
              const val = perRow[rowIdx]?.[f.key] ?? "";
              return (
                <label className="field" key={f.key}>
                  <span className="field-label">{f.key}</span>
                  {opts ? (
                    <select
                      value={val}
                      onChange={(e) => onChange(rowIdx, f.key, e.target.value)}
                    >
                      <option value="">—</option>
                      {opts.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value={val}
                      placeholder={f.meta?.[0] || ""}
                      onChange={(e) => onChange(rowIdx, f.key, e.target.value)}
                    />
                  )}
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </Band>
  );
}

function CityLookupBand({ rows, labels, lookups, status, error, onRefresh }) {
  if (!rows.length) return null;
  const unresolved = lookups.filter(
    (lookup) => lookup.status === "missing" || lookup.status === "error"
  );
  return (
    <Band
      title="City Code (Redash)"
      hint="Fetched from a Redash hp_city query by city name; no manual entry required."
    >
      {status === "running" && (
        <div className="banner info">Fetching city codes from Redash...</div>
      )}
      {status === "error" && (
        <div className="banner warn">
          {error || "Some city codes could not be resolved from Redash."}
        </div>
      )}
      {unresolved.length > 0 && status !== "running" && (
        <div className="banner warn">
          {unresolved.length} city lookup{unresolved.length === 1 ? "" : "s"} need
          attention in the Redash hp_city result.
        </div>
      )}
      <div className="grid">
        {rows.map((row, i) => {
          const cityName = cityNameForRow(row);
          const lookup = lookups[i] || {};
          const value =
            lookup.cityCode ||
            (status === "running" ? "Resolving..." : "Not found");
          return (
            <div className="field" key={i}>
              <span className="field-label">
                {cityName || labels[i] || `Row ${i + 1}`}
              </span>
              <span
                className={`readonly-value ${lookup.cityCode ? "" : "warn"}`}
                title={lookup.error || ""}
              >
                {value}
              </span>
            </div>
          );
        })}
      </div>
      <div className="lookup-actions">
        <button
          className="secondary"
          disabled={status === "running"}
          onClick={onRefresh}
        >
          Refresh city codes
        </button>
      </div>
    </Band>
  );
}

function ConfidenceBar({ value }) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return null;
  const pct = Math.max(0, Math.min(100, raw <= 1 ? raw * 100 : raw));
  return (
    <span className="confidence-wrap" title={`AI confidence ${Math.round(pct)}%`}>
      <span className="confidence-track">
        <span className="confidence-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="confidence-label">{Math.round(pct)}%</span>
    </span>
  );
}

function PreviewTable({ aoa, confidenceForCell, onCellChange }) {
  if (!aoa || aoa.length < 3) return null;
  const headers = aoa[0];
  const data = aoa.slice(2);
  return (
    <details className="preview">
      <summary>
        Preview generated rows ({data.length} × {headers.length} cols)
      </summary>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th key={i}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row, r) => (
              <tr key={r}>
                {row.map((c, i) => {
                  const confidence = confidenceForCell?.({
                    header: headers[i],
                    rowIndex: r,
                    colIndex: i,
                  });
                  return (
                    <td key={i} title={String(c ?? "")}>
                      {onCellChange ? (
                        <input
                          className="preview-cell-input"
                          value={String(c ?? "")}
                          onChange={(e) => onCellChange(r, i, e.target.value)}
                        />
                      ) : (
                        <span className="cell-value">{String(c ?? "")}</span>
                      )}
                      {confidence != null && <ConfidenceBar value={confidence} />}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function Section({ title, open, onToggle, gated, gateMsg, children }) {
  return (
    <section className={`section ${gated ? "gated" : ""}`}>
      <header className="section-head" onClick={onToggle}>
        <span className={`chev ${open ? "open" : ""}`}>▶</span>
        <h2>{title}</h2>
        {gated && <span className="lock">🔒 {gateMsg}</span>}
      </header>
      {open && <div className="section-body">{children}</div>}
    </section>
  );
}

// ---- main -------------------------------------------------------------------
export default function App() {
  const [templates, setTemplates] = useState(null);
  const [templateError, setTemplateError] = useState(null);
  const [vendorRows, setVendorRows] = useState([]);
  const [extracted, setExtracted] = useState(null);
  const [flags, setFlags] = useState([]);
  const [fileName, setFileName] = useState("");

  // LLM classification
  const envKeyPresent = Boolean(getEnvApiKey());
  const [apiKey, setApiKey] = useState("");
  const [llmStatus, setLlmStatus] = useState("idle"); // idle|running|done|error|no-key
  const [llmError, setLlmError] = useState("");
  const [aiClassifications, setAiClassifications] = useState([]);

  const [vendorConfig, setVendorConfig] = useState({});
  const [packageInputs, setPackageInputs] = useState({
    Product: [],
    Rateplan: [],
    Price: [],
  });
  const [cellOverrides, setCellOverrides] = useState({
    Product: {},
    Rateplan: {},
    Price: {},
  });
  const [cityLookups, setCityLookups] = useState([]);
  const [cityLookupStatus, setCityLookupStatus] = useState("idle");
  const [cityLookupError, setCityLookupError] = useState("");

  const [productDownloaded, setProductDownloaded] = useState(false);
  const [rateplanDownloaded, setRateplanDownloaded] = useState(false);
  const [productIds, setProductIds] = useState([]);
  const [rateplanIds, setRateplanIds] = useState([]);
  const [mockCmsStatus, setMockCmsStatus] = useState({
    Product: "idle",
    Rateplan: "idle",
  });
  const [mockCmsError, setMockCmsError] = useState({
    Product: "",
    Rateplan: "",
  });

  const [openSections, setOpenSections] = useState({
    Product: true,
    Rateplan: false,
    Price: false,
  });

  useEffect(() => {
    loadAllTemplates()
      .then(setTemplates)
      .catch((e) => setTemplateError(e.message));
  }, []);

  const packageLabels = useMemo(
    () => vendorRows.map((r) => r["Package Name"] || r["package Name"] || ""),
    [vendorRows]
  );

  async function resolveCityCodes(rows) {
    const cityNames = rows.map(cityNameForRow);
    setCityLookupStatus("running");
    setCityLookupError("");
    setCityLookups(
      cityNames.map((cityName) => ({
        cityName,
        cityCode: "",
        status: cityName ? "pending" : "empty",
      }))
    );

    const lookups = await lookupCityCodes(cityNames);
    setCityLookups(lookups);

    const failed = lookups.filter((lookup) => lookup.status === "error");
    if (failed.length) {
      setCityLookupStatus("error");
      setCityLookupError(`${failed.length} city lookup request failed.`);
      return;
    }
    setCityLookupStatus("done");
  }

  async function onUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const rows = await parseVendorFile(file);
    setVendorRows(rows);
    setAiClassifications([]);
    // Instant deterministic output (classification fields use stub defaults)…
    setExtracted(extract(rows));
    setFlags(computeFlags(rows));

    setVendorConfig({
      Product: defaultVendorConfig("Product"),
      Rateplan: defaultVendorConfig("Rateplan"),
      Price: defaultVendorConfig("Price"),
    });
    setPackageInputs({
      Product: rows.map(() => defaultPackageInput("Product")),
      Rateplan: rows.map(() => defaultPackageInput("Rateplan")),
      Price: rows.map(() => defaultPackageInput("Price")),
    });
    setCellOverrides({ Product: {}, Rateplan: {}, Price: {} });
    resolveCityCodes(rows);
    setProductIds(rows.map(() => ""));
    setRateplanIds(rows.map(() => ""));
    setMockCmsStatus({ Product: "idle", Rateplan: "idle" });
    setMockCmsError({ Product: "", Rateplan: "" });
    setProductDownloaded(false);
    setRateplanDownloaded(false);

    // …then enhance with Claude classifications (overlays the stubs).
    runClassification(rows);
  }

  async function runClassification(rows) {
    if (!rows || !rows.length) return;
    setLlmStatus("running");
    setLlmError("");
    const { classifications, error } = await classifyActivities(rows, { apiKey });
    if (error === "no-key") {
      setLlmStatus("no-key");
      return;
    }
    if (error) {
      setLlmStatus("error");
      setLlmError(error);
      return; // keep the deterministic output already on screen
    }
    setExtracted(extract(rows, classifications));
    setAiClassifications(classifications);
    setLlmStatus("done");
  }

  function extractedFor(sheetName) {
    if (!extracted) return [];
    const base = extracted[sheetName.toLowerCase()] || [];
    if (sheetName === "Product") {
      return base.map((row, i) => ({
        ...row,
        "City Code": cityLookups[i]?.cityCode || row["City Code"] || "",
      }));
    }
    return base;
  }

  function confidenceForCell(sheetName, header, rowIndex) {
    const field = AI_CONFIDENCE_BY_SHEET[sheetName]?.[normalizeHeader(header)];
    if (!field) return null;
    const value = aiClassifications[rowIndex]?.confidence?.[field];
    return value == null ? null : value;
  }

  const idsByRow = useMemo(
    () =>
      vendorRows.map((_, i) => ({
        product: productIds[i] || "",
        rateplan: rateplanIds[i] || "",
      })),
    [vendorRows, productIds, rateplanIds]
  );

  function aoaFor(sheetName) {
    if (!templates || !extracted) return null;
    return buildAoa({
      sheetName,
      template: templates[sheetName],
      extractedRows: extractedFor(sheetName),
      vendorConfig: vendorConfig[sheetName] || {},
      packageInputs: packageInputs[sheetName] || [],
      ids: idsByRow,
    });
  }

  function applyCellOverrides(sheetName, aoa) {
    if (!aoa) return aoa;
    const overrides = cellOverrides[sheetName] || {};
    const entries = Object.entries(overrides);
    if (!entries.length) return aoa;
    const next = aoa.map((row) => [...row]);
    entries.forEach(([key, value]) => {
      const [rowIdx, colIdx] = key.split(":").map(Number);
      const targetRow = rowIdx + 2;
      if (next[targetRow] && Number.isInteger(colIdx)) {
        next[targetRow][colIdx] = value;
      }
    });
    return next;
  }

  const productAoa = applyCellOverrides("Product", aoaFor("Product"));
  const rateplanAoa = applyCellOverrides("Rateplan", aoaFor("Rateplan"));
  const priceAoa = applyCellOverrides("Price", aoaFor("Price"));

  function setCellOverride(sheetName, rowIdx, colIdx, value) {
    setCellOverrides((s) => ({
      ...s,
      [sheetName]: {
        ...(s[sheetName] || {}),
        [`${rowIdx}:${colIdx}`]: value,
      },
    }));
  }

  function applyMockIds(kind, idRows, key, setter) {
    setter((current) => {
      const next = [...current];
      idRows.forEach((row) => {
        if (row.rowIndex == null) return;
        next[row.rowIndex] = row[key] || "";
      });
      return next;
    });
    setMockCmsStatus((s) => ({ ...s, [kind]: "done" }));
    setMockCmsError((s) => ({ ...s, [kind]: "" }));
  }

  async function syncProductsToMockCms() {
    setMockCmsStatus((s) => ({ ...s, Product: "running" }));
    setMockCmsError((s) => ({ ...s, Product: "" }));
    try {
      const ids = await createMockProducts(
        extractedFor("Product").map((row, i) => ({
          rowIndex: i,
          productName: row["Product name"] || packageLabels[i] || `Package ${i + 1}`,
        }))
      );
      applyMockIds("Product", ids, "productId", setProductIds);
    } catch (e) {
      setMockCmsStatus((s) => ({ ...s, Product: "error" }));
      setMockCmsError((s) => ({
        ...s,
        Product: e?.message || "Mock Product upload failed",
      }));
    }
  }

  async function syncRateplansToMockCms() {
    setMockCmsStatus((s) => ({ ...s, Rateplan: "running" }));
    setMockCmsError((s) => ({ ...s, Rateplan: "" }));
    try {
      const ids = await createMockRateplans(
        extractedFor("Rateplan").map((row, i) => ({
          rowIndex: i,
          productId: productIds[i] || "",
          rateplanName: row["Rateplan name"] || packageLabels[i] || `Package ${i + 1}`,
        }))
      );
      applyMockIds("Rateplan", ids, "rateplanId", setRateplanIds);
    } catch (e) {
      setMockCmsStatus((s) => ({ ...s, Rateplan: "error" }));
      setMockCmsError((s) => ({
        ...s,
        Rateplan: e?.message || "Mock Rateplan upload failed",
      }));
    }
  }

  async function handleDownload(sheetName, aoa) {
    downloadSheet({ sheetName, template: templates[sheetName], aoa });
    if (sheetName === "Product") {
      setProductDownloaded(true);
      setOpenSections((s) => ({ ...s, Rateplan: true }));
      await syncProductsToMockCms();
    }
    if (sheetName === "Rateplan") {
      setRateplanDownloaded(true);
      setOpenSections((s) => ({ ...s, Price: true }));
      await syncRateplansToMockCms();
    }
  }

  const cityLookupRunning = cityLookupStatus === "running";
  const productMockRunning = mockCmsStatus.Product === "running";
  const rateplanMockRunning = mockCmsStatus.Rateplan === "running";
  const canDownloadProduct =
    Boolean(productAoa) && !cityLookupRunning && !productMockRunning;
  const productIdsComplete =
    vendorRows.length > 0 && productIds.every((id) => id && id.trim());
  const rateplanIdsComplete =
    vendorRows.length > 0 && rateplanIds.every((id) => id && id.trim());
  const canDownloadRateplan =
    productDownloaded && productIdsComplete && !rateplanMockRunning;
  const canDownloadPrice =
    rateplanDownloaded && rateplanIdsComplete && !rateplanMockRunning;

  const rateplanFlags = flags.filter((f) => f.sheet === "Rateplan");

  function setVC(sheet, key, value) {
    setVendorConfig((s) => ({ ...s, [sheet]: { ...s[sheet], [key]: value } }));
  }
  function setPkg(sheet, rowIdx, key, value) {
    setPackageInputs((s) => {
      const arr = [...(s[sheet] || [])];
      arr[rowIdx] = { ...arr[rowIdx], [key]: value };
      return { ...s, [sheet]: arr };
    });
  }

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>Vendor Tariff → CMS Ingestion</h1>
          <p className="sub">
            Product → Rateplan → Price. IDs are the baton — each sheet unlocks
            the next.
          </p>
        </div>
        <div className="badge">POC · in-browser · Claude Sonnet 4.6</div>
      </header>

      {templateError && (
        <div className="banner err">
          Failed to load sample templates: {templateError}
        </div>
      )}

      <div className="upload">
        <label className="upload-btn">
          <input type="file" accept=".xlsx,.xls" onChange={onUpload} hidden />
          Upload vendor tariff (.xlsx)
        </label>
        {fileName && (
          <span className="filemeta">
            {fileName} · {vendorRows.length} activity row(s) parsed
          </span>
        )}
      </div>

      {/* AI classification status + key control */}
      <div className="ai-band">
        <div className="ai-status">
          {llmStatus === "running" && (
            <span className="ai-running">
              🧠 Claude (Sonnet 4.6) is classifying {vendorRows.length} activit
              {vendorRows.length === 1 ? "y" : "ies"}…
            </span>
          )}
          {llmStatus === "done" && (
            <span className="ai-done">
              ✓ AI classification applied — all 13 rule-stub fields (Type,
              Sub-Type, Sub-Category, Short Desc, Unit Type, Suitable-for, meal,
              time-of-day, private/shared, valid-days, run-on-days, pickup &amp;
              dropoff) were inferred from each activity.
            </span>
          )}
          {llmStatus === "no-key" && (
            <span className="ai-warn">
              ⚠ No Anthropic API key — showing deterministic output with stub
              classifications. Set <code>VITE_ANTHROPIC_API_KEY</code> in{" "}
              <code>.env.local</code> or paste a key below, then re-run.
            </span>
          )}
          {llmStatus === "error" && (
            <span className="ai-warn">
              ⚠ AI classification failed ({llmError}). Showing deterministic
              output with stub classifications.
            </span>
          )}
          {llmStatus === "idle" && (
            <span className="ai-idle">
              {envKeyPresent
                ? "Claude Sonnet 4.6 is configured — upload a tariff to classify."
                : "No env key detected — paste an Anthropic key below to enable AI classification (or run deterministic-only)."}
            </span>
          )}
        </div>
        {!envKeyPresent && (
          <div className="ai-key">
            <input
              type="password"
              value={apiKey}
              placeholder="sk-ant-… (kept in memory only)"
              onChange={(e) => setApiKey(e.target.value)}
            />
            {vendorRows.length > 0 && (
              <button
                className="secondary"
                disabled={llmStatus === "running"}
                onClick={() => runClassification(vendorRows)}
              >
                {llmStatus === "running" ? "Classifying…" : "Run AI classification"}
              </button>
            )}
          </div>
        )}
        {envKeyPresent && vendorRows.length > 0 && llmStatus !== "running" && (
          <button className="secondary" onClick={() => runClassification(vendorRows)}>
            Re-run AI classification
          </button>
        )}
      </div>

      {!extracted && (
        <div className="empty">
          Upload a vendor tariff sheet to auto-fill the three CMS sheets. The
          deterministic transforms run for real; the classification fields are
          inferred per-activity by Claude (with a deterministic stub fallback if
          no key is set).
        </div>
      )}

      {extracted && (
        <>
          {/* STAGE 1 — PRODUCT */}
          <Section
            title="1 · Product"
            open={openSections.Product}
            onToggle={() =>
              setOpenSections((s) => ({ ...s, Product: !s.Product }))
            }
          >
            <VendorConfigBand
              sheetName="Product"
              values={vendorConfig.Product || {}}
              onChange={(k, v) => setVC("Product", k, v)}
            />


            <CityLookupBand
              rows={vendorRows}
              labels={packageLabels}
              lookups={cityLookups}
              status={cityLookupStatus}
              error={cityLookupError}
              onRefresh={() => resolveCityCodes(vendorRows)}
            />

            <PackageInputBand
              sheetName="Product"
              rows={packageLabels}
              perRow={packageInputs.Product || []}
              onChange={(r, k, v) => setPkg("Product", r, k, v)}
            />

            <PreviewTable
              aoa={productAoa}
              confidenceForCell={({ header, rowIndex }) =>
                confidenceForCell("Product", header, rowIndex)
              }
              onCellChange={(rowIdx, colIdx, value) =>
                setCellOverride("Product", rowIdx, colIdx, value)
              }
            />

            <div className="actions">
              <button
                className="primary"
                disabled={!canDownloadProduct}
                onClick={() => handleDownload("Product", productAoa)}
              >
                ⬇ Download Product sheet
              </button>
              {cityLookupRunning && (
                <span className="hint-inline">Waiting for city-code lookup.</span>
              )}
              {productMockRunning && (
                <span className="hint-inline">Mock CMS is generating Product IDs.</span>
              )}
              {mockCmsStatus.Product === "done" && (
                <span className="done">Product IDs generated.</span>
              )}
              {mockCmsStatus.Product === "error" && (
                <span className="hint-inline">{mockCmsError.Product}</span>
              )}
              {productDownloaded && (
                <span className="done">
                  Downloaded. Mock CMS auto-fills Product IDs for stage 2.
                </span>
              )}
            </div>
          </Section>

          {/* STAGE 2 — RATEPLAN */}
          <Section
            title="2 · Rateplan"
            open={openSections.Rateplan}
            onToggle={() =>
              setOpenSections((s) => ({ ...s, Rateplan: !s.Rateplan }))
            }
            gated={!productDownloaded}
            gateMsg="Download Product first"
          >
            <div className="banner warn">
              ⚠ Mapping trace incomplete: 50 of 105 columns mapped. The remaining
              columns ship verbatim from the Rateplan sample row until the trace
              is completed.
            </div>
            {rateplanFlags.length > 0 && (
              <div className="banner flag">
                {rateplanFlags.map((f, i) => (
                  <div key={i}>
                    ⚑ {packageLabels[f.rowIndex] || `Row ${f.rowIndex + 1}`} —{" "}
                    {f.field}: {f.message}
                  </div>
                ))}
              </div>
            )}

            <Band
              title="Product IDs (mock CMS)"
              hint="Auto-generated after Product download; edit any value before creating Rateplans."
            >
              <div className="grid">
                {packageLabels.map((label, i) => (
                  <label className="field" key={i}>
                    <span className="field-label">
                      {label || `Package ${i + 1}`}
                    </span>
                    <input
                      value={productIds[i] ?? ""}
                      placeholder="Auto-generated ACME code"
                      onChange={(e) =>
                        setProductIds((arr) => {
                          const next = [...arr];
                          next[i] = e.target.value;
                          return next;
                        })
                      }
                    />
                  </label>
                ))}
              </div>
            </Band>

            <VendorConfigBand
              sheetName="Rateplan"
              values={vendorConfig.Rateplan || {}}
              onChange={(k, v) => setVC("Rateplan", k, v)}
            />
            <PackageInputBand
              sheetName="Rateplan"
              rows={packageLabels}
              perRow={packageInputs.Rateplan || []}
              onChange={(r, k, v) => setPkg("Rateplan", r, k, v)}
            />

            <PreviewTable
              aoa={rateplanAoa}
              confidenceForCell={({ header, rowIndex }) =>
                confidenceForCell("Rateplan", header, rowIndex)
              }
              onCellChange={(rowIdx, colIdx, value) =>
                setCellOverride("Rateplan", rowIdx, colIdx, value)
              }
            />

            <div className="actions">
              <button
                className="primary"
                disabled={!canDownloadRateplan}
                onClick={() => handleDownload("Rateplan", rateplanAoa)}
              >
                ⬇ Download Rateplan sheet
              </button>
              {!productDownloaded && (
                <span className="hint-inline">Download Product first.</span>
              )}
              {productDownloaded && !productIdsComplete && (
                <span className="hint-inline">
                  Waiting for Product IDs. You can also edit them manually.
                </span>
              )}
              {rateplanDownloaded && (
                <span className="done">
                  Downloaded. Mock CMS auto-fills Rateplan IDs for stage 3.
                </span>
              )}
              {rateplanMockRunning && (
                <span className="hint-inline">Mock CMS is generating Rateplan IDs.</span>
              )}
              {mockCmsStatus.Rateplan === "done" && (
                <span className="done">Rateplan IDs generated.</span>
              )}
              {mockCmsStatus.Rateplan === "error" && (
                <span className="hint-inline">{mockCmsError.Rateplan}</span>
              )}
            </div>
          </Section>

          {/* STAGE 3 — PRICE */}
          <Section
            title="3 · Price (Pricing)"
            open={openSections.Price}
            onToggle={() => setOpenSections((s) => ({ ...s, Price: !s.Price }))}
            gated={!rateplanDownloaded}
            gateMsg="Download Rateplan first"
          >
            <div className="banner info">
              ℹ Pricing = COST only, in vendor currency (MYR). No FX, no GST — a
              downstream system applies conversion &amp; tax. These values are
              read straight from the vendor sheet.
            </div>

            <Band
              title="Rateplan IDs (mock CMS)"
              hint="Auto-generated after Rateplan download as RPYYYY_ACMEXXXX; edit before Price download."
            >
              <div className="grid">
                {packageLabels.map((label, i) => (
                  <label className="field" key={i}>
                    <span className="field-label">
                      {label || `Package ${i + 1}`}
                    </span>
                    <input
                      value={rateplanIds[i] ?? ""}
                      placeholder="Auto-generated RPYYYY_ACMEXXXX"
                      onChange={(e) =>
                        setRateplanIds((arr) => {
                          const next = [...arr];
                          next[i] = e.target.value;
                          return next;
                        })
                      }
                    />
                  </label>
                ))}
              </div>
            </Band>

            <VendorConfigBand
              sheetName="Price"
              values={vendorConfig.Price || {}}
              onChange={(k, v) => setVC("Price", k, v)}
            />
            <PackageInputBand
              sheetName="Price"
              rows={packageLabels}
              perRow={packageInputs.Price || []}
              onChange={(r, k, v) => setPkg("Price", r, k, v)}
            />

            <PreviewTable
              aoa={priceAoa}
              confidenceForCell={({ header, rowIndex }) =>
                confidenceForCell("Price", header, rowIndex)
              }
              onCellChange={(rowIdx, colIdx, value) =>
                setCellOverride("Price", rowIdx, colIdx, value)
              }
            />

            <div className="actions">
              <button
                className="primary"
                disabled={!canDownloadPrice}
                onClick={() => handleDownload("Price", priceAoa)}
              >
                ⬇ Download Price sheet
              </button>
              {!rateplanDownloaded && (
                <span className="hint-inline">Download Rateplan first.</span>
              )}
              {rateplanDownloaded && !rateplanIdsComplete && (
                <span className="hint-inline">
                  Waiting for Rateplan IDs. You can also edit them manually.
                </span>
              )}
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

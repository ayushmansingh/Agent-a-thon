import { useEffect, useMemo, useState } from "react";
import "./App.css";
import { extract, computeFlags } from "./lib/extractor.js";
import {
  loadAllTemplates,
  parseVendorFile,
  buildAoa,
  downloadSheet,
} from "./lib/sheets.js";
import { fieldsByCategory } from "./config/fieldConfig.js";
import { lookupCityCode } from "./config/cityMaster.js";

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

const BAND_HINT = {
  vendor_config: "Set once per vendor — applies to every package.",
  package_input: "Differs per package — fill in for each activity below.",
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
              const isBool = String(f.meta?.[0]).toLowerCase() === "bool";
              const val = perRow[rowIdx]?.[f.key] ?? "";
              return (
                <label className="field" key={f.key}>
                  <span className="field-label">{f.key}</span>
                  {isBool ? (
                    <select
                      value={val}
                      onChange={(e) => onChange(rowIdx, f.key, e.target.value)}
                    >
                      <option value="">—</option>
                      <option value="TRUE">TRUE</option>
                      <option value="FALSE">FALSE</option>
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

function PreviewTable({ aoa }) {
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
                {row.map((c, i) => (
                  <td key={i} title={String(c ?? "")}>
                    {String(c ?? "")}
                  </td>
                ))}
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

  const [vendorConfig, setVendorConfig] = useState({});
  const [packageInputs, setPackageInputs] = useState({
    Product: [],
    Rateplan: [],
    Price: [],
  });
  const [cityOverrides, setCityOverrides] = useState([]);

  const [productDownloaded, setProductDownloaded] = useState(false);
  const [rateplanDownloaded, setRateplanDownloaded] = useState(false);
  const [productIds, setProductIds] = useState([]);
  const [rateplanIds, setRateplanIds] = useState([]);

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

  async function onUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const rows = await parseVendorFile(file);
    setVendorRows(rows);
    const ex = extract(rows);
    setExtracted(ex);
    setFlags(computeFlags(rows));

    setVendorConfig({
      Product: defaultVendorConfig("Product"),
      Rateplan: defaultVendorConfig("Rateplan"),
      Price: defaultVendorConfig("Price"),
    });
    setPackageInputs({
      Product: rows.map(() => ({})),
      Rateplan: rows.map(() => ({})),
      Price: rows.map(() => ({})),
    });
    setCityOverrides(rows.map((r) => lookupCityCode(r["destination Name"])));
    setProductIds(rows.map(() => ""));
    setRateplanIds(rows.map(() => ""));
    setProductDownloaded(false);
    setRateplanDownloaded(false);
  }

  function extractedFor(sheetName) {
    if (!extracted) return [];
    const base = extracted[sheetName.toLowerCase()] || [];
    if (sheetName === "Product") {
      return base.map((row, i) => ({
        ...row,
        "City Code": cityOverrides[i] || row["City Code"] || "",
      }));
    }
    return base;
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

  const productAoa = useMemo(
    () => aoaFor("Product"),
    [templates, extracted, vendorConfig, packageInputs, cityOverrides]
  );
  const rateplanAoa = useMemo(
    () => aoaFor("Rateplan"),
    [templates, extracted, vendorConfig, packageInputs, idsByRow]
  );
  const priceAoa = useMemo(
    () => aoaFor("Price"),
    [templates, extracted, vendorConfig, packageInputs, idsByRow]
  );

  function handleDownload(sheetName, aoa) {
    downloadSheet({ sheetName, template: templates[sheetName], aoa });
    if (sheetName === "Product") {
      setProductDownloaded(true);
      setOpenSections((s) => ({ ...s, Rateplan: true }));
    }
    if (sheetName === "Rateplan") {
      setRateplanDownloaded(true);
      setOpenSections((s) => ({ ...s, Price: true }));
    }
  }

  const productIdsComplete =
    vendorRows.length > 0 && productIds.every((id) => id && id.trim());
  const rateplanIdsComplete =
    vendorRows.length > 0 && rateplanIds.every((id) => id && id.trim());
  const canDownloadRateplan = productDownloaded && productIdsComplete;
  const canDownloadPrice = rateplanDownloaded && rateplanIdsComplete;

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
        <div className="badge">POC · in-browser · stub extractor</div>
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

      {!extracted && (
        <div className="empty">
          Upload a vendor tariff sheet to auto-fill the three CMS sheets. The
          deterministic transforms run for real; LLM-classification fields are
          stubbed.
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

            <Band
              title="City Code (lookup)"
              hint="Resolved from city_master. Edit manually if a city is missing."
            >
              <div className="grid">
                {packageLabels.map((label, i) => {
                  const resolved = lookupCityCode(
                    vendorRows[i]?.["destination Name"]
                  );
                  return (
                    <label className="field" key={i}>
                      <span className="field-label">
                        {vendorRows[i]?.["destination Name"] ||
                          label ||
                          `Row ${i + 1}`}
                      </span>
                      <input
                        value={cityOverrides[i] ?? ""}
                        placeholder={resolved ? "" : "not found — enter code"}
                        className={!cityOverrides[i] ? "warn" : ""}
                        onChange={(e) =>
                          setCityOverrides((arr) => {
                            const next = [...arr];
                            next[i] = e.target.value;
                            return next;
                          })
                        }
                      />
                    </label>
                  );
                })}
              </div>
            </Band>

            <PackageInputBand
              sheetName="Product"
              rows={packageLabels}
              perRow={packageInputs.Product || []}
              onChange={(r, k, v) => setPkg("Product", r, k, v)}
            />

            <PreviewTable aoa={productAoa} />

            <div className="actions">
              <button
                className="primary"
                onClick={() => handleDownload("Product", productAoa)}
              >
                ⬇ Download Product sheet
              </button>
              {productDownloaded && (
                <span className="done">
                  ✓ Downloaded. Upload to CMS, then paste Product IDs in stage 2.
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
              title="Product ID handoff"
              hint="Paste the Product ID(s) the CMS returned. Injected into Rateplan rows."
            >
              <div className="grid">
                {packageLabels.map((label, i) => (
                  <label className="field" key={i}>
                    <span className="field-label">
                      {label || `Package ${i + 1}`}
                    </span>
                    <input
                      value={productIds[i] ?? ""}
                      placeholder="Product ID from CMS"
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

            <PreviewTable aoa={rateplanAoa} />

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
                  Enter a Product ID for every package to unlock.
                </span>
              )}
              {rateplanDownloaded && (
                <span className="done">
                  ✓ Downloaded. Paste Rateplan IDs in stage 3.
                </span>
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
              title="Rateplan ID handoff"
              hint="Paste the Rateplan ID(s) the CMS returned. Injected into Price rows."
            >
              <div className="grid">
                {packageLabels.map((label, i) => (
                  <label className="field" key={i}>
                    <span className="field-label">
                      {label || `Package ${i + 1}`}
                    </span>
                    <input
                      value={rateplanIds[i] ?? ""}
                      placeholder="Rateplan ID from CMS"
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

            <PreviewTable aoa={priceAoa} />

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
                  Enter a Rateplan ID for every package to unlock.
                </span>
              )}
            </div>
          </Section>
        </>
      )}
    </div>
  );
}

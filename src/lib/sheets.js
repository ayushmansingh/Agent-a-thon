// SheetJS layer: load the sample templates (headers + format/legend row +
// example row) and generate output workbooks that match them exactly.
//
//   Row 1 = headers (verbatim from sample, incl. the "[Use ~ as Sep.]" hints)
//   Row 2 = format/legend row (verbatim — the CMS expects it; NOT data)
//   Row 3+ = generated data, one row per vendor activity row

import * as XLSX from "xlsx";
import { buildConfigIndex, normalizeHeader, defaultValue } from "../config/fieldConfig.js";

// Output sheet/tab names. NOTE: Price tab must be named "Pricing".
export const SHEET_META = {
  Product: { file: "/Product_Sample_Sheet.xlsx", tab: "Product" },
  Rateplan: { file: "/Rateplan_Sample_Sheet.xlsx", tab: "Rateplan" },
  Price: { file: "/Price_Sample_Sheet.xlsx", tab: "Pricing" },
};

// Fetch a sample workbook and pull headers (row1), format row (row2),
// and example row (row3) from its first sheet.
export async function loadTemplate(sheetName) {
  const meta = SHEET_META[sheetName];
  const res = await fetch(meta.file);
  if (!res.ok) throw new Error(`Could not load sample for ${sheetName}`);
  const buf = await res.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
  return {
    headers: aoa[0] || [],
    formatRow: aoa[1] || [],
    exampleRow: aoa[2] || [],
    tab: meta.tab,
  };
}

export async function loadAllTemplates() {
  const entries = await Promise.all(
    Object.keys(SHEET_META).map(async (name) => [name, await loadTemplate(name)])
  );
  return Object.fromEntries(entries);
}

// Build the cell value for one column of one row.
function cellValue({
  header,
  configIndex,
  sheetName,
  extracted,
  vendorConfig,
  packageInput,
  ids,
  exampleRow,
  colIdx,
}) {
  const norm = normalizeHeader(header);
  const entry = configIndex[norm];

  // Untraced column (Rateplan) -> ship verbatim from the sample example row.
  if (!entry) return exampleRow[colIdx] ?? "";

  const { key, category } = entry;
  switch (category) {
    case "system_id": {
      // meta tells stage; we always inject whatever id is available.
      if (key === "Rateplan ID") return ids?.rateplan ?? "";
      // both "Product ID" columns + stageB
      return ids?.product ?? "";
    }
    case "vendor_config":
      return vendorConfig?.[key] ?? "";
    case "package_input":
      return packageInput?.[key] ?? "";
    case "default":
      return defaultValue(sheetName, key);
    case "blank":
      return "";
    case "lookup":
    case "derived_vendor":
    case "derived_vendor_optional":
    case "derived_rule_stub":
      return extracted?.[key] ?? "";
    default:
      return extracted?.[key] ?? "";
  }
}

// Generate an array-of-arrays for a sheet: [headers, formatRow, ...dataRows].
export function buildAoa({
  sheetName,
  template,
  extractedRows,
  vendorConfig,
  packageInputs,
  ids,
}) {
  const configIndex = buildConfigIndex(sheetName);
  const { headers, formatRow, exampleRow } = template;
  const dataRows = extractedRows.map((extracted, rowIdx) =>
    headers.map((header, colIdx) =>
      cellValue({
        header,
        configIndex,
        sheetName,
        extracted,
        vendorConfig,
        packageInput: packageInputs?.[rowIdx] || {},
        ids: ids?.[rowIdx] || ids || {},
        exampleRow,
        colIdx,
      })
    )
  );
  return [headers, formatRow, ...dataRows];
}

// Build + trigger a download of the sheet.
export function downloadSheet({ sheetName, template, aoa }) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, template.tab);
  XLSX.writeFile(wb, `${sheetName}_Upload.xlsx`);
}

// Parse an uploaded vendor tariff .xlsx -> array of row objects keyed by header.
export async function parseVendorFile(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "", raw: true });
  return rows;
}

// A read-only preview (headers + first generated row) for the UI.
export function previewRows(aoa, max = 5) {
  return {
    headers: aoa[0] || [],
    formatRow: aoa[1] || [],
    data: aoa.slice(2, 2 + max),
  };
}

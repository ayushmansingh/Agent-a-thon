// Redash API-backed city lookup.
//
// Configure:
//   VITE_REDASH_CITY_LOOKUP_URL=https://common-redash.mmt.live/queries/162593/source?p_city_name=Dubai
//   REDASH_KEY=<holiday redash api key>
//
// Runtime flow per city:
//   POST /api/queries/162593/refresh?p_city_name=<city>
//   GET  /api/jobs/<job_id>
//   GET  /api/query_results/<query_result_id>.json

const DEFAULT_CITY_LOOKUP_URL =
  "https://common-redash.mmt.live/queries/162593/source?p_city_name={{city_name}}";
const POLL_INTERVAL_MS = 700;
const MAX_POLLS = 20;

const resultCache = new Map();

function cityLookupUrl() {
  return (
    (import.meta.env && import.meta.env.VITE_REDASH_CITY_LOOKUP_URL) ||
    DEFAULT_CITY_LOOKUP_URL
  ).trim();
}

function redashKey() {
  return (
    (import.meta.env &&
      (import.meta.env.REDASH_KEY ||
        import.meta.env.VITE_REDASH_KEY ||
        import.meta.env.VITE_REDASH_HOLIDAY_KEY)) ||
    ""
  ).trim();
}

function redashHeaders() {
  const key = redashKey();
  if (!key) {
    throw new Error("Set REDASH_KEY in .env.local");
  }
  return {
    Accept: "application/json",
    Authorization: `Key ${key}`,
    "Content-Type": "application/json",
  };
}

function sourceQueryId(url) {
  return (
    url.pathname.match(/^\/queries\/(\d+)\/source\/?$/)?.[1] ||
    url.pathname.match(/^\/api\/queries\/(\d+)\/.*$/)?.[1] ||
    ""
  );
}

function shouldUseDevProxy() {
  return Boolean(import.meta.env?.DEV);
}

function citySource() {
  const origin = globalThis.location?.origin || "http://localhost";
  const url = new URL(cityLookupUrl(), origin);
  const queryId = sourceQueryId(url);
  if (!queryId) {
    throw new Error("Redash city lookup URL must include /queries/<id>/source");
  }
  return {
    origin: shouldUseDevProxy() ? origin : url.origin,
    pathPrefix: shouldUseDevProxy() ? "/redash-api" : "",
    queryId,
  };
}

function refreshUrl(cityName) {
  const { origin, pathPrefix, queryId } = citySource();
  const url = new URL(`${pathPrefix}/api/queries/${queryId}/refresh`, origin);
  url.searchParams.set("p_city_name", cityName);
  return url.toString();
}

function jobUrl(origin, pathPrefix, jobId) {
  return new URL(
    `${pathPrefix}/api/jobs/${encodeURIComponent(jobId)}`,
    origin
  ).toString();
}

function resultUrl(origin, pathPrefix, resultId) {
  return new URL(
    `${pathPrefix}/api/query_results/${encodeURIComponent(resultId)}.json`,
    origin
  ).toString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJson(res) {
  const body = await res.text();
  if (/^\s*<!doctype html/i.test(body) || /^\s*<html/i.test(body)) {
    throw new Error("Redash returned an HTML page instead of JSON");
  }
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Redash returned non-JSON data");
  }
}

async function requestJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { ...redashHeaders(), ...(opts.headers || {}) },
  });
  const json = await readJson(res);
  if (!res.ok) {
    const message =
      json?.message || json?.error || json?.job?.error || res.statusText;
    throw new Error(`Redash API failed (${res.status}: ${message})`);
  }
  return json;
}

function rowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.query_result?.data?.rows)) {
    return payload.query_result.data.rows;
  }
  if (Array.isArray(payload?.data?.rows)) return payload.data.rows;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function valueFromKeys(row, keys) {
  if (!row || typeof row !== "object") return "";
  for (const key of keys) {
    if (row[key] != null && String(row[key]).trim() !== "") return row[key];
  }
  return "";
}

function cityCodeFromRow(row) {
  if (typeof row === "string" || typeof row === "number") return row;
  return valueFromKeys(row, [
    "city_code",
    "cityCode",
    "City Code",
    "CITY_CODE",
    "id",
    "Id",
    "ID",
    "code",
    "Code",
  ]);
}

function cityCodeFromPayload(payload) {
  const row = rowsFromPayload(payload)[0];
  const cityCode = cityCodeFromRow(row);
  return cityCode == null ? "" : String(cityCode).trim();
}

async function runCityQuery(cityName) {
  const { origin, pathPrefix } = citySource();
  const refresh = await requestJson(refreshUrl(cityName), { method: "POST" });

  if (refresh.query_result) return cityCodeFromPayload(refresh);

  const jobId = refresh.job?.id;
  if (!jobId) {
    throw new Error(refresh.job?.error || "Redash did not return a job id");
  }

  for (let i = 0; i < MAX_POLLS; i += 1) {
    const jobPayload = await requestJson(jobUrl(origin, pathPrefix, jobId));
    const job = jobPayload.job || {};

    if (job.status === 3 && job.query_result_id) {
      const result = await requestJson(
        resultUrl(origin, pathPrefix, job.query_result_id)
      );
      return cityCodeFromPayload(result);
    }

    if (job.status === 4) {
      throw new Error(job.error || "Redash query failed");
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error("Timed out waiting for Redash city lookup");
}

export async function lookupCityCode(cityName) {
  const name = String(cityName ?? "").trim();
  if (!name) {
    return { cityName: name, cityCode: "", status: "empty" };
  }

  if (resultCache.has(name)) return resultCache.get(name);

  try {
    const cityCode = await runCityQuery(name);
    const result = {
      cityName: name,
      cityCode,
      status: cityCode ? "found" : "missing",
    };
    resultCache.set(name, result);
    return result;
  } catch (e) {
    return {
      cityName: name,
      cityCode: "",
      status: "error",
      error: e?.message || "Redash city lookup failed",
    };
  }
}

export async function lookupCityCodes(cityNames) {
  const names = Array.isArray(cityNames) ? cityNames : [];
  return Promise.all(names.map((cityName) => lookupCityCode(cityName)));
}

export default lookupCityCode;

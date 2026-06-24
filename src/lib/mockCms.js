async function postJson(path, payload) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Mock CMS failed (${res.status})`);
  return body;
}

export async function createMockProducts(products) {
  const body = await postJson("/mock-cms/products", { products });
  return Array.isArray(body.productIds) ? body.productIds : [];
}

export async function createMockRateplans(rateplans) {
  const body = await postJson("/mock-cms/rateplans", { rateplans });
  return Array.isArray(body.rateplanIds) ? body.rateplanIds : [];
}

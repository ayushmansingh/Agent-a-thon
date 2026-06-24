import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ""
    req.on("data", (chunk) => {
      body += chunk
    })
    req.on("end", () => {
      if (!body.trim()) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch (e) {
        reject(e)
      }
    })
    req.on("error", reject)
  })
}

function writeJson(res, status, payload) {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(payload))
}

function sequenceId(prefix, number, width) {
  return `${prefix}${String(number).padStart(width, "0")}`
}

function mockCmsPlugin() {
  return {
    name: "mock-cms-api",
    configureServer(server) {
      server.middlewares.use("/mock-cms/products", async (req, res) => {
        if (req.method !== "POST") {
          writeJson(res, 405, { error: "Method not allowed" })
          return
        }
        try {
          const body = await readJsonBody(req)
          const products = Array.isArray(body.products) ? body.products : []
          writeJson(res, 200, {
            productIds: products.map((product, i) => ({
              rowIndex: product.rowIndex ?? i,
              productId: sequenceId("ACME", i + 1, 6),
            })),
          })
        } catch (e) {
          writeJson(res, 400, { error: e?.message || "Invalid request" })
        }
      })

      server.middlewares.use("/mock-cms/rateplans", async (req, res) => {
        if (req.method !== "POST") {
          writeJson(res, 405, { error: "Method not allowed" })
          return
        }
        try {
          const body = await readJsonBody(req)
          const rateplans = Array.isArray(body.rateplans) ? body.rateplans : []
          writeJson(res, 200, {
            rateplanIds: rateplans.map((rateplan, i) => {
              const productId = String(rateplan.productId || "").trim()
              return {
                rowIndex: rateplan.rowIndex ?? i,
                rateplanId: `${sequenceId("RP", i + 1, 4)}_${productId}`,
              }
            }),
          })
        } catch (e) {
          writeJson(res, 400, { error: e?.message || "Invalid request" })
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  envPrefix: ["VITE_", "REDASH_"],
  plugins: [react(), mockCmsPlugin()],
  server: {
    proxy: {
      "/redash-api": {
        target: "https://common-redash.mmt.live",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/redash-api/, ""),
      },
    },
  },
})

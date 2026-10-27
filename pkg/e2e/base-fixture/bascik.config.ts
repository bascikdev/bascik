export default {
  base: "/sub/",
  // Per-lane output directory; see ../bascik.config.ts.
  directory: { out: process.env.BASCIK_E2E_OUT ?? "dist" },
  pipeline: { workers: false },
  minify: { identifiers: false },
};

export const server = {
  http: {
    port: Number(process.env.BASCIK_SERVER_PORT) || 9552,
    tls: { enabled: process.env.BASCIK_ENABLE_TLS === "true" },
  },
};

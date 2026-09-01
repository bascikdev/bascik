export default {
  base: '/sub/',
  pipeline: { workers: false },
  minify: { identifiers: false },
};

export const server = {
  http: {
    port: Number(process.env.BASCIK_SERVER_PORT) || 9552,
    tls: { enabled: process.env.BASCIK_ENABLE_TLS === 'true' },
  },
};
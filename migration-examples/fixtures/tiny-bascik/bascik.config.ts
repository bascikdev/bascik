import { defineConfig } from '@bascik/bascik';
export default defineConfig({
  http: { port: Number(process.env.PORT), hostname: '127.0.0.1' },
  minify: { identifiers: true },
});
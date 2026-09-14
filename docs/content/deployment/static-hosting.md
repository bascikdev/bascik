# Static Hosting

Deploying a static Bascik site is fast, simple, and free on almost every modern hosting platform. Because `bascik --build` compiles your components and styles into standard vanilla HTML, CSS, and client JavaScript in `dist/`, you can host your site anywhere without running a Node server in production.

## The 3-Step Workflow

Every static deployment boils down to three simple steps:

1. **Build:** Run `npx bascik --build` to compile your project into `dist/`.
2. **Preview (optional):** Inspect the production output locally with `npx http-server dist` or `npx bascik --server`.
3. **Deploy:** Point your hosting provider to the `dist/` folder.

That is all there is to it. There are no runtime servers to manage, no container images to maintain, and no backend hosting bills.

## Deploy to Cloudflare Pages (Recommended)

Cloudflare Pages offers unlimited bandwidth, instant global caching across 300+ cities, free automatic SSL certificates, and zero-configuration builds directly from Git.

### Option A: Automatic Git Deployments

This is the easiest way to deploy. Once connected, every `git push` automatically builds and updates your live site.

1. Push your Bascik project to a repository on **GitHub** or **GitLab**.
2. Log in to the [Cloudflare Dashboard](https://dash.cloudflare.com/) and navigate to **Workers & Pages** > **Create application** > **Pages** > **Connect to Git**.
3. Select your repository and configure the build settings:
   - **Framework preset:** `None`
   - **Build command:** `npx bascik --build`
   - **Build output directory:** `dist`
4. If your site generates a sitemap or robots.txt, add an environment variable:
   - **Variable name:** `BASCIK_SITE_URL`
   - **Value:** `https://your-domain.com` (or your staging/preview URL)
5. Click **Save and Deploy**. Cloudflare builds your project and assigns a live `*.pages.dev` URL immediately.

### Option B: Direct Upload via Wrangler CLI

If you prefer deploying directly from your terminal or CI without connecting a Git provider, use the Wrangler CLI:

```sh
# 1. Build your static site
npx bascik --build

# 2. Deploy dist/ directly to Cloudflare Pages
npx wrangler pages deploy dist --project-name my-bascik-site
```

> **Dynamic Cloudflare Features:** If your site uses request-time server scripts (`data-bascik-server`), progressive HTML streams (`data-bascik-stream`), or edge API routes (`src/api/`), use the official [Cloudflare Adapter](/deployment/cloudflare) instead of pure static hosting.

## Deploy to GitHub Pages

GitHub Pages is a great free hosting choice for documentation, open-source project showcases, and personal websites.

### Deploying with GitHub Actions

1. In your GitHub repository, click **Settings** > **Pages**.
2. Under **Build and deployment** > **Source**, select **GitHub Actions**.
3. Create a workflow file at `.github/workflows/deploy.yml` in your repository:

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout repository
        uses: actions/checkout@v5

      - name: Setup Node.js
        uses: actions/setup-node@v5
        with:
          node-version: '24'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build site
        run: npx bascik --build
        env:
          BASCIK_SITE_URL: https://${{ github.repository_owner }}.github.io/${{ github.event.repository.name }}

      - name: Upload Pages artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: dist/

  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    needs: build
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

4. Push your changes to `main`. GitHub Actions builds your site and publishes it to `https://<username>.github.io/<repository>/`.

### Configuring Subdirectories for GitHub Pages

If your repository is published to a project subpath (e.g. `https://username.github.io/my-site/` rather than a custom root domain), tell Bascik your base path in `bascik.config.ts`:

```ts
// bascik.config.ts
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  base: '/my-site/',
});
```

Bascik automatically prefixes all root-relative asset URLs, stylesheets, scripts, and links during the build so everything resolves correctly under the subdirectory.

## Deploy to Netlify

Netlify provides automated continuous deployment, instant preview URLs for pull requests, and custom domains with free SSL.

### Option A: Netlify Dashboard

1. Log in to [Netlify](https://app.netlify.com/) and click **Add new site** > **Import an existing project**.
2. Connect your Git provider and select your repository.
3. Configure the build settings:
   - **Build command:** `npx bascik --build`
   - **Publish directory:** `dist`
4. Under **Environment variables**, set `BASCIK_SITE_URL` to your production URL.
5. Click **Deploy site**.

### Option B: Configuration File (`netlify.toml`)

You can also check in a `netlify.toml` file at your repository root to configure builds automatically:

```toml
[build]
  command = "npx bascik --build"
  publish = "dist"

[build.environment]
  NODE_VERSION = "24"
```

### Option C: Netlify CLI

Deploy manually from your terminal using the Netlify CLI:

```sh
# Build your site
npx bascik --build

# Deploy dist to production
npx netlify deploy --prod --dir=dist
```

## Deploy to Vercel

Vercel provides zero-configuration Git deployments and edge network hosting.

### Option A: Vercel Dashboard

1. Import your repository in the [Vercel Dashboard](https://vercel.com/new).
2. In the project configuration screen:
   - **Framework Preset:** Select **Other**
   - **Build Command:** `npx bascik --build`
   - **Output Directory:** `dist`
3. Add `BASCIK_SITE_URL` under **Environment Variables**.
4. Click **Deploy**.

### Option B: Vercel CLI

Deploy directly from your command line:

```sh
# Build the static site
npx bascik --build

# Deploy dist
npx vercel --prod
```

## Deploy to AWS S3 & CloudFront

For custom AWS architectures, host the compiled `dist/` directory in an Amazon S3 bucket configured for static website hosting and fronted by Amazon CloudFront:

```sh
# 1. Build your site
npx bascik --build

# 2. Sync dist to your S3 bucket
aws s3 sync dist s3://my-static-site-bucket --delete

# 3. Invalidate CloudFront cache (optional)
aws cloudfront create-invalidation --distribution-id YOUR_DIST_ID --paths "/*"
```

## Deploy to Traditional Web Servers (NGINX, Caddy, Apache)

If you have your own VPS, dedicated server, or VM, you can copy the contents of `dist/` directly into your web root directory (e.g. `/var/www/html/`).

### NGINX Configuration Example

```nginx
server {
    listen 80;
    server_name example.com www.example.com;
    root /var/www/html/dist;
    index index.html;

    # Serve static files directly, fall back to directory index or 404
    location / {
        try_files $uri $uri/ $uri.html =404;
    }

    # Custom 404 error page
    error_page 404 /404.html;
    location = /404.html {
        internal;
    }
}
```

### Caddy Configuration Example

```caddy
example.com {
    root * /var/www/html/dist
    file_server
    try_files {path} {path}/ {path}.html =404
    handle_errors {
        rewrite * /404.html
        file_server
    }
}
```

## Helpful Tips for Static Deployments

### Custom 404 Page

Create a page at `src/pages/404.html`. During the build, Bascik compiles it to `dist/404.html`. Major static hosts (Cloudflare Pages, GitHub Pages, Netlify, and Vercel) automatically serve `404.html` whenever a requested URL does not match any static file.

### Local Static Preview

Before pushing changes to production, test your exact static build locally. You can use Bascik's built-in server or any standard static file server:

```sh
# Build your site
npx bascik --build

# Preview with Bascik's production server
npx bascik --server

# Or preview with http-server
npx http-server dist
```

### Sitemap and Robots.txt

When `generate.sitemap: true` or `generate.robots: true` is configured in `bascik.config.ts`, Bascik requires a valid site URL so search engines receive absolute URLs. Pass `BASCIK_SITE_URL` during the build:

```sh
BASCIK_SITE_URL=https://example.com npx bascik --build
```

### Asset Fingerprinting and Long-Term Caching

For immutable, long-term CDN caching of static assets (like fonts, logos, and images), see [Asset Fingerprinting](/how-to/asset-fingerprinting).

## When to Use More Than Static Hosting

Static hosting covers all sites with pre-rendered HTML, client-side interactions, and build-time scripts. If your application grows to need request-time backend features:

- **Serverless Edge Functions:** To execute server scripts (`data-bascik-server`), live streaming (`data-bascik-stream`), or API routes (`src/api/`) on Cloudflare's global edge network without managing servers, see the [Cloudflare Adapter](/deployment/cloudflare).
- **Self-Hosted Node.js Server:** To run your own Node origin server with HTTP/2 and server-side scripts, see the [Production Server](/production-server) guide.

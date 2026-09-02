/**
 * nav.ts — Single source of truth for docs navigation order.
 *
 * Imported by render-nav.ts at build time. To add, remove, or reorder
 * pages, edit this file only — sidebar, pagination, and the top nav all
 * derive from it automatically.
 */

export interface NavPage {
  href: string;
  label: string;
}

export interface NavSection {
  section: string;
  pages: NavPage[];
}

export const NAV: NavSection[] = [
  {
    section: 'Overview', pages: [
      { href: '/why-bascik', label: 'Why Bascik' },
      { href: '/developer-experience', label: 'Developer Experience' },
      { href: '/vs-frameworks', label: 'Bascik vs Frameworks' },
      { href: '/performance', label: 'Lighthouse 100s' },
      { href: '/getting-started', label: 'Getting Started' },
    ]
  },
  {
    section: 'Features', pages: [
      { href: '/components', label: 'Components' },
      { href: '/scoped-styles', label: 'Scoped Styles' },
      { href: '/scoped-javascript', label: 'Scoped JavaScript' },
      { href: '/preserve', label: 'Preserve Scoping' },
      { href: '/slots', label: 'Slots' },
      { href: '/props', label: 'Props' },
      { href: '/attribute-inheritance', label: 'Attribute Inheritance' },
      { href: '/build-scripts', label: 'Build Scripts' },
      { href: '/dynamic-routes', label: 'Dynamic Routes' },
      { href: '/api-routes', label: 'API Routes' },
      { href: '/server', label: 'Production Server' },
      { href: '/sitemap', label: 'Sitemap & robots.txt' },
      { href: '/libraries', label: 'JavaScript Libraries' },
    ]
  },
  {
    section: 'Reference', pages: [
      { href: '/faq', label: 'FAQ' },
      { href: '/cli', label: 'CLI / Command Line' },
      { href: '/configuration', label: 'Configuration' },
      { href: '/environment-variables', label: 'Environment Variables' },
      { href: '/compatibility', label: 'Scoping Compatibility' },
      { href: '/deploying', label: 'Deploying' },
    ]
  },
  {
    section: 'Testing & Debugging', pages: [
      { href: '/testing', label: 'Overview' },
      { href: '/testing/unit-testing', label: 'Unit Testing' },
      { href: '/testing/component-testing', label: 'Component Testing' },
      { href: '/testing/build-scripts', label: 'Build Scripts' },
      { href: '/testing/server-scripts', label: 'Server Scripts' },
      { href: '/testing/exec-scripts', label: 'Exec Scripts' },
      { href: '/testing/e2e-testing', label: 'End-to-End Testing' },
      { href: '/testing/debugging', label: 'Debugging' },
      { href: '/testing/source-maps', label: 'Source Maps' },
      { href: '/testing/linting', label: 'Linting' },
    ]
  },
  {
    section: 'Tooling', pages: [
      { href: '/tools/vscode-extension', label: 'VS Code Extension' },
      { href: '/tools/agent-skill', label: 'Agent Skill' },
    ]
  },
  {
    section: 'Recipes', pages: [
      { href: '/recipes/markdown', label: 'Markdown' },
      { href: '/recipes/page-aware-scripts', label: 'Page-Aware Scripts' },
      { href: '/recipes/server-scripts', label: 'Server Scripts' },
      { href: '/recipes/templating', label: 'Templating' },
    ]
  },
  {
    section: 'Internals', pages: [
      { href: '/internals', label: 'Internals Overview' },
      { href: '/internals/architecture', label: 'Architecture' },
      { href: '/internals/transpilation-pipeline', label: 'Transpilation Pipeline' },
      { href: '/internals/scoping-system', label: 'Scoping System' },
      { href: '/internals/server', label: 'Server Architecture' },
      { href: '/internals/diagnostics', label: 'Diagnostics' },
      { href: '/internals/minification', label: 'Minification' },
      { href: '/internals/testing', label: 'Testing Internals' },
      { href: '/internals/create-app', label: 'Create App' },
      { href: '/internals/ci-cd', label: 'CI / CD' },
    ]
  },
  {
    section: 'Switch to Bascik', pages: [
      { href: '/switch', label: 'Overview' },
      { href: '/switch/from-astro', label: 'From Astro' },
      { href: '/switch/from-eleventy', label: 'From Eleventy' },
      { href: '/switch/from-hugo', label: 'From Hugo' },
      { href: '/switch/from-next', label: 'From Next.js' },
      { href: '/switch/from-react', label: 'From React' },
      { href: '/switch/from-svelte', label: 'From Svelte' },
      { href: '/switch/from-vue', label: 'From Vue' },
    ]
  },
];

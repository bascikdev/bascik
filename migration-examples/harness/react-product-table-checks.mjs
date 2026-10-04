import assert from 'node:assert/strict';

// Task 09 behavior checks for the "Thinking in React" product table (SRC-REACT-THINKING
// @8c68ae8) and its Bascik port. The same checks run against both sites. They read what a person
// sees (rows, text, computed styles, focus) and never a class name or an id, because the
// production build hashes both.

export const ALL_ROWS = [
  'Fruits', 'Apple $1', 'Dragonfruit $1', 'Passionfruit $2',
  'Vegetables', 'Spinach $2', 'Pumpkin $4', 'Peas $1',
];

/** Rows a person can see in the table body, one normalized string per row. */
export async function visibleRows(page) {
  return page.locator('tbody tr:visible').evaluateAll((rows) =>
    rows.map((row) => row.innerText.replace(/\s+/g, ' ').trim()));
}

/** Opens a page with listeners that record every console error, page error, and failed request. */
export async function openPage(browser, site, path, { viewport = { width: 1280, height: 900 }, javaScriptEnabled = true } = {}) {
  const context = await browser.newContext({ viewport, javaScriptEnabled });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') problems.push(`console: ${message.text()}`); });
  page.on('requestfailed', (request) => problems.push(`requestfailed: ${request.url()}`));
  page.on('response', (response) => {
    if (response.status() >= 400 && response.url().startsWith(site.url)) problems.push(`${response.status()}: ${response.url()}`);
  });
  const response = await page.goto(`${site.url}${path}`, { waitUntil: 'load' });
  return { context, page, response, problems };
}

/**
 * A development server may answer 200 with a holding page until its first build ends. Waits
 * until the real table is on screen so a check never runs against the holding page.
 */
export async function waitForTable(page, label, timeoutMs = 60000) {
  try {
    await page.locator('tbody tr:visible').first().waitFor({ timeout: timeoutMs });
  } catch {
    throw new Error(`${label}: the product table never appeared`);
  }
}

async function withPage(browser, site, label, path, body, options) {
  const opened = await openPage(browser, site, path, options);
  try {
    await waitForTable(opened.page, `${label} ${path}`);
    await body(opened);
    assert.deepEqual(opened.problems, [], `${label} ${path}: console errors or failed requests`);
  } finally { await opened.context.close(); }
}

/** Step 2 and the initial render: markup, grouping, order, and the red out-of-stock names. */
export async function checkStaticTable(browser, site, label) {
  await withPage(browser, site, label, '/', async ({ page, response }) => {
    assert.equal(response.status(), 200, `${label}: / status`);
    assert.deepEqual(await visibleRows(page), ALL_ROWS, `${label}: initial rows`);
    assert.deepEqual(await page.locator('thead th').allInnerTexts(), ['Name', 'Price'], `${label}: header cells`);
    assert.equal(await page.locator('table').count(), 1, `${label}: one table`);
    // The category cell spans both columns, as in the tutorial.
    assert.deepEqual(await page.locator('tbody th').evaluateAll((cells) => cells.map((cell) => cell.colSpan)), [2, 2], `${label}: category colspan`);
    const colors = {};
    for (const name of ['Apple', 'Dragonfruit', 'Passionfruit', 'Spinach', 'Pumpkin', 'Peas']) {
      colors[name] = await page.getByRole('cell', { name, exact: true })
        .evaluate((cell) => getComputedStyle(cell.firstElementChild ?? cell).color);
    }
    for (const name of ['Passionfruit', 'Pumpkin']) assert.equal(colors[name], 'rgb(255, 0, 0)', `${label}: ${name} is red`);
    for (const name of ['Apple', 'Dragonfruit', 'Spinach', 'Peas']) assert.notEqual(colors[name], 'rgb(255, 0, 0)', `${label}: ${name} is not red`);
    assert.equal(await page.getByRole('textbox').count(), 1, `${label}: one text box`);
    assert.equal(await page.getByRole('checkbox').count(), 1, `${label}: one checkbox`);
  });
}

/** The sandbox stylesheet, read back as computed styles. */
export async function checkStyles(browser, site, label) {
  await withPage(browser, site, label, '/', async ({ page }) => {
    const styles = await page.evaluate(() => {
      const cs = (selector) => getComputedStyle(document.querySelector(selector));
      const label = document.querySelector('label');
      return {
        body: cs('body').padding,
        headerCell: cs('thead th').padding,
        categoryCell: cs('tbody th').padding,
        dataCell: cs('tbody td').padding,
        labelDisplay: getComputedStyle(label).display,
        labelMargin: getComputedStyle(label).marginTop + '/' + getComputedStyle(label).marginBottom,
      };
    });
    assert.deepEqual(styles, {
      body: '5px', headerCell: '4px', categoryCell: '4px', dataCell: '2px', labelDisplay: 'block', labelMargin: '5px/5px',
    }, `${label}: computed styles`);
  });
}

/** Steps 3 to 5: text filter, case folding, the stock checkbox, and their combination. */
export async function checkFiltering(browser, site, label) {
  await withPage(browser, site, label, '/', async ({ page }) => {
    const search = page.getByPlaceholder('Search...');
    const stock = page.getByLabel('Only show products in stock');

    await search.fill('fruit');
    assert.deepEqual(await visibleRows(page), ['Fruits', 'Dragonfruit $1', 'Passionfruit $2'], `${label}: "fruit"`);
    await search.fill('FRUIT');
    assert.deepEqual(await visibleRows(page), ['Fruits', 'Dragonfruit $1', 'Passionfruit $2'], `${label}: "FRUIT" folds case`);
    // A match in the middle of a name, in both categories.
    await search.fill('p');
    assert.deepEqual(await visibleRows(page),
      ['Fruits', 'Apple $1', 'Passionfruit $2', 'Vegetables', 'Spinach $2', 'Pumpkin $4', 'Peas $1'], `${label}: "p"`);
    await stock.check();
    assert.deepEqual(await visibleRows(page), ['Fruits', 'Apple $1', 'Vegetables', 'Spinach $2', 'Peas $1'], `${label}: "p" in stock`);
    await search.fill('');
    assert.deepEqual(await visibleRows(page), ['Fruits', 'Apple $1', 'Dragonfruit $1', 'Vegetables', 'Spinach $2', 'Peas $1'], `${label}: in stock only`);
    await stock.uncheck();
    assert.deepEqual(await visibleRows(page), ALL_ROWS, `${label}: cleared`);

    // No match: the table keeps its header, and a category with no rows has no heading.
    await search.fill('zzz');
    assert.deepEqual(await visibleRows(page), [], `${label}: no match`);
    assert.deepEqual(await page.locator('thead th').allInnerTexts(), ['Name', 'Price'], `${label}: header stays`);
    // A space matches only names that contain a space, which none do.
    await search.fill(' ');
    assert.deepEqual(await visibleRows(page), [], `${label}: a space matches nothing`);
    await search.fill('');
    assert.deepEqual(await visibleRows(page), ALL_ROWS, `${label}: restored`);

    // Both controls show what the user typed (the controlled inputs of step 5).
    await search.fill('spin');
    assert.equal(await search.inputValue(), 'spin', `${label}: text box keeps its value`);
    await stock.check();
    assert.equal(await stock.isChecked(), true, `${label}: checkbox keeps its state`);
    assert.deepEqual(await visibleRows(page), ['Vegetables', 'Spinach $2'], `${label}: "spin" in stock`);
  });
}

/** Keyboard use: Tab order, typing, Space on the checkbox, and Enter in the text box. */
export async function checkKeyboard(browser, site, label, expected) {
  await withPage(browser, site, label, '/', async ({ page }) => {
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'INPUT', `${label}: first Tab reaches the text box`);
    assert.equal(await page.evaluate(() => document.activeElement?.type), 'text', `${label}: it is the text box`);
    await page.keyboard.type('pea');
    assert.deepEqual(await visibleRows(page), ['Vegetables', 'Peas $1'], `${label}: typed "pea"`);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.type), 'checkbox', `${label}: second Tab reaches the checkbox`);
    await page.keyboard.press('Space');
    assert.equal(await page.getByLabel('Only show products in stock').isChecked(), true, `${label}: Space checks it`);

    // Enter in a form's only text box submits the form. Record what each site does.
    await page.getByPlaceholder('Search...').focus();
    const before = page.url();
    const navigated = page.waitForURL((url) => url.toString() !== before, { timeout: 1500 }).then(() => true, () => false);
    await page.keyboard.press('Enter');
    const reloaded = await navigated;
    assert.equal(reloaded, expected.enterNavigates, `${label}: Enter ${expected.enterNavigates ? 'navigates' : 'stays'}`);
    if (!reloaded) assert.deepEqual(await visibleRows(page), ['Vegetables', 'Peas $1'], `${label}: Enter keeps the filter`);
  });
}

/**
 * Leaving and coming back must never leave the table disagreeing with the fields. A browser may
 * restore what was typed, or reset it; either is fine as long as the rows match the field.
 */
export async function checkHistory(browser, site, label) {
  await withPage(browser, site, label, '/', async ({ page }) => {
    const search = page.getByPlaceholder('Search...');
    const stock = page.getByLabel('Only show products in stock');
    await search.fill('zzz');
    await stock.check();
    await page.goto("about:blank");
    await page.goBack({ waitUntil: 'load' });
    await search.waitFor();
    const text = await search.inputValue();
    const checked = await stock.isChecked();
    const rows = await visibleRows(page);
    const expected = ALL_ROWS.filter((row, index) => {
      if (/^(Fruits|Vegetables)$/.test(row)) return false;
      const name = row.split(' ')[0];
      const stocked = !['Passionfruit', 'Pumpkin'].includes(name);
      return name.toLowerCase().includes(text.toLowerCase()) && !(checked && !stocked) && index >= 0;
    });
    const dataRows = rows.filter((row) => !/^(Fruits|Vegetables)$/.test(row));
    assert.deepEqual(dataRows, expected, `${label}: after Back the rows match text ${JSON.stringify(text)} and checkbox ${checked}`);
  });
}

/** The accessible names a person using assistive technology would hear. */
export async function checkAccessibleNames(browser, site, label, expected) {
  await withPage(browser, site, label, '/', async ({ page }) => {
    assert.equal(await page.getByRole('checkbox', { name: 'Only show products in stock' }).count(), 1, `${label}: checkbox name`);
    const textbox = page.getByRole('textbox');
    const name = await textbox.evaluate((node) => node.getAttribute('aria-label') ?? '');
    assert.equal(name, expected.textBoxAriaLabel, `${label}: text box aria-label`);
  });
}

/** Phone width: no sideways scrolling, and the controls still work. */
export async function checkMobile(browser, site, label) {
  await withPage(browser, site, label, '/', async ({ page }) => {
    const size = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
    assert.ok(size.content <= size.viewport, `${label}: scrollWidth ${size.content} exceeds ${size.viewport}`);
    await page.getByPlaceholder('Search...').fill('apple');
    assert.deepEqual(await visibleRows(page), ['Fruits', 'Apple $1'], `${label}: filter on a phone`);
  }, { viewport: { width: 390, height: 844 } });
}

/** What reaches the browser: script count and bytes, and whether the table needs JavaScript. */
export async function checkScripts(browser, site, label, expected) {
  const response = await fetch(`${site.url}/`);
  const html = await response.text();
  const external = [...html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((match) => match[1]);
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  let bytes = inline.reduce((sum, code) => sum + Buffer.byteLength(code), 0);
  for (const src of external.filter((path) => !path.includes('live-reload') && !path.startsWith('/@'))) {
    bytes += (await (await fetch(new URL(src, site.url))).arrayBuffer()).byteLength;
  }
  if (expected.productionScripts) {
    assert.ok(bytes <= expected.maxScriptBytes, `${label}: ${bytes} script bytes exceed ${expected.maxScriptBytes}`);
    assert.ok(bytes >= expected.minScriptBytes, `${label}: ${bytes} script bytes is below ${expected.minScriptBytes}`);
    site.measured = { scripts: external.length + inline.length, bytes };
  }
  // Without JavaScript: the Bascik table is server output, the React table needs the runtime.
  const opened = await openPage(browser, site, '/', { javaScriptEnabled: false });
  try {
    if (expected.rendersWithoutJavaScript) {
      assert.deepEqual(await visibleRows(opened.page), ALL_ROWS, `${label}: rows without JavaScript`);
    } else {
      assert.equal(await opened.page.locator('tbody tr').count(), 0, `${label}: no rows without JavaScript`);
    }
  } finally { await opened.context.close(); }
}

/** Port only: two instances on one page keep separate state. */
export async function checkInstances(browser, site, label) {
  await withPage(browser, site, label, '/instances/', async ({ page }) => {
    const first = page.getByTestId('first');
    const second = page.getByTestId('second');
    const rows = (section) => section.locator('tbody tr:visible').evaluateAll((trs) => trs.map((tr) => tr.innerText.replace(/\s+/g, ' ').trim()));
    assert.deepEqual(await rows(first), ALL_ROWS, `${label}: first starts full`);
    assert.deepEqual(await rows(second), ALL_ROWS, `${label}: second starts full`);

    await first.getByPlaceholder('Search...').fill('pea');
    assert.deepEqual(await rows(first), ['Vegetables', 'Peas $1'], `${label}: first filtered`);
    assert.deepEqual(await rows(second), ALL_ROWS, `${label}: second untouched`);

    await second.getByLabel('Only show products in stock').check();
    assert.deepEqual(await rows(second), ['Fruits', 'Apple $1', 'Dragonfruit $1', 'Vegetables', 'Spinach $2', 'Peas $1'], `${label}: second in stock`);
    assert.deepEqual(await rows(first), ['Vegetables', 'Peas $1'], `${label}: first unchanged by the second`);
    assert.equal(await first.getByLabel('Only show products in stock').isChecked(), false, `${label}: first checkbox unchanged`);
    assert.equal(await second.getByPlaceholder('Search...').inputValue(), '', `${label}: second text box unchanged`);

    // Labels are scoped per instance: clicking a label text toggles its own checkbox.
    await first.getByText('Only show products in stock').click();
    assert.equal(await first.getByLabel('Only show products in stock').isChecked(), true, `${label}: label click hits its own checkbox`);
    assert.equal(await second.getByLabel('Only show products in stock').isChecked(), true, `${label}: second stays checked`);
  });
}

/** Routes outside the app. */
export async function checkErrors(site, label, expectedStatus = 404) {
  const response = await fetch(`${site.url}/definitely-missing`);
  await response.arrayBuffer();
  if (response.status !== expectedStatus) throw new Error(`${label}: /definitely-missing status ${response.status}`);
}

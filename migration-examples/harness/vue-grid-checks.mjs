import assert from 'node:assert/strict';

// Behavior checks shared by the pinned Vue grid example and the Bascik port.
// Locators use roles and computed style, never framework class names or attributes, so the same
// assertions run against both implementations. Port-only checks are in checkPortOnly.

export const FIGHTERS = [
  ['Chuck Norris', 'Infinity'],
  ['Bruce Lee', '9000'],
  ['Jackie Chan', '7000'],
  ['Jet Li', '8000'],
];

const joined = (rows) => rows.map((row) => row.join('|'));
const FIGHTER_ROWS = joined(FIGHTERS);

async function withPage(browser, viewport, action, { javaScriptEnabled = true } = {}) {
  const context = await browser.newContext({ viewport, javaScriptEnabled });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const problems = [];
  page.on('console', (message) => { if (message.type() === 'error') problems.push(`console: ${message.text()}`); });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => problems.push(`request failed: ${request.url()}`));
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  try {
    return await action(page, problems);
  } finally {
    await context.close();
  }
}

// Reads what a person sees: the visible rows, the message, and how each header looks.
// The arrow is the last element inside the header cell for both implementations.
async function readGrid(page, scope = 'body') {
  return page.locator(scope).first().evaluate((root) => {
    const visible = (element) => element.getClientRects().length > 0;
    const style = (element) => getComputedStyle(element);
    const table = root.querySelector('table');
    const tableVisible = Boolean(table && visible(table));
    return {
      tableVisible,
      rows: tableVisible
        ? [...root.querySelectorAll('tbody tr')].map((row) => [...row.cells].map((cell) => cell.textContent.trim()).join('|'))
        : [],
      message: [...root.querySelectorAll('p')].filter(visible).map((paragraph) => paragraph.textContent.trim()),
      headers: tableVisible
        ? [...root.querySelectorAll('th')].map((th) => {
          const arrow = th.querySelector('span:last-child');
          const rect = th.getBoundingClientRect();
          const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return {
            text: th.textContent.trim(),
            active: style(th).color === 'rgb(255, 255, 255)',
            arrow: style(arrow).borderBottomWidth === '4px' ? 'asc' : style(arrow).borderTopWidth === '4px' ? 'dsc' : 'none',
            arrowOpacity: style(arrow).opacity,
            cursor: style(target).cursor,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        })
        : [],
    };
  });
}

const header = (page, name) => page.getByRole('columnheader', { name });
const search = (page) => page.getByRole('textbox');

function assertGrid(state, expected, label) {
  assert.deepEqual(state.rows, expected.rows, `${label}: rows`);
  if (expected.headers) {
    assert.deepEqual(state.headers.map(({ text, active, arrow }) => ({ text, active, arrow })), expected.headers, `${label}: headers`);
    for (const entry of state.headers) {
      assert.equal(entry.cursor, 'pointer', `${label}: ${entry.text} header shows a pointer cursor`);
      assert.equal(entry.arrowOpacity, entry.active ? '1' : '0.66', `${label}: ${entry.text} arrow opacity`);
    }
  }
}

const inactive = (text, arrow = 'asc') => ({ text, active: false, arrow });
const active = (text, arrow) => ({ text, active: true, arrow });

export async function checkRoute(site, label) {
  const response = await fetch(`${site.url}/`);
  assert.equal(response.status, 200, `${label}: / status`);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/, `${label}: / content type`);
  assert.ok((await response.text()).length > 0, `${label}: / has a body`);
}

// First load, the sort cycle, and per-column state. The first click on a column sorts descending
// and a second click sorts ascending, because the upstream flips the order before it sorts.
export async function checkSorting(browser, site, label) {
  await withPage(browser, { width: 1000, height: 700 }, async (page, problems) => {
    await page.goto(`${site.url}/`);
    await header(page, 'Name').waitFor();
    assertGrid(await readGrid(page), { rows: FIGHTER_ROWS, headers: [inactive('Name'), inactive('Power')] }, `${label} initial`);

    const steps = [
      ['Name', ['Jet Li|8000', 'Jackie Chan|7000', 'Chuck Norris|Infinity', 'Bruce Lee|9000'], [active('Name', 'dsc'), inactive('Power')]],
      ['Name', ['Bruce Lee|9000', 'Chuck Norris|Infinity', 'Jackie Chan|7000', 'Jet Li|8000'], [active('Name', 'asc'), inactive('Power')]],
      ['Power', ['Chuck Norris|Infinity', 'Bruce Lee|9000', 'Jet Li|8000', 'Jackie Chan|7000'], [inactive('Name'), active('Power', 'dsc')]],
      ['Power', ['Jackie Chan|7000', 'Jet Li|8000', 'Bruce Lee|9000', 'Chuck Norris|Infinity'], [inactive('Name'), active('Power', 'asc')]],
      // A column keeps its own order when another column was sorted in between.
      ['Name', ['Jet Li|8000', 'Jackie Chan|7000', 'Chuck Norris|Infinity', 'Bruce Lee|9000'], [active('Name', 'dsc'), inactive('Power')]],
      ['Power', ['Chuck Norris|Infinity', 'Bruce Lee|9000', 'Jet Li|8000', 'Jackie Chan|7000'], [inactive('Name', 'dsc'), active('Power', 'dsc')]],
    ];
    let count = 0;
    for (const [column, rows, headers] of steps) {
      await header(page, column).click();
      assertGrid(await readGrid(page), { rows, headers }, `${label} click ${++count} on ${column}`);
    }
    assert.deepEqual(problems, [], `${label}: sorting is free of console errors and failed requests`);
  });
}

export async function checkFiltering(browser, site, label) {
  await withPage(browser, { width: 1000, height: 700 }, async (page, problems) => {
    await page.goto(`${site.url}/`);
    await header(page, 'Name').waitFor();
    const cases = [
      ['JE', ['Jet Li|8000']],
      ['inf', ['Chuck Norris|Infinity']],
      ['CHUCK', ['Chuck Norris|Infinity']],
      ['7000', ['Jackie Chan|7000']],
      // A space is a real filter: every name has one, and nothing trims it.
      [' ', FIGHTER_ROWS],
      ['', FIGHTER_ROWS],
    ];
    for (const [query, rows] of cases) {
      await search(page).fill(query);
      assertGrid(await readGrid(page), { rows }, `${label} filter ${JSON.stringify(query)}`);
    }

    await search(page).fill('zzz');
    let state = await readGrid(page);
    assert.equal(state.tableVisible, false, `${label}: no table when nothing matches`);
    assert.deepEqual(state.message, ['No matches found.'], `${label}: no-match message`);
    await search(page).fill('');
    state = await readGrid(page);
    assert.deepEqual(state.message, [], `${label}: message gone after clearing`);
    assertGrid(state, { rows: FIGHTER_ROWS }, `${label} cleared`);

    // The filter and the sort apply together, and a sort survives an empty result.
    await header(page, 'Name').click();
    await search(page).fill('e');
    assertGrid(await readGrid(page), {
      rows: ['Jet Li|8000', 'Jackie Chan|7000', 'Bruce Lee|9000'],
      headers: [active('Name', 'dsc'), inactive('Power')],
    }, `${label} sort then filter`);
    await search(page).fill('zzz');
    await search(page).fill('');
    assertGrid(await readGrid(page), {
      rows: ['Jet Li|8000', 'Jackie Chan|7000', 'Chuck Norris|Infinity', 'Bruce Lee|9000'],
      headers: [active('Name', 'dsc'), inactive('Power')],
    }, `${label} sort kept across an empty result`);
    assert.deepEqual(problems, [], `${label}: filtering is free of console errors and failed requests`);
  });
}

// Enter in the search box. The upstream form has one text field and no submit handler, so the
// browser submits it, and the page reloads with the query in the address. That is recorded as
// the upstream baseline. The port deliberately does not reload (see README).
export async function checkSearchSubmit(browser, site, label, { reloads }) {
  await withPage(browser, { width: 1000, height: 700 }, async (page) => {
    await page.goto(`${site.url}/`);
    await search(page).click();
    await page.keyboard.type('jet');
    await Promise.all([
      reloads ? page.waitForURL((url) => url.search === '?query=jet') : Promise.resolve(),
      page.keyboard.press('Enter'),
    ]);
    await page.waitForLoadState('load');
    if (reloads) {
      assert.equal(await search(page).inputValue(), '', `${label}: the upstream form reloads and clears the box`);
      assertGrid(await readGrid(page), { rows: FIGHTER_ROWS }, `${label} after a reload`);
    } else {
      await page.waitForTimeout(250);
      assert.equal(new URL(page.url()).search, '', `${label}: Enter does not navigate`);
      assert.equal(await search(page).inputValue(), 'jet', `${label}: the typed text stays`);
      assertGrid(await readGrid(page), { rows: ['Jet Li|8000'] }, `${label} after Enter`);
    }
  });
}

export async function checkKeyboard(browser, site, label, { sortHeadersFocusable }) {
  await withPage(browser, { width: 1000, height: 700 }, async (page) => {
    await page.goto(`${site.url}/`);
    await header(page, 'Name').waitFor();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'INPUT', `${label}: the first Tab stop is the search box`);
    await page.keyboard.type('je');
    assertGrid(await readGrid(page), { rows: ['Jet Li|8000'] }, `${label} typing`);
    await search(page).fill('');
    const focusable = await page.evaluate(() => [...document.querySelectorAll('th')]
      .some((th) => th.tabIndex >= 0 || th.querySelector('button, a[href], [tabindex]')));
    assert.equal(focusable, sortHeadersFocusable, `${label}: sort headers ${sortHeadersFocusable ? 'are' : 'are not'} keyboard focusable`);
    if (sortHeadersFocusable) {
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'BUTTON', `${label}: Tab from the search box reaches a sort button`);
      await page.keyboard.press('Enter');
      assertGrid(await readGrid(page), {
        rows: ['Jet Li|8000', 'Jackie Chan|7000', 'Chuck Norris|Infinity', 'Bruce Lee|9000'],
        headers: [active('Name', 'dsc'), inactive('Power')],
      }, `${label} Enter on Name`);
      await page.keyboard.press('Space');
      assert.deepEqual((await readGrid(page)).rows, ['Bruce Lee|9000', 'Chuck Norris|Infinity', 'Jackie Chan|7000', 'Jet Li|8000'], `${label}: Space sorts again`);
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      assertGrid(await readGrid(page), {
        rows: ['Chuck Norris|Infinity', 'Bruce Lee|9000', 'Jet Li|8000', 'Jackie Chan|7000'],
        headers: [inactive('Name'), active('Power', 'dsc')],
      }, `${label} Enter on Power`);
    }
  });
}

export async function checkLayout(browser, site, label) {
  await withPage(browser, { width: 390, height: 844 }, async (page, problems) => {
    await page.goto(`${site.url}/`);
    await header(page, 'Name').waitFor();
    const widths = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
    assert.ok(widths.content <= widths.viewport, `${label}: no horizontal scrolling at 390px (${widths.content} > ${widths.viewport})`);
    const state = await readGrid(page);
    // Same box sizes in both implementations: a table cell is 160 wide and 38 high at the default size.
    assert.deepEqual(state.headers.map(({ width, height }) => [width, height]), [[160, 38], [160, 38]], `${label}: header cell size`);
    await search(page).fill('bruce');
    assertGrid(await readGrid(page), { rows: ['Bruce Lee|9000'] }, `${label} mobile filter`);
    assert.deepEqual(problems, [], `${label}: mobile page is free of console errors and failed requests`);
  });
}

// Sums script bytes the browser receives, so the "no framework runtime" claim is a number.
export async function scriptWeight(site) {
  const html = await (await fetch(`${site.url}/`)).text();
  const inline = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\bsrc=/.test(match[0]) && !/type="application\/json"/.test(match[0]) &&
      !/data-bascik-live-reload/.test(match[0]))
    .reduce((sum, match) => sum + Buffer.byteLength(match[1]), 0);
  let external = 0;
  for (const match of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)) {
    const response = await fetch(new URL(match[1], `${site.url}/`));
    external += (await response.arrayBuffer()).byteLength;
  }
  return { inline, external, tags: (html.match(/<script\b/gi) ?? []).length };
}

export async function checkScriptWeight(site, label, { framework }) {
  const weight = await scriptWeight(site);
  if (framework) {
    assert.ok(weight.external > 40000, `${label}: the Vue runtime is shipped as a bundle (${weight.external} bytes)`);
  } else {
    assert.equal(weight.external, 0, `${label}: no external script`);
    assert.ok(weight.inline > 1000 && weight.inline < 12000, `${label}: inline script size ${weight.inline}`);
  }
  return weight;
}

// Port only: markup, accessibility, instances, lifecycle, and the no-JavaScript result.
export async function checkPortOnly(browser, site, label, { dev }) {
  await withPage(browser, { width: 1000, height: 700 }, async (page, problems) => {
    await page.goto(`${site.url}/`);
    await header(page, 'Name').waitFor();
    assert.equal(await page.evaluate(() => typeof window.Vue), 'undefined', `${label}: no Vue global`);
    assert.equal(await page.locator('[data-v-app]').count(), 0, `${label}: no Vue app root`);
    assert.equal(await page.getByLabel('Search').count(), 1, `${label}: the search box has a label`);
    const names = header(page, 'Name');
    assert.equal(await names.getAttribute('aria-sort'), null, `${label}: no aria-sort before sorting`);
    await names.click();
    assert.equal(await names.getAttribute('aria-sort'), 'descending', `${label}: aria-sort after the first click`);
    await header(page, 'Power').click();
    assert.equal(await names.getAttribute('aria-sort'), null, `${label}: aria-sort moves with the sort`);
    assert.equal(await header(page, 'Power').getAttribute('aria-sort'), 'descending', `${label}: aria-sort on Power`);
    const ids = await page.evaluate(() => [...document.querySelectorAll('[id]')].map((element) => element.id));
    assert.equal(new Set(ids).size, ids.length, `${label}: element ids are unique`);
    assert.deepEqual(problems.filter((problem) => !(dev && /live-reload|EventSource/.test(problem))), [], `${label}: port page problems`);
  });

  // Repeated instances: separate state, two search boxes, one placed after its grid.
  await withPage(browser, { width: 1000, height: 900 }, async (page, problems) => {
    await page.goto(`${site.url}/two-grids/`);
    const fighters = page.getByTestId('fighters-grid');
    const planets = page.getByTestId('planets-grid');
    await fighters.getByRole('columnheader', { name: 'Name' }).waitFor();
    await planets.getByRole('columnheader', { name: 'Moons' }).waitFor();
    assert.deepEqual((await readGrid(page, '[data-testid="fighters-grid"]')).rows, FIGHTER_ROWS, `${label}: first grid rows`);
    assert.deepEqual((await readGrid(page, '[data-testid="planets-grid"]')).rows,
      ['Mercury|0', 'Earth|1', 'Mars|2', 'Jupiter|95', 'Saturn|146'], `${label}: second grid rows`);

    await planets.getByRole('columnheader', { name: 'Moons' }).click();
    // Numbers sort as numbers: 146 is after 95.
    assert.deepEqual((await readGrid(page, '[data-testid="planets-grid"]')).rows,
      ['Saturn|146', 'Jupiter|95', 'Mars|2', 'Earth|1', 'Mercury|0'], `${label}: second grid sorted`);
    assert.deepEqual((await readGrid(page, '[data-testid="fighters-grid"]')).rows, FIGHTER_ROWS, `${label}: first grid not affected by sorting the second`);

    await page.getByLabel('Search fighters').fill('bruce');
    assert.deepEqual((await readGrid(page, '[data-testid="fighters-grid"]')).rows, ['Bruce Lee|9000'], `${label}: first search filters the first grid`);
    assert.equal((await readGrid(page, '[data-testid="planets-grid"]')).rows.length, 5, `${label}: first search does not filter the second grid`);
    // This search box comes after its grid in the document.
    await page.getByLabel('Search planets').fill('mar');
    assert.deepEqual((await readGrid(page, '[data-testid="planets-grid"]')).rows, ['Mars|2'], `${label}: second search filters the second grid`);
    assert.deepEqual((await readGrid(page, '[data-testid="fighters-grid"]')).rows, ['Bruce Lee|9000'], `${label}: second search leaves the first grid alone`);
    await page.getByLabel('Search planets').fill('');
    await page.getByLabel('Search fighters').fill('');
    await fighters.getByRole('columnheader', { name: 'Power' }).click();
    assert.deepEqual((await readGrid(page, '[data-testid="fighters-grid"]')).rows,
      ['Chuck Norris|Infinity', 'Bruce Lee|9000', 'Jet Li|8000', 'Jackie Chan|7000'], `${label}: sort state per grid`);
    assert.deepEqual((await readGrid(page, '[data-testid="planets-grid"]')).rows,
      ['Saturn|146', 'Jupiter|95', 'Mars|2', 'Earth|1', 'Mercury|0'], `${label}: the second grid keeps its own sort`);
    const ids = await page.evaluate(() => [...document.querySelectorAll('[id]')].map((element) => element.id));
    assert.equal(new Set(ids).size, ids.length, `${label}: ids are unique across both instances`);
    assert.deepEqual(problems.filter((problem) => !(dev && /live-reload|EventSource/.test(problem))), [], `${label}: two-grid page problems`);
  });

  // Back navigation: a value the browser restores in the box must match the grid.
  await withPage(browser, { width: 1000, height: 700 }, async (page) => {
    await page.goto(`${site.url}/`);
    await header(page, 'Name').waitFor();
    await search(page).fill('jet');
    await page.goto(`${site.url}/two-grids/`);
    await page.goBack();
    await header(page, 'Name').waitFor();
    const value = await search(page).inputValue();
    const rows = (await readGrid(page)).rows;
    assert.equal(rows.length, value ? 1 : 4, `${label}: after Back, ${rows.length} rows match the box value ${JSON.stringify(value)}`);
  });

  // Without JavaScript the table is empty, like the upstream page, and nothing breaks.
  await withPage(browser, { width: 1000, height: 700 }, async (page, problems) => {
    const response = await page.goto(`${site.url}/`);
    assert.equal(response.status(), 200, `${label}: page loads without JavaScript`);
    assert.equal((await readGrid(page)).tableVisible, false, `${label}: no table without JavaScript`);
    assert.deepEqual(problems, [], `${label}: no-JavaScript page problems`);
  }, { javaScriptEnabled: false });

  const missing = await fetch(`${site.url}/missing/`);
  assert.equal(missing.status, 404, `${label}: unknown path is a 404`);
}

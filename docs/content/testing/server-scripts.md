# Testing Server Scripts

Server scripts (`<script data-bascik-server>`) execute in Node.js at request time to generate dynamic HTML content on HTTP/1.1 and HTTP/2 production servers (`bascik --server`). To keep server scripts maintainable, secure, and easily testable, separate backend business logic, database queries, and request parsing into pure exported TypeScript modules.

## Build Scripts vs Server Scripts Testing

| Characteristic       | Build Scripts (`data-bascik-build`)                                                            | Server Scripts (`data-bascik-server`)                                         |
| -------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Execution Time**   | Once at compile time (`bascik --build`)                                                        | On every incoming HTTP request (`bascik --server`)                            |
| **Data Sources**     | Local Markdown/JSON files, build-time env vars, static APIs                                    | Database queries, session cookies, request headers, query parameters          |
| **Testing Strategy** | Mock build env vars (`BASCIK_SOURCE_FILE`, `BASCIK_PAGE_FILE`), test static outputs in `dist/` | Unit test pure handlers, mock database connections, test request-time parsers |
| **Detailed Guide**   | [Build Scripts Testing](/testing/build-scripts)                                                | [Server Scripts Testing](/testing/server-scripts)                             |

## Architecture & Directory Structure

Place pure TypeScript helper modules alongside the component or page file:

```text
src/components/weather-widget/
  weather-widget.html          ← component template with <script data-bascik-server>
  weather-service.ts           ← pure exported backend functions
  weather-service.test.ts      ← Vitest unit tests with mocked API/DB calls
```

## Separating Logic from Server Templates

### 1. Pure Helper Module (`weather-service.ts`)

```ts
import { html, type SafeHtml } from "@bascik/bascik/html";

export interface WeatherData {
  city: string;
  temp: number;
  condition: string;
}

// The weather API's text is data from another site: html escapes it.
export function formatWeatherReport(data: WeatherData): SafeHtml {
  const roundedTemp = Math.round(data.temp);
  return html`<div class="weather-report">
    <h4>${data.city}</h4>
    <p>${roundedTemp}°F - ${data.condition}</p>
  </div>`;
}

export async function fetchCityWeather(
  city: string,
  apiKey: string,
): Promise<WeatherData> {
  const res = await fetch(
    `https://api.weather.example/v1?q=${encodeURIComponent(city)}&key=${apiKey}`,
  );
  if (!res.ok) throw new Error(`Weather lookup failed: ${res.statusText}`);
  return res.json();
}
```

### 2. Server Script Usage (`weather-widget.html`)

Inside the component template, import the helper module and execute request-time logic:

```html
<script data-bascik-server>
  import { fetchCityWeather, formatWeatherReport } from "./weather-service.ts";

  export default async function (request) {
    const apiKey = process.env.WEATHER_API_KEY ?? "";
    try {
      const data = await fetchCityWeather("Seattle", apiKey);
      return formatWeatherReport(data);
    } catch (err) {
      return '<p class="error-msg">Weather currently unavailable</p>';
    }
  }
</script>
```

> **ESM Import Convention:** Import a local TypeScript module by its real `.ts` filename. Node 22.22+ strips the types at runtime, so the same specifier works in the dev server, `bascik --server`, and Vitest. A `.js` specifier is not mapped to a `.ts` file and fails with `ERR_MODULE_NOT_FOUND`.

## Writing Server Logic Unit Tests

Test pure server logic functions and async backend integrations directly using Vitest:

```ts
// weather-service.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { formatWeatherReport, fetchCityWeather } from "./weather-service.ts";

describe("formatWeatherReport", () => {
  it("formats weather data into HTML markup", () => {
    // html returns an object, not a string: String() it before string checks.
    const output = String(
      formatWeatherReport({
        city: "Fountain Hills",
        temp: 72.6,
        condition: "Sunny",
      }),
    );

    expect(output).toContain("<h4>Fountain Hills</h4>");
    expect(output).toContain("73°F - Sunny");
    expect(output).toContain('class="weather-report"');
  });

  it("escapes markup in the API's text", () => {
    const output = String(
      formatWeatherReport({ city: "<img src=x>", temp: 1, condition: "" }),
    );
    expect(output).toContain("&lt;img src=x&gt;");
  });
});

describe("fetchCityWeather", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches and returns weather data for a valid city", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ city: "Seattle", temp: 65, condition: "Cloudy" }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const data = await fetchCityWeather("Seattle", "test-key");
    expect(data.city).toBe("Seattle");
    expect(data.temp).toBe(65);
  });

  it("throws an error when external API responds with error code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(null, { status: 404, statusText: "Not Found" }),
    );

    await expect(fetchCityWeather("UnknownCity", "test-key")).rejects.toThrow(
      "Weather lookup failed: Not Found",
    );
  });
});
```

## Direct Server Script Handler Testing

Under Bascik's in-process execution model, server scripts export standard async functions receiving a standard `Request` and returning HTML markup. You can test these handler functions directly in unit tests without starting an HTTP server or spawning child processes.

A handler's return is not always a string: one that builds its markup with [`html`](/html-helpers#html) returns a `SafeHtml` object, and one that returns `items.map(...)` returns an array, which the page joins with no separator (see [Return Values](/server-scripts#return-values)). Pass the result to `serverScriptOutput` from `@bascik/bascik/runtime`, the function Bascik uses to print it, and assert on its `text`: those are the bytes the page gets. `String(output)` is right only for a single string or `html` value; for an array it adds the commas the page never shows (`<li>a</li>,<li>b</li>`).

```ts
// src/components/weather-widget/weather-widget.server.test.ts
import { describe, it, expect } from "vitest";
import { serverScriptOutput } from "@bascik/bascik/runtime";
import weatherHandler from "./weather-widget.server.ts";

describe("weatherHandler", () => {
  it("renders greeting and weather for requested city query param", async () => {
    const request = new Request("http://localhost/weather?city=Seattle", {
      headers: { "x-display-name": "Alice" },
    });
    const context = { remoteIp: "127.0.0.1" };

    const printed = serverScriptOutput(
      await weatherHandler(request, context, {
        signal: new AbortController().signal,
      }),
    );
    expect(printed.error).toBeUndefined();
    expect(printed.text).toContain("Seattle");
    expect(printed.text).toContain("Alice");
  });
});
```

When a handler returns something the page refuses (data instead of markup, a `Response`, a caught `Error`, or the array of Promises an `async` callback in `.map` makes), `text` is `undefined` and `error` says what came back, in the words of the server's message:

```ts
import { it, expect } from "vitest";
import { serverScriptOutput } from "@bascik/bascik/runtime";

it("names a refused return", () => {
  const printed = serverScriptOutput([Promise.resolve("<li>Kettle</li>")]);
  expect(printed.text).toBeUndefined();
  expect(printed.error?.kind).toBe("promise");
  expect(printed.error?.received).toBe("an array holding a Promise at [0]");
});
```

## Testing Request Parameter Parsers

When your server scripts parse incoming query strings or request headers, test parameter validation and sanitization as pure functions:

```ts
// src/lib/query-parser.ts
export function parsePaginationParams(queryString: string): {
  page: number;
  limit: number;
} {
  const params = new URLSearchParams(queryString);
  const rawPage = parseInt(params.get("page") ?? "1", 10);
  const rawLimit = parseInt(params.get("limit") ?? "20", 10);

  const page = isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;
  const limit =
    isNaN(rawLimit) || rawLimit < 1 || rawLimit > 100 ? 20 : rawLimit;

  return { page, limit };
}
```

```ts
// src/lib/query-parser.test.ts
import { describe, it, expect } from "vitest";
import { parsePaginationParams } from "./query-parser.ts";

describe("parsePaginationParams", () => {
  it("parses valid query parameters", () => {
    expect(parsePaginationParams("page=3&limit=50")).toEqual({
      page: 3,
      limit: 50,
    });
  });

  it("falls back to defaults for missing or invalid values", () => {
    expect(parsePaginationParams("")).toEqual({ page: 1, limit: 20 });
    expect(parsePaginationParams("page=-5&limit=999")).toEqual({
      page: 1,
      limit: 20,
    });
    expect(parsePaginationParams("page=abc")).toEqual({ page: 1, limit: 20 });
  });
});
```

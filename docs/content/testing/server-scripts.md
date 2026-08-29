# Server Scripts Testing

Server scripts (`<script data-bascik-server>`) execute in Node.js at request time to generate dynamic HTML content. To keep server scripts testable, separate backend business logic into pure exported TypeScript modules.

## Architecture & Directory Structure

Place pure TypeScript helper modules alongside the component file:

```text
src/components/weather-widget/
  weather-widget.html          ← component template with <script data-bascik-server>
  weather-service.ts           ← pure exported functions (TypeScript)
  weather-service.test.ts      ← Vitest unit tests
```

## Separating Logic from Server Templates

### 1. Pure Helper Module (`weather-service.ts`)

```ts
export interface WeatherData {
  city: string;
  temp: number;
  condition: string;
}

export function formatWeatherReport(data: WeatherData): string {
  const roundedTemp = Math.round(data.temp);
  return `<div class="weather-report">` +
    `<h4>${data.city}</h4>` +
    `<p>${roundedTemp}°F - ${data.condition}</p>` +
    `</div>`;
}
```

### 2. Server Script Usage (`weather-widget.html`)

Inside the component template, import the helper module and process request data:

```html
<script data-bascik-server>
  import { formatWeatherReport } from './weather-service.js';
  const data = { city: 'Seattle', temp: 68.4, condition: 'Partly Cloudy' };
  console.log(formatWeatherReport(data));
</script>
```

> **ESM Import Convention:** Node 24 and Node 22.18+ support runtime `.js` specifiers pointing to local `.ts` source files, allowing seamless execution in both production dev servers and test runners.

## Writing Server Logic Unit Tests

Test pure server logic functions directly using Vitest:

```ts
// weather-service.test.ts
import { describe, it, expect } from 'vitest';
import { formatWeatherReport } from './weather-service.ts';

describe('formatWeatherReport', () => {
  it('formats weather data into HTML markup', () => {
    const output = formatWeatherReport({
      city: 'Fountain Hills',
      temp: 72.6,
      condition: 'Sunny',
    });

    expect(output).toContain('<h4>Fountain Hills</h4>');
    expect(output).toContain('73°F - Sunny');
    expect(output).toContain('class="weather-report"');
  });
});
```

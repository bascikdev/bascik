// JSON has no Infinity, but the number literal 1e999 parses back to it.
export function toJson(value: unknown): string {
  const marker = `__${crypto.randomUUID()}__`;
  const json = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'number' && Number.isNaN(item)) throw new RangeError('NaN cannot be passed to a grid');
    if (item === Infinity) return `${marker}+`;
    if (item === -Infinity) return `${marker}-`;
    return item;
  });
  return json.replaceAll(`"${marker}+"`, () => '1e999').replaceAll(`"${marker}-"`, () => '-1e999');
}

export interface GridData {
  columns: string[];
  rows: Record<string, unknown>[];
}

// The grid reads its data from this element. `<` is escaped so no value can end the script early.
export function renderGridData(data: GridData): string {
  const json = toJson(data).replaceAll('<', () => '\\u003c');
  return `<script type="application/json">${json}</script>`;
}

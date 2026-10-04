import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderGridData, toJson } from './grid.ts';

test('toJson keeps Infinity as a number that parses back', () => {
  const parsed = JSON.parse(toJson([{ power: Infinity, low: -Infinity, text: 'Infinity' }]));
  assert.equal(parsed[0].power, Infinity);
  assert.equal(parsed[0].low, -Infinity);
  assert.equal(parsed[0].text, 'Infinity');
});

test('toJson refuses NaN instead of writing null', () => {
  assert.throws(() => toJson([{ power: NaN }]), RangeError);
});

test('renderGridData cannot be ended early by row text', () => {
  const rows = [{ name: `</script><script>alert(1)</script> <!-- $& $1 $' $\`` }];
  const html = renderGridData({ columns: ['name'], rows });
  assert.equal(html.match(/<script/g)?.length, 1);
  assert.equal(html.match(/<\/script>/g)?.length, 1);
  const json = html.slice(html.indexOf('>') + 1, html.lastIndexOf('</script>'));
  assert.deepEqual(JSON.parse(json).rows, rows);
});

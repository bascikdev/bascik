import { describe, expect, it } from 'vitest';
import { marked } from 'marked';
import { headingPlainText, slugFromHeadingHtml } from './heading-slug.ts';

const inlineHtml = (markdown: string): string => marked.parseInline(markdown, { async: false });

describe('headingPlainText', () => {
  it.each([
    ['Props & slots', 'Props & slots'],
    ['The `<slot>` element', 'The <slot> element'],
    ["Don't \"quote\" me", 'Don\'t "quote" me'],
    // A literal entity in a code span must read as the entity, not the character
    // it names: `&amp;lt;` decodes once to `&lt;`, never twice to `<`.
    ['Write `&lt;slot&gt;` to show a tag', 'Write &lt;slot&gt; to show a tag'],
    ['`&amp;` in props', '&amp; in props'],
  ])('reads %j as %j', (markdown, expected) => {
    expect(headingPlainText(inlineHtml(markdown))).toBe(expected);
  });
});

describe('slugFromHeadingHtml', () => {
  it.each([
    ['Server Scripts', 'server-scripts'],
    ['Props & slots', 'props-slots'],
    ['The `<slot>` element', 'the-slot-element'],
    ['Write `&lt;slot&gt;` to show a tag', 'write-ltslotgt-to-show-a-tag'],
  ])('slugs %j as %j', (markdown, expected) => {
    expect(slugFromHeadingHtml(inlineHtml(markdown))).toBe(expected);
  });
});

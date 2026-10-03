---
title: 'Markdown Style Guide'
description: 'A tour of the Markdown features this port renders at build time, from headings to footnotes.'
pubDate: 2024-06-19
heroImage: '/assets/post-1.webp'
---

This post exercises the Markdown features the original style guide covers, so a page can be compared
element by element after the build.

## Headings

The following HTML `<h1>` to `<h6>` elements represent six levels of section headings. `<h1>` is the
highest section level while `<h6>` is the lowest.

# H1

## H2

### H3

#### H4

##### H5

###### H6

## Paragraph

Short paragraphs keep a page readable. This one is only here to show spacing between blocks of body
text at the width of the prose column.

A second paragraph follows so the gap between paragraphs is visible, and a third line of text makes
the wrapping behavior easy to see on a narrow screen.

## Images

### Syntax

```markdown
![Alt text](/path/to/image.webp)
```

### Output

![An abstract gradient with overlapping translucent circles](/assets/about.webp)

## Blockquotes

A blockquote represents content quoted from another source, optionally with a citation.

### Blockquote without attribution

#### Syntax

```markdown
> A short quoted line.
> **Note** that you can use _Markdown syntax_ within a blockquote.
```

#### Output

> A short quoted line.
> **Note** that you can use _Markdown syntax_ within a blockquote.

### Blockquote with attribution

#### Syntax

```markdown
> Simple things should be simple, and complex things should be possible.<br>
> - <cite>Alan Kay[^1]</cite>
```

#### Output

> Simple things should be simple, and complex things should be possible.<br>
> - <cite>Alan Kay[^1]</cite>

[^1]: A widely repeated design maxim, attributed here only to demonstrate footnotes.

## Tables

### Syntax

```markdown
| Italics   | Bold     | Code   |
| --------- | -------- | ------ |
| _italics_ | **bold** | `code` |
```

### Output

| Italics   | Bold     | Code   |
| --------- | -------- | ------ |
| _italics_ | **bold** | `code` |

## Code Blocks

### Syntax

Three backticks on a new line open a block, and three backticks on a new line close it. Add a language
name after the opening fence to label the block.

````markdown
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Example HTML5 Document</title>
  </head>
  <body>
    <p>Test</p>
  </body>
</html>
```
````

### Output

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Example HTML5 Document</title>
  </head>
  <body>
    <p>Test</p>
  </body>
</html>
```

## List Types

### Ordered List

#### Syntax

```markdown
1. First item
2. Second item
3. Third item
```

#### Output

1. First item
2. Second item
3. Third item

### Unordered List

#### Syntax

```markdown
- List item
- Another item
- And another item
```

#### Output

- List item
- Another item
- And another item

### Nested list

#### Syntax

```markdown
- Fruit
  - Apple
  - Orange
  - Banana
- Dairy
  - Milk
  - Cheese
```

#### Output

- Fruit
  - Apple
  - Orange
  - Banana
- Dairy
  - Milk
  - Cheese

## Other Elements: abbr, sub, sup, kbd, mark

### Syntax

```markdown
<abbr title="Hypertext Markup Language">HTML</abbr> is the markup language of the web.

H<sub>2</sub>O

X<sup>n</sup> + Y<sup>n</sup> = Z<sup>n</sup>

Press <kbd>CTRL</kbd> + <kbd>ALT</kbd> + <kbd>Delete</kbd> to end the session.

Most <mark>highlighted</mark> text draws the eye first.
```

### Output

<abbr title="Hypertext Markup Language">HTML</abbr> is the markup language of the web.

H<sub>2</sub>O

X<sup>n</sup> + Y<sup>n</sup> = Z<sup>n</sup>

Press <kbd>CTRL</kbd> + <kbd>ALT</kbd> + <kbd>Delete</kbd> to end the session.

Most <mark>highlighted</mark> text draws the eye first.

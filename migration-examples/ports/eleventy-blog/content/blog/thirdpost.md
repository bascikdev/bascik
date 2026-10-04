---
title: Measuring a tide table
description: A third note about reading a tide table without trusting it too far.
date: 2018-08-24
tags: ["second tag", "posts with two tags"]
---
A tide table is a prediction, not a promise. Wind and pressure move the water, and the printed numbers know nothing about either.

## Code

### This is a very long heading that is here to check that long headings wrap cleanly This is a very long heading that is here to check that long headings wrap cleanly This is a very long heading that is here to check that long headings wrap cleanly

Here is the correction I apply before trusting the printed height, written as a short function.

```js
// adjust a predicted height for local pressure
function correct(height, hectopascals) {
	const offset = (1013 - hectopascals) / 100;
	return height + offset;
}

// Test with a line break above this line.
console.log(correct(2.4, 1003));
```

### Heading with a [link](#code)

The same arithmetic without a language, to check that an unmarked block is still escaped and scrollable.

```
// adjust a predicted height for local pressure
function correct(height, hectopascals) {
	const offset = (1013 - hectopascals) / 100;
	return height + offset;
}
```

## Section header

Plain notes still matter. Write down the time you arrived, not the time the table said you should have.

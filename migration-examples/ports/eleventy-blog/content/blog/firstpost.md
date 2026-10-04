---
title: Mending a rope fender
description: A first note about splicing, and what a small repair teaches about patience.
date: 2018-05-01
tags: another tag
---
The old fender had frayed at the eye, which is where every fender frays first. Rather than buy a new one, I spent an evening learning how to rebuild the splice, and the evening taught me more than the rope did.

A repair like this rewards slow hands. Each tuck is simple on its own, and the whole job only goes wrong when you hurry the third one.

## What went wrong first

The first attempt held for about a week. I had tucked against the lay of the rope instead of with it, and the strands worked loose under load.

```diff-js
 // the splice, as a checklist
 function splice(eye) {
+  let tucks = 3;
-  let tucks = 1;
   tucks++;
 }

 // Test with a line break above this line.
 console.log('Test');
```

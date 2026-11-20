# Visual Design and Interaction

Build a Bascik site around what people come to do. Choose a visual direction for that task, then use native HTML and CSS so the design still works on a small screen, by keyboard, and without unnecessary client code.

## Set a visual direction

Start with the product and one or two references. Identify what makes each reference work: an editorial type scale, a distinctive palette, or the way it keeps the main action near the content. Use those observations rather than copying the site. A report should prioritize comparable numbers, while a portfolio should give the work room to speak.

Pick two compatible base tones and one accent. Start with the accent on the primary action and reduce the saturation of competing colors. Use additional colors when they explain data or status, but never make color the only cue. Set tokens in a global stylesheet and read them from components. See [Theming](/how-to/theming) for light and dark schemes.

Choose type for the subject and confirm that you can distribute the font. Use size, weight, and spacing to create hierarchy. Reserve tabular figures for comparisons, constrain prose to a comfortable line length, and test long names before imposing a line limit. Let spacing group content before adding borders. Avoid nested cards, decorative badges, and stock effects that say nothing about the product.

Show actual work, products, or representative data. A hero can use subject-specific texture or photography, but it does not need a background effect to prove that it was designed. Avoid fabricated metrics and only attribute example content to real people when the attribution is accurate.

## Design the interaction

Start with a link for navigation and a button for an action. Show the next step, give errors in words, and tell people what happened after submission. Keep demo flows explicitly simulated and avoid collecting real payment details, passwords, or other sensitive information. See [Interactivity](/how-to/interactivity) for native controls and progressive enhancement.

Motion should convey where an element came from or acknowledge an action. Keep everyday feedback short. A disclosure can animate its intrinsic height where supported; it must open immediately where it is not. Keep direct manipulation responsive, preserve direction on release, and do not require a swipe to reach content. Disable cosmetic motion for reduced-motion preferences without losing feedback or hiding content.

Do not fade or scale above-the-fold content into view during initial page load. Render it visibly on the first paint; loading entrances can delay meaningful content and harm Lighthouse metrics. Reserve entrances for user-triggered panels and appropriate below-the-fold interactions. Theme changes should apply immediately without a page flash.

## Review the compiled page

Test light and dark themes, keyboard focus, narrow and wide layouts, zoom, and touch. Check that long labels fit, loading does not move the interface unexpectedly, and a failure state offers a way forward. Compare the rendered result to the visual direction rather than checking that it uses a particular effect.

These guidelines adapt design and motion principles from [Charles Unemployed](https://www.youtube.com/@charles.unemployed/shorts) to Bascik's HTML-first workflow.

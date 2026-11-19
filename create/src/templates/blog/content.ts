/**
 * @module templates/blog/content
 *
 * The blog template's sample racing posts. Each is written to `content/posts/<slug>.md`, and its slug is its URL.
 */

/** The sample posts, newest first, as `[slug, Markdown]`. The generated e2e spec names the same four. */
export const SAMPLE_POSTS: readonly (readonly [
  slug: string,
  markdown: string,
])[] = [
  [
    "hurley-haywood-at-daytona",
    `---
title: Hurley Haywood at Daytona
description: A driver profile tracing Hurley Haywood's Daytona endurance career, race craft, and lasting IMSA record.
date: 2026-10-28
author: Apex Racing Desk
tags: [driver-profiles, imsa]
---

Hurley Haywood is a defining name in Porsche endurance racing. His career links Daytona, Sebring, and Le Mans through different cars and generations, making him a useful lens for understanding how a modern sports-car driver builds consistency.

## The race craft that travelled

Haywood's results came from pace that could survive a long stint. He could work traffic, preserve tires, and hand a car to the next driver with enough margin to attack rather than recover.

## Daytona and the team around the car

At Daytona, the 24-hour format rewards preparation: pit timing, night vision, weather, and clear communication between co-drivers. Haywood's record is tied closely to Porsche programs and IMSA competition, where shared stints turn one driver's speed into a team's result.

> Endurance speed is repeatable lap time, not one heroic lap.

## The lesson for club racers

Use a repeatable reference for braking, then make only one change at a time. A clean stint at Laguna Seca or Sebring matters more than a qualifying lap that leaves the car outside the balance window.
`,
  ],
  [
    "porsche-prototypes-917-935-962-963",
    `---
title: From the 917 to the 963
description: A Porsche prototype history across the 917, 935, 962, and 963, with the engineering themes that shaped each era.
date: 2026-09-14
author: Apex Racing Desk
tags: [porsche-history, prototypes]
---

Porsche's prototype story is a line of problems solved in public: aerodynamic stability, turbo heat, braking, hybrid efficiency, and the discipline of running across four distinct endurance eras.

## Porsche 917: outright speed arrives

The Porsche 917 made the company's 1970 Le Mans breakthrough. Its exposed high-speed character demanded bravery and aerodynamic work, but it established a template for purpose-built Porsche prototypes.

## Porsche 935 and Porsche 962: turbo and team craft

The Porsche 935 turned the production-derived 911 silhouette into an international racing weapon. Later, the Porsche 962 carried the road-car-derived 962 identity through Group C and IMSA competition, where balance and reliability mattered as much as straight-line speed.

| Model | Main racing theme |
| ----- | ----------------- |
| 917 | Aerodynamic top speed |
| 935 | Turbocharged silhouette racing |
| 962 | Group C and IMSA versatility |
| 963 | Modern LMDh energy management |

## Porsche 963: the new hybrid era

The Porsche 963 competes in WEC and IMSA under the LMDh formula. Jordan Taylor is among the drivers who have represented Porsche in top-flight sports-car racing, and the 963's challenge is coordination of hybrid deployment, tire load, and pit-window strategy.
`,
  ],
  [
    "laguna-seca-set-up-notes",
    `---
title: Laguna Seca Set-Up Notes
description: A practical Porsche track report for Laguna Seca, covering brake balance, Corkscrew confidence, tire temperature, and stint setup.
date: 2026-08-02
author: Ross Bentley
tags: [set-ups, track-report, laguna-seca]
---

Laguna Seca asks a car to change direction at the start of the lap, brake uphill, manage camber through the Corkscrew, then settle its tires for the slower final sector. This is a baseline for a balanced GT or prototype test day, not a substitute for a team engineer's model.

## Brake balance and turn-in

Start with the manufacturer's recommended bias, then add one small step of rear bias only if the front axle is refusing to settle on the approach to Turn 2. Revisit after the first fully representative stint so track evolution is part of the result.

## Tire temperature budget

Log inside-to-middle-to-outside temperatures by corner and compare both axles. A useful setup change should improve both repeatability and tire drop-off, not merely make one timed lap look fast.

- Use the bump at the Corkscrew as a balance check.
- Watch rear temperatures after the long uphill section.
- Compare a five-lap average rather than one flyer.

## Paul Newman and the 911 school

Paul Newman also raced Porsches and helped make motorsport a serious second act rather than a celebrity cameo. His measured approach is a reminder that seat time, feedback, and professional preparation are the setup tools that matter most.
`,
  ],
  [
    "le-mans-spa-race-preview",
    `---
title: Le Mans and Spa Race Preview
description: A WEC race preview comparing the Le Mans and Spa demands, strategy windows, traffic, and Porsche 963 preparation.
date: 2026-06-19
author: Apex Racing Desk
tags: [race-previews, wec]
---

Spa and Le Mans expose different parts of an endurance package. Spa demands repeatable speed through the uphill section and a fast-changing weather window. Le Mans stretches the driver, hybrid system, and traffic plan over a full 24-hour race.

## Spa: speed with limited recovery

A strong Spa stint comes from stable aero and predictable braking into the medium-speed sequence. Rain risk raises the value of a wide usable tire window, and the strategy team must decide whether a stop is for weather or for fuel before the safety-car window closes.

## Le Mans: traffic and the full race

At Le Mans, straight-line efficiency supports tire and fuel calculations, while traffic creates hundreds of small passing decisions. The Porsche 963 program must keep hybrid deployment inside the rules and avoid thermal penalties during the night cycle.

## The race-week watch list

1. Track evolution between qualifying and the opening stint.
2. Energy deployment through the slowest Le Mans sections.
3. Double-stint behavior on new and used tires.
4. Night visibility and pit-lane handoffs.

The IMSA calendar has its own five-sector stress test at Daytona and Sebring, but the WEC at Spa and Le Mans shows whether preparation survives a longer, less forgiving weekend.
`,
  ],
];

/**
 * The docs template's race operations and engineering sample pages.
 * The order and grouping of the pages is `SIDEBAR` in `lib.ts`.
 */

const RACE_WEEKEND = `---
title: Race weekend
description: Build a race-weekend plan that connects the track, the team, and the car.
---

A race weekend starts as a shared operating plan, not a collection of setup guesses. Define the sessions, the conditions, and the decisions that each run must resolve.

## Plan the sessions

At Daytona, Sebring, Watkins Glen, Laguna Seca, Le Mans, or Spa, use the event schedule to separate learning runs from validation runs:

- **Practice:** establish reference laps and confirm tire behavior.
- **Qualifying:** run the fuel, pressure, and traffic plan you can repeat.
- **Warm-up:** verify the baseline and communicate changes early.
- **Race:** execute the strategy, preserve the car, and update for conditions.

### Record one baseline

Keep every change tied to a timestamp and a lap range. The team should be able to answer what changed, why it changed, and which data channel showed the effect.

## Roles and handoffs

The race engineer owns the session plan and the final setup change. The data engineer confirms sensor health and trace quality. The driver validates balance in clear running. The crew chief controls pit equipment and repeatable handoffs.

> A fast lap without trustworthy weather, fuel, tire, and timing context is only a limited reference.

## Next steps

- [Braking zones](/docs/braking-zones) turns corner entry into repeatable markers.
- [Setup and tyres](/docs/setup-and-tyres) connects qualifying targets to tire pressure and balance.
- [Pit operations](/docs/pit-operations) keeps driver changes and pit stops synchronized.
`;

const BRAKING_ZONES = `---
title: Braking zones
description: Mark braking points, release shapes, and corner-entry balance at representative circuits.
---

A useful braking zone has a start, a pressure build, a release, and a reference to the car's response. Mark it by distance or timing marker, not only by a subjective point on track.

## Build a reference

For a representative lap at Sebring or Watkins Glen, compare four traces:

| Channel | What to inspect |
| :------ | :-------------- |
| Brake pressure | Initial build, peak pressure, and release shape |
| Steering angle | Entry speed, lock, and correction |
| Longitudinal acceleration | Brake application and corner-entry stability |
| Speed | Turn-in speed and minimum speed by sector |

## Find the limit

At Laguna Seca, a late entrance can create front lock and extra time spent away from the ideal exit. At Le Mans, the priority is often a stable stop after high-speed load. Spa asks for a smooth transition in changing grip and elevation.

### Qualitative notes

Record the driver's words beside the data: locked front, rear light, turn-in push, or throttle pickup hesitation. The description should identify the car state and the part of the corner, while the trace confirms the magnitude.

## Repeat and review

Run at least one comparable lap before changing brake balance or entry setup. Ross Bentley's race-driving method emphasizes observation and repeatable references, especially when the driver and engineer compare a plan with the actual lap.
`;

const SETUP_AND_TYRES = `---
title: Setup and tyres
description: Coordinate qualifying setups and tire management across weather, traffic, and stint length.
---

Qualifying setup and race setup are different compromises. A qualifying lap favors immediate grip and one controlled peak; a race stint favors stable temperatures, predictable degradation, and consistent traffic behavior.

## Qualify with a plan

Set a fuel and pressure target, a push lap, an out-lap, and a traffic contingency. Jordan Taylor's Grand Touring race work shows the value of preparation in high-traffic sessions, but the setup still has to suit the track and class.

| Variable | Qualifying question | Race question |
| :------- | :----------------- | :------------ |
| Tire pressure | Is initial grip stable? | Is pressure still in its operating band? |
| Spring and bar | Does turn-in respond quickly? | Does the car stay controlled over a stint? |
| Fuel load | Is the lap run in low fuel? | Is the final stint predictable? |
| Traffic | Can the lap avoid slow zones? | Can the car manage wake and passing? |

## Manage tire temperature

Read tire temperatures with pressure, lap time, and track conditions together. A high inner reading can be alignment or load, while a rise across the tire can reflect pace or track temperature.

- Start with a documented pressure baseline.
- Compare cold and hot values only under the same procedure.
- Avoid a setup conclusion from one interrupted lap.
- Plan a stop for the expected crossover, not only for fuel.

## Preserve the window

At Daytona and Sebring, bumps and abrasive surfaces can raise tire load. At Watkins Glen and Spa, changing weather can make the first lap of a stint more representative than peak grip.

> Tire management is a control system: inputs, feedback, limits, and adjustment.
`;

const PIT_OPERATIONS = `---
title: Pit operations
description: Standardize driver changes, pit stop procedures, timing, and handoffs.
---

A pit stop is a repeatable system with independent jobs. The procedure should define who announces the stop, who prepares the equipment, and what stops the car from releasing unsafe or incomplete.

## Driver changes

A driver change should follow a named sequence:

1. The arriving driver calls the timing board and the pit entry status.
2. The crew positions the car within the marked stopping area.
3. Belts, window, radio, and protective equipment are checked before the seat change.
4. The driver signs in or follows the series procedure when required.
5. The departing driver performs a full systems and visibility check before release.

Paul Newman and Hurley Haywood are examples of the endurance-racing tradition in which driver selection, preparation, and racecraft extend beyond raw lap time.

## Pit stop checklist

| Phase | Control |
| :---- | :------ |
| Entry | Pit lane speed, service target, and traffic |
| Arrival | Chocks, pit position, and fire-extinguisher readiness |
| Service | Tire, fuel or charging, damage, and driver-change ownership |
| Exit | Final belts, systems check, clear lane, and release confirmation |

## Build repeatability

Run the procedure from the same call line and use the same confirmations for practice and race stops. Measure elapsed time, service time, and lost time separately. A fast tire change means little if it follows a slow arrival or creates an unsafe release.

## Series checks

IMSA and WEC pit rules differ by event, class, and regulations. Confirm the current sporting and technical bulletin before any stop procedure is final.
`;

const DATA_AND_RULES = `---
title: Data channels and race rules
description: Define telemetry channels that support decisions and track IMSA and WEC requirements.
---

Race data must answer a question: is the car in a safe operating state, is its balance changing, and does the strategy match the remaining stint?

## Core data channels

| Channel group | Example channels | Decision supported |
| :------------ | :--------------- | :---------------- |
| Timing | Lap, sector, delta, pit loss | Pace and strategy |
| Powertrain | RPM, gear, throttle, temperatures | Fuel and damage management |
| Tires | Pressure, temperatures, wheel speed | Stint limits and pressures |
| Chassis | Brake, steering, suspension, ride height | Balance and compliance |
| Vehicle health | Battery, oil, water, sensor fault | Reliability and pit priority |

Use a common unit and a named calibration for each channel. Sensor drops must appear as gaps or faults, not interpolated values that look like valid measurements.

## IMSA and WEC working rules

IMSA and WEC set the sporting, technical, safety, and stop procedures for their events. They publish series-specific balances of performance, pit-entry restrictions, full-course-yellow rules, tire rules, and homologation limits.

Before each session:

- Read the latest sporting and technical bulletin.
- Confirm class, tire, refueling or charging, and driver-change requirements.
- Review local yellow, red, and safety-car procedures.
- Validate official timing data against the team telemetry.

> Regulations change over time and by event. Use the current official documentation for every final decision.

## Le Mans and the endurance format

A Le Mans race plan must cover darkness, weather, safety-car timing, and traffic. Daytona and Sebring often demand repeatable pace through rough surfaces and changing grip. Spa and Laguna Seca reward a setup that remains predictable as fuel and tire load change.
`;

const PORSCHE_CLASSICS = `---
title: Porsche classic race engineering
description: Historical notes on the Porsche 917, 935, 962, and 963 across endurance racing.
---

Porsche prototypes and GT cars share an endurance-racing principle: keep the package stable long enough to make fewer errors than the opposition.

## Model notes

| Porsche | Engineering theme | Racing context |
| :------ | :---------------- | :------------- |
| 917 | Aerodynamics, engine power, and high-speed confidence | Early-1970s sports-prototype racing |
| 935 | Turbocharged production-based competition with aero adaptation | IMSA and international GT racing |
| 962 | Closed-cockpit endurance prototype with adaptable circuits | IMSA and World Sports-Prototype programs |
| 963 | Modern hybrid prototype prepared for IMSA and WEC competition | Hypercar-era endurance racing |

These are broad themes, not setup prescriptions. Weight, aerodynamics, tire, electronics, and homologation rules differ from period to period.

## Drivers and preparation

Hurley Haywood is closely associated with Porsche endurance success, from major wins to the 917 and 935-era cars. Paul Newman brought high-level Hollywood visibility and serious amateur racing discipline to Porsche competition. Jordan Taylor represents the modern Porsche 963-era professional lineup, with IMSA and endurance-race experience. Ross Bentley connects racecraft instruction to repeatable observation and debriefing.

## Preserve an older car

- Separate restoration requirements from race setup.
- Protect period-specific parts and document any replacement.
- Establish cooling, oil pressure, brake, and tire baselines before speed.
- Use a modern data logger for trend analysis without changing the car to fit the logger.
- Keep a current safety and technical inspection path for the event.

## Circuit context

The Daytona banking, Sebring bumps, Watkins Glen elevation, Laguna Seca corkscrew, Le Mans straights and night sectors, and Spa weather are useful reminders that one historical setup is not a universal setup.

> Vintage Porsche notes should respect the car's original engineering and the safety rules of the event in which it competes.
`;

/** The sample pages by file name without `.md`, in sidebar order. */
export const DOCS_SAMPLE_PAGES: Record<string, string> = {
  "race-weekend": RACE_WEEKEND,
  "braking-zones": BRAKING_ZONES,
  "setup-and-tyres": SETUP_AND_TYRES,
  "pit-operations": PIT_OPERATIONS,
  "data-and-rules": DATA_AND_RULES,
  "porsche-classics": PORSCHE_CLASSICS,
};

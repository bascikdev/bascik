// The example's data from App.vue: the grid component receives it from outside.
export const gridColumns = ['name', 'power'];

export const gridData = [
  { name: 'Chuck Norris', power: Infinity },
  { name: 'Bruce Lee', power: 9000 },
  { name: 'Jackie Chan', power: 7000 },
  { name: 'Jet Li', power: 8000 },
];

// A second dataset for the two-grid page. Moons are numbers, so 95 sorts before 146.
export const planetColumns = ['planet', 'moons'];

export const planetData = [
  { planet: 'Mercury', moons: 0 },
  { planet: 'Earth', moons: 1 },
  { planet: 'Mars', moons: 2 },
  { planet: 'Jupiter', moons: 95 },
  { planet: 'Saturn', moons: 146 },
];

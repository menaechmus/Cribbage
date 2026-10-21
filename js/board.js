// The pegboard as geometry, in SVG units: where each hole sits and the shape
// of the track beneath them. Nothing is drawn here, so it can be tested.
//
// The track is one S-shaped run of holes: left to right along the top, round
// a bend, back along the middle, round a second bend, and along the bottom to
// the finish. Each bend holds one group of five holes. The lanes (two, or
// three for a three-player game) run side by side all the way, so the outer
// ones take the outside of one bend and the inside of the other, and every
// lane is the same length.

// Two lanes 8 apart, or three 7 apart. A third lane needs wider bends (the
// inside one still has room between its holes) and so a taller board.
const SHAPES = {
  2: { height: 88, track: 17, lane: 8, straights: [13, 44, 75], left: 28.5, right: 331.5 },
  3: { height: 100, track: 25, lane: 7, straights: [14, 50, 86], left: 32.5, right: 327.5 },
};

export const boardFor = (lanes = 2) => ({ width: 360, height: SHAPES[lanes].height, track: SHAPES[lanes].track });
export const BOARD = boardFor(2);

const BEND_HOLES = 5;

// How the holes of a game to `target` are spread along the straights.
function layout(target, shape) {
  const side = ((target - 1) / 5 - 3) / 3; // groups of five on the top and bottom straights
  const columns = 5 * (side + 1); // the middle straight is one group longer
  // Holes are one pitch apart, with an extra half pitch between groups and a
  // quarter pitch between each end of a straight and its bend.
  const pitch = (shape.right - shape.left) / (columns - 0.5 + side / 2);
  const x = column => shape.left + (column + Math.floor(column / 5) / 2 + 0.25) * pitch;
  return { side, columns, pitch, x };
}

// The nth hole of a bend, counted from its top. `way` is 1 for a bend that
// curves out to the right and -1 for one to the left. The five holes divide
// the half-circle into six equal steps.
function bendXY(x, way, y, radius, n) {
  const angle = ((n + 1) * Math.PI) / (BEND_HOLES + 1);
  return [x + way * radius * Math.sin(angle), y - radius * Math.cos(angle)];
}

// Where hole number `hole` of a lane is. Holes 0 and -1 are the two starting
// holes; `target` (or anything beyond) is the single finish hole.
export function holeXY(target, lane, hole, lanes = 2) {
  const shape = SHAPES[lanes];
  const { side, columns, pitch, x } = layout(target, shape);
  const [top, middle, bottom] = shape.straights;
  const turn = (middle - top) / 2; // radius of a bend's centre line
  // Lane 0 runs uppermost on the top and bottom straights and lowest on the
  // middle one; the last lane is its mirror image.
  const offset = (lane - (lanes - 1) / 2) * shape.lane;

  if (hole >= target) return [x(5 * side - 1) + 1.5 * pitch, bottom];
  // The top straight is right-aligned, leaving a pocket for the starting holes.
  if (hole < 1) return [x(5) - (1.5 - hole) * pitch, top + offset];

  let n = hole - 1; // steps along the track from hole 1
  if (n < 5 * side) return [x(5 + n), top + offset];
  n -= 5 * side;
  if (n < BEND_HOLES) return bendXY(shape.right, 1, (top + middle) / 2, turn - offset, n);
  n -= BEND_HOLES;
  if (n < columns) return [x(columns - 1 - n), middle - offset];
  n -= columns;
  if (n < BEND_HOLES) return bendXY(shape.left, -1, (middle + bottom) / 2, turn + offset, n);
  n -= BEND_HOLES;
  return [x(n), bottom + offset];
}

// The centre line of the track as an SVG path, from the starting holes to the
// finish. Stroked as wide as boardFor() says, with round ends, it is the band
// the holes sit in.
export function trackPath(target, lanes = 2) {
  const { straights: [top, middle, bottom], left, right } = SHAPES[lanes];
  const turn = (middle - top) / 2;
  const start = holeXY(target, 0, -1, lanes)[0].toFixed(2);
  const finish = holeXY(target, 0, target, lanes)[0].toFixed(2);
  return (
    `M${start} ${top} H${right} A${turn} ${turn} 0 0 1 ${right} ${middle} ` +
    `H${left} A${turn} ${turn} 0 0 0 ${left} ${bottom} H${finish}`
  );
}

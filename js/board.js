// The pegboard as geometry, in SVG units: where each hole sits and the shape
// of the track beneath them. Nothing is drawn here, so it can be tested.
//
// The track is one S-shaped run of holes: left to right along the top, round
// a bend, back along the middle, round a second bend, and along the bottom to
// the finish. Each bend holds one group of five holes. The two players' lanes
// run side by side all the way, so each lane takes the outside of one bend and
// the inside of the other.

export const BOARD = { width: 360, height: 88, track: 17 };

const LANE = 8; // between the two lanes
const STRAIGHTS = [13, 44, 75]; // centre line of each straight, top to bottom
const TURN = (STRAIGHTS[1] - STRAIGHTS[0]) / 2; // radius of a bend's centre line
const LEFT = 28.5; // the straights run between these two,
const RIGHT = 331.5; // and the bends curve outwards from them
const BEND_HOLES = 5;

// How the holes of a game to `target` are spread along the straights.
function layout(target) {
  const side = ((target - 1) / 5 - 3) / 3; // groups of five on the top and bottom straights
  const columns = 5 * (side + 1); // the middle straight is one group longer
  // Holes are one pitch apart, with an extra half pitch between groups and a
  // quarter pitch between each end of a straight and its bend.
  const pitch = (RIGHT - LEFT) / (columns - 0.5 + side / 2);
  const x = column => LEFT + (column + Math.floor(column / 5) / 2 + 0.25) * pitch;
  return { side, columns, pitch, x };
}

// The nth hole of a bend, counted from its top. `way` is 1 for a bend that
// curves out to the right and -1 for one to the left. The five holes divide
// the half-circle into six equal steps.
function bendXY(x, way, y, radius, n) {
  const angle = ((n + 1) * Math.PI) / (BEND_HOLES + 1);
  return [x + way * radius * Math.sin(angle), y - radius * Math.cos(angle)];
}

// Where hole number `hole` of a seat's lane is. Holes 0 and -1 are the two
// starting holes; `target` (or anything beyond) is the single finish hole.
export function holeXY(target, seat, hole) {
  const { side, columns, pitch, x } = layout(target);
  const [top, middle, bottom] = STRAIGHTS;
  // Seat 0 runs above the centre line on the top and bottom straights and
  // below it on the middle one; seat 1 is the mirror image.
  const offset = seat === 0 ? -LANE / 2 : LANE / 2;

  if (hole >= target) return [x(5 * side - 1) + 1.5 * pitch, bottom];
  // The top straight is right-aligned, leaving a pocket for the starting holes.
  if (hole < 1) return [x(5) - (1.5 - hole) * pitch, top + offset];

  let n = hole - 1; // steps along the track from hole 1
  if (n < 5 * side) return [x(5 + n), top + offset];
  n -= 5 * side;
  if (n < BEND_HOLES) return bendXY(RIGHT, 1, (top + middle) / 2, TURN - offset, n);
  n -= BEND_HOLES;
  if (n < columns) return [x(columns - 1 - n), middle - offset];
  n -= columns;
  if (n < BEND_HOLES) return bendXY(LEFT, -1, (middle + bottom) / 2, TURN + offset, n);
  n -= BEND_HOLES;
  return [x(n), bottom + offset];
}

// The centre line of the track as an SVG path, from the starting holes to the
// finish. Stroked BOARD.track wide with round ends, it is the band the holes
// sit in.
export function trackPath(target) {
  const [top, middle, bottom] = STRAIGHTS;
  const start = holeXY(target, 0, -1)[0].toFixed(2);
  const finish = holeXY(target, 0, target)[0].toFixed(2);
  return (
    `M${start} ${top} H${RIGHT} A${TURN} ${TURN} 0 0 1 ${RIGHT} ${middle} ` +
    `H${LEFT} A${TURN} ${TURN} 0 0 0 ${LEFT} ${bottom} H${finish}`
  );
}

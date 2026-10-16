// Fireworks and confetti for a won game, drawn on a canvas laid over the
// table. createShow() and advance() are the simulation and never touch the
// page, so they can be tested; startParty() puts a show on screen.
//
// Distances are in CSS pixels and times in seconds. Sizes and speeds follow
// the screen, so a show looks the same on a phone and a desktop.

const COLORS = ['#f6c955', '#62b5ff', '#ff7f61', '#9fe8ff', '#fffdf5', '#ff9bd2', '#b6f07a'];

const ROCKETS = 6;
const LAUNCH_GAP = 0.4; // between one rocket leaving the ground and the next
const SPARKS = 60; // in each burst
const CONFETTI_AT = 0.2; // when the confetti starts to fall
const DRAG = 1.6; // how fast sparks lose speed, per second

const between = (random, low, high) => low + (high - low) * random();

export function createShow(width, height, random = Math.random) {
  const reach = Math.min(width, height);
  // Rockets take turns on the left and right of the screen so the bursts
  // spread out, and each bursts somewhere in the upper half.
  const rockets = Array.from({ length: ROCKETS }, (_, i) => ({
    at: i * LAUNCH_GAP,
    rise: between(random, 0.6, 0.8),
    x: width * (i % 2 ? between(random, 0.5, 0.85) : between(random, 0.15, 0.5)),
    from: height + 6,
    to: height * between(random, 0.12, 0.42),
    color: COLORS[Math.floor(random() * COLORS.length)],
    burst: false,
  }));
  // One piece of confetti in each narrow strip of the width, starting at
  // different heights above the screen so they arrive over a second or so.
  const pieces = Math.round(Math.min(160, Math.max(80, width / 3.5)));
  const confetti = Array.from({ length: pieces }, (_, i) => ({
    x: ((i + random()) / pieces) * width,
    y: -height * between(random, 0, 0.25) - 12,
    fall: height * between(random, 0.27, 0.37),
    sway: between(random, 8, 22),
    swayAt: between(random, 0, 2 * Math.PI),
    swaySpeed: between(random, 1.5, 3),
    tilt: between(random, 0, Math.PI),
    spin: between(random, 0, 2 * Math.PI),
    spinSpeed: between(random, 4, 9),
    width: between(random, 7, 11),
    height: between(random, 4, 6),
    color: COLORS[Math.floor(random() * COLORS.length)],
  }));
  return { width, height, reach, random, time: 0, rockets, sparks: [], confetti };
}

function explode(show, rocket) {
  const { random, reach } = show;
  for (let i = 0; i < SPARKS; i++) {
    const angle = ((i + random()) / SPARKS) * 2 * Math.PI;
    const speed = reach * 0.5 * between(random, 0.35, 1);
    show.sparks.push({
      x: rocket.x,
      y: rocket.to,
      vx: speed * Math.cos(angle),
      vy: speed * Math.sin(angle),
      age: 0,
      life: between(random, 1, 1.4),
      color: i % 5 ? rocket.color : COLORS[4], // a few cream sparks in every burst
    });
  }
}

// Moves the show on by `seconds` and returns how many rockets burst.
export function advance(show, seconds) {
  show.time += seconds;
  let bursts = 0;
  for (const rocket of show.rockets) {
    if (rocket.burst || show.time < rocket.at + rocket.rise) continue;
    rocket.burst = true;
    bursts++;
    explode(show, rocket);
  }

  const drag = Math.exp(-DRAG * seconds);
  const gravity = show.reach * 0.3;
  for (const spark of show.sparks) {
    spark.age += seconds;
    spark.vx *= drag;
    spark.vy = spark.vy * drag + gravity * seconds;
    spark.x += spark.vx * seconds;
    spark.y += spark.vy * seconds;
  }
  show.sparks = show.sparks.filter(spark => spark.age < spark.life);

  if (show.time >= CONFETTI_AT) {
    for (const piece of show.confetti) {
      piece.y += piece.fall * seconds;
      piece.swayAt += piece.swaySpeed * seconds;
      piece.spin += piece.spinSpeed * seconds;
    }
    show.confetti = show.confetti.filter(piece => piece.y < show.height + 20);
  }
  return bursts;
}

export const isOver = show => show.rockets.every(rocket => rocket.burst) && !show.sparks.length && !show.confetti.length;

export function drawShow(show, context) {
  context.clearRect(0, 0, show.width, show.height);
  context.lineCap = 'round';
  context.lineWidth = 2.5;
  // Light adds up where sparks cross, as it does in the sky.
  context.globalCompositeOperation = 'lighter';
  for (const rocket of show.rockets) {
    const progress = (show.time - rocket.at) / rocket.rise;
    if (rocket.burst || progress < 0) continue;
    const y = rocket.from + (rocket.to - rocket.from) * (1 - (1 - progress) ** 2); // slowing as it climbs
    context.globalAlpha = 1;
    context.strokeStyle = rocket.color;
    context.beginPath();
    context.moveTo(rocket.x, y + 22);
    context.lineTo(rocket.x, y);
    context.stroke();
  }
  // Each spark is a streak behind a brighter head.
  for (const spark of show.sparks) {
    context.globalAlpha = 1 - (spark.age / spark.life) ** 2;
    context.strokeStyle = spark.color;
    context.fillStyle = spark.color;
    context.beginPath();
    context.moveTo(spark.x - spark.vx * 0.08, spark.y - spark.vy * 0.08);
    context.lineTo(spark.x, spark.y);
    context.stroke();
    context.beginPath();
    context.arc(spark.x, spark.y, 1.8, 0, 2 * Math.PI);
    context.fill();
  }

  context.globalCompositeOperation = 'source-over';
  context.globalAlpha = 1;
  for (const piece of show.confetti) {
    context.save();
    context.translate(piece.x + piece.sway * Math.sin(piece.swayAt), piece.y);
    context.rotate(piece.tilt);
    context.scale(1, Math.cos(piece.spin)); // turning over as it falls
    context.fillStyle = piece.color;
    context.fillRect(-piece.width / 2, -piece.height / 2, piece.width, piece.height);
    context.restore();
  }
}

// Runs a show on `canvas`, calling onBurst() as each rocket bursts. It stops
// and clears the canvas by itself once the last piece of confetti has landed.
export function startParty(canvas, onBurst = () => {}) {
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const show = createShow(innerWidth, innerHeight);
  canvas.width = Math.round(innerWidth * ratio);
  canvas.height = Math.round(innerHeight * ratio);
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);

  let frame = 0;
  let last = null;
  let stopped = false;
  function tick(now) {
    if (stopped) return;
    // A step is capped, so a show in a hidden tab carries on where it was.
    const seconds = last === null ? 0 : Math.min(0.05, (now - last) / 1000);
    last = now;
    for (let bursts = advance(show, seconds); bursts > 0; bursts--) onBurst();
    if (isOver(show)) {
      stop();
      return;
    }
    drawShow(show, context);
    frame = requestAnimationFrame(tick);
  }
  function stop() {
    stopped = true;
    cancelAnimationFrame(frame);
    canvas.width = 0; // clears it and frees the memory
    canvas.height = 0;
  }
  frame = requestAnimationFrame(tick);
  return { stop };
}

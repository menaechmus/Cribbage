// Sound effects, made on the spot with the Web Audio API so the game ships no
// audio files. Every effect is built from two ingredients: a burst of filtered
// noise (paper sliding, a card snapping down) and a short tone (a peg, a chime).

const noiseByContext = new WeakMap();

function noiseFor(context) {
  let buffer = noiseByContext.get(context);
  if (!buffer) {
    buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    noiseByContext.set(context, buffer);
  }
  return buffer;
}

// Fades a gain node in fast and out by `at + length`.
function shape(level, at, length, gain) {
  level.gain.setValueAtTime(0.0001, at);
  level.gain.exponentialRampToValueAtTime(gain, at + Math.min(0.004, length / 3));
  level.gain.exponentialRampToValueAtTime(0.0001, at + length);
}

// `sweep` slides the pitch over the burst: above 1 rises, like a card pulled
// across felt; below 1 falls, like one landing.
function burst(context, at, { length, pitch, sweep = 1, gain }) {
  const source = context.createBufferSource();
  source.buffer = noiseFor(context);
  const filter = context.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(pitch, at);
  filter.frequency.exponentialRampToValueAtTime(pitch * sweep, at + length);
  const level = context.createGain();
  shape(level, at, length, gain);
  source.connect(filter).connect(level).connect(context.destination);
  source.start(at, Math.random() * 0.5, length + 0.01);
}

function tone(context, at, { length, pitch, glide = 1, gain, wave = 'sine' }) {
  const oscillator = context.createOscillator();
  oscillator.type = wave;
  oscillator.frequency.setValueAtTime(pitch, at);
  oscillator.frequency.exponentialRampToValueAtTime(pitch * glide, at + length);
  const level = context.createGain();
  shape(level, at, length, gain);
  oscillator.connect(level).connect(context.destination);
  oscillator.start(at);
  oscillator.stop(at + length + 0.01);
}

const EFFECTS = {
  // Two riffles of the deck, then the cards squared up.
  shuffle(context, at) {
    for (const start of [0, 0.28]) {
      for (let t = 0; t < 0.2; t += 0.008 + Math.random() * 0.006) {
        burst(context, at + start + t, { length: 0.012, pitch: 2400 + Math.random() * 2400, gain: 0.5 + Math.random() * 0.4 });
      }
    }
    burst(context, at + 0.5, { length: 0.09, pitch: 1400, sweep: 0.6, gain: 0.8 });
  },

  deal(context, at) {
    burst(context, at, { length: 0.07, pitch: 2200, sweep: 1.7, gain: 0.7 });
  },

  // A card pushed to the crib.
  slide(context, at) {
    burst(context, at, { length: 0.12, pitch: 1500, sweep: 2, gain: 0.8 });
  },

  // A card laid on the table: a snap with a little weight under it.
  place(context, at) {
    burst(context, at, { length: 0.045, pitch: 3200, sweep: 0.6, gain: 0.9 });
    tone(context, at, { length: 0.07, pitch: 170, glide: 0.5, gain: 0.3 });
  },

  // The starter turned over.
  flip(context, at) {
    burst(context, at, { length: 0.05, pitch: 1800, sweep: 2.2, gain: 0.7 });
    burst(context, at + 0.07, { length: 0.04, pitch: 3400, sweep: 0.6, gain: 0.8 });
  },

  // A peg dropping into its hole.
  peg(context, at) {
    tone(context, at, { length: 0.06, pitch: 880, glide: 0.7, gain: 0.25, wave: 'triangle' });
    burst(context, at, { length: 0.015, pitch: 4200, gain: 0.5 });
  },

  win(context, at) {
    [523, 659, 784, 1047].forEach((pitch, i) => tone(context, at + i * 0.1, { length: 0.3, pitch, gain: 0.2, wave: 'triangle' }));
  },

  lose(context, at) {
    [392, 330, 262].forEach((pitch, i) => tone(context, at + i * 0.14, { length: 0.32, pitch, gain: 0.2, wave: 'triangle' }));
  },
};

export const SOUNDS = Object.keys(EFFECTS);

// Schedules one effect on any audio context; the tests use an offline one.
export function renderSound(name, context, at = context.currentTime) {
  EFFECTS[name](context, at);
}

let context = null;
let muted = false;
let waking = false;

export function setMuted(value) {
  muted = value;
}

// Browsers only let a page make sound after a tap or key press, so this is
// called from every one of those.
export function unlockSound() {
  if (muted || !window.AudioContext) return;
  context ??= new AudioContext();
  if (context.state === 'running' || waking) return;
  waking = true;
  context
    .resume()
    .catch(() => {})
    .then(() => {
      waking = false;
    });
}

export function playSound(name, delay = 0) {
  // A suspended context would hoard sounds and play them all at once on waking.
  if (muted || !context || (context.state !== 'running' && !waking)) return;
  try {
    renderSound(name, context, context.currentTime + delay);
  } catch {
    // Sound is decoration: a browser that cannot make it must not stop the game.
  }
}

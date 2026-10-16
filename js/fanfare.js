// The fanfare for a win: an original tune (C, C-C-C, D C D, E, sent in as a
// piano recording) arranged for a brass ensemble with timpani, made on the
// spot with the Web Audio API like the other sounds.
//
// What makes synthesized brass sound artificial is sameness: every note the
// same, perfectly in tune, starting together, in a dead room. So each part
// here has two or three players, slightly out of tune with one another and a
// few milliseconds apart; each note scoops up into pitch with a breath of
// air; louder notes are brighter; long notes get vibrato; and it all plays in
// a generated hall.

const SECTIONS = {
  // bright: how far the tone opens, in multiples of the pitch. formant: the
  // body resonance of the instrument. scoop: cents below pitch a note starts.
  // gain: the balance between sections, trumpets leading as in a fanfare.
  trumpet: { players: 3, bright: 8, attack: 0.03, scoop: 30, formant: 1400, vibrato: 12, gain: 1.4 },
  horn: { players: 3, bright: 3, attack: 0.06, scoop: 20, formant: 500, vibrato: 7, gain: 0.7 },
  trombone: { players: 2, bright: 5, attack: 0.045, scoop: 25, formant: 650, vibrato: 7, gain: 0.65 },
  tuba: { players: 2, bright: 3.5, attack: 0.06, scoop: 15, formant: 300, vibrato: 5, gain: 0.55 },
};

const LEVEL = 0.55; // the whole ensemble, next to the game's other sounds

const frequency = midi => 440 * 2 ** ((midi - 69) / 12);

// ---- The tune and its arrangement ---------------------------------------

const BPM = 200; // three beats to the bar
// The tune an octave above the recording, where trumpets shine: [note,
// beat it starts on, beats it lasts, how hard it is played].
const TUNE = [
  [72, 0, 1.2, 0.85], [72, 1.5, 0.4, 0.75], [72, 2, 0.28, 0.65], [72, 2.33, 0.55, 0.95],
  [74, 3, 0.75, 0.9], [72, 4, 0.75, 0.85], [74, 5, 0.75, 0.9],
  [76, 6, 4, 1],
];
const SECOND = [67, 67, 67, 67, 71, 67, 71, 72]; // a second trumpet below it
// The chords: C under the four Cs, then G, C (with E in the bass) and G7
// under D C D, and C for the long E. Notes for each of the lower parts.
const LOW = ['horn', 'horn', 'trombone', 'trombone', 'tuba'];
const CHORDS = [
  [64, 60, 55, 48, 36],
  [62, 59, 50, 43, 31],
  [64, 60, 55, 52, 40],
  [65, 59, 50, 43, 31],
  [67, 64, 55, 48, 36],
];

function score() {
  const parts = [
    { section: 'trumpet', notes: TUNE },
    { section: 'trumpet', players: 2, notes: TUNE.map(([, beat, beats, level], i) => [SECOND[i], beat, beats, level * 0.85]) },
    // Oom-pah-pah under the first bar (the two lowest parts on the beat, the
    // others answering off it), a short chord on each beat of the second,
    // then everyone holds the last chord.
    ...LOW.map((section, voice) => {
      const home = CHORDS[0][voice];
      const notes = voice < 3 ? [[home, 1, 0.45, 0.65], [home, 2, 0.45, 0.65]] : [[home, 0, 0.6, 0.85]];
      for (const beat of [3, 4, 5]) notes.push([CHORDS[beat - 2][voice], beat, 0.7, 0.8]);
      notes.push([CHORDS[4][voice], 6, 4, 0.95]);
      return { section, players: 2, notes };
    }),
    // A quick run up in the horns into the last chord.
    { section: 'horn', players: 2, notes: [[67, 5.5, 0.15, 0.8], [69, 5.667, 0.15, 0.85], [71, 5.833, 0.15, 0.9]] },
  ];
  // Timpani on the strong beats, then a roll under the last chord that ends
  // with a stroke as the brass cut off: [note, beat, how hard].
  const drums = [[48, 0, 0.85], [43, 3, 0.8], [48, 4, 0.75], [43, 5, 0.8], [48, 9.85, 1]];
  const roll = { midi: 48, beat: 6, beats: 3.7, from: 0.3, to: 0.9 };
  return { parts, drums, roll };
}

// ---- The room -----------------------------------------------------------

// A stereo tail of noise that darkens as it fades, about 1.8 s to silence.
// Made once per audio context, like the noise buffer.
const hallByContext = new WeakMap();

function hallFor(context) {
  let hall = hallByContext.get(context);
  if (!hall) {
    const rate = context.sampleRate;
    const length = Math.round(1.8 * rate);
    const buffer = context.createBuffer(2, length, rate);
    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      let low = 0;
      for (let i = 0; i < length; i++) {
        const t = i / rate;
        low += (0.55 * Math.exp(-1.8 * t) + 0.04) * (Math.random() * 2 - 1 - low);
        data[i] = low * Math.exp(-3.8 * t) * Math.min(1, t / 0.01);
      }
    }
    hall = context.createConvolver();
    hall.buffer = buffer;
    const wet = context.createGain();
    wet.gain.value = 0.32;
    hall.connect(wet).connect(context.destination);
    hallByContext.set(context, hall);
  }
  return hall;
}

// Where the ensemble plays into: a gentle compressor that holds the voices
// together and keeps the peak down, heard directly and through the hall.
function stage(context) {
  const input = context.createGain();
  input.gain.value = LEVEL;
  const squeeze = context.createDynamicsCompressor();
  squeeze.threshold.value = -14;
  squeeze.ratio.value = 3;
  squeeze.attack.value = 0.01;
  squeeze.release.value = 0.25;
  input.connect(squeeze);
  squeeze.connect(context.destination);
  squeeze.connect(hallFor(context));
  return input;
}

// ---- The instruments ----------------------------------------------------

// One note played by a whole section. `level` 0–1 is how hard they play.
function brassNote(context, out, noise, at, { section, players, midi, length, level }) {
  const s = SECTIONS[section];
  const pitch = frequency(midi);
  length = Math.max(length, s.attack + 0.04);
  const body = context.createBiquadFilter();
  body.type = 'peaking';
  body.frequency.value = s.formant;
  body.Q.value = 1.2;
  body.gain.value = 6;
  body.connect(out);

  const count = players ?? s.players;
  for (let player = 0; player < count; player++) {
    const start = at + Math.random() * 0.018;
    const end = start + length;
    const cents = (Math.random() * 2 - 1) * 7;
    const peak = (0.07 * s.gain * level) / Math.sqrt(count);

    const oscillator = context.createOscillator();
    oscillator.type = 'sawtooth';
    oscillator.frequency.value = pitch;
    oscillator.detune.setValueAtTime(cents - s.scoop, start);
    oscillator.detune.linearRampToValueAtTime(cents, start + 0.05);

    // The tone opens as the note speaks, settles, and closes as it ends.
    const top = Math.min(9000, pitch * s.bright * (0.55 + 0.45 * level));
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.8;
    filter.frequency.setValueAtTime(pitch * 1.1, start);
    filter.frequency.exponentialRampToValueAtTime(top, start + s.attack);
    filter.frequency.exponentialRampToValueAtTime(top * 0.65, start + s.attack + 0.03);
    filter.frequency.setValueAtTime(top * 0.65, end);
    filter.frequency.exponentialRampToValueAtTime(pitch * 1.1, end + 0.12);

    const amp = context.createGain();
    amp.gain.setValueAtTime(0.0001, start);
    amp.gain.exponentialRampToValueAtTime(peak, start + s.attack);
    amp.gain.exponentialRampToValueAtTime(peak * 0.72, start + s.attack + 0.03);
    amp.gain.setValueAtTime(peak * 0.72, end);
    amp.gain.exponentialRampToValueAtTime(0.0001, end + 0.12);

    oscillator.connect(filter).connect(amp).connect(body);
    oscillator.start(start);
    oscillator.stop(end + 0.15);

    // Long notes waver a little once they are under way.
    if (length > 0.45) {
      const lfo = context.createOscillator();
      lfo.frequency.value = 4.8 + Math.random() * 0.8;
      const depth = context.createGain();
      depth.gain.setValueAtTime(0, start);
      depth.gain.setValueAtTime(0, start + 0.25);
      depth.gain.linearRampToValueAtTime(s.vibrato, end);
      lfo.connect(depth).connect(oscillator.detune);
      lfo.start(start);
      lfo.stop(end + 0.15);
    }

    // A breath of air as the note starts.
    const air = context.createBufferSource();
    air.buffer = noise;
    const band = context.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = Math.min(6000, pitch * 3);
    band.Q.value = 1.5;
    const puff = context.createGain();
    puff.gain.setValueAtTime(0.0001, start);
    puff.gain.exponentialRampToValueAtTime(peak * 0.5, start + 0.01);
    puff.gain.exponentialRampToValueAtTime(0.0001, start + 0.07);
    air.connect(band).connect(puff).connect(body);
    air.start(start, Math.random() * 0.5, 0.08);
  }
}

// A kettledrum stroke: a tuned thud whose overtones die away faster than the
// note, with the soft knock of the mallet.
function timpani(context, out, noise, at, midi, level) {
  const pitch = frequency(midi);
  for (const [ratio, gain, decay] of [[1, 1, 1.6], [1.5, 0.45, 0.9], [1.99, 0.25, 0.6], [2.44, 0.12, 0.4]]) {
    const oscillator = context.createOscillator();
    oscillator.frequency.setValueAtTime(pitch * ratio * 1.015, at);
    oscillator.frequency.exponentialRampToValueAtTime(pitch * ratio, at + 0.08);
    const amp = context.createGain();
    amp.gain.setValueAtTime(0.0001, at);
    amp.gain.exponentialRampToValueAtTime(0.12 * level * gain, at + 0.005);
    amp.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    oscillator.connect(amp).connect(out);
    oscillator.start(at);
    oscillator.stop(at + decay + 0.01);
  }
  const mallet = context.createBufferSource();
  mallet.buffer = noise;
  const low = context.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.value = 700;
  const knock = context.createGain();
  knock.gain.setValueAtTime(0.0001, at);
  knock.gain.exponentialRampToValueAtTime(0.14 * level, at + 0.003);
  knock.gain.exponentialRampToValueAtTime(0.0001, at + 0.04);
  mallet.connect(low).connect(knock).connect(out);
  mallet.start(at, Math.random() * 0.5, 0.05);
}

// Plays the fanfare from `at`. `noise` is a buffer of white noise, for the
// players' breath and the mallets.
export function playFanfare(context, at, noise) {
  const out = stage(context);
  const beat = 60 / BPM;
  const { parts, drums, roll } = score();
  for (const { section, players, notes } of parts) {
    for (const [midi, start, beats, level] of notes) {
      brassNote(context, out, noise, at + start * beat, { section, players, midi, length: beats * beat, level });
    }
  }
  for (const [midi, start, level] of drums) timpani(context, out, noise, at + start * beat, midi, level);
  // The roll: quick strokes swelling from one level to the other.
  for (let t = 0; t < roll.beats * beat; t += 0.05 + Math.random() * 0.012) {
    const level = (roll.from + ((roll.to - roll.from) * t) / (roll.beats * beat)) * (0.85 + Math.random() * 0.3);
    timpani(context, out, noise, at + roll.beat * beat + t, roll.midi, level);
  }
}

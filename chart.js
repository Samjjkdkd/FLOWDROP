const modes = {
  Easy: { gap: .29, threshold: 2.4, hold: .70 },
  Normal: { gap: .17, threshold: 1.7, hold: .55 },
  Hard: { gap: .105, threshold: 1.15, hold: .48 }
};

function chart(buffer, difficulty) {
  const mode = modes[difficulty];
  const input = buffer.getChannelData(0);
  const rate = buffer.sampleRate;
  const stride = Math.max(1, Math.floor(rate / 12000));
  const hop = Math.round(rate * .02);
  const frames = [];
  let bass = 0, lowMid = 0, previous = [0, 0, 0];
  for (let start = 0; start + hop <= input.length; start += hop) {
    const energy = [0, 0, 0];
    for (let i = start; i < start + hop; i += stride) {
      bass += .07 * (input[i] - bass);
      lowMid += .36 * (input[i] - lowMid);
      energy[0] += bass * bass;
      energy[1] += (lowMid - bass) ** 2;
      energy[2] += (input[i] - lowMid) ** 2;
    }
    const bands = energy.map(value => Math.log1p(value * 25));
    const attack = bands.reduce((sum, value, band) =>
      sum + Math.max(0, value - previous[band]) * [1.45, 1.15, .75][band], 0);
    frames.push({ time: start / rate, attack, bass: bands[0], energy: bands.reduce((a, b) => a + b) });
    previous = bands;
  }

  const notes = [];
  const lanes = [1, 4, 0, 5, 2, 3];
  const freeAt = Array(6).fill(0);
  let last = -Infinity, lastHold = -Infinity, lastChord = -Infinity;
  let recent = 0;
  for (let i = 0; i < frames.length - 1; i++) {
    const f = frames[i];
    const before = frames[i - 1]?.attack ?? 0;
    const threshold = Math.max(.07, recent * mode.threshold);
    recent = recent * .94 + f.attack * .06;
    if (f.attack < threshold || f.attack < before || f.attack <= frames[i + 1].attack ||
        f.time - last < mode.gap || f.time > buffer.duration - .12) continue;
    const lane = Array.from({ length: 6 }, (_, j) => lanes[(notes.length + j) % 6])
      .find(candidate => freeAt[candidate] <= f.time);
    if (lane === undefined) continue;

    let duration = 0;
    if (f.time - lastHold > 3 && f.bass > .6) {
      let tail = i + 1;
      while (tail < frames.length && tail - i < 48 &&
             frames[tail].bass > f.bass * .6 && frames[tail].energy > f.energy * .6) tail++;
      const length = (tail - i) * hop / rate;
      if (length >= mode.hold && f.time + length < buffer.duration) {
        duration = length;
        lastHold = f.time;
      }
    }
    notes.push({ time: f.time, lane, duration });
    freeAt[lane] = f.time + duration + .16;
    last = f.time;
    const allowChord = (difficulty === 'Hard' && notes.length % 7 === 0) ||
      (difficulty === 'Normal' && !duration && f.time - lastChord >= 1.4);
    if (allowChord && f.attack > threshold * 2) {
      const opposite = (lane + 3) % 6;
      if (freeAt[opposite] <= f.time) {
        notes.push({ time: f.time, lane: opposite, duration: 0 });
        freeAt[opposite] = f.time + .16;
        lastChord = f.time;
      }
    }
  }
  return notes;
}

function practice(context) {
  const rate = context.sampleRate;
  const buffer = context.createBuffer(1, rate * 17, rate);
  const samples = buffer.getChannelData(0);
  let seed = 17;
  for (let beat = 0; beat < 32; beat++) {
    for (const [offset, kind] of [[0, beat % 2 ? 'snare' : 'kick'], [.25, 'hat']]) {
      const start = Math.round((.5 + beat * .5 + offset) * rate);
      for (let i = 0; i < rate * .14; i++) {
        const t = i / rate;
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const noise = seed / 2147483648 - 1;
        samples[start + i] += kind === 'kick'
          ? .8 * Math.sin(2 * Math.PI * (45 * t + 2 * (1 - Math.exp(-35 * t)))) * Math.exp(-29 * t)
          : noise * (kind === 'snare' ? .5 * Math.exp(-38 * t) : .16 * Math.exp(-115 * t));
      }
    }
  }
  return buffer;
}

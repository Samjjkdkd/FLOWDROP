const modes = {
  Easy: { gap: .29, threshold: 2.4, hold: .70 },
  Normal: { gap: .17, threshold: 1.7, hold: .55, chord: 3.6 },
  Hard: { gap: .105, threshold: 1.15, hold: .48, chord: 2.9 }
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
    frames.push({ time: start / rate, attack, low: energy[0], body: energy[1] + energy[2], mid: energy[1] });
    previous = bands;
  }

  const intensity = sectionIntensity(frames, hop / rate);
  const notes = [];
  const lanes = [1, 4, 0, 5, 2, 3];
  const freeAt = Array(6).fill(0);
  let last = -Infinity, lastHold = -Infinity, holdEnd = -Infinity;
  let recent = 0;
  for (let i = 0; i < frames.length - 1; i++) {
    const f = frames[i];
    const before = frames[i - 1]?.attack ?? 0;
    const drive = intensity[i];
    const density = 1.35 - drive * .7;
    const threshold = Math.max(.07, recent * mode.threshold * density);
    recent = recent * .94 + f.attack * .06;
    if (f.attack < threshold || f.attack < before || f.attack <= frames[i + 1].attack ||
        f.time - last < mode.gap * density || f.time > buffer.duration - .12) continue;
    const lane = Array.from({ length: 6 }, (_, j) => lanes[(notes.length + j) % 6])
      .find(candidate => freeAt[candidate] <= f.time);
    if (lane === undefined) continue;

    let duration = 0;
    if (f.time - lastHold > 3) {
      duration = sustainLength(frames, i, hop / rate, mode.hold);
      if (f.time + duration >= buffer.duration) duration = 0;
      if (duration) {
        lastHold = f.time;
        holdEnd = f.time + duration;
      }
    }
    notes.push({ time: f.time, lane, duration });
    freeAt[lane] = f.time + duration + .16;
    last = f.time;
    // A held key plus one tap already uses both available fingers.
    if (mode.chord && f.time >= holdEnd + .08 &&
        f.attack > Math.max(.22, recent * mode.chord * (1.35 - drive * .65))) {
      const opposite = (lane + 3) % 6;
      if (freeAt[opposite] <= f.time) {
        notes.push({ time: f.time, lane: opposite, duration: 0 });
        freeAt[opposite] = f.time + .16;
      }
    }
  }
  return notes;
}

function sectionIntensity(frames, step) {
  if (!frames.length) return [];
  const radius = Math.round(2 / step);
  const energy = [0];
  const attacks = [0];
  for (const frame of frames) {
    energy.push(energy.at(-1) + Math.log1p(frame.low + frame.body));
    attacks.push(attacks.at(-1) + Math.min(3, frame.attack));
  }
  const sections = frames.map((_, i) => {
    const start = Math.max(0, i - radius);
    const end = Math.min(frames.length, i + radius + 1);
    return [(energy[end] - energy[start]) / (end - start),
      (attacks[end] - attacks[start]) / (end - start)];
  });
  const scales = [0, 1].map(band => {
    const values = sections.map(section => section[band]).sort((a, b) => a - b);
    const low = values[Math.floor((values.length - 1) * .2)];
    const high = values[Math.floor((values.length - 1) * .85)];
    return {low, range: high - low};
  });
  return sections.map(section => {
    const [loudness, activity] = scales.map(({low, range}, band) =>
      range < .015 ? .5 : Math.max(0, Math.min(1, (section[band] - low) / range)));
    return loudness * .45 + activity * .55;
  });
}

function sustainLength(frames, start, step, minimum) {
  // Compare the sound after the attack with the few frames before it.
  const attack = frames.slice(start, start + 5);
  if (attack.length < 5) return 0;
  const body = attack.reduce((sum, frame) => sum + frame.body, 0) / attack.length;
  const mid = attack.reduce((sum, frame) => sum + frame.mid, 0) / attack.length;
  const leadIn = frames.slice(Math.max(0, start - 5), start);
  const baseline = leadIn.reduce((sum, frame) => sum + frame.body, 0) / Math.max(1, leadIn.length);
  const low = attack.reduce((sum, frame) => sum + frame.low, 0) / attack.length;
  if (body < low * .65 || body < .025 || mid < body * .25 || body < baseline * 2.5) return 0;

  // A brief dip is fine. A fresh attack or a sustained drop ends the hold.
  const limit = Math.min(frames.length, start + Math.round(1.6 / step));
  let end = start + 4;
  for (let i = start + 5; i < limit; i++) {
    const frame = frames[i];
    if (frame.attack > Math.max(1, frames[start].attack * .75)) break;
    if (frame.body >= body * .20 && frame.mid >= mid * .16) {
      end = i;
    } else if (i - end >= 3) {
      break;
    }
  }
  const length = (end + 1 - start) * step;
  return length >= minimum ? length : 0;
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

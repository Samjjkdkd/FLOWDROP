const modes = {
  Easy: { gap: .29, threshold: 2.4, hold: .66 },
  Normal: { gap: .22, threshold: 2.05, hold: .50, doubleHold: .76, chord: 3.6, peak: 5.5 },
  Hard: { gap: .105, threshold: 1.15, hold: .44, doubleHold: .62, chord: 2.9, peak: 7.5 }
};

const chartDefaults = {sectionWindow: 8};

const laneOrders = {
  2: [0, 1],
  4: [0, 3, 1, 2],
  6: [1, 4, 0, 5, 2, 3],
  8: [1, 6, 2, 5, 0, 7, 3, 4]
};

const analyzedTracks = new WeakMap();

function analyzeTrack(buffer) {
  const cached = analyzedTracks.get(buffer);
  if (cached) return cached;
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
    const drum = 1.6 * Math.max(0, bands[0] - previous[0]) +
      .45 * Math.max(0, bands[2] - previous[2]);
    frames.push({ time: start / rate, attack, drum, low: energy[0], body: energy[1] + energy[2], mid: energy[1] });
    previous = bands;
  }

  const step = hop / rate;
  const attacks = frames.filter((f, i) => f.attack > .07 &&
    f.attack >= (frames[i - 1]?.attack ?? 0) && f.attack > (frames[i + 1]?.attack ?? 0))
    .map(f => f.attack).sort((a, b) => a - b);
  const attackFloor = attacks[Math.floor(attacks.length * .73)] ?? 0;
  const result = {frames, step, beat: estimateBeat(frames), attackFloor};
  analyzedTracks.set(buffer, result);
  return result;
}

function estimateBeat(frames) {
  if (frames.length < 200) return null;
  const strengths = frames.map(f => f.drum).sort((a, b) => a - b);
  const floor = Math.max(.12, strengths[Math.floor(strengths.length * .85)]);
  const peaks = frames.filter((f, i) => f.drum >= floor &&
    f.drum >= (frames[i - 1]?.drum ?? 0) && f.drum > (frames[i + 1]?.drum ?? 0));
  if (peaks.length < 10) return null;
  const limit = peaks.map(f => f.drum).sort((a, b) => a - b)[Math.floor(peaks.length * .85)];
  const weights = peaks.map(f => Math.min(limit, f.drum));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  function fit(bpm) {
    const spacing = 30 / bpm;
    let cosine = 0, sine = 0, pulseCosine = 0, pulseSine = 0;
    for (let i = 0; i < peaks.length; i++) {
      const angle = 2 * Math.PI * peaks[i].time / spacing;
      cosine += weights[i] * Math.cos(angle);
      sine += weights[i] * Math.sin(angle);
      pulseCosine += weights[i] * Math.cos(angle / 2);
      pulseSine += weights[i] * Math.sin(angle / 2);
    }
    const confidence = Math.hypot(cosine, sine) / total;
    return {bpm, spacing, phase: Math.atan2(sine, cosine) * spacing / (2 * Math.PI), confidence,
      score: confidence + .30 * Math.hypot(pulseCosine, pulseSine) / total - .07 * Math.abs(Math.log2(bpm / 120))};
  }
  let best = fit(120);
  for (let bpm = 72; bpm <= 180; bpm++) {
    const candidate = fit(bpm);
    if (candidate.score > best.score) best = candidate;
  }
  const coarse = best.bpm;
  for (let bpm = coarse - 1; bpm <= coarse + 1; bpm += .05) {
    const candidate = fit(bpm);
    if (candidate.score > best.score) best = candidate;
  }
  return best.confidence >= .26 ? best : null;
}

function gridDistance(time, beat) {
  const relative = (time - beat.phase) / beat.spacing;
  return Math.abs(relative - Math.round(relative)) * beat.spacing;
}

function chart(buffer, difficulty, settings = {modes, ...chartDefaults}, laneCount = 6) {
  const mode = settings.modes[difficulty];
  const {frames, step, beat, attackFloor} = analyzeTrack(buffer);
  const intensity = sectionIntensity(frames, step, settings.sectionWindow);
  const notes = [];
  const recentStarts = [];
  const lanes = laneOrders[laneCount];
  const half = laneCount / 2;
  const freeAt = Array(laneCount).fill(0);
  let last = -Infinity, lastHold = -Infinity, holdEnd = -Infinity;
  let holdLane = -1, pairedHold = false, lastDoubleHold = -Infinity;
  let recent = 0, starts = 0, chords = 0;
  for (let i = 0; i < frames.length - 1; i++) {
    const f = frames[i];
    const before = frames[i - 1]?.attack ?? 0;
    const drive = intensity[i];
    const density = 1.35 - drive * .7;
    const relativeFloor = attackFloor * (.55 + mode.threshold * .25);
    const threshold = Math.max(.07, relativeFloor, recent * mode.threshold * density);
    recent = recent * .94 + f.attack * .06;
    const onGrid = beat && gridDistance(f.time, beat) <= Math.min(.043, beat.spacing * .19);
    const drumAttack = f.drum >= f.attack * .45;
    const thresholdScale = beat && drumAttack ? (onGrid ? .79 : 1.34) : 1;
    if (f.attack < threshold * thresholdScale || f.attack < before || f.attack <= frames[i + 1].attack ||
        f.time - last < mode.gap * density || f.time > buffer.duration - .12) continue;
    // Charge 1 for a single start and 1.5 for a two-key chord.
    const peak = mode.peak;
    while (recentStarts.length && f.time - recentStarts[0].time >= 1) recentStarts.shift();
    const load = recentStarts.reduce((sum, start) => sum + start.weight, 0);
    if (peak && load + 1 > peak) continue;
    const holding = f.time < holdEnd;
    if (holding && pairedHold) continue;
    const tick = beat ? Math.round((f.time - beat.phase) / beat.spacing) : starts;
    const phrase = Math.max(0, Math.floor(tick / 32));
    const useGrid = onGrid && drumAttack;
    const position = useGrid ? tick + (tick % 32 >= 24 ? Math.floor(tick / 2) : 0) : starts;
    const firstLane = ((position + phrase % 2 * half) % laneCount + laneCount) % laneCount;
    const lane = Array.from({ length: laneCount }, (_, j) => lanes[(firstLane + j) % laneCount])
      .find(candidate => freeAt[candidate] <= f.time &&
        (!holding || (candidate < half) !== (holdLane < half)));
    if (lane === undefined) continue;

    let duration = 0;
    if (!holding && f.time - lastHold >= (mode.chord ? 1.8 : 3)) {
      const shortMinimum = beat && mode.chord && !drumAttack
        ? Math.min(mode.hold, Math.max(.16, beat.spacing * .8))
        : mode.hold;
      duration = sustainLength(frames, i, step, shortMinimum, beat);
      if (f.time + duration >= buffer.duration) duration = 0;
    }
    notes.push({ time: f.time, lane, duration });
    freeAt[lane] = f.time + duration + .16;
    last = f.time;
    starts++;
    let weight = 1;
    const targetChordShare = .27 - drive * .09;
    const chordDue = chords < starts * targetChordShare;
    const chordAttack = f.attack > Math.max(.14, recent * mode.chord * (onGrid ? .60 : .82));
    // A held key plus one tap already uses both available fingers.
    pairedHold = holding && pairedHold;
    if (mode.chord && chordDue && chordAttack && load + 1.5 <= peak && f.time >= holdEnd + .08 &&
        (!duration || (f.time - lastDoubleHold >= 12 &&
          duration >= mode.doubleHold && f.attack > threshold * 3.2))) {
      const opposite = (lane + half) % laneCount;
      if (freeAt[opposite] <= f.time) {
        notes.push({ time: f.time, lane: opposite, duration });
        freeAt[opposite] = f.time + duration + .16;
        pairedHold = duration > 0;
        if (pairedHold) lastDoubleHold = f.time;
        weight = 1.5;
        chords++;
      }
    }
    if (duration) {
      lastHold = f.time;
      holdEnd = f.time + duration;
      holdLane = lane;
    }
    if (peak) recentStarts.push({time: f.time, weight});
  }
  return notes;
}

function sectionIntensity(frames, step, windowSeconds) {
  if (!frames.length) return [];
  const radius = Math.round(windowSeconds / (2 * step));
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

function sustainLength(frames, start, step, minimum, beat = null) {
  // Compare the sound after the attack with the few frames before it.
  const attack = frames.slice(start, start + 5);
  if (attack.length < 5) return 0;
  const body = attack.reduce((sum, frame) => sum + frame.body, 0) / attack.length;
  const mid = attack.reduce((sum, frame) => sum + frame.mid, 0) / attack.length;
  const leadIn = frames.slice(Math.max(0, start - 5), start);
  const baseline = leadIn.reduce((sum, frame) => sum + frame.body, 0) / Math.max(1, leadIn.length);
  const low = attack.reduce((sum, frame) => sum + frame.low, 0) / attack.length;
  if (body < low * .65 || body < .018 || mid < body * .22 || body < baseline * 1.85) return 0;

  // Track the part of the sound above the pre-attack mix.
  const bodyFloor = baseline + (body - baseline) * .34;
  const midFloor = mid * .30;
  const limit = Math.min(frames.length, start + Math.floor(1.3 / step));
  let end = start + 4;
  let recentAttack = 0;
  for (let i = start + 5; i < limit; i++) {
    const frame = frames[i];
    const elapsed = (i - start) * step;
    const peak = frame.attack >= frames[i - 1].attack &&
      frame.attack > (frames[i + 1]?.attack ?? 0);
    const newAttack = frame.attack >= Math.max(.65, frames[start].attack * .28, recentAttack * 3);
    const beatBoundary = beat && gridDistance(frame.time, beat) <= step;
    const rhythmicAttack = beatBoundary && frame.drum >= .30 && frame.attack >= recentAttack * 2;
    if (elapsed >= minimum && peak && (newAttack || rhythmicAttack)) return elapsed;
    recentAttack = recentAttack * .9 + frame.attack * .1;
    if (frame.attack > Math.max(1.4, frames[start].attack * .9) && frame.mid < mid * .55) break;
    if (frame.body >= bodyFloor && frame.mid >= midFloor) {
      end = i;
    } else if (i - end >= 3) {
      break;
    }
  }
  const length = (end + 1 - start) * step;
  if (length < minimum) return 0;
  if (!beat) return length;
  // A nearby subdivision can finish the hold slightly early, without extending past decay.
  const tailTime = frames[start].time + length;
  const subdivision = beat.spacing / 2;
  const gridTail = beat.phase + Math.floor((tailTime - beat.phase) / subdivision) * subdivision;
  const aligned = gridTail - frames[start].time;
  return aligned >= minimum && length - aligned <= .035 ? aligned : length;
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

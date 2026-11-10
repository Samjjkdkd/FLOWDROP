const $ = id => document.getElementById(id);
const defaultBindings = {
  2: ['KeyF', 'KeyJ'],
  4: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'],
  6: ['KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL'],
  8: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon']
};
const laneModes = Object.keys(defaultBindings).map(Number);
const bindings = {...defaultBindings};
const supportedKey = /^(Key[A-Z]|Digit[0-9]|Numpad[0-9]|Arrow(Left|Right|Up|Down)|Space|Semicolon|Quote|Comma|Period|Slash|BracketLeft|BracketRight|Backslash|Minus|Equal|Backquote)$/;
const keyNames = {Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  BracketLeft: '[', BracketRight: ']', Backslash: String.fromCharCode(92), Minus: '-', Equal: '=', Backquote: String.fromCharCode(96)};
try {
  const stored = JSON.parse(localStorage.getItem('flowdrop-bindings'));
  for (const count of laneModes) {
    const layout = stored?.[count];
    if (Array.isArray(layout) && layout.length === count && new Set(layout).size === count &&
        layout.every(key => typeof key === 'string' && supportedKey.test(key))) bindings[count] = layout;
  }
} catch {
  // Key bindings still work for this session when browser storage is unavailable.
}
function keyName(code) {
  return keyNames[code] ?? code.replace(/^(Key|Digit|Arrow)/, '');
}
function saveBindings(count, layout) {
  bindings[count] = layout;
  try {
    localStorage.setItem('flowdrop-bindings', JSON.stringify(bindings));
  } catch {
    // Storage can be disabled for local files.
  }
}
function renderBindings() {
  const count = Number($('bindingMode').value);
  $('bindingList').replaceChildren(...bindings[count].map((code, lane) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Lane ' + (lane + 1) + ' / ' + keyName(code);
    button.onclick = () => {
      $('bindingMessage').textContent = 'Press a key for lane ' + (lane + 1) + '.';
      button.dataset.listening = 'true';
    };
    button.onblur = () => { delete button.dataset.listening; };
    button.onkeydown = event => {
      if (!button.dataset.listening || event.key === 'Escape' || event.key === 'Tab') return;
      event.preventDefault();
      if (event.repeat) return;
      if (!supportedKey.test(event.code) || event.ctrlKey || event.metaKey || event.altKey) {
        $('bindingMessage').textContent = 'Choose a letter, number, arrow, space, or punctuation key.';
        return;
      }
      const layout = bindings[count].slice();
      if (layout.some((key, index) => key === event.code && index !== lane)) {
        $('bindingMessage').textContent = 'That key is already assigned to another lane.';
        return;
      }
      layout[lane] = event.code;
      saveBindings(count, layout);
      button.textContent = 'Lane ' + (lane + 1) + ' / ' + keyName(event.code);
      delete button.dataset.listening;
      $('bindingMessage').textContent = 'Key updated.';
    };
    return button;
  }));
}
$('openKeySettings').onclick = () => {
  $('bindingMode').value = $('laneMode').value;
  $('bindingMessage').textContent = '';
  renderBindings();
  $('keySettings').showModal();
};
$('bindingMode').onchange = () => {
  $('bindingMessage').textContent = '';
  renderBindings();
};
$('resetBindings').onclick = () => {
  const count = Number($('bindingMode').value);
  saveBindings(count, defaultBindings[count]);
  renderBindings();
  $('bindingMessage').textContent = 'Defaults restored for this mode.';
};
const canvas = $('field');
const ctx = canvas.getContext('2d');
const held = new Set();
const inputs = new Map();
const windowSize = .155;
const maxScore = 100000;
const trackLimit = 30;
const difficulties = ['Easy', 'Normal', 'Hard'];
const tracks = [];
let selected;
let audio, active, loading = false;
let lastRun;
let frame;

$('audio').addEventListener('change', updateControls);

function readChart(data, buffer) {
  if (data?.version !== 1 || !laneModes.includes(data.lanes) || !Array.isArray(data.notes) ||
      !data.notes.length || data.notes.length > 12000) {
    throw new Error('Choose a valid 2-, 4-, 6-, or 8-lane FLOWDROP chart.');
  }
  const ends = Array(data.lanes).fill(-1);
  let previous = -1;
  return data.notes.map(({time, lane, duration}) => {
    if (!Number.isFinite(time) || time < 0 || time < previous ||
        !Number.isInteger(lane) || lane < 0 || lane >= data.lanes ||
        !Number.isFinite(duration) || duration < 0 || time <= ends[lane] ||
        time + duration > buffer.duration + .02) {
      throw new Error('Invalid chart or mismatched audio. Choose the original track version.');
    }
    ends[lane] = time + duration;
    previous = time;
    return {time, lane, duration};
  });
}
function saveChart(track, notes, difficulty, laneCount) {
  if (!notes?.length) return;
  const data = {version: 1, lanes: laneCount, notes};
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = track.name + '-' + difficulty.toLowerCase() + '-' + laneCount + 'k.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function updateControls() {
  const full = tracks.length >= trackLimit;
  document.querySelector('.library').hidden = !tracks.length;
  $('start').disabled = loading || full || !$('audio').files.length;
  $('demo').disabled = loading || full;
  $('exit').disabled = loading;
  $('playTrack').disabled = loading || !selected?.charts[$('laneMode').value]?.[$('difficulty').value]?.length;
  $('saveGame').disabled = $('saveTrack').disabled = $('playTrack').disabled;
  $('replayGame').disabled = loading || !lastRun;
  $('trackCount').textContent = tracks.length + ' / ' + trackLimit;
}

function renderTracks() {
  $('tracks').replaceChildren(...tracks.map(track => {
    const row = document.createElement('li');
    const pick = document.createElement('button');
    pick.textContent = track.name;
    pick.setAttribute('aria-pressed', String(selected === track));
    pick.onclick = () => {
      selected = track;
      renderTracks();
    };
    const remove = document.createElement('button');
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', 'Remove ' + track.name);
    remove.onclick = () => {
      if (loading) return;
      if (lastRun?.track === track) {
        stopRun();
        lastRun = null;
      }
      tracks.splice(tracks.indexOf(track), 1);
      if (selected === track) selected = tracks[0];
      renderTracks();
    };
    row.append(pick, remove);
    return row;
  }));
  const difficulty = $('difficulty');
  for (const option of difficulty.options) {
    option.disabled = !selected?.charts[$('laneMode').value]?.[option.value]?.length;
  }
  if (difficulty.selectedOptions[0]?.disabled) {
    difficulty.value = [...difficulty.options].find(option => !option.disabled)?.value ?? 'Normal';
  }
  difficulty.disabled = !selected;
  updateControls();
}

async function openAudio() {
  audio ??= new AudioContext();
  await audio.resume();
}

async function decode(file) {
  if (!file) return practice(audio);
  if (file.size > 40 * 1024 * 1024) throw new Error('Audio must be under 40 MB.');
  const buffer = await audio.decodeAudioData(await file.arrayBuffer());
  if (buffer.duration > 600) throw new Error('Audio must be under 10 minutes.');
  return buffer;
}

const chartFields = {
  sectionWindow: ['Section window (s)', 'Larger windows smooth out brief changes in loudness and rhythm.', 2, 20, 1],
  gap: ['Base spacing (s)', 'Higher values spread out successive hits. Section intensity can shorten or widen this gap.', .08, .65, .005],
  threshold: ['Attack threshold', 'Higher values keep only more pronounced starts, such as stronger drum hits.', .5, 5, .05],
  hold: ['Minimum hold (s)', 'Higher values require a sound to sustain longer before it becomes a hold.', .25, 1.3, .01],
  doubleHold: ['Minimum double hold (s)', 'Higher values make paired holds rarer. A strong attack is also required.', .4, 1.3, .01],
  chord: ['Chord threshold', 'Higher values make two-key hits rarer.', 1, 8, .1],
  peak: ['Peak budget / second', 'A single hit costs 1. A chord costs 1.5. Lower budgets reduce bursts.', 1, 10, .5],
};
const defaultChartSettings = {...chartDefaults, modes};
let chartSettings = defaultChartSettings;

function renderChartSettings(settings) {
  const fields = $('chartFields');
  fields.replaceChildren();
  for (const [group, values] of [['Global', chartDefaults], ...Object.entries(modes)]) {
    const section = document.createElement('details');
    section.open = group === 'Global' || group === 'Normal';
    const heading = document.createElement('summary');
    heading.textContent = group;
    section.append(heading);
    for (const key of Object.keys(values)) {
      const [title, help, min, max, step] = chartFields[key];
      const label = document.createElement('label');
      label.textContent = title;
      const input = document.createElement('input');
      input.type = 'number';
      input.name = group + '.' + key;
      input.min = min;
      input.max = max;
      input.step = step;
      input.required = true;
      input.value = (group === 'Global' ? settings : settings.modes[group])[key];
      const explanation = document.createElement('small');
      explanation.textContent = help + ' Default: ' + values[key] + '.';
      label.append(input, explanation);
      section.append(label);
    }
    fields.append(section);
  }
}

$('openChartSettings').onclick = () => {
  renderChartSettings(chartSettings);
  $('chartSettingsMessage').textContent = '';
  $('chartSettings').showModal();
};
$('cancelChartSettings').onclick = () => $('chartSettings').close();
$('resetChartSettings').onclick = () => {
  renderChartSettings(defaultChartSettings);
  $('chartSettingsMessage').textContent = 'Defaults restored in this form. Select Apply to use them.';
};
$('chartSettingsForm').addEventListener('invalid', event => {
  const group = event.target.closest('details');
  if (group) group.open = true;
}, true);
$('chartSettingsForm').onsubmit = event => {
  event.preventDefault();
  const settings = {modes: Object.fromEntries(difficulties.map(level => [level, {}]))};
  for (const [name, value] of new FormData(event.currentTarget)) {
    const [group, key] = name.split('.');
    (group === 'Global' ? settings : settings.modes[group])[key] = Number(value);
  }
  for (const [level, mode] of Object.entries(settings.modes)) {
    if (mode.doubleHold < mode.hold) {
      $('chartSettingsMessage').textContent = level + ': double holds must be at least as long as single holds.';
      return;
    }
  }
  chartSettings = settings;
  $('chartSettings').close();
};

async function importTracks(files, chartFile, demo = false) {
  if (loading || (!files.length && !demo)) return;
  const status = $('message');
  if (chartFile && files.length !== 1) {
    status.textContent = 'Select exactly one audio file when importing a chart.';
    return;
  }
  const settings = chartSettings;
  const slots = trackLimit - tracks.length;
  const queue = demo ? [null].slice(0, slots) : files.slice(0, slots);
  loading = true;
  updateControls();
  const errors = [];
  let added = 0;
  try {
    await openAudio();
    if (chartFile?.size > 2 * 1024 * 1024) throw new Error('Choose a chart under 2 MB.');
    const imported = chartFile ? JSON.parse(await chartFile.text()) : null;
    for (const file of queue) {
      const name = file?.name ?? 'Practice beat';
      status.textContent = 'Generating charts / ' + name;
      await new Promise(resolve => setTimeout(resolve, 0));
      try {
        const buffer = await decode(file);
        const charts = Object.fromEntries(laneModes.map(count => [
          count, Object.fromEntries(difficulties.map(level => [level, chart(buffer, level, settings, count)]))
        ]));
        if (chartFile) {
          const custom = readChart(imported, buffer);
          charts[imported.lanes].Custom = custom;
        }
        if (!Object.values(charts).some(group => Object.values(group).some(notes => notes.length))) throw new Error('No clear hits found.');
        const track = {file, name, charts};
        tracks.push(track);
        if (!added) {
          selected = track;
          if (chartFile) $('laneMode').value = String(imported.lanes);
          $('difficulty').value = chartFile ? 'Custom' : 'Normal';
        }
        added++;
      } catch (error) {
        errors.push(name + ': ' + error.message);
      }
    }
  } catch (error) {
    errors.push(error.message);
  } finally {
    loading = false;
    const skipped = files.length - queue.length;
    const summary = [added ? added + ' track(s) added.' : '',
      skipped > 0 ? skipped + ' skipped. Library limit: ' + trackLimit + '.' : '', ...errors].filter(Boolean).join(' ');
    status.textContent = summary;
    if (added) {
      $('audio').value = '';
      $('chartFile').value = '';
      $('libraryMessage').textContent = summary;
      renderTracks();
    }
    updateControls();
  }
}

async function playSelection() {
  const track = selected;
  const difficulty = $('difficulty').value;
  const laneCount = Number($('laneMode').value);
  const notes = track?.charts[laneCount]?.[difficulty];
  if (loading || !notes?.length) return;
  stopRun();
  loading = true;
  updateControls();
  try {
    await openAudio();
    const buffer = lastRun?.track === track ? lastRun.buffer : await decode(track.file);
    startRun({track, buffer, notes, difficulty, laneCount});
  } catch (error) {
    $('libraryMessage').textContent = error.message;
  } finally {
    loading = false;
    updateControls();
  }
}

$('start').onclick = () => importTracks([...$('audio').files], $('chartFile').files[0]);
$('demo').onclick = () => importTracks([], null, true);
$('difficulty').onchange = updateControls;
$('laneMode').onchange = () => {
  renderTracks();
};
$('playTrack').onclick = playSelection;
$('saveTrack').onclick = () => saveChart(selected, selected?.charts[$('laneMode').value]?.[$('difficulty').value], $('difficulty').value, Number($('laneMode').value));
$('saveGame').onclick = () => saveChart(lastRun.track, lastRun.notes, lastRun.difficulty, lastRun.laneCount);
$('openSettings').onclick = () => $('settingsDialog').showModal();
$('touchWidth').onchange = event => {
  $('game').dataset.touchWidth = event.target.value;
};
$('exit').onclick = () => {
  stopRun();
  lastRun = null;
  $('game').hidden = true;
  $('setup').hidden = false;
  $('message').textContent = tracks.length + ' track(s) in this session.';
  $('audio').focus();
  updateControls();
};
$('closeResults').onclick = $('exit').onclick;
$('results').addEventListener('cancel', event => {
  event.preventDefault();
  $('exit').click();
});
$('replay').onclick = $('replayGame').onclick = () => {
  if (loading || !lastRun) return;
  stopRun();
  startRun(lastRun);
};

function scheduleAudio(buffer, elapsed) {
  const source = audio.createBufferSource();
  source.buffer = buffer;
  source.connect(audio.destination);
  const now = audio.currentTime;
  source.start(now + Math.max(0, -elapsed), Math.min(buffer.duration, Math.max(0, elapsed)));
  return {source, start: now - elapsed};
}

function disconnectAudio(run) {
  if (!run.source) return;
  run.source.stop();
  run.source.disconnect();
  run.source = null;
}

$('pause').onclick = () => {
  const run = active;
  if (!run || run.finished || run.countdown) return;
  if (run.pausedAt === undefined) {
    run.pausedAt = audio.currentTime - run.start;
    disconnectAudio(run);
    cancelAnimationFrame(frame);
    $('pauseStatus').textContent = 'Paused';
    $('pauseStatus').hidden = false;
    $('pause').textContent = 'Resume';
    return;
  }
  const deadline = performance.now() + 3000;
  $('pause').disabled = true;
  const count = () => {
    const remaining = deadline - performance.now();
    if (remaining > 0) {
      $('pauseStatus').textContent = Math.ceil(remaining / 1000);
      run.countdown = setTimeout(count, Math.min(remaining, 50));
      return;
    }
    run.countdown = null;
    Object.assign(run, scheduleAudio(run.buffer, run.pausedAt));
    delete run.pausedAt;
    for (const note of run.notes) {
      if (note.state === 'holding' && !held.has(note.lane)) release(note.lane);
    }
    $('pauseStatus').hidden = true;
    $('pause').textContent = 'Pause';
    $('pause').disabled = false;
    frame = requestAnimationFrame(tick);
  };
  count();
};

function startRun(run) {
  lastRun = run;
  run = {...run, travel: Number($('speed').value),
    offset: Math.max(-250, Math.min(250, Number($('offset').value) || 0)) / 1000,
    vertical: $('view').value === 'vertical', sounds: $('sounds').value === 'on'};
  const playback = scheduleAudio(run.buffer, -run.travel);
  active = {...run, notes: run.notes.map(note => ({...note})), ...playback,
    duration: run.buffer.duration, effects: [], cursor: 0, score: 0, combo: 0, hits: 0, fullCombo: true};
  $('setup').hidden = true;
  $('game').dataset.laneCount = String(run.laneCount);
  $('game').hidden = false;
  fitPlayfield();
  $('pause').disabled = false;
  $('exit').focus();
  frame = requestAnimationFrame(tick);
}

function keySound(lane) {
  const now = audio.currentTime;
  const tone = audio.createOscillator();
  const gain = audio.createGain();
  tone.type = 'triangle';
  tone.frequency.setValueAtTime(370 + lane * 55, now);
  tone.frequency.exponentialRampToValueAtTime(150 + lane * 20, now + .045);
  gain.gain.setValueAtTime(.07, now);
  gain.gain.exponentialRampToValueAtTime(.001, now + .055);
  tone.connect(gain).connect(audio.destination);
  tone.onended = () => { tone.disconnect(); gain.disconnect(); };
  tone.start(now);
  tone.stop(now + .06);
}

function stopRun() {
  if ($('results').open) $('results').close();
  cancelAnimationFrame(frame);
  if (active) {
    clearTimeout(active.countdown);
    disconnectAudio(active);
  }
  active = null;
  $('pauseStatus').hidden = true;
  $('pause').textContent = 'Pause';
  $('pause').disabled = false;
  held.clear();
  inputs.clear();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function time() {
  return audio.currentTime - active.start - active.offset;
}

function accuracy() {
  return active.score / (active.notes.length * 100);
}

function displayScore() {
  return Math.round(accuracy() * maxScore).toLocaleString('en-US');
}

function judge(note, label, points, t) {
  note.state = points ? 'done' : 'missed';
  if (!points) note.missedAt = t;
  active.effects.push({lane: note.lane, label, t,
    color: {Perfect: '#d1ff69', Good: '#75e4ff', Bad: '#ffbc66', Miss: '#ff728a'}[label]});
  active.score += points;
  if (points) {
    active.combo++;
    active.hits++;
  } else {
    active.combo = 0;
    active.fullCombo = false;
  }
}

function press(lane, input) {
  if ($('settingsDialog').open || !active || active.finished || lane < 0 || inputs.has(input)) return;
  inputs.set(input, lane);
  if (held.has(lane)) return;
  held.add(lane);
  if (active.pausedAt !== undefined) return;
  if (active.sounds) keySound(lane);
  const t = time();
  let nearest;
  for (let i = active.cursor; i < active.notes.length; i++) {
    const note = active.notes[i];
    if (note.time > t + windowSize) break;
    if (note.lane !== lane || note.state || Math.abs(t - note.time) > windowSize) continue;
    if (!nearest || Math.abs(t - note.time) < Math.abs(t - nearest.time)) nearest = note;
  }
  if (!nearest) return;
  const delta = Math.abs(t - nearest.time);
  const label = delta <= .065 ? 'Perfect' : delta <= .115 ? 'Good' : 'Bad';
  const points = {Perfect: 100, Good: 65, Bad: 30}[label];
  if (nearest.duration) {
    nearest.state = 'holding';
    nearest.label = label;
    nearest.points = points;
  } else {
    judge(nearest, label, points, t);
  }
}

function release(lane) {
  held.delete(lane);
  if (!active || active.finished || active.pausedAt !== undefined) return;
  const t = time();
  const note = active.notes.find(item => item.lane === lane && item.state === 'holding');
  if (!note) return;
  if (t >= note.time + note.duration - .135) {
    judge(note, note.label, note.points, t);
  } else {
    note.brokenHold = true;
    judge(note, 'Miss', 0, t);
  }
}
function releaseInput(input) {
  const lane = inputs.get(input);
  if (lane === undefined) return;
  inputs.delete(input);
  if (![...inputs.values()].includes(lane)) release(lane);
}

window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && active && !active.finished && !$('settingsDialog').open) {
    event.preventDefault();
    if (!event.repeat) $('pause').click();
    return;
  }
  const lane = bindings[active?.laneCount]?.indexOf(event.code) ?? -1;
  if ($('settingsDialog').open || !active || active.finished || lane < 0 ||
      event.altKey || event.ctrlKey || event.metaKey) return;
  event.preventDefault();
  if (!event.repeat) press(lane, event.code);
});
window.addEventListener('keyup', event => releaseInput(event.code));
window.addEventListener('blur', () => [...inputs.keys()].forEach(releaseInput));

canvas.addEventListener('pointerdown', event => {
  if (!active || active.finished || event.button !== 0) return;
  const bounds = canvas.getBoundingClientRect();
  const touchX = (event.clientX - bounds.left) * canvas.width / bounds.width;
  const touchY = (event.clientY - bounds.top) * canvas.height / bounds.height;
  if (touchY < line - 65 || touchX < x(0, line) || touchX >= x(active.laneCount, line)) return;
  const lane = Math.floor((touchX - x(0, line)) / (x(1, line) - x(0, line)));
  canvas.setPointerCapture(event.pointerId);
  press(lane, event.pointerId);
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  canvas.addEventListener(type, event => releaseInput(event.pointerId));
}

const touchScreen = matchMedia('(any-pointer: coarse)');
const center = 420;
const laneTop = 90;
const portraitTouch = matchMedia('(any-pointer: coarse) and (orientation: portrait)');
let line = 510;

function fitPlayfield() {
  if (!active) return;
  const bounds = canvas.getBoundingClientRect();
  const portraitFour = portraitTouch.matches && active.laneCount === 4;
  const height = portraitFour && bounds.width > 0
    ? Math.round(canvas.width * bounds.height / bounds.width)
    : 600;
  if (canvas.height !== height) canvas.height = height;
  line = portraitFour ? Math.round(height * .78) : 510;
}

new ResizeObserver(() => {
  if (!active || active.finished) return;
  fitPlayfield();
}).observe(canvas);

function x(lane, y) {
  y = Math.min(y, line);
  const laneWidth = (touchScreen.matches ? 822 : 678) / active.laneCount;
  const perspective = (y - laneTop) / (line - laneTop);
  const distantWidth = portraitTouch.matches && active.laneCount === 4 ? .78 : .28;
  return center + (lane - active.laneCount / 2) *
    (active.vertical ? laneWidth : laneWidth * (distantWidth + (1 - distantWidth) * perspective));
}

function tick() {
  const t = time();
  const { notes, travel } = active;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i <= active.laneCount; i++) {
    ctx.strokeStyle = '#55556b';
    ctx.beginPath();
    ctx.moveTo(x(i, laneTop), laneTop);
    ctx.lineTo(x(i, line), line);
    ctx.lineTo(x(i, line), canvas.height);
    ctx.stroke();
  }
  ctx.fillStyle = '#d1ff69';
  ctx.fillRect(x(0, line), line, x(active.laneCount, line) - x(0, line), 2);
  if (touchScreen.matches) {
    for (let lane = 0; lane < active.laneCount; lane++) {
      ctx.fillStyle = lane < active.laneCount / 2 ? '#9b94ff35' : '#ff9dcf35';
      ctx.fillRect(x(lane, line) + 3, line + 4, x(1, line) - x(0, line) - 6, canvas.height - line - 8);
    }
  }
  for (const lane of held) {
    ctx.fillStyle = '#d1ff69';
    ctx.fillRect(x(lane, line) + 3, line - 3, x(1, line) - x(0, line) - 6, 6);
  }
  for (let i = active.cursor; i < notes.length; i++) {
    const note = notes[i];
    if (note.time > t + travel) break;
    if (note.state === 'done') continue;
    const fadeDuration = note.duration ? .30 : .17;
    if (note.state === 'missed' && t - note.missedAt >= fadeDuration) {
      note.state = 'done';
      continue;
    }
    if (note.state === 'holding' && t >= note.time + note.duration) {
      judge(note, note.label, note.points, t);
      continue;
    }
    if (!note.state && t - note.time > windowSize) {
      judge(note, 'Miss', 0, t);
    }
    const missed = note.state === 'missed';
    const yAt = when => {
      const y = line - (when - t) / travel * (line - laneTop);
      return Math.max(laneTop, missed || !note.state ? y : Math.min(line, y));
    };
    ctx.save();
    if (missed) ctx.globalAlpha = Math.max(0, 1 - (t - note.missedAt) / fadeDuration);
    const y = note.brokenHold ? line : yAt(note.time);
    const tail = yAt(note.time + note.duration);
    ctx.fillStyle = note.duration ? '#d1ff69' : note.lane < active.laneCount / 2 ? '#9b94ff' : '#ff9dcf';
    const leftLane = note.lane + .08;
    const rightLane = note.lane + .92;
    const left = x(leftLane, y);
    const right = x(rightLane, y);
    const height = touchScreen.matches ? 24 : 16;
    if (note.duration) {
      if (!note.brokenHold || tail < line) {
        const upper = tail - height / 2;
        const lower = note.brokenHold ? y : y + height / 2;
        const upperLeft = x(leftLane, tail);
        const upperRight = x(rightLane, tail);
        const radius = Math.min(height / 2, (lower - upper) / 2, (upperRight - upperLeft) / 2);
        ctx.beginPath();
        ctx.moveTo((upperLeft + upperRight) / 2, upper);
        ctx.arcTo(upperRight, upper, right, lower, radius);
        ctx.arcTo(right, lower, left, lower, radius);
        ctx.arcTo(left, lower, upperLeft, upper, radius);
        ctx.arcTo(upperLeft, upper, upperRight, upper, radius);
        ctx.closePath();
        ctx.fill();
      }
    } else {
      ctx.beginPath();
      ctx.roundRect(left, y - height / 2, right - left, height, 5);
      ctx.fill();
    }
    ctx.restore();
  }
  while (notes[active.cursor]?.state === 'done') active.cursor++;
  ctx.textAlign = 'center';
  if (active.combo) {
    ctx.fillStyle = active.fullCombo ? '#ffe080' : '#fff';
    ctx.font = 'bold 45px monospace';
    ctx.fillText(active.combo, center, 110);
    ctx.font = 'bold 14px monospace';
    ctx.fillText('COMBO', center, 132);
  }
  active.effects = active.effects.filter(effect => t - effect.t < .48);
  for (const effect of active.effects) {
    const progress = Math.max(0, (t - effect.t) / .48);
    const cx = x(effect.lane + .5, line);
    ctx.save();
    ctx.globalAlpha = 1 - progress;
    ctx.fillStyle = ctx.strokeStyle = effect.color;
    ctx.lineWidth = 3;
    ctx.font = 'bold 17px monospace';
    ctx.fillText(effect.label, cx, line - 21 - progress * 40);
    ctx.beginPath();
    const radius = 11 + progress * 24;
    if (effect.label === 'Miss') {
      ctx.moveTo(cx - radius, line - radius);
      ctx.lineTo(cx + radius, line + radius);
      ctx.moveTo(cx + radius, line - radius);
      ctx.lineTo(cx - radius, line + radius);
    } else {
      ctx.ellipse(cx, line, radius * 1.7, radius * .55, 0, 0, Math.PI * 2);
    }
    ctx.stroke();
    ctx.restore();
  }
  ctx.textAlign = 'right';
  ctx.fillStyle = '#b3b1bc';
  ctx.font = '700 12px monospace';
  ctx.fillText('SCORE', canvas.width - 24, 26);
  ctx.fillStyle = '#f7f6ef';
  ctx.font = 'italic 700 38px Georgia, serif';
  ctx.fillText(displayScore(), canvas.width - 24, 65);

  if (t >= active.duration + .55) {
    active.finished = true;
    $('pause').disabled = true;
    held.clear();
    inputs.clear();
    $('finalScore').textContent = displayScore();
    $('accuracy').textContent = (accuracy() * 100).toFixed(1) + '%';
    $('result').textContent = active.hits + ' of ' + notes.length + ' notes hit';
    $('results').showModal();
    $('replay').focus();
    return;
  }
  frame = requestAnimationFrame(tick);
}
$('demo').disabled = false;
$('start').disabled = !$('audio').files.length;
$('message').textContent = 'Audio stays on this device. Tracks are kept until this page is closed or refreshed.';

if (touchScreen.matches) $('laneMode').value = '4';

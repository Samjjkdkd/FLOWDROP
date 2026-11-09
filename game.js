const $ = id => document.getElementById(id);
const keys = ['KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL'];
const canvas = $('field');
const ctx = canvas.getContext('2d');
const held = new Set();
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
  if (data?.version !== 1 || data.lanes !== 6 || !Array.isArray(data.notes) ||
      !data.notes.length || data.notes.length > 12000) {
    throw new Error('Choose a valid six-lane FLOWDROP chart.');
  }
  const ends = Array(6).fill(-1);
  let previous = -1;
  return data.notes.map(({time, lane, duration}) => {
    if (!Number.isFinite(time) || time < 0 || time < previous ||
        !Number.isInteger(lane) || lane < 0 || lane >= 6 ||
        !Number.isFinite(duration) || duration < 0 || time <= ends[lane] ||
        time + duration > buffer.duration + .02) {
      throw new Error('Invalid chart or mismatched audio. Choose the original track version.');
    }
    ends[lane] = time + duration;
    previous = time;
    return {time, lane, duration};
  });
}
function saveChart(track, notes, difficulty) {
  if (!notes?.length) return;
  const data = {version: 1, lanes: 6, notes};
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = track.name + '-' + difficulty.toLowerCase() + '.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function updateControls() {
  const full = tracks.length >= trackLimit;
  document.querySelector('.library').hidden = !tracks.length;
  $('start').disabled = loading || full || !$('audio').files.length;
  $('demo').disabled = loading || full;
  $('exit').disabled = loading;
  $('playTrack').disabled = loading || !selected?.charts[$('difficulty').value]?.length;
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
    option.disabled = !selected?.charts[option.value]?.length;
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

async function importTracks(files, chartFile, demo = false) {
  if (loading || (!files.length && !demo)) return;
  const status = $('message');
  if (chartFile && files.length !== 1) {
    status.textContent = 'Select exactly one audio file when importing a chart.';
    return;
  }
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
        const charts = Object.fromEntries(difficulties.map(level => [level, chart(buffer, level)]));
        if (chartFile) charts.Custom = readChart(imported, buffer);
        if (!Object.values(charts).some(notes => notes.length)) throw new Error('No clear hits found.');
        const track = {file, name, charts};
        tracks.push(track);
        if (!added) {
          selected = track;
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
  const notes = track?.charts[difficulty];
  if (loading || !notes?.length) return;
  stopRun();
  loading = true;
  updateControls();
  try {
    await openAudio();
    const buffer = lastRun?.track === track ? lastRun.buffer : await decode(track.file);
    startRun({track, buffer, notes, difficulty});
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
$('playTrack').onclick = playSelection;
$('saveTrack').onclick = () => saveChart(selected, selected?.charts[$('difficulty').value], $('difficulty').value);
$('saveGame').onclick = () => saveChart(lastRun.track, lastRun.notes, lastRun.difficulty);
$('openSettings').onclick = () => $('settingsDialog').showModal();
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

function startRun(run) {
  lastRun = run;
  run = {...run, travel: Number($('speed').value),
    offset: Math.max(-250, Math.min(250, Number($('offset').value) || 0)) / 1000,
    vertical: $('view').value === 'vertical', sounds: $('sounds').value === 'on'};
  const source = audio.createBufferSource();
  source.buffer = run.buffer;
  source.connect(audio.destination);
  const start = audio.currentTime + run.travel;
  source.start(start);
  active = {...run, notes: run.notes.map(note => ({...note})), source, start,
    duration: run.buffer.duration, effects: [], cursor: 0, score: 0, combo: 0, hits: 0};
  $('setup').hidden = true;
  $('game').hidden = false;
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
    active.source.stop();
    active.source.disconnect();
  }
  active = null;
  held.clear();
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
  }
}

window.addEventListener('keydown', event => {
  const lane = keys.indexOf(event.code);
  if ($('settingsDialog').open || !active || active.finished || lane < 0 || event.altKey || event.ctrlKey || event.metaKey) return;
  event.preventDefault();
  if (event.repeat || held.has(lane)) return;
  held.add(lane);
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
});

function release(lane) {
  held.delete(lane);
  if (!active || active.finished) return;
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
window.addEventListener('keyup', event => release(keys.indexOf(event.code)));
window.addEventListener('blur', () => [...held].forEach(release));

const center = 420;
const laneTop = 90;
const line = 510;
function x(lane, y) {
  y = Math.min(y, line);
  return center + (lane - 3) * (active.vertical ? 113 : 32 + 81 * (y - laneTop) / (line - laneTop));
}

function tick() {
  const t = time();
  const { notes, travel } = active;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i <= 6; i++) {
    ctx.strokeStyle = '#55556b';
    ctx.beginPath();
    ctx.moveTo(x(i, laneTop), laneTop);
    ctx.lineTo(x(i, line), line);
    ctx.lineTo(x(i, line), canvas.height);
    ctx.stroke();
  }
  ctx.fillStyle = '#d1ff69';
  ctx.fillRect(x(0, line), line, x(6, line) - x(0, line), 2);
  for (const lane of held) {
    ctx.fillStyle = '#d1ff69';
    ctx.fillRect(x(lane, line) + 3, line - 3, 107, 6);
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
    ctx.fillStyle = note.duration ? '#d1ff69' : note.lane < 3 ? '#9b94ff' : '#ff9dcf';
    if (note.duration && (!note.brokenHold || tail < line)) {
      ctx.beginPath();
      ctx.moveTo(x(note.lane + .24, tail), tail);
      ctx.lineTo(x(note.lane + .76, tail), tail);
      ctx.lineTo(x(note.lane + .76, y), y);
      ctx.lineTo(x(note.lane + .24, y), y);
      ctx.fill();
    }
    if (!note.brokenHold) {
      ctx.fillRect(x(note.lane + .08, y), y - 5, x(note.lane + .92, y) - x(note.lane + .08, y), 10);
    }
    ctx.restore();
  }
  while (notes[active.cursor]?.state === 'done') active.cursor++;
  ctx.textAlign = 'center';
  if (active.combo) {
    ctx.fillStyle = '#fff';
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
    held.clear();
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

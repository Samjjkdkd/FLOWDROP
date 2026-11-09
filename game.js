const $ = id => document.getElementById(id);
const keys = ['KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL'];
const canvas = $('field');
const ctx = canvas.getContext('2d');
const held = new Set();
const windowSize = .155;
const maxScore = 100000;
let savedChart;
let audio, active, loading = false;
let lastRun;
let frame;

$('audio').addEventListener('change', () => {
  $('start').disabled = !$('audio').files.length || loading;
});
$('chartFile').addEventListener('change', () => {
  $('start').textContent = $('chartFile').files.length ? 'Play imported chart' : 'Generate & play';
  $('difficulty').disabled = !!$('chartFile').files.length;
});
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
function saveChart() {
  if (!savedChart) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(savedChart, null, 2)], {type: 'application/json'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'flowdrop-chart.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('save').onclick = $('saveGame').onclick = saveChart;
$('start').onclick = () => launch(false);
$('demo').onclick = () => launch(true);
$('exit').onclick = $('closeResults').onclick = exit;
$('results').addEventListener('cancel', event => {
  event.preventDefault();
  exit();
});
$('replay').onclick = $('replayGame').onclick = () => {
  const run = lastRun;
  exit();
  startRun(run);
};

async function launch(demo) {
  if (loading || active) return;
  const file = $('audio').files[0];
  if (!demo && !file) return;
  loading = true;
  $('start').disabled = $('demo').disabled = true;
  $('message').textContent = 'Analyzing audio...';
  try {
    audio ??= new AudioContext();
    await audio.resume();
    if (!demo && file.size > 40 * 1024 * 1024) throw new Error('Choose an audio file under 40 MB.');
    const buffer = demo ? practice(audio) : await audio.decodeAudioData(await file.arrayBuffer());
    if (buffer.duration > 600) throw new Error('Choose a track under 10 minutes.');
    const chartFile = demo ? null : $('chartFile').files[0];
    if (chartFile?.size > 2 * 1024 * 1024) throw new Error('Choose a chart under 2 MB.');
    const notes = chartFile
      ? readChart(JSON.parse(await chartFile.text()), buffer)
      : chart(buffer, $('difficulty').value);
    if (!notes.length) throw new Error('No clear hits found. Try another track or difficulty.');
    const travel = Number($('speed').value);
    const offset = Math.max(-250, Math.min(250, Number($('offset').value) || 0)) / 1000;
    lastRun = {buffer, notes, travel, offset, vertical: $('view').value === 'vertical',
      sounds: $('sounds').value === 'on'};
    startRun(lastRun);
  } catch (error) {
    $('message').textContent = error.message || 'Could not open this audio file.';
  } finally {
    loading = false;
    $('start').disabled = !$('audio').files.length;
    $('demo').disabled = false;
  }
}

function startRun(run) {
  const source = audio.createBufferSource();
  source.buffer = run.buffer;
  source.connect(audio.destination);
  const start = audio.currentTime + run.travel;
  source.start(start);
  savedChart = {version: 1, lanes: 6, notes: run.notes};
  $('save').disabled = false;
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

function exit() {
  if ($('results').open) $('results').close();
  cancelAnimationFrame(frame);
  if (active) {
    active.source.stop();
    active.source.disconnect();
  }
  active = null;
  held.clear();
  $('game').hidden = true;
  $('setup').hidden = false;
  $('message').textContent = 'Your file stays on this device.';
  $('audio').focus();
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
  if (!active || active.finished || lane < 0 || event.altKey || event.ctrlKey || event.metaKey) return;
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
$('message').textContent = 'Your file stays on this device. Positive timing offset moves judgment later.';

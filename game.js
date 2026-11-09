

const $ = id => document.getElementById(id);
const keys = ['KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL'];
const canvas = $('field');
const ctx = canvas.getContext('2d');
const held = new Set();
const windowSize = .115;
let audio, active, loading = false;
let frame;

$('audio').addEventListener('change', () => {
  $('start').disabled = !$('audio').files.length || loading;
});
$('start').onclick = () => launch(false);
$('demo').onclick = () => launch(true);
$('exit').onclick = exit;

async function launch(demo) {
  if (loading || active) return;
  const file = $('audio').files[0];
  if (!demo && !file) return;
  loading = true;
  $('start').disabled = $('demo').disabled = true;
  $('message').textContent = 'Analyzing audio...';
  let source;
  try {
    audio ??= new AudioContext();
    await audio.resume();
    if (!demo && file.size > 40 * 1024 * 1024) throw new Error('Choose an audio file under 40 MB.');
    const buffer = demo ? practice(audio) : await audio.decodeAudioData(await file.arrayBuffer());
    if (buffer.duration > 600) throw new Error('Choose a track under 10 minutes.');
    const notes = chart(buffer, $('difficulty').value);
    if (!notes.length) throw new Error('No clear hits found. Try another track or difficulty.');
    const travel = Number($('speed').value);
    const offset = Math.max(-250, Math.min(250, Number($('offset').value) || 0)) / 1000;
    source = audio.createBufferSource();
    source.buffer = buffer;
    source.connect(audio.destination);
    const start = audio.currentTime + travel;
    source.start(start);
    active = { notes, source, start, travel, offset, duration: buffer.duration,
      cursor: 0, score: 0, combo: 0, hits: 0, feedback: '', feedbackAt: -Infinity };
    $('setup').hidden = true;
    $('game').hidden = false;
    $('result').textContent = '';
    $('exit').focus();
    frame = requestAnimationFrame(tick);
  } catch (error) {
    source?.disconnect();
    $('message').textContent = error.message || 'Could not open this audio file.';
  } finally {
    loading = false;
    $('start').disabled = !$('audio').files.length;
    $('demo').disabled = false;
  }
}

function exit() {
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

function judge(note, label, points, t) {
  note.state = 'done';
  active.feedback = label;
  active.feedbackAt = t;
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
  const t = time();
  let nearest;
  for (let i = active.cursor; i < active.notes.length; i++) {
    const note = active.notes[i];
    if (note.time > t + windowSize) break;
    if (note.lane !== lane || note.state || Math.abs(t - note.time) > windowSize) continue;
    if (!nearest || Math.abs(t - note.time) < Math.abs(t - nearest.time)) nearest = note;
  }
  if (!nearest) return;
  const perfect = Math.abs(t - nearest.time) <= .055;
  if (nearest.duration) {
    nearest.state = 'holding';
    nearest.perfect = perfect;
  } else {
    judge(nearest, perfect ? 'Perfect' : 'Good', perfect ? 100 : 65, t);
  }
});

function release(lane) {
  held.delete(lane);
  if (!active || active.finished) return;
  const t = time();
  const note = active.notes.find(item => item.lane === lane && item.state === 'holding');
  if (!note) return;
  if (t >= note.time + note.duration - .075) {
    judge(note, note.perfect ? 'Perfect' : 'Good', note.perfect ? 100 : 65, t);
  } else {
    judge(note, 'Miss', 0, t);
  }
}
window.addEventListener('keyup', event => release(keys.indexOf(event.code)));
window.addEventListener('blur', () => [...held].forEach(release));

const center = 420;
const top = 45;
const line = 510;
function x(lane, y) {
  return center + (lane - 3) * (32 + 81 * (y - top) / (line - top));
}

function tick() {
  const t = time();
  const { notes, travel } = active;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i <= 6; i++) {
    ctx.strokeStyle = '#55556b';
    ctx.beginPath();
    ctx.moveTo(x(i, top), top);
    ctx.lineTo(x(i, line), line);
    ctx.stroke();
  }
  ctx.fillStyle = '#d1ff69';
  ctx.fillRect(x(0, line), line, x(6, line) - x(0, line), 2);
  for (let lane = 0; lane < 6; lane++) {
    ctx.fillStyle = held.has(lane) ? '#d1ff69' : '#35354a';
    ctx.fillRect(x(lane, line) + 3, line + 7, 107, 42);
    ctx.fillStyle = held.has(lane) ? '#121218' : '#fff';
    ctx.font = 'bold 23px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(keys[lane].at(-1), x(lane + .5, line), line + 35);
  }
  for (let i = active.cursor; i < notes.length; i++) {
    const note = notes[i];
    if (note.time > t + travel) break;
    if (note.state === 'done') continue;
    if (note.state === 'holding' && t >= note.time + note.duration) {
      judge(note, note.perfect ? 'Perfect' : 'Good', note.perfect ? 100 : 65, t);
      continue;
    }
    if (!note.state && t - note.time > windowSize) {
      judge(note, 'Miss', 0, t);
      continue;
    }
    const yAt = when => Math.max(top, Math.min(line, line - (when - t) / travel * (line - top)));
    const y = yAt(note.time);
    const tail = yAt(note.time + note.duration);
    ctx.fillStyle = note.duration ? '#d1ff69' : note.lane < 3 ? '#9b94ff' : '#ff9dcf';
    if (note.duration) {
      ctx.beginPath();
      ctx.moveTo(x(note.lane + .24, tail), tail);
      ctx.lineTo(x(note.lane + .76, tail), tail);
      ctx.lineTo(x(note.lane + .76, y), y);
      ctx.lineTo(x(note.lane + .24, y), y);
      ctx.fill();
    }
    ctx.fillRect(x(note.lane + .08, y), y - 5, x(note.lane + .92, y) - x(note.lane + .08, y), 10);
  }
  while (notes[active.cursor]?.state === 'done') active.cursor++;
  if (t - active.feedbackAt < .45) {
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 26px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(active.feedback, center, 110);
  }
  $('score').textContent = active.score.toLocaleString();
  $('combo').textContent = active.combo + ' COMBO';
  if (t >= active.duration + .25) {
    active.finished = true;
    held.clear();
    $('result').textContent = 'Track complete / ' + active.hits + ' of ' + notes.length + ' hits / ' +
      Math.round(active.score / (notes.length * 100) * 100) + '% accuracy';
    return;
  }
  frame = requestAnimationFrame(tick);
}
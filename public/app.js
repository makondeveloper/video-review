'use strict';
/* 영상 검수 — 영상을 보며 고칠 곳을 마킹하고 <영상>.review.json 으로 저장한다.
   편집 코드는 나중에 status === 'done' 인 파일만 읽어 실제 편집에 쓴다. */

const TYPES = [
  { key: 'cut',      label: '컷편집', color: '#f05252' },
  { key: 'subtitle', label: '자막',   color: '#e3b341' },
  { key: 'audio',    label: '소리',   color: '#3fb950' },
  { key: 'sfx',      label: '효과음', color: '#2dd4bf' },
  { key: 'effect',   label: '효과',   color: '#fb923c' },
  { key: 'visual',   label: '화면',   color: '#4c9dff' },
  { key: 'other',    label: '기타',   color: '#b37feb' },
];
const TYPE = Object.fromEntries(TYPES.map(t => [t.key, t]));

const $ = s => document.querySelector(s);
const enc = encodeURIComponent;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const video = $('#video');
const cv = $('#tl');
const ctx = cv.getContext('2d');
const scroller = $('#tlscroll');
const spacer = $('#tlspacer');
const noteEl = $('#note');

// ---------- 상태 ----------
const S = { dir: '', videos: [], name: null };
let R = null;              // 지금 열린 검수 기록
let selId = null;
let curType = 'cut';
let inPt = null, outPt = null;
let pps = 20;              // 타임라인 1초당 픽셀
let fitMode = true;
let filter = null;         // 목록에서 보는 종류 (null = 전체)
let undoStack = [], redoStack = [];
let needDraw = true;
let resumeAfterNote = false;
let drag = null;
let hoverX = null;
let layout = [];           // 마지막으로 그린 마커 위치 (클릭 판정용)
let TH = null;             // 썸네일 줄
let thumbToken = 0;

const RULER_H = 24, THUMB_H = 46, MARK_Y = RULER_H + THUMB_H + 6, LANE_H = 22, LANE_GAP = 4;
const MAX_PPS = 400;

// 같이 보기로 들어온 사람(손님)도 마커는 마킹·수정할 수 있다.
// 손님이 못 하는 것: 폴더 바꾸기, 다른 영상 열기, 검수 완료, 같이 보기 설정 (서버도 막는다)
const isGuest = () => S.role === 'guest';
const canEdit = () => !!R;

const dur = () => (R && R.duration) || (isFinite(video.duration) ? video.duration : 0);
const fps = () => (R && R.fps) || 30;

// ---------- 타임코드 ----------
function tc(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const f = fps();
  const nominal = Math.round(f);
  let s = Math.floor(t + 1e-6);
  let fr = Math.floor((t - s) * f + 1e-4);
  if (fr >= nominal) { fr = 0; s += 1; }
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
  const p = n => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(ss)}:${p(fr)}`;
}
function tcShort(t, step) {
  const full = tc(t);
  if (step < 1) return full;
  return dur() >= 3600 ? full.slice(0, 8) : full.slice(3, 8);
}
function parseTC(str) {
  str = String(str).trim();
  if (!str) return null;
  if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);
  const parts = str.split(':');
  if (parts.some(p => !/^\d+(\.\d+)?$/.test(p))) return null;
  const n = parts.map(Number);
  if (n.length === 4) return n[0] * 3600 + n[1] * 60 + n[2] + n[3] / fps();
  if (n.length === 3) return n[0] * 3600 + n[1] * 60 + n[2];
  if (n.length === 2) return n[0] * 60 + n[1];
  return null;
}

// ---------- 서버 ----------
async function api(path, opts = {}) {
  opts.headers = Object.assign({ 'X-Review': '1' }, opts.headers || {});
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = r.status + '';
    try { const txt = await r.text(); try { msg = JSON.parse(txt).error || msg; } catch { msg = txt.slice(0, 120) || msg; } } catch { }
    const e = new Error(msg); e.status = r.status; throw e;
  }
  return r;
}

async function loadState() {
  const s = await (await api('/api/state')).json();
  applyState(s);
  return s;
}
function applyState(s) {
  S.dir = s.dir;
  S.videos = s.videos || [];
  S.role = s.role || 'host';
  S.share = s.share || null;
  document.body.classList.toggle('guest', isGuest());
  renderShareBtn();
  $('#dir').value = S.dir;
  renderVideoSelect();
}

function statusLabel(v) {
  if (v.status === 'done') return `✅ 검수 완료 · ${v.markers}개`;
  if (v.status === 'in_review') return `✏️ 검수 중 · ${v.markers}개`;
  if (v.status === 'broken') return '⚠️ 기록 파일 오류';
  return '새 영상';
}
function renderVideoSelect() {
  const sel = $('#videoSel');
  if (!S.videos.length) {
    sel.innerHTML = '<option value="">이 폴더에 영상이 없어요</option>';
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  sel.innerHTML = (S.name ? '' : '<option value="">영상 고르기…</option>') +
    S.videos.map(v => `<option value="${esc(v.name)}"${v.name === S.name ? ' selected' : ''}>${esc(v.name)}  —  ${statusLabel(v)}</option>`).join('');
}
function syncVideoEntry() {
  if (!R) return;
  const v = S.videos.find(x => x.name === S.name);
  if (v) { v.status = R.status; v.markers = R.markers.length; }
  renderVideoSelect();
}

// ---------- 저장 ----------
let saveTimer = null, dirty = false, saving = null;
function setSaveState(text, err) {
  const el = $('#saveState');
  el.textContent = text;
  el.classList.toggle('err', !!err);
}
function serialize() {
  const markers = sortedMarkers().map(m => ({
    id: m.id, type: m.type, kind: m.kind,
    start: +m.start.toFixed(3), end: +m.end.toFixed(3),
    startTC: tc(m.start), endTC: tc(m.end),
    note: m.note || '', applied: !!m.applied,
    rule: !!m.rule,   // 팀장님 '앞으로도 이렇게' = 원칙집 후보 (구조안 11-10)
    createdAt: m.createdAt, updatedAt: m.updatedAt,
  }));
  return JSON.stringify({ ...R, updatedAt: new Date().toISOString(), markers }, null, 2);
}
function scheduleSave() {
  if (!canEdit()) return;
  dirty = true;
  setSaveState('저장 대기…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 500);
}
// 여러 명이 같이 고칠 수 있어서, 저장할 때 서버 판(rev)이 내가 마지막으로 본 판(baseRev) 그대로일 때만 쓴다.
// 그 사이 다른 사람이 저장했으면(409) 최신 판을 받아 마커별로 합친 뒤 다시 저장한다.
let baseRev = 0;
async function save() {
  if (!canEdit() || !dirty) return;
  if (saving) { await saving; if (!dirty) return; }
  clearTimeout(saveTimer);
  dirty = false;
  const name = S.name;
  setSaveState('저장 중…');
  saving = (async () => {
    for (let i = 0; i < 5; i++) {
      if (S.name !== name || !R) return;
      R.rev = baseRev + 1;
      try {
        await api('/api/review?name=' + enc(name), { method: 'PUT', body: serialize(), headers: { 'Content-Type': 'application/json' } });
        baseRev = R.rev;
        setSaveState('저장됨 ' + new Date().toTimeString().slice(0, 8));
        syncVideoEntry();
        return;
      } catch (e) {
        if (e.status === 409) { await pullRemote(); continue; }
        dirty = true; setSaveState('저장 실패: ' + e.message, true); return;
      }
    }
    dirty = true; setSaveState('저장이 겹쳐서 다시 시도할게요', true); scheduleSave();
  })();
  await saving;
  saving = null;
}
async function flushSave() { if (saving) await saving; if (dirty) await save(); }
window.addEventListener('beforeunload', () => {
  if (dirty && R) { R.rev = baseRev + 1; fetch('/api/review?name=' + enc(S.name), { method: 'PUT', body: serialize(), keepalive: true, headers: { 'X-Review': '1' } }); }
});

// 서버에 더 새 판이 있으면 받아서 합친다. 합친 게 있으면 true.
async function pullRemote() {
  if (!R) return false;
  const name = S.name;
  let rec;
  try { rec = await (await api('/api/review?name=' + enc(name))).json(); }
  catch (e) { if (e.status === 404) return false; throw e; }
  if (S.name !== name || !R) return false;
  const rrev = rec.rev || 0;
  if (rrev <= baseRev) return false;
  mergeRemote(rec);
  baseRev = rrev;
  return true;
}
// 마커별로 합치기: 같은 마커면 나중에 고친 쪽(updatedAt)이 이긴다. 지운 기록(deleted)이 더 나중이면 지운다.
function mergeRemote(rec) {
  const tomb = new Map();
  for (const t of [...(R.deleted || []), ...(rec.deleted || [])]) if ((tomb.get(t.id) || '') < t.at) tomb.set(t.id, t.at);
  const byId = new Map();
  for (const m of rec.markers || []) byId.set(m.id, normalize({ ...m }));
  for (const m of R.markers) {
    const o = byId.get(m.id);
    if (!o || (m.updatedAt || '') > (o.updatedAt || '')) byId.set(m.id, m);
  }
  R.markers = [...byId.values()].filter(m => !(tomb.has(m.id) && tomb.get(m.id) >= (m.updatedAt || '')));
  R.deleted = [...tomb].map(([id, at]) => ({ id, at }));
  // 검수 완료·fps·경로는 검수하는 사람(호스트) 것. 손님은 서버 값을 따른다.
  if (isGuest()) {
    R.status = rec.status; R.doneAt = rec.doneAt; R.videoPath = rec.videoPath || R.videoPath;
    if (rec.fps) R.fps = rec.fps;
  }
  undoStack = []; redoStack = [];   // 다른 사람 수정이 섞이면 되돌리기 기록은 비운다
  if (selId && !getSel()) selId = null;
  renderList(); renderEditor(); renderDone(); needDraw = true;
}

// ---------- 영상 열기 ----------
async function openVideo(name) {
  await flushSave();
  S.name = name;
  try { localStorage.setItem('vr.last', S.dir + '|' + name); } catch { }
  selId = null; inPt = outPt = null; undoStack = []; redoStack = [];
  let rec = null;
  try { rec = await (await api('/api/review?name=' + enc(name))).json(); }
  catch (e) { if (e.status !== 404) { setSaveState('기록을 못 읽었어요: ' + e.message, true); } }
  R = rec || {
    version: 1, video: name, videoPath: '', duration: 0, fps: 30,
    status: 'in_review', createdAt: new Date().toISOString(), markers: [],
  };
  R.video = name;
  if (!isGuest()) R.videoPath = joinPath(S.dir, name);   // 손님은 폴더 경로를 모른다
  baseRev = (rec && rec.rev) || 0;
  R.deleted = R.deleted || [];
  R.markers = (R.markers || []).map(m => ({ ...m }));
  R.markers.forEach(normalize);
  $('#fps').value = String(R.fps);
  if ($('#fps').value !== String(R.fps)) $('#fps').value = '30';
  setSaveState(rec ? '불러옴' : '새 검수');
  $('#empty').hidden = true;
  video.src = '/video?name=' + enc(name);
  video.playbackRate = +$('#rate').value;
  renderVideoSelect();
  renderAll();
}
function joinPath(dir, name) { return dir.replace(/[\\/]+$/, '') + '\\' + name; }

video.addEventListener('loadedmetadata', () => {
  if (!R) return;
  const changed = Math.abs((R.duration || 0) - video.duration) > 0.01;
  R.duration = +video.duration.toFixed(3);
  R.width = video.videoWidth; R.height = video.videoHeight;
  fitZoom();
  if (changed && R.markers.length) scheduleSave();
  buildThumbs(video.currentSrc || video.src, video.duration);
  renderFsMarks();
  needDraw = true;
});
video.addEventListener('error', () => {
  if (!S.name) return;
  $('#empty').hidden = false;
  $('#empty').innerHTML = '이 영상은 브라우저에서 재생이 안 돼요.<br>프리미어에서 <b>H.264 (.mp4)</b>로 내보낸 파일로 검수해 주세요.<br><span class="dim">(ProRes·HEVC 일부는 브라우저가 못 엽니다)</span>';
});
video.addEventListener('play', () => { $('#playBtn').textContent = '❚❚'; });
video.addEventListener('pause', () => { $('#playBtn').textContent = '▶'; needDraw = true; });
video.addEventListener('seeked', () => { needDraw = true; });

// ---------- 썸네일 줄 ----------
function once(el, ev) { return new Promise(res => el.addEventListener(ev, res, { once: true })); }
async function buildThumbs(src, d) {
  const token = ++thumbToken;
  TH = null;
  if (!d || !isFinite(d)) return;
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.src = src;
  await once(v, 'loadedmetadata');
  if (token !== thumbToken || !v.videoWidth) return;
  const th = 72;
  const tw = Math.round(th * v.videoWidth / v.videoHeight);
  let n = clamp(Math.ceil(d / 1.5), 20, 240);
  n = Math.min(n, Math.floor(32000 / tw));
  const strip = document.createElement('canvas');
  strip.width = tw * n; strip.height = th;
  TH = { strip, sctx: strip.getContext('2d'), tw, th, n, step: d / n, done: new Uint8Array(n), aspect: tw / th };
  const order = [];
  for (const stride of [32, 16, 8, 4, 2, 1]) for (let i = 0; i < n; i += stride) if (!order.includes(i)) order.push(i);
  for (const i of order) {
    if (token !== thumbToken) return;
    v.currentTime = Math.min(d - 0.05, (i + 0.5) * TH.step);
    await Promise.race([once(v, 'seeked'), new Promise(r => setTimeout(r, 4000))]);
    if (token !== thumbToken) return;
    try { TH.sctx.drawImage(v, i * tw, 0, tw, th); TH.done[i] = 1; } catch { }
    needDraw = true;
  }
  v.removeAttribute('src'); v.load();
}
function nearestThumb(idx) {
  if (!TH) return -1;
  idx = clamp(idx, 0, TH.n - 1);
  for (let k = 0; k < TH.n; k++) {
    if (idx - k >= 0 && TH.done[idx - k]) return idx - k;
    if (idx + k < TH.n && TH.done[idx + k]) return idx + k;
  }
  return -1;
}

// ---------- 마커 ----------
const uid = () => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function normalize(m) {
  const d = dur() || Infinity;
  if (m.end == null) m.end = m.start;
  if (m.end < m.start) [m.start, m.end] = [m.end, m.start];
  m.start = clamp(m.start, 0, d);
  m.end = clamp(m.end, 0, d);
  if (m.end - m.start < 1 / fps()) { m.end = m.start; m.kind = 'point'; } else m.kind = 'range';
  if (!TYPE[m.type]) m.type = 'other';
  return m;
}
function sortedMarkers() { return [...R.markers].sort((a, b) => a.start - b.start || a.end - b.end); }
function getSel() { return R && R.markers.find(m => m.id === selId); }
function snapshot() {
  undoStack.push(JSON.stringify(R.markers));
  if (undoStack.length > 200) undoStack.shift();
  redoStack = [];
}
function commit() {
  R.markers.forEach(normalize);
  if (selId && !getSel()) selId = null;
  renderList(); renderEditor(); needDraw = true;
  scheduleSave();
}
// 되돌리기도 "지금 고친 것"으로 남겨야 다른 사람 화면과 합칠 때 이긴다
function restoreMarkers(json) {
  const prev = new Map(R.markers.map(m => [m.id, JSON.stringify(m)]));
  const next = JSON.parse(json);
  const now = new Date().toISOString();
  const nextIds = new Set(next.map(m => m.id));
  for (const m of next) if (prev.get(m.id) !== JSON.stringify(m)) m.updatedAt = now;
  for (const id of prev.keys()) if (!nextIds.has(id)) R.deleted.push({ id, at: now });
  R.markers = next;
}
function doUndo() {
  if (!canEdit() || !undoStack.length) return flash('되돌릴 게 없어요');
  redoStack.push(JSON.stringify(R.markers));
  restoreMarkers(undoStack.pop());
  commit(); flash('되돌림');
}
function doRedo() {
  if (!canEdit() || !redoStack.length) return flash('다시 할 게 없어요');
  undoStack.push(JSON.stringify(R.markers));
  restoreMarkers(redoStack.pop());
  commit(); flash('다시 함');
}
function addMarker(type, start, end) {
  if (!canEdit()) return null;
  snapshot();
  const now = new Date().toISOString();
  const m = normalize({ id: uid(), type, start, end, note: '', applied: false, createdAt: now, updatedAt: now });
  R.markers.push(m);
  selId = m.id;
  commit();
  return m;
}
function touch(m) { m.updatedAt = new Date().toISOString(); }
function removeSel() {
  const m = getSel(); if (!m || !canEdit()) return;
  snapshot();
  R.markers = R.markers.filter(x => x.id !== m.id);
  R.deleted.push({ id: m.id, at: new Date().toISOString() });   // 다른 사람 화면에서도 지워지게
  selId = null;
  commit(); flash('마커 삭제 (Ctrl+Z로 되돌리기)');
}
function select(id, { seek = false, focus = false } = {}) {
  selId = id;
  const m = getSel();
  if (m && seek) seekTo(m.start);
  renderList(); renderEditor(); needDraw = true;
  if (m) scrollIntoViewT(m.start);
  if (focus) focusNote();
}
// 바로 포커스해야 M 누르고 곧장 치는 글자가 빠지지 않는다
function focusNote() { noteEl.focus({ preventScroll: true }); noteEl.setSelectionRange(noteEl.value.length, noteEl.value.length); }

// 종류 버튼·숫자키 = 그 종류로 바로 마킹, M = 마지막에 쓴 종류로 마킹
function mark(type) {
  if (!canEdit() || !dur()) return;
  if (type) setType(type);
  const t = video.currentTime;
  let s = t, e = t;
  if (inPt != null) {
    s = inPt; e = outPt != null ? outPt : t;
    if (e < s) [s, e] = [e, s];
    inPt = outPt = null;
  }
  const wasPlaying = !video.paused;
  resumeAfterNote = false;
  if ($('#pauseOnMark').checked) {
    if (wasPlaying) { video.pause(); resumeAfterNote = true; }
  }
  const m = addMarker(curType, s, e);
  renderIO();
  flash(`${TYPE[curType].label} 마킹 · ${tc(m.start)}${m.kind === 'range' ? ' → ' + tc(m.end) : ''}`);
  if ($('#pauseOnMark').checked) focusNote();
}
// 마지막에 쓴 종류 (M 키, 타임라인 끌어서 만들 때 쓰임)
function setType(key) {
  curType = key;
  renderTypes();
}
// 오른쪽 편집 칸 종류 버튼 = 고른 마커의 종류를 바꾼다
function setSelType(key) {
  if (!canEdit()) return;
  const m = getSel();
  if (m && m.type !== key) { snapshot(); m.type = key; touch(m); commit(); }
}
function jumpMarker(dir) {
  if (!R || !R.markers.length) return;
  const t = video.currentTime;
  const list = sortedMarkers();
  let m;
  if (dir > 0) m = list.find(x => x.start > t + 0.01) || list[list.length - 1];
  else m = [...list].reverse().find(x => x.start < t - 0.01) || list[0];
  select(m.id, { seek: true });
}

// ---------- 재생 ----------
function seekTo(t) {
  if (!dur()) return;
  video.currentTime = clamp(t, 0, dur());
  needDraw = true;
}
function togglePlay() {
  if (!R) return;
  if (video.paused) { if (video.currentTime >= dur() - 0.01) video.currentTime = 0; video.play(); }
  else video.pause();
}
function step(sec) { video.pause(); seekTo(video.currentTime + sec); }
const ACTS = {
  play: togglePlay,
  prevFrame: () => step(-1 / fps()), nextFrame: () => step(1 / fps()),
  back1s: () => step(-1), fwd1s: () => step(1),
  prevMark: () => jumpMarker(-1), nextMark: () => jumpMarker(1),
};
document.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => { ACTS[b.dataset.act](); b.blur(); }));

// ---------- 화면 그리기: 오른쪽 목록 ----------
function renderTypes() {
  $('#types').innerHTML = TYPES.map((t, i) =>
    `<button data-type="${t.key}" class="${t.key === curType ? 'on' : ''}" title="지금 위치에 ${t.label} 마킹 (${i + 1})"${R ? '' : ' disabled'}><i style="background:${t.color}"></i>${t.label}<kbd>${i + 1}</kbd></button>`).join('');
  // mousedown 에서 기본 동작을 막아야 버튼이 포커스를 가져가지 않고 메모 칸으로 바로 간다
  $('#types').querySelectorAll('button').forEach(b => {
    b.onmousedown = e => e.preventDefault();
    b.onclick = () => mark(b.dataset.type);
  });
}
function renderFilters() {
  const counts = {};
  (R ? R.markers : []).forEach(m => counts[m.type] = (counts[m.type] || 0) + 1);
  const total = R ? R.markers.length : 0;
  $('#filters').innerHTML = `<span class="fchip ${filter ? '' : 'on'}" data-f="">전체 ${total}</span>` +
    TYPES.filter(t => counts[t.key]).map(t =>
      `<span class="fchip ${filter === t.key ? 'on' : ''}" data-f="${t.key}"><i style="background:${t.color}"></i>${t.label} ${counts[t.key]}</span>`).join('');
  $('#filters').querySelectorAll('.fchip').forEach(c => c.onclick = () => { filter = c.dataset.f || null; renderList(); });
}
function renderList() {
  renderFilters();
  renderFsMarks();
  const ul = $('#list');
  if (!R) { ul.innerHTML = ''; $('#count').textContent = ''; return; }
  const applied = R.markers.filter(m => m.applied).length;
  $('#count').textContent = R.markers.length ? `${R.markers.length}개${applied ? ` · 반영 ${applied}` : ''}` : '';
  const list = sortedMarkers().filter(m => !filter || m.type === filter);
  if (!list.length) {
    ul.innerHTML = `<li class="emptyrow">${R.markers.length ? '이 종류의 마커가 없어요.' : '영상을 보다가 고칠 곳에서 <kbd>M</kbd>을 누르세요.<br>구간은 <kbd>I</kbd>·<kbd>O</kbd>로 찍거나 타임라인 마커 줄을 끌면 돼요.'}</li>`;
    return;
  }
  ul.innerHTML = list.map(m => {
    const t = TYPE[m.type];
    const times = m.kind === 'range' ? `${tc(m.start)} → ${tc(m.end)}` : tc(m.start);
    return `<li class="row${m.id === selId ? ' sel' : ''}${m.applied ? ' applied' : ''}" data-id="${m.id}">
      <span class="bar" style="background:${t.color}"></span>
      <div><div class="tcs tc">${times}</div><div class="nt${m.note ? '' : ' none'}">${m.note ? esc(m.note) : '메모 없음'}</div></div>
      <div class="tags"><span class="tag" style="color:${t.color}">${t.label}</span>${m.rule ? '<span class="tag rule" title="앞으로도 이렇게 (원칙 후보)">★ 앞으로도</span>' : ''}</div></li>`;
  }).join('');
  ul.querySelectorAll('.row').forEach(li => {
    li.onclick = () => select(li.dataset.id, { seek: true });
    li.ondblclick = () => select(li.dataset.id, { seek: true, focus: true });
  });
  const selEl = ul.querySelector('.row.sel');
  if (selEl) selEl.scrollIntoView({ block: 'nearest' });
}
function renderEditor() {
  const m = getSel();
  const ed = $('#editor');
  ed.hidden = !m;
  if (!m) return;
  $('#edType').innerHTML = TYPES.map(t =>
    `<button data-type="${t.key}" class="${t.key === m.type ? 'on' : ''}"><i style="background:${t.color}"></i>${t.label}</button>`).join('');
  $('#edType').querySelectorAll('button').forEach(b => b.onclick = () => setSelType(b.dataset.type));
  if (document.activeElement !== $('#edStart')) $('#edStart').value = tc(m.start);
  if (document.activeElement !== $('#edEnd')) $('#edEnd').value = tc(m.end);
  if (document.activeElement !== noteEl) noteEl.value = m.note || '';
  $('#edDone').checked = !!m.applied;
  $('#edRule').checked = !!m.rule;
  $('#fsNoteHead').textContent = `${TYPE[m.type].label} · ${tc(m.start)}${m.kind === 'range' ? ' → ' + tc(m.end) : ''}  —  Enter 저장하고 이어서 재생`;
  $('#edPoint').disabled = m.kind === 'point';
}
function renderIO() {
  const el = $('#ioState');
  if (inPt == null && outPt == null) { el.textContent = ''; return; }
  el.innerHTML = `구간 <span class="tc">${inPt != null ? tc(inPt) : '--'} → ${outPt != null ? tc(outPt) : '--'}</span> <span class="dim">(M 누르면 마커, X 지우기)</span>`;
  needDraw = true;
}
function renderDone() {
  const b = $('#doneBtn');
  b.disabled = !R;
  if (!R) return;
  const done = R.status === 'done';
  b.textContent = done ? '✅ 검수 완료됨 (다시 열기)' : '검수 완료';
  b.classList.toggle('done', done);
}
function renderAll() {
  renderTypes(); renderList(); renderEditor(); renderIO(); renderDone();
  needDraw = true;
}

let flashTimer = null;
function flash(text) {
  const el = $('#flash');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('on'), 1400);
}

// ---------- 편집 칸 ----------
noteEl.addEventListener('focus', () => { const m = getSel(); if (m) snapshot(); });
noteEl.addEventListener('input', () => {
  const m = getSel(); if (!m) return;
  m.note = noteEl.value; touch(m);
  renderList(); needDraw = true; scheduleSave();
});
function timeInput(el, which) {
  el.addEventListener('change', () => {
    const m = getSel(); if (!m) return;
    const t = parseTC(el.value);
    if (t == null) { flash('시간 형식: 00:01:23:15 또는 83.5'); renderEditor(); return; }
    snapshot();
    if (which === 'start') { m.start = t; if (m.kind === 'point' || m.end < t) m.end = Math.max(m.end, t); }
    else m.end = t;
    touch(m); commit();
  });
  el.addEventListener('keydown', e => { if (e.key === 'Enter') el.blur(); });
}
timeInput($('#edStart'), 'start');
timeInput($('#edEnd'), 'end');
$('#edStartNow').onclick = () => {
  const m = getSel(); if (!m) return; snapshot();
  const t = video.currentTime;
  if (m.kind === 'point') { m.start = t; m.end = t; } else { m.start = t; }
  touch(m); commit();
};
$('#edEndNow').onclick = () => { const m = getSel(); if (!m) return; snapshot(); m.end = video.currentTime; touch(m); commit(); };
$('#edPoint').onclick = () => { const m = getSel(); if (!m) return; snapshot(); m.end = m.start; touch(m); commit(); };
$('#edDel').onclick = removeSel;
$('#edRule').onchange = () => { const m = getSel(); if (!m) return; snapshot(); m.rule = $('#edRule').checked; touch(m); commit(); flash(m.rule ? '★ 앞으로도 이렇게 — 원칙 후보로 표시했어요' : '원칙 후보 표시를 뺐어요'); };
$('#edDone').onchange = () => { const m = getSel(); if (!m) return; snapshot(); m.applied = $('#edDone').checked; touch(m); commit(); };

// ---------- 위쪽 막대 ----------
$('#dirOpen').onclick = () => openDir();
$('#dir').addEventListener('keydown', e => { if (e.key === 'Enter') openDir(); });
// 폴더 경로든 영상 파일 경로든 연다. 파일이면 그 폴더를 열고 그 영상을 바로 띄운다.
async function openDir(pathArg) {
  const dir = (pathArg || $('#dir').value).trim().replace(/^"|"$/g, '');
  if (!dir) return;
  await flushSave();
  try {
    const s = await (await api('/api/dir', { method: 'POST', body: JSON.stringify({ dir }), headers: { 'Content-Type': 'application/json' } })).json();
    closeVideo();
    applyState(s);
    rememberDir(S.dir);
    if (s.open) openVideo(s.open);
    else flash(S.videos.length ? `영상 ${S.videos.length}개 — 위에서 골라 주세요` : '이 폴더에 영상이 없어요');
  } catch (e) { flash('그 경로를 못 찾았어요'); }
}
$('#pickBtn').onclick = async e => {
  e.target.blur();
  flash('파일 열기 창을 띄웠어요 (작업 표시줄에 숨어 있을 수 있어요)');
  try {
    const r = await (await api('/api/pick', { method: 'POST' })).json();
    if (r.path) openDir(r.path);
  } catch (err) { flash('파일 열기 창을 못 띄웠어요: ' + err.message); }
};
// 최근에 연 폴더 (이 브라우저에만 기억, 경로 칸 ▼ 목록)
function recentDirs() { try { return JSON.parse(localStorage.getItem('vr.recentDirs') || '[]'); } catch { return []; } }
function rememberDir(d) {
  if (!d) return;
  const list = [d, ...recentDirs().filter(x => x !== d)].slice(0, 8);
  try { localStorage.setItem('vr.recentDirs', JSON.stringify(list)); } catch { }
  renderRecentDirs();
}
function renderRecentDirs() { $('#recentDirs').innerHTML = recentDirs().map(d => `<option value="${esc(d)}">`).join(''); }
$('#dir').addEventListener('focus', e => e.target.select());
function closeVideo() {
  S.name = null; R = null; selId = null; TH = null; thumbToken++;
  video.removeAttribute('src'); video.load();
  $('#empty').hidden = false;
  $('#empty').textContent = '영상을 골라 주세요.';
  renderAll();
}
$('#videoSel').onchange = e => { if (e.target.value) openVideo(e.target.value); e.target.blur(); };
$('#doneBtn').onclick = async () => {
  if (!R) return;
  if (R.status === 'done') {
    if (!confirm('검수를 다시 열까요?\n정리 파일에 "검수 중"으로 표시돼서, 다시 완료하기 전까지 재편집 세션이 쓰지 않아요.')) return;
    R.status = 'in_review'; delete R.doneAt;
    flash('검수를 다시 열었어요');
  } else {
    const empty = R.markers.filter(m => !(m.note || '').trim()).length;
    if (empty && !confirm(`메모가 없는 마커가 ${empty}개 있어요. 그래도 검수 완료할까요?\n(재편집 세션이 무엇을 고칠지 몰라 팀장님께 물어보게 돼요)`)) return;
    R.status = 'done'; R.doneAt = new Date().toISOString();
  }
  renderDone();
  dirty = true; await save();
  if (dirty) return flash('저장이 안 돼서 정리 파일을 못 만들었어요. 다시 눌러 주세요');
  try {
    const r = await (await api('/api/summary?name=' + enc(S.name), { method: 'PUT', body: buildSummary(), headers: { 'Content-Type': 'text/markdown; charset=utf-8' } })).json();
    if (R.status === 'done') showDoneModal(r.path);
  } catch (e) { flash('정리 파일을 못 만들었어요: ' + e.message); }
};

// ---------- 검수 정리 파일 (<영상>.검수정리.md) ----------
// 검수 완료를 누르면 만든다. 편집 오피스의 재편집 세션이 이 파일을 읽고, 팀장님께 한 번 더 확인받은 뒤 고친다.
// 재편집 순서: 길이가 안 바뀌는 것 먼저 → 컷편집은 맨 마지막에 뒤(늦은 시각)부터 (앞을 자르면 뒤 시각이 밀리므로)
const REEDIT_ORDER = ['subtitle', 'audio', 'sfx', 'effect', 'visual', 'other', 'cut'];
function buildSummary() {
  const list = sortedMarkers();
  const num = new Map(list.map((m, i) => [m.id, 'R' + String(i + 1).padStart(2, '0')]));
  const cell = s => String(s || '').replace(/\r?\n/g, ' / ').replace(/\|/g, '\\|').trim();
  const where = m => m.kind === 'range'
    ? `${tc(m.start)} → ${tc(m.end)} (${(m.end - m.start).toFixed(1)}초)`
    : `${tc(m.start)} (지점)`;
  const counts = TYPES.map(t => [t, list.filter(m => m.type === t.key).length]).filter(([, n]) => n);
  const empty = list.filter(m => !(m.note || '').trim());
  const applied = list.filter(m => m.applied);
  const done = R.status === 'done';
  const when = iso => iso ? new Date(iso).toLocaleString('sv-SE').slice(0, 16) : '';
  const L = [];
  L.push(`# 검수 정리 — ${R.video}`, '');
  L.push(done
    ? `- 상태: **검수 완료** (${when(R.doneAt)}) — 재편집에 써도 됨`
    : `- 상태: **검수 중 (다시 열림)** — ⚠ 다시 검수 완료하기 전까지 재편집에 쓰지 않는다`);
  L.push(`- 영상 파일: \`${R.videoPath || R.video}\``);
  L.push(`- 길이: ${tc(dur())} · fps ${fps()}${R.width ? ` · ${R.width}×${R.height}` : ''}`);
  L.push(`- 기록 파일: \`${R.video}.review.json\` (rev ${R.rev || 0}) — 이 정리와 같은 판인지 rev로 확인`);
  L.push(`- 정리한 시각: ${when(new Date().toISOString())}`);
  L.push(`- 고칠 곳: 총 ${list.length}개${counts.length ? ' — ' + counts.map(([t, n]) => `${t.label} ${n}`).join(' · ') : ''}`);
  if (empty.length) L.push(`- ⚠ 메모 없는 마커 ${empty.length}개: ${empty.map(m => num.get(m.id)).join(', ')} → 무엇을 고칠지 팀장님께 확인`);
  if (applied.length) L.push(`- 이미 반영됨 표시: ${applied.length}개 (${applied.map(m => num.get(m.id)).join(', ')}) → 다시 고치지 않음`);
  L.push('');
  L.push('## 시각 기준');
  L.push('- 아래 시각은 **검수한 영상 파일** 기준(HH:MM:SS:FF)이다.');
  L.push('- 시퀀스를 처음부터 끝까지 통째로 내보낸 영상이면 **시퀀스 시각과 같다.** 시퀀스 시작이 00:00:00:00이 아니면 그만큼 더한다.');
  L.push('- 검수 뒤에 시퀀스가 바뀌었으면(컷 등) 시각이 밀렸을 수 있다 → 재편집 전에 확인하고 팀장님께 먼저 말한다.');
  L.push('');
  L.push('## 고칠 곳 (시간 순)', '');
  L.push('| 번호 | 시각 | 종류 | 메모 | 앞으로도 | 반영 | id |', '|---|---|---|---|---|---|---|');
  for (const m of list) {
    L.push(`| ${num.get(m.id)} | ${where(m)} | ${TYPE[m.type].label} | ${cell(m.note) || '⚠ 메모 없음'} | ${m.rule ? '★' : ''} | ${m.applied ? '반영됨' : ''} | ${m.id} |`);
  }
  if (!list.length) L.push('| - | - | - | 고칠 곳 없음 | | | |');
  L.push('');
  // 검수 학습 (구조안 11-10): 팀장님이 '앞으로도 이렇게'로 표시한 것 = 원인 ②(원칙집에 없음) 확정 후보
  const rules = list.filter(m => m.rule);
  L.push('## 원칙 후보 (팀장님 "앞으로도 이렇게" 표시)');
  if (rules.length) {
    L.push('재편집 뒤 검수 학습 기록에 **원인 ② 새 원칙 후보**로 적는다(이미 원칙집에 있으면 ① 놓친 원칙). 원칙집 반영은 팀장님 승인 후.', '');
    for (const m of rules) L.push(`- ${num.get(m.id)} · ${TYPE[m.type].label} · ${cell(m.note) || '⚠ 메모 없음'}`);
  } else {
    L.push('- 없음. 나머지 항목의 원인(① 놓친 원칙 / ② 새 원칙 / ③ 이 영상만 / ④ 세션 한계)은 재편집 세션이 나눈다.');
  }
  L.push('');
  L.push('## 재편집 순서 (종류별)');
  L.push('길이가 바뀌지 않는 것부터 하고, **컷편집은 맨 마지막에 뒤(늦은 시각)부터** 한다. 앞을 먼저 자르면 뒤 시각이 전부 밀린다.', '');
  for (const key of REEDIT_ORDER) {
    let ms = list.filter(m => m.type === key && !m.applied);
    if (!ms.length) continue;
    if (key === 'cut') ms = [...ms].reverse();
    L.push(`### ${TYPE[key].label} (${ms.length})${key === 'cut' ? ' — 뒤에서부터' : ''}`);
    for (const m of ms) L.push(`- ${num.get(m.id)} · ${where(m)} · ${cell(m.note) || '⚠ 메모 없음'}`);
    L.push('');
  }
  return L.join('\n') + '\n';
}
function showDoneModal(path) {
  $('#shareBody').innerHTML = `
    <p><b>검수 완료!</b> 고칠 곳 ${R.markers.length}개를 정리 파일로 만들었어요.</p>
    <div class="linkrow"><input id="donePath" readonly value="${esc(path)}"><button id="doneCopy" class="primary">경로 복사</button></div>
    <p class="dim">편집 오피스 Main Header에게 "이 영상 재편집 준비해줘"라고 말하고 이 경로를 알려 주세요. 재편집 세션이 정리해서 한 번 더 여쭤본 뒤, 승인하시면 고쳐요.</p>
    <div class="srow"><button id="doneOk" class="primary">확인</button></div>`;
  $('#share .hh b').textContent = '✅ 검수 완료';
  $('#doneCopy').onclick = async () => {
    const i = $('#donePath');
    try { await navigator.clipboard.writeText(i.value); } catch { i.select(); document.execCommand('copy'); }
    flash('경로를 복사했어요');
  };
  $('#doneOk').onclick = () => { $('#share').hidden = true; };
  $('#share').hidden = false;
}
$('#rate').onchange = e => { video.playbackRate = +e.target.value; e.target.blur(); };
$('#fps').onchange = e => {
  if (R) { R.fps = +e.target.value; scheduleSave(); renderList(); renderEditor(); }
  needDraw = true; e.target.blur();
};
$('#vol').oninput = e => { video.volume = +e.target.value; };
$('#helpBtn').onclick = () => { $('#help').hidden = false; };
$('#helpClose').onclick = () => { $('#help').hidden = true; };
$('#help').onclick = e => { if (e.target.id === 'help') $('#help').hidden = true; };

// ---------- 확대 / 축소 ----------
const fitPps = () => dur() ? Math.max(0.01, (scroller.clientWidth - 24) / dur()) : 20;
function setPps(p, anchorX = scroller.clientWidth / 2) {
  const minP = fitPps();
  const t = (scroller.scrollLeft + anchorX) / pps;
  pps = clamp(p, minP, MAX_PPS);
  fitMode = pps <= minP * 1.0001;
  spacer.style.width = Math.ceil(dur() * pps + 24) + 'px';
  scroller.scrollLeft = t * pps - anchorX;
  const v = Math.log(pps / minP) / Math.log(MAX_PPS / minP);
  $('#zoom').value = Math.round(clamp(isFinite(v) ? v : 0, 0, 1) * 1000);
  needDraw = true;
}
function fitZoom() { pps = fitPps(); setPps(pps, 0); scroller.scrollLeft = 0; }
$('#zoom').oninput = e => {
  const minP = fitPps();
  const p = minP * Math.pow(MAX_PPS / minP, +e.target.value / 1000);
  setPps(p, clamp(video.currentTime * pps - scroller.scrollLeft, 0, scroller.clientWidth));
};
$('#zoomIn').onclick = () => setPps(pps * 1.6, playheadAnchor());
$('#zoomOut').onclick = () => setPps(pps / 1.6, playheadAnchor());
$('#zoomFit').onclick = fitZoom;
function playheadAnchor() { return clamp(video.currentTime * pps - scroller.scrollLeft, 0, scroller.clientWidth); }
scroller.addEventListener('wheel', e => {
  if (!R) return;
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const rect = cv.getBoundingClientRect();
    setPps(pps * Math.exp(-e.deltaY * 0.0025), e.clientX - rect.left);
  } else {
    scroller.scrollLeft += (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY);
  }
}, { passive: false });
scroller.addEventListener('scroll', () => { needDraw = true; });
window.addEventListener('resize', () => { if (fitMode) fitZoom(); else setPps(pps); });
function scrollIntoViewT(t) {
  const x = t * pps - scroller.scrollLeft;
  const W = scroller.clientWidth;
  if (x < 20 || x > W - 20) scroller.scrollLeft = t * pps - W * 0.3;
}

// ---------- 타임라인 그리기 ----------
function tickStep() {
  const f = fps();
  const cand = [1 / f, 2 / f, 5 / f, 10 / f, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  for (const s of cand) if (s * pps >= 90) return s;
  return 3600;
}
function layoutLanes(x0, W) {
  ctx.font = '12px "Malgun Gothic", sans-serif';
  const items = sortedMarkers().map(m => {
    const x = m.start * pps - x0;
    let w = (m.end - m.start) * pps;
    let vis = w;
    if (m.kind === 'point') {
      const label = (TYPE[m.type].label + (m.note ? ' ' + m.note.split('\n')[0] : '')).slice(0, 30);
      vis = Math.min(180, 18 + ctx.measureText(label).width);
      w = 0;
    }
    return { m, x, w, vis: Math.max(vis, 6) };
  });
  const laneEnds = [];
  for (const it of items) {
    let lane = laneEnds.findIndex(end => end <= it.x - 2);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(0); }
    laneEnds[lane] = it.x + it.vis;
    it.lane = lane;
  }
  return { items, lanes: Math.max(2, laneEnds.length) };
}
function draw() {
  const dpr = window.devicePixelRatio || 1;
  const W = scroller.clientWidth;
  const x0 = scroller.scrollLeft;
  const d = dur();
  const { items, lanes } = R ? layoutLanes(x0, W) : { items: [], lanes: 2 };
  const H = MARK_Y + Math.min(lanes, 6) * (LANE_H + LANE_GAP) + 8;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#1c1d21'; ctx.fillRect(0, 0, W, H);
  if (!R || !d) { layout = []; return; }
  const X = t => t * pps - x0;
  const endX = X(d);

  // 눈금자
  ctx.fillStyle = '#25262b'; ctx.fillRect(0, 0, W, RULER_H);
  const stepT = tickStep();
  const minor = stepT / 5;
  ctx.strokeStyle = '#555962'; ctx.fillStyle = '#a4a8b0';
  ctx.font = '11px Consolas, monospace'; ctx.textBaseline = 'top';
  ctx.beginPath();
  const tStart = Math.floor((x0 / pps) / minor) * minor;
  for (let t = tStart; t <= Math.min(d, (x0 + W) / pps); t += minor) {
    const x = Math.round(X(t)) + 0.5;
    const major = Math.abs(t / stepT - Math.round(t / stepT)) < 1e-6;
    ctx.moveTo(x, RULER_H); ctx.lineTo(x, RULER_H - (major ? 10 : 4));
    if (major) ctx.fillText(tcShort(t, stepT), x + 3, 3);
  }
  ctx.stroke();

  // 썸네일 줄
  ctx.fillStyle = '#111215'; ctx.fillRect(0, RULER_H, Math.min(W, endX), THUMB_H);
  if (TH) {
    const tileW = THUMB_H * TH.aspect;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, RULER_H, Math.min(W, endX), THUMB_H); ctx.clip();
    for (let ax = Math.floor(x0 / tileW) * tileW; ax < x0 + W && ax < d * pps; ax += tileW) {
      const t = (ax + tileW / 2) / pps;
      const idx = nearestThumb(Math.floor(t / TH.step));
      if (idx < 0) continue;
      ctx.drawImage(TH.strip, idx * TH.tw, 0, TH.tw, TH.th, ax - x0, RULER_H, tileW, THUMB_H);
    }
    ctx.restore();
  }
  // 영상 끝 이후 어둡게
  if (endX < W) { ctx.fillStyle = '#141518'; ctx.fillRect(Math.max(0, endX), 0, W - endX, H); }

  // I/O 구간
  if (inPt != null || outPt != null) {
    const a = inPt != null ? inPt : 0, b = outPt != null ? outPt : video.currentTime;
    const xa = X(Math.min(a, b)), xb = X(Math.max(a, b));
    ctx.fillStyle = 'rgba(255,255,255,.10)'; ctx.fillRect(xa, 0, xb - xa, H);
    ctx.fillStyle = '#d9dbe0';
    if (inPt != null) ctx.fillRect(X(inPt) - 1, 0, 2, H);
    if (outPt != null) ctx.fillRect(X(outPt) - 1, 0, 2, H);
  }

  // 마커
  layout = [];
  ctx.font = '12px "Malgun Gothic", sans-serif'; ctx.textBaseline = 'middle';
  for (const it of items) {
    if (it.lane >= 6) continue;
    const { m } = it;
    if (it.x + it.vis < -2 || it.x > W + 2) continue;
    const t = TYPE[m.type];
    const y = MARK_Y + it.lane * (LANE_H + LANE_GAP);
    const sel = m.id === selId;
    const label = t.label + (m.note ? '  ' + m.note.split('\n')[0] : '');
    ctx.globalAlpha = m.applied ? 0.4 : 1;
    if (m.kind === 'range') {
      const w = Math.max(it.w, 3);
      ctx.fillStyle = t.color + '55'; ctx.fillRect(it.x, y, w, LANE_H);
      ctx.fillStyle = t.color; ctx.fillRect(it.x, y, 3, LANE_H); ctx.fillRect(it.x + w - 3, y, 3, LANE_H);
      ctx.fillRect(it.x, RULER_H, w, 3); // 썸네일 위 띠
      if (sel) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(it.x + 1, y + 1, w - 2, LANE_H - 2); }
      ctx.save(); ctx.beginPath(); ctx.rect(it.x + 5, y, Math.max(0, w - 10), LANE_H); ctx.clip();
      ctx.fillStyle = '#fff'; ctx.fillText(label, Math.max(it.x + 7, 4), y + LANE_H / 2 + 1);
      ctx.restore();
      layout.push({ m, x: it.x, w, y, h: LANE_H });
    } else {
      ctx.fillStyle = t.color;
      ctx.fillRect(Math.round(it.x) - 1, RULER_H, 2, y - RULER_H); // 선
      ctx.beginPath();                                           // 깃발
      ctx.moveTo(it.x, y); ctx.lineTo(it.x + 12, y + LANE_H / 2); ctx.lineTo(it.x, y + LANE_H); ctx.closePath(); ctx.fill();
      ctx.save(); ctx.beginPath(); ctx.rect(it.x + 14, y, it.vis - 14, LANE_H); ctx.clip();
      ctx.fillStyle = sel ? '#fff' : '#d0d3d9'; ctx.fillText(label, it.x + 15, y + LANE_H / 2 + 1);
      ctx.restore();
      if (sel) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(it.x - 3, y - 1, it.vis + 4, LANE_H + 2); }
      layout.push({ m, x: it.x - 3, w: it.vis + 3, y, h: LANE_H, point: true });
    }
    // 눈금자 위 표시
    ctx.fillStyle = t.color; ctx.fillRect(it.x, 0, Math.max(2, it.w), 3);
    ctx.globalAlpha = 1;
  }
  if (lanes > 6) {
    ctx.fillStyle = '#a4a8b0'; ctx.textBaseline = 'bottom';
    ctx.fillText(`겹친 마커가 많아요 — 확대해서 보세요`, 8, H - 1);
  }

  // 마우스 위치 선
  if (hoverX != null && !drag) {
    ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.fillRect(hoverX, 0, 1, H);
  }

  // 재생 헤드
  const px = Math.round(X(video.currentTime)) + 0.5;
  ctx.strokeStyle = '#4c9dff'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke();
  ctx.fillStyle = '#4c9dff';
  ctx.beginPath(); ctx.moveTo(px - 7, 0); ctx.lineTo(px + 7, 0); ctx.lineTo(px + 7, 10); ctx.lineTo(px, 17); ctx.lineTo(px - 7, 10); ctx.closePath(); ctx.fill();
}

function updateTC() {
  $('#tcNow').textContent = tc(video.currentTime);
  $('#tcDur').textContent = '/ ' + tc(dur());
  if (isScreenFs()) {
    $('#fsTc').textContent = tc(video.currentTime) + ' / ' + tc(dur());
    $('#fsHead').style.left = (dur() ? video.currentTime / dur() * 100 : 0) + '%';
  }
}
function follow() {
  if (video.paused || drag) return;
  const x = video.currentTime * pps - scroller.scrollLeft;
  const W = scroller.clientWidth;
  if (x > W - 40 || x < 0) scroller.scrollLeft = video.currentTime * pps - 40;
}
function loop() {
  if (!video.paused || needDraw) {
    needDraw = false;
    follow(); draw(); updateTC();
  }
  requestAnimationFrame(loop);
}

// ---------- 타임라인 마우스 ----------
function cvPos(e) { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function xToT(x) { return clamp((x + scroller.scrollLeft) / pps, 0, dur()); }
function snapT(t, excludeId) {
  const tx = t * pps;
  const cands = [video.currentTime];
  if (inPt != null) cands.push(inPt);
  if (outPt != null) cands.push(outPt);
  for (const m of R.markers) if (m.id !== excludeId) cands.push(m.start, m.end);
  let best = t, bd = 7;
  for (const c of cands) { const dd = Math.abs(c * pps - tx); if (dd < bd) { bd = dd; best = c; } }
  return best;
}
function hit(x, y) {
  for (let i = layout.length - 1; i >= 0; i--) {
    const L = layout[i];
    if (x >= L.x - 4 && x <= L.x + L.w + 4 && y >= L.y && y <= L.y + L.h) {
      if (L.point) return { m: L.m, part: 'body' };
      if (x <= L.x + 6) return { m: L.m, part: 'l' };
      if (x >= L.x + L.w - 6) return { m: L.m, part: 'r' };
      return { m: L.m, part: 'body' };
    }
  }
  return null;
}
cv.addEventListener('mousedown', e => {
  if (!R || !dur() || e.button !== 0) return;
  e.preventDefault();
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  const { x, y } = cvPos(e);
  const t = xToT(x);
  if (y < MARK_Y - 3) {
    drag = { mode: 'scrub', wasPlaying: !video.paused };
    video.pause();
    seekTo(t);
    return;
  }
  const h = hit(x, y);
  if (h) {
    select(h.m.id);
    drag = { mode: h.part === 'body' ? 'move' : h.part, id: h.m.id, x0: x, t0: t, s0: h.m.start, e0: h.m.end, moved: false };
  } else {
    drag = { mode: 'create', x0: x, t0: snapT(t), id: null };
  }
});
window.addEventListener('mousemove', e => {
  if (!drag) {
    if (e.target === cv && R) {
      const { x, y } = cvPos(e);
      hoverX = x;
      const h = y >= MARK_Y - 3 ? hit(x, y) : null;
      cv.style.cursor = h ? (h.part === 'body' ? 'grab' : 'ew-resize') : (y < MARK_Y - 3 ? 'pointer' : 'crosshair');
      cv.title = h ? `${TYPE[h.m.type].label} ${tc(h.m.start)}${h.m.kind === 'range' ? ' → ' + tc(h.m.end) : ''}${h.m.note ? '\n' + h.m.note : ''}` : '';
      needDraw = true;
    } else if (hoverX != null) { hoverX = null; needDraw = true; }
    return;
  }
  const { x } = cvPos(e);
  const t = xToT(x);
  if (drag.mode === 'scrub') { seekTo(t); return; }
  if (!drag.moved && Math.abs(x - drag.x0) < 4) return;
  if (drag.mode === 'create') {
    if (!drag.id) { const m = addMarker(curType, drag.t0, drag.t0); drag.id = m.id; }
    const m = R.markers.find(z => z.id === drag.id);
    const tt = snapT(t, m.id);
    m.start = Math.min(drag.t0, tt); m.end = Math.max(drag.t0, tt);
    drag.moved = true;
  } else {
    const m = R.markers.find(z => z.id === drag.id);
    if (!m) return;
    if (!drag.moved) { snapshot(); drag.moved = true; cv.style.cursor = drag.mode === 'move' ? 'grabbing' : 'ew-resize'; }
    if (drag.mode === 'move') {
      const len = drag.e0 - drag.s0;
      let s = drag.s0 + (t - drag.t0);
      const ss = snapT(s, m.id), se = snapT(s + len, m.id);
      if (ss !== s) s = ss; else if (se !== s + len) s = se - len;
      s = clamp(s, 0, dur() - len);
      m.start = s; m.end = s + len;
    } else if (drag.mode === 'l') {
      m.start = Math.min(snapT(t, m.id), m.end);
    } else if (drag.mode === 'r') {
      m.end = Math.max(snapT(t, m.id), m.start);
    }
    touch(m);
  }
  renderEditor(); needDraw = true;
});
window.addEventListener('mouseup', e => {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.mode === 'scrub') { if (d.wasPlaying) video.play(); return; }
  if (d.mode === 'create') {
    if (d.id) { commit(); flash('구간 마커를 만들었어요 — 메모를 적어 주세요'); focusNote(); }
    else { select(null); seekTo(d.t0); }
    return;
  }
  if (d.moved) commit();
  else { const m = getSel(); if (m) seekTo(m.start); }
});
cv.addEventListener('dblclick', e => {
  const { x, y } = cvPos(e);
  const h = hit(x, y);
  if (h) select(h.m.id, { focus: true });
});
cv.addEventListener('mouseleave', () => { hoverX = null; needDraw = true; });

// 화면 클릭 = 재생/정지, 더블클릭 = 전체화면
video.addEventListener('click', togglePlay);
video.addEventListener('dblclick', () => toggleFs(screenEl));

// ---------- 전체화면 ----------
// F = 영상만 전체화면 (아래에 얇은 진행 막대 + 마커), Shift+F = 타임라인까지 통째로
const screenEl = $('#screen');
function isScreenFs() { return document.fullscreenElement === screenEl; }
function toggleFs(target) {
  if (document.fullscreenElement) document.exitFullscreen();
  else target.requestFullscreen().catch(() => flash('전체화면을 열지 못했어요'));
}
$('#fsBtn').onclick = e => { toggleFs(screenEl); e.target.blur(); };
$('#appFsBtn').onclick = e => { toggleFs(document.documentElement); e.target.blur(); };
$('#fsExit').onclick = e => { e.stopPropagation(); document.exitFullscreen(); };
document.addEventListener('fullscreenchange', () => {
  const fs = isScreenFs();
  document.body.classList.toggle('fs-screen', fs);
  // 영상 전체화면일 때는 메모 칸을 영상 위로 옮겨야 보인다
  if (fs) $('#fsNote').appendChild(noteEl);
  else $('#editor').insertBefore(noteEl, $('#editor .erow'));
  $('#fsBtn').textContent = fs ? '⛶ 전체화면 끝' : '⛶ 전체화면';
  $('#appFsBtn').textContent = document.fullscreenElement === document.documentElement ? '⛶ 통째로 끝' : '⛶ 화면 통째로';
  showFsBar();
  renderFsMarks(); updateTC();
  setTimeout(() => { if (fitMode) fitZoom(); else setPps(pps); }, 60);
});
function renderFsMarks() {
  const box = $('#fsMarks');
  if (!R || !dur()) { box.innerHTML = ''; return; }
  box.innerHTML = R.markers.map(m => {
    const w = m.kind === 'range' ? Math.max(0.3, (m.end - m.start) / dur() * 100) : 0;
    return `<span class="${m.kind}${m.id === selId ? ' sel' : ''}" title="${esc(TYPE[m.type].label + ' ' + (m.note || ''))}" style="left:${m.start / dur() * 100}%;width:${w}%;background:${TYPE[m.type].color}"></span>`;
  }).join('');
}
// 진행 막대: 클릭·끌기로 이동
let fsDrag = false;
function fsSeek(e) { const r = $('#fsTrack').getBoundingClientRect(); seekTo(clamp((e.clientX - r.left) / r.width, 0, 1) * dur()); updateTC(); }
$('#fsTrack').addEventListener('mousedown', e => { e.stopPropagation(); fsDrag = true; fsSeek(e); });
window.addEventListener('mousemove', e => { if (fsDrag) fsSeek(e); });
window.addEventListener('mouseup', () => { fsDrag = false; });
$('#fsbar').addEventListener('click', e => e.stopPropagation());
$('#fsNote').addEventListener('click', e => e.stopPropagation());
// 재생 중 마우스가 가만히 있으면 막대·커서 숨김
let idleTimer = null;
function showFsBar() {
  screenEl.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!video.paused && isScreenFs()) screenEl.classList.add('idle'); }, 2500);
}
screenEl.addEventListener('mousemove', showFsBar);
video.addEventListener('pause', showFsBar);
video.addEventListener('play', showFsBar);

// ---------- 단축키 ----------
let lSpeed = 1;
document.addEventListener('keydown', e => {
  const tag = e.target.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  if (!$('#help').hidden) { if (e.key === 'Escape' || e.key === '?') $('#help').hidden = true; return; }
  if (!$('#share').hidden) { if (e.key === 'Escape') $('#share').hidden = true; return; }
  if (typing) {
    if (e.key === 'Escape') { e.target.blur(); e.preventDefault(); }
    if (e.target === noteEl && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault(); noteEl.blur();
      if (resumeAfterNote) { resumeAfterNote = false; video.play(); }
    }
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.code === 'KeyZ') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
  if (mod && e.code === 'KeyY') { e.preventDefault(); doRedo(); return; }
  if (mod && e.code === 'KeyS') { e.preventDefault(); dirty = true; save(); return; }
  if (mod || e.altKey) return;
  if (e.key === '?') { $('#help').hidden = false; return; }
  if (e.code === 'KeyF') { e.preventDefault(); toggleFs(e.shiftKey ? document.documentElement : screenEl); return; }
  if (!R) return;
  let used = true;
  switch (e.code) {
    case 'Space': togglePlay(); break;
    case 'KeyK': video.pause(); lSpeed = 1; break;
    case 'KeyL':
      if (video.paused) { lSpeed = 1; } else { lSpeed = lSpeed >= 2 ? 1 : lSpeed + 0.5; }
      video.playbackRate = lSpeed * +$('#rate').value; video.play();
      flash(`재생 ${video.playbackRate}x`); break;
    case 'KeyJ': seekTo(video.currentTime - 5); break;
    case 'ArrowLeft': step(e.shiftKey ? -1 : -1 / fps()); break;
    case 'ArrowRight': step(e.shiftKey ? 1 : 1 / fps()); break;
    case 'ArrowUp': jumpMarker(-1); break;
    case 'ArrowDown': jumpMarker(1); break;
    case 'Home': seekTo(0); break;
    case 'End': seekTo(dur()); break;
    case 'KeyM': mark(); break;
    case 'KeyI': inPt = video.currentTime; if (outPt != null && outPt < inPt) outPt = null; renderIO(); flash('구간 시작 ' + tc(inPt)); break;
    case 'KeyO': outPt = video.currentTime; if (inPt == null) inPt = 0; if (outPt < inPt) [inPt, outPt] = [outPt, inPt]; renderIO(); flash('구간 끝 ' + tc(outPt)); break;
    case 'KeyX': inPt = outPt = null; renderIO(); break;
    case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4': case 'Digit5': case 'Digit6': case 'Digit7':
    case 'Numpad1': case 'Numpad2': case 'Numpad3': case 'Numpad4': case 'Numpad5': case 'Numpad6': case 'Numpad7':
      mark(TYPES[+e.code.slice(-1) - 1].key); break;
    case 'Delete': case 'Backspace': removeSel(); break;
    case 'Enter': case 'NumpadEnter': if (getSel()) focusNote(); break;
    case 'Escape': if (inPt != null || outPt != null) { inPt = outPt = null; renderIO(); } else select(null); break;
    case 'Equal': case 'NumpadAdd': setPps(pps * 1.6, playheadAnchor()); break;
    case 'Minus': case 'NumpadSubtract': setPps(pps / 1.6, playheadAnchor()); break;
    case 'Backslash': fitZoom(); break;
    default: used = false;
  }
  if (used) e.preventDefault();
});

// ---------- 같이 보기 (같은 와이파이) ----------
// 기본은 나만 보기. 켜면 서버가 와이파이 쪽 주소를 열고 1회용 링크를 만든다. 끄면 링크가 막힌다.
function renderShareBtn() {
  const on = !!(S.share && S.share.sharing);
  const b = $('#shareBtn');
  b.classList.toggle('on', on);
  const n = (S.share && S.share.viewers) || 0;
  b.textContent = on ? `👥 같이 보는 중 · ${n}명` : '👥 같이 보기';
  b.title = on ? `링크로 들어와 있는 사람 ${n}명 (나 빼고)` : '같은 와이파이의 다른 사람에게 이 화면 보여 주기';
  const v = $('#shareViewers');
  if (v) v.textContent = n ? `지금 ${n}명이 보고 있어요` : '아직 들어온 사람이 없어요';
}
// 공유 중이면 3초마다 들어와 있는 사람 수를 다시 읽는다
setInterval(async () => {
  if (isGuest() || !(S.share && S.share.sharing)) return;
  try { S.share = await (await api('/api/share')).json(); renderShareBtn(); } catch { }
  // 같이 보는 사람이 고친 마커를 내 화면에도 합친다
  if (S.share && S.share.sharing && S.share.video === S.name && R && !dirty && !saving && !drag) {
    try { await pullRemote(); } catch { }
  }
}, 3000);
function renderShareBody(err) {
  const on = S.share && S.share.sharing;
  let html;
  if (err === 'setup') {
    html = `<p>처음 한 번만 준비가 필요해요.</p>
      <p><b>video-review</b> 폴더의 <b>같이보기-준비.cmd</b>를 더블클릭하고, 윈도우가 물어보면 <b>예</b>를 눌러 주세요. 끝나면 아래 버튼을 누르면 돼요.</p>
      <p class="dim">같은 와이파이에 있는 기기만 들어올 수 있게 열어요.</p>
      <div class="srow"><button id="shareOn" class="primary">다시 시도</button></div>`;
  } else if (on) {
    const other = S.name && S.name !== S.share.video;
    html = `<p>공유 중인 영상: <b>${esc(S.share.video || '')}</b> · <span id="shareViewers" class="dim"></span></p>
      <p>같은 와이파이에 있는 사람에게 이 링크를 보내 주세요. 링크를 열면 이 영상이 바로 나와요. 받은 사람도 <b>마킹·수정</b>할 수 있고, 서로 고친 내용이 몇 초 안에 양쪽 화면에 합쳐져요.</p>
      <p class="dim">검수 완료, 폴더·영상 바꾸기, 같이 보기 끄기는 나만 할 수 있어요.</p>
      ${other ? `<p class="dim">지금 보고 있는 영상(<b>${esc(S.name)}</b>)과 달라요. <button id="shareSwitch">지금 보는 영상으로 바꾸기</button> (링크는 그대로, 보는 사람 화면도 바뀌어요)</p>` : ''}
      <div class="linkrow"><input id="shareUrl" readonly value="${esc(S.share.url || '')}"><button id="shareCopy" class="primary">복사</button></div>
      <p class="dim">같이 보기를 끄면 이 링크는 더 이상 안 열려요. 다시 켜면 새 링크가 생겨요.</p>
      <div class="srow"><button id="shareOff" class="danger">같이 보기 끄기</button></div>`;
  } else {
    html = `<p>지금은 <b>나만 보기</b> 상태예요.</p>
      ${S.name
        ? `<p>같이 보기를 켜면 지금 보는 영상 <b>${esc(S.name)}</b>을 같은 와이파이에 있는 사람이 링크로 바로 열어서 같이 마킹·수정할 수 있어요.</p>
           <div class="srow"><button id="shareOn" class="primary">이 영상 같이 보기 켜기</button></div>`
        : `<p>먼저 위에서 같이 볼 영상을 골라 주세요. 링크는 그 영상으로 고정돼요.</p>`}`;
  }
  $('#shareBody').innerHTML = html;
  renderShareBtn();
  if ($('#shareOn')) $('#shareOn').onclick = () => setShare(true);
  if ($('#shareOff')) $('#shareOff').onclick = () => setShare(false);
  if ($('#shareSwitch')) $('#shareSwitch').onclick = () => setShare(true);
  if ($('#shareCopy')) $('#shareCopy').onclick = async () => {
    const i = $('#shareUrl');
    try { await navigator.clipboard.writeText(i.value); } catch { i.select(); document.execCommand('copy'); }
    flash('링크를 복사했어요');
  };
}
async function setShare(on) {
  try {
    S.share = await (await api('/api/share', { method: 'POST', body: JSON.stringify({ on, video: S.name }), headers: { 'Content-Type': 'application/json' } })).json();
    renderShareBody();
    flash(on ? `같이 보기: ${S.name}` : '같이 보기를 껐어요');
  } catch (e) {
    if (e.message === 'setup needed') renderShareBody('setup');
    else flash('같이 보기를 바꾸지 못했어요: ' + e.message);
  }
  renderShareBtn();
}
$('#shareBtn').onclick = async e => {
  e.target.blur();
  try { S.share = await (await api('/api/share')).json(); } catch { }
  renderShareBtn(); renderShareBody();
  $('#share .hh b').textContent = '👥 같이 보기';
  $('#share').hidden = false;
};
$('#shareClose').onclick = () => { $('#share').hidden = true; };
$('#share').onclick = e => { if (e.target.id === 'share') $('#share').hidden = true; };

// 손님 화면: 3초마다 영상 목록과 마커를 다시 읽어 검수하는 사람의 마킹을 따라간다
let lastReviewText = '';
// 손님 탭마다 하나씩: 서버가 이걸로 몇 명이 보고 있는지 센다
const VIEWER_ID = (() => {
  const make = () => Math.random().toString(36).slice(2, 12).padEnd(8, '0');
  try { let id = sessionStorage.getItem('vr.viewer'); if (!id) { id = make(); sessionStorage.setItem('vr.viewer', id); } return id; }
  catch { return make(); }
})();
async function guestPoll() {
  if (!isGuest() || $('#guestGone')) return;
  try {
    const s = await (await api('/api/state', { headers: { 'X-Viewer': VIEWER_ID } })).json();
    S.videos = s.videos || [];
    renderVideoSelect();
    $('#guestBadge').textContent = `👥 같이 보기 · ${s.viewers || 1}명 접속 중`;
    if (s.shareVideo !== S.name) { followShareVideo(s.shareVideo); guestFails = 0; return; }
    if (S.name && R && !dirty && !saving && !drag) await pullRemote();
    guestFails = 0;
  } catch (e) {
    // 같이 보기를 끄면 서버가 그 주소를 닫아서 아예 연결이 안 된다 → 두 번 연속 실패하면 끝난 걸로 본다
    if (e.status === 403 || ++guestFails >= 2) showGuestGone();
  }
}
let guestFails = 0;
// 검수하는 사람이 공유 영상을 바꾸면 손님 화면도 그 영상으로 바뀐다
function followShareVideo(name) {
  $('#guestVideo').textContent = name || '';
  if (!name || name === S.name) return;
  lastReviewText = '';
  openVideo(name);
  if (R) flash(`${name} 같이 보는 중`);
}
function showGuestGone() {
  if ($('#guestGone')) return;
  video.pause();
  const d = document.createElement('div');
  d.id = 'guestGone';
  d.innerHTML = '<div><b>같이 보기가 끝났어요.</b><br><span class="dim">다시 보려면 검수하는 사람에게 새 링크를 받아 주세요.</span></div>';
  document.body.appendChild(d);
}
setInterval(guestPoll, 3000);

// ---------- 시작 ----------
(async function init() {
  renderAll();
  requestAnimationFrame(loop);
  try {
    const s0 = await loadState();
    if (isGuest()) { followShareVideo(s0.shareVideo); guestPoll(); return; }
    rememberDir(S.dir);   // 손님은 공유된 영상으로 바로
    let last = null;
    try { last = localStorage.getItem('vr.last'); } catch { }
    if (last) {
      const [dir, name] = last.split('|');
      if (dir === S.dir && S.videos.some(v => v.name === name)) openVideo(name);
    }
  } catch (e) {
    $('#empty').textContent = '검수 서버에 연결하지 못했어요. start.cmd 로 서버를 켜 주세요.';
  }
})();

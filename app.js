/* PRINCE2 Foundation Trainer – App-Logik
   Datenbasis: data/katalog.json (ein Eintrag pro Frage, siehe README „Datenmodell“).
   Änderungshistorie und Begründungen: docs/PROTOKOLL.md */

/* ---------- Konstanten ---------- */
const EXAMS = [
  { code: 'MU1', title: 'Musterprüfung 1', sub: 'Offizielle PeopleCert-Musterprüfung, v7.2', official: true },
  { code: 'MU2', title: 'Musterprüfung 2', sub: 'Offizielle PeopleCert-Musterprüfung, v7.2', official: true },
  { code: 'MOA', title: 'Mock A', sub: 'Mock Exam A', official: false },
  { code: 'MOB', title: 'Mock B', sub: 'Mock Exam B', official: false },
];
const COUNTS = [10, 20, 30, 40, 50, 60];
const PASS_RATE = 0.6;          // Bestehensgrenze: 60 % (bei 60 Fragen = 36)
const SECONDS_PER_QUESTION = 60; // Simulation an: 1 Minute pro Frage
const LETTERS = ['A', 'B', 'C', 'D'];
const SOURCE_NOTE = 'Fragen und Lösungen: PRINCE2® Musterprüfungen 1 und 2 Foundation, Version 7.2 (PeopleCert, offizielle Schulungsunterlagen, inkl. Begründungen) sowie Mock Exam A und B.';

/* ---------- Einstellungen (pro Browser gemerkt) ---------- */
const DEFAULT_SETTINGS = {
  mode: 'exam',                              // 'exam' = Reale Prüfung, 'training' = Trainieren
  exam: 'MU1',
  count: 20,
  examOpts: { sim: true, shuffle: false },   // Reale Prüfung: Simulation standardmäßig an, Mischen aus
  trainingOpts: { sim: false },              // Trainieren: Fragen und Antworten werden immer gemischt
};
function loadSettings(){
  try {
    const s = JSON.parse(localStorage.getItem('p2-settings') || '{}');
    return { ...DEFAULT_SETTINGS, ...s,
      examOpts: { ...DEFAULT_SETTINGS.examOpts, ...(s.examOpts || {}) },
      trainingOpts: { ...DEFAULT_SETTINGS.trainingOpts, ...(s.trainingOpts || {}) } };
  } catch(e) { return structuredClone(DEFAULT_SETTINGS); }
}
function saveSettings(){ try { localStorage.setItem('p2-settings', JSON.stringify(settings)); } catch(e) {} }
const settings = loadSettings();

/* ---------- Zustand ---------- */
let CATALOG = [];
const state = {
  view: 'start',        // 'start' | 'exam' | 'result'
  loading: true, loadError: null,
  session: null,        // laufende Prüfung / Trainingseinheit, siehe newSession()
  pos: 0,
  reviewMode: false,
  modal: null,
  timerId: null,
};

const app = document.getElementById('app');
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const shuffled = arr => { const a = [...arr]; for(let i = a.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const examOf = code => EXAMS.find(e => e.code === code);
const passMark = n => Math.ceil(n * PASS_RATE);

/* ---------- Fragen & Antworten ----------
   Antworten werden intern über feste Schlüssel (A–D der Katalogfrage) gespeichert.
   Angezeigt wird ein Buchstabe je Position: item.perm[i] ist der Schlüssel, der an Position LETTERS[i] steht. */
const rightKeys = q => Array.isArray(q.answer) ? q.answer : [q.answer];
const isRight = (q, key) => !!key && rightKeys(q).includes(key);
const shown = (item, key) => LETTERS[item.perm.indexOf(key)];
const rightLabel = item => rightKeys(item.q).map(k => shown(item, k)).sort().join(' oder ');
const rightText = item => rightKeys(item.q).map(k => `${shown(item, k)} – ${esc(item.q.opts[k])}`).join(' / ');
const originNo = (q, code) => { const o = q.origin.find(o => o.startsWith(code + '-')); return o ? Number(o.split('-')[1]) : 0; };

/* ---------- Laden ---------- */
function loadCatalog(){
  fetch('data/katalog.json').then(r => { if(!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
    .then(data => { CATALOG = data; state.loading = false; render(); })
    .catch(err => {
      state.loading = false;
      state.loadError = location.protocol === 'file:'
        ? 'Die Fragen können nicht direkt aus dem Dateisystem geladen werden. Bitte die App über einen Webserver öffnen (siehe README).'
        : `Der Fragenkatalog konnte nicht geladen werden (${err.message}). Bitte die Seite neu laden.`;
      render();
    });
}

/* ---------- Sitzung erzeugen ---------- */
function newSession(){
  let items, title, sim, shuffle;
  if(settings.mode === 'exam'){
    const code = settings.exam;
    sim = settings.examOpts.sim; shuffle = settings.examOpts.shuffle;
    items = CATALOG.filter(q => q.origin.some(o => o.startsWith(code + '-')))
      .sort((a, b) => originNo(a, code) - originNo(b, code))
      .map(q => {
        const own = q.origin.find(o => o.startsWith(code + '-'));
        // Originalreihenfolge der Optionen dieser Prüfung, oder gemischt
        const perm = shuffle ? shuffled(LETTERS) : (q.optOrder?.[own] || 'ABCD').split('');
        return { q, perm, origNo: originNo(q, code) };
      });
    if(shuffle) items = shuffled(items);
    title = examOf(code).title;
  } else {
    sim = settings.trainingOpts.sim; shuffle = true;
    items = shuffled(CATALOG).slice(0, settings.count).map(q => ({ q, perm: shuffled(LETTERS) }));
    title = `Training · ${items.length} Fragen`;
  }
  return { mode: settings.mode, exam: settings.mode === 'exam' ? settings.exam : null, title, sim, shuffle, items,
           answers: {}, flags: new Set(), elapsed: 0,
           limit: sim ? items.length * SECONDS_PER_QUESTION : 0,   // 0 = Stoppuhr ohne Limit
           timeout: false };
}

/* ---------- Zeit: Simulation an = Countdown (1 Min./Frage), sonst Stoppuhr ---------- */
function fmt(s){ return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }
function showTimer(){
  const s = state.session;
  const countdown = s.limit > 0;
  const value = countdown ? s.limit - s.elapsed : s.elapsed;
  timer.hidden = false;
  timer.innerHTML = `<small>${countdown ? 'Restzeit' : 'Dauer'}</small> ${fmt(value)}`;
  timer.classList.toggle('warn', countdown && value <= Math.min(300, s.limit / 5));
}
function startTimer(){
  stopTimer(); showTimer();
  state.timerId = setInterval(() => {
    const s = state.session; s.elapsed++; showTimer();
    if(s.limit && s.elapsed >= s.limit){ s.timeout = true; finish(); }
  }, 1000);
}
function stopTimer(){ if(state.timerId){ clearInterval(state.timerId); state.timerId = null; } }

/* ---------- Aktionen ---------- */
function start(){
  if(state.loading || state.loadError || !CATALOG.length) return;
  state.session = newSession(); state.pos = 0; state.reviewMode = false; state.modal = null;
  state.view = 'exam'; startTimer(); render(); window.scrollTo(0, 0);
}
function current(){ return state.session.items[state.pos]; }
function choose(letter){
  const s = state.session, item = current();
  if(state.reviewMode) return;
  if(s.answers[item.q.id] && !s.sim) return;     // ohne Simulation bleibt die erste Antwort stehen
  s.answers[item.q.id] = item.perm[LETTERS.indexOf(letter)];
  render();
}
function go(pos){ state.pos = Math.max(0, Math.min(state.session.items.length - 1, pos)); render(); window.scrollTo({top: 0, behavior: 'smooth'}); }
function toggleFlag(){ const f = state.session.flags, id = current().q.id; f.has(id) ? f.delete(id) : f.add(id); render(); }
function askFinish(){
  const s = state.session; const open = s.items.length - Object.keys(s.answers).length;
  if(open === 0) return finish();
  state.modal = { open }; render();
}
function finish(){
  stopTimer(); timer.hidden = true; state.modal = null; state.view = 'result'; render(); window.scrollTo(0, 0);
}
function review(pos){ state.view = 'exam'; state.reviewMode = true; state.pos = pos; render(); window.scrollTo(0, 0); }
function score(){ const s = state.session; return s.items.filter(it => isRight(it.q, s.answers[it.q.id])).length; }

/* ---------- Ansichten ---------- */
function render(){
  if(state.view === 'start') app.innerHTML = viewStart();
  else if(state.view === 'exam') app.innerHTML = viewExam();
  else app.innerHTML = viewResult();
  if(state.modal) app.insertAdjacentHTML('beforeend', viewModal());
  updateChrome();
  bind();
}
function updateChrome(){
  const s = state.session;
  examLabel.textContent = state.view !== 'start' && s ? s.title
    : settings.mode === 'exam' ? `Reale Prüfung · ${examOf(settings.exam).title}` : `Trainieren · ${settings.count} Fragen`;
  footSource.textContent = SOURCE_NOTE;
}

function switchRow(id, checked, title, text){
  return `<div class="opt-row">
        <label class="switch"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''}><i></i></label>
        <label for="${id}"><b>${title}</b><span>${text}</span></label>
      </div>`;
}

function viewStart(){
  const ready = !state.loading && !state.loadError;
  const isExam = settings.mode === 'exam';
  const opts = isExam ? settings.examOpts : settings.trainingOpts;
  const n = isExam ? 60 : settings.count;
  const ex = examOf(settings.exam);

  const modeCards = [
    ['exam', 'Reale Prüfung', 'Eine der vier Prüfungen mit 60 Fragen, wie in der echten Prüfung.'],
    ['training', 'Trainieren', `Zufällige Fragen aus dem Gesamtkatalog${ready ? ` mit ${CATALOG.length} Fragen` : ''}.`],
  ].map(([v, t, d]) => `
        <label class="pick mode">
          <input type="radio" name="mode" value="${v}" ${settings.mode === v ? 'checked' : ''}>
          <span class="dot" aria-hidden="true"></span>
          <span><b>${t}</b><small>${d}</small></span>
        </label>`).join('');

  const examCards = EXAMS.map(e => `
        <label class="pick">
          <input type="radio" name="exam" value="${e.code}" ${e.code === settings.exam ? 'checked' : ''}>
          <span class="dot" aria-hidden="true"></span>
          <span><b>${esc(e.title)}</b><small>${esc(e.sub)}</small>
            <span class="badge ${e.official ? 'official' : ''}">${e.official ? 'mit Begründungen' : 'nur Lösungen'}</span></span>
        </label>`).join('');

  const countButtons = COUNTS.map(c => `
          <label class="seg-opt"><input type="radio" name="count" value="${c}" ${c === settings.count ? 'checked' : ''}><span>${c}</span></label>`).join('');

  const topics = {};
  if(isExam) CATALOG.filter(q => q.origin.some(o => o.startsWith(settings.exam + '-')))
    .forEach(q => { if(q.topic) topics[q.topic] = (topics[q.topic] || 0) + 1; });

  const timeText = opts.sim ? `${n} min` : 'Stoppuhr';
  const lead = isExam
    ? `${ex.title}: 60 Fragen in Originalreihenfolge${settings.examOpts.shuffle ? ' (Fragen und Antworten gemischt)' : ''}. ${ex.official
        ? 'Mit offizieller Begründung zu jeder Antwortoption und Referenz ins PRINCE2-Handbuch.'
        : 'Für diese Prüfung liegen nur die Lösungen vor, keine Begründungen.'}`
    : `${settings.count} zufällige Fragen aus allen vier Prüfungen, ohne Wiederholung. Fragen und Antwortoptionen werden jedes Mal neu gemischt. Begründungen gibt es, wo die Quelle sie liefert.`;

  return `
  <section class="hero">
    <div>
      <div class="eyebrow">PRINCE2® 7 · Foundation</div>
      <h1>Prüfungstrainer – üben wie in der echten Prüfung</h1>
      <fieldset class="picker">
        <legend>1 · Was möchtest du tun?</legend>
        <div class="picker-grid">${modeCards}</div>
      </fieldset>
      ${isExam ? `
      <fieldset class="picker">
        <legend>2 · Welche Prüfung möchtest du schreiben?</legend>
        <div class="picker-grid">${examCards}</div>
      </fieldset>` : `
      <fieldset class="picker">
        <legend>2 · Mit wie vielen Fragen möchtest du üben?</legend>
        <div class="seg" role="radiogroup">${countButtons}</div>
      </fieldset>`}
      <p class="lead">${lead}</p>
      <div class="facts">
        <div class="fact"><b>${n}</b><span>Fragen</span></div>
        <div class="fact"><b>${passMark(n)}</b><span>richtig zum Bestehen (60&nbsp;%)</span></div>
        <div class="fact"><b>${timeText}</b><span>${opts.sim ? 'Zeitlimit, 1 Minute pro Frage' : 'ohne Zeitlimit, Zeit wird gemessen'}</span></div>
      </div>
      ${isExam && ready ? `<div class="topics">${Object.entries(topics).map(([t, c]) => `<span class="chip"><b>${c}</b> ${esc(t)}</span>`).join('')}</div>` : ''}
    </div>
    <div class="card">
      <h2>3 · Einstellungen</h2>
      ${switchRow('optSim', opts.sim, 'Reale Prüfungssimulation',
        `Kein Feedback während der ${isExam ? 'Prüfung' : 'Übung'}. Rückmeldungen (korrekte Antworten und ggf. Begründungen) werden erst nach Abgabe der ${isExam ? 'Prüfung' : 'Übung'} angezeigt. Zeitlimit: 1 Minute pro Frage (${n} Minuten).`)}
      ${isExam ? switchRow('optShuffle', settings.examOpts.shuffle, 'Fragen mischen',
        'Zufällige Reihenfolge der Fragen und der Antwortoptionen statt Originalreihenfolge.') : `
      <div class="opt-row info"><span class="info-icon" aria-hidden="true">↻</span>
        <span><b>Immer gemischt</b><span>Fragen und Antwortoptionen werden bei jedem Training neu gemischt.</span></span>
      </div>`}
      <p class="time-note">${opts.sim
        ? `Zeit: Countdown ${n} Minuten, danach wird automatisch abgegeben.`
        : 'Zeit: Stoppuhr läuft mit, kein Zeitlimit.'}</p>
      <div class="nav" style="margin-top:var(--space-5)">
        <button class="btn primary" id="startBtn" style="width:100%;justify-content:center" ${ready ? '' : 'disabled'}>${isExam ? `${esc(ex.title)} starten` : `Training mit ${settings.count} Fragen starten`}</button>
      </div>
      ${state.loading ? '<p class="load-note">Fragenkatalog wird geladen …</p>' : ''}
      ${state.loadError ? `<p class="load-note err">${esc(state.loadError)}</p>` : ''}
    </div>
  </section>`;
}

function originHint(item){
  const s = state.session;
  if(s.mode === 'exam') return s.shuffle ? ` · Original-Nr. ${item.origNo}` : '';
  return ` · Herkunft: ${item.q.origin.join(', ')}`;
}

function viewExam(){
  const s = state.session, item = current(), q = item.q, total = s.items.length;
  const chosen = s.answers[q.id];                      // gespeicherter Schlüssel
  const answered = Object.keys(s.answers).length;
  const hidden = s.sim && !state.reviewMode;           // Simulation: Lösung erst nach Abgabe
  const reveal = !hidden && (chosen || state.reviewMode);
  const locked = state.reviewMode || (chosen && !s.sim);
  const noun = s.mode === 'exam' ? 'Prüfung' : 'Übung';

  const options = item.perm.map((key, i) => {
    const L = LETTERS[i];
    let cls = 'opt', tag = '';
    if(hidden){
      if(key === chosen){ cls += ' selected'; tag = 'Deine Antwort'; }
    } else if(reveal){
      if(isRight(q, key)){ cls += ' correct'; tag = 'Richtige Antwort'; }
      else if(key === chosen){ cls += ' wrong'; tag = 'Deine Antwort'; }
    }
    return `<button class="${cls}" data-choose="${L}" ${locked ? 'disabled' : ''} aria-pressed="${chosen === key}">
      <span class="letter">${L}</span><span>${esc(q.opts[key])}</span>${tag ? `<span class="tag">${tag}</span>` : ''}
    </button>`;
  }).join('');

  let feedback = '';
  if(reveal){
    const ok = isRight(q, chosen);
    const hasExpl = Object.keys(q.expl).length === 4;
    const sorted = [...item.perm].sort((a, b) => (isRight(q, b) - isRight(q, a)) || (item.perm.indexOf(a) - item.perm.indexOf(b)));
    const body = hasExpl
      ? sorted.map(key => `<div class="expl ${isRight(q, key) ? 'right' : 'other'}"><span class="letter">${shown(item, key)}</span><div><span class="verdict">${isRight(q, key) ? 'Richtig' : 'Falsch'}${key === chosen && !ok ? ' – deine Auswahl' : ''}</span><p>${esc(q.expl[key])}</p></div></div>`).join('')
      : rightKeys(q).map((key, i, all) => `<div class="expl right"><span class="letter">${shown(item, key)}</span><div><span class="verdict">Richtig ist ${shown(item, key)} (${esc(q.opts[key])})</span>${q.rationale && i === all.length - 1 ? `<p>${esc(q.rationale)}</p>` : ''}</div></div>`).join('');
    feedback = `
    <div class="feedback">
      <div class="fb-head ${ok ? 'ok' : 'bad'}">
        ${ok ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/></svg><span>Richtig – gut gemacht.</span>'
             : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg><span>${chosen ? 'Leider falsch.' : 'Nicht beantwortet.'} Richtig ist <strong>${rightLabel(item)}</strong>.</span>`}
      </div>
      <div class="fb-body">
        <h3>${hasExpl || q.rationale ? 'Begründung' : 'Lösung'}</h3>
        ${body}
        <div class="ref">${q.ref ? `<span>Lehrplan-Referenz: <code>${esc(q.ref)}</code></span><span>„Siehe x.y“ = Abschnitt im PRINCE2 7 Handbuch</span>` : ''}<span>Frage-ID: <code>${q.id}</code> · ${esc(q.origin.join(', '))}</span></div>
      </div>
    </div>`;
  }

  const cells = s.items.map((it, i) => {
    const a = s.answers[it.q.id];
    let cls = 'cell';
    if(a) cls += hidden ? ' done' : (isRight(it.q, a) ? ' ok' : ' bad');
    if(i === state.pos) cls += ' cur';
    if(s.flags.has(it.q.id)) cls += ' flag';
    return `<button class="${cls}" data-go="${i}" aria-label="Frage ${i + 1}">${i + 1}</button>`;
  }).join('');
  const flagged = s.flags.has(q.id);

  return `
  <div class="exam">
    <section>
      <div class="progress" role="progressbar" aria-valuenow="${answered}" aria-valuemax="${total}"><i style="width:${answered / total * 100}%"></i></div>
      <div class="qmeta">
        <span class="qnum">Frage ${state.pos + 1} von ${total}</span>
        ${hidden ? '<span class="mode-badge">Prüfungssimulation</span>' : ''}
        <span class="qtopic">${q.topic ? `· ${esc(q.topic)}` : ''}${originHint(item)}</span>
      </div>
      ${q.scenario ? `<div class="scenario">${esc(q.scenario)}</div>` : ''}
      <p class="qtext">${esc(q.question)}</p>
      ${q.items.length ? `<ol class="items">${q.items.map((it, i) => `<li><b>${i + 1}.</b><span>${esc(it)}</span></li>`).join('')}</ol>` : ''}
      <div class="options">${options}</div>
      ${feedback}
      <div class="nav">
        <button class="btn" data-nav="-1" ${state.pos === 0 ? 'disabled' : ''}>← Zurück</button>
        <button class="btn ${flagged ? 'flagged' : ''}" id="flagBtn">${flagged ? '⚑ Markiert' : '⚐ Markieren'}</button>
        <span class="spacer"></span>
        ${state.reviewMode ? `<button class="btn" id="backToResult">Zur Auswertung</button>` : ''}
        ${state.pos < total - 1
          ? `<button class="btn primary" data-nav="1">Weiter →</button>`
          : (state.reviewMode ? '' : `<button class="btn primary" id="finishBtn">${noun} abgeben</button>`)}
      </div>
    </section>
    <aside class="side">
      <h2>Übersicht <span>${answered}/${total} beantwortet</span></h2>
      <div class="grid">${cells}</div>
      <div class="legend">
        ${hidden
          ? `<span><i style="background:var(--accent);border-color:var(--accent)"></i> beantwortet</span>`
          : `<span><i style="background:var(--ok);border-color:var(--ok)"></i> richtig</span>
        <span><i style="background:var(--bad);border-color:var(--bad)"></i> falsch</span>`}
        <span><i></i> offen</span>
        <span><i style="background:var(--flag);border-color:var(--flag);border-radius:999px"></i> markiert</span>
      </div>
      ${state.reviewMode ? `<button class="btn" id="backToResult2">Zur Auswertung</button>` : `<button class="btn" id="finishBtn2">${noun} abgeben</button>`}
    </aside>
  </div>`;
}

function viewResult(){
  const s = state.session, total = s.items.length, pass = passMark(total);
  const sc = score(); const passed = sc >= pass; const pct = Math.round(sc / total * 100);
  const r = 74, circ = 2 * Math.PI * r;
  const topics = {};
  s.items.forEach(it => { if(!it.q.topic) return; const t = topics[it.q.topic] ||= {c: 0, n: 0}; t.n++; if(isRight(it.q, s.answers[it.q.id])) t.c++; });
  const rows = s.items.map((it, i) => ({ it, i }));
  const wrong = rows.filter(({it}) => s.answers[it.q.id] && !isRight(it.q, s.answers[it.q.id]));
  const open = rows.filter(({it}) => !s.answers[it.q.id]);
  const noun = s.mode === 'exam' ? 'Prüfung' : 'Übung';
  const time = s.limit ? `Benötigte Zeit: ${fmt(s.elapsed)} von ${fmt(s.limit)} Minuten.` : `Benötigte Zeit: ${fmt(s.elapsed)} Minuten.`;
  const line = ({it, i}, cls, extra) => `<button class="rv" data-review="${i}"><span class="n ${cls}">${i + 1}</span><span>${esc(it.q.question)}<small>${extra}Richtig: ${rightText(it)} · ${esc(it.q.origin.join(', '))}</small></span></button>`;
  return `
  <section class="result-head">
    <div class="ring ${passed ? '' : 'fail'}">
      <svg viewBox="0 0 170 170"><circle class="track" cx="85" cy="85" r="${r}"/><circle class="val" cx="85" cy="85" r="${r}" stroke-dasharray="${circ}" stroke-dashoffset="${circ * (1 - sc / total)}"/></svg>
      <div class="num"><div><b>${sc}/${total}</b><br><span>${pct} % richtig</span></div></div>
    </div>
    <div>
      <div class="eyebrow">Auswertung · ${esc(s.title)}${s.sim ? ' · Prüfungssimulation' : ''}</div>
      <div class="verdict-big ${passed ? 'ok' : 'bad'}">${passed ? 'Bestanden' : 'Nicht bestanden'}</div>
      <p class="lead" style="margin-bottom:var(--space-4)">${passed
        ? `Du hast ${sc} von ${total} Fragen richtig beantwortet – die Bestehensgrenze liegt bei ${pass} (60 %).`
        : `Du hast ${sc} von ${total} Fragen richtig beantwortet. Für das Bestehen fehlen dir noch ${pass - sc} richtige Antwort${pass - sc === 1 ? '' : 'en'} (Grenze: ${pass}).`}
        ${s.timeout ? ` Die Zeit ist abgelaufen – die ${noun} wurde automatisch abgegeben.` : ''}
        ${time}
      </p>
      <div class="nav" style="margin-top:0">
        <button class="btn primary" id="restartBtn">Neue ${s.mode === 'exam' ? 'Prüfung' : 'Übung'} starten</button>
        <button class="btn" id="reviewAllBtn">Alle Fragen durchsehen</button>
      </div>
    </div>
  </section>

  ${Object.keys(topics).length ? `<h2 class="section-title">Ergebnis nach Themenbereich</h2>
  <div class="topic-list">
    ${Object.entries(topics).map(([t, v]) => `<div class="topic-row"><span>${esc(t)} <span style="color:var(--text-muted)">(${v.c}/${v.n})</span></span><div class="bar"><i style="width:${v.c / v.n * 100}%"></i></div><span class="pct">${Math.round(v.c / v.n * 100)} %</span></div>`).join('')}
  </div>${s.mode === 'training' && Object.values(topics).reduce((a, v) => a + v.n, 0) < total ? '<p class="time-note">Mock-Fragen ohne Themenzuordnung sind hier nicht enthalten.</p>' : ''}` : ''}

  ${wrong.length ? `<h2 class="section-title">Falsch beantwortet (${wrong.length})</h2>
  <div class="review">${wrong.map(w => line(w, 'bad', `Deine Antwort: ${shown(w.it, s.answers[w.it.q.id])} · `)).join('')}</div>` : ''}

  ${open.length ? `<h2 class="section-title">Nicht beantwortet (${open.length})</h2>
  <div class="review">${open.map(o => line(o, 'skip', '')).join('')}</div>` : ''}

  ${!wrong.length && !open.length ? `<p class="lead" style="margin-top:var(--space-6)">Alle ${total} Fragen richtig – volle Punktzahl.</p>` : ''}`;
}

function viewModal(){
  const noun = state.session.mode === 'exam' ? 'Prüfung' : 'Übung';
  return `<div class="modal" id="modal"><div class="card">
    <h2>${noun} wirklich abgeben?</h2>
    <p>Du hast noch <strong>${state.modal.open}</strong> ${state.modal.open === 1 ? 'Frage' : 'Fragen'} nicht beantwortet. Unbeantwortete Fragen zählen als falsch.</p>
    <div class="nav"><button class="btn" id="modalCancel">Weiter bearbeiten</button><span class="spacer"></span><button class="btn primary" id="modalOk">Jetzt abgeben</button></div>
  </div></div>`;
}

/* ---------- Bindings ---------- */
function bind(){
  const $ = id => document.getElementById(id);
  const change = (fn, focusSel) => e => { fn(e); saveSettings(); render(); const el = focusSel && document.querySelector(focusSel); el && el.focus(); };
  document.querySelectorAll('input[name="mode"]').forEach(r => r.onchange = change(() => settings.mode = r.value, `input[name="mode"][value="${r.value}"]`));
  document.querySelectorAll('input[name="exam"]').forEach(r => r.onchange = change(() => settings.exam = r.value, `input[name="exam"][value="${r.value}"]`));
  document.querySelectorAll('input[name="count"]').forEach(r => r.onchange = change(() => settings.count = Number(r.value), `input[name="count"][value="${r.value}"]`));
  $('optSim') && ($('optSim').onchange = change(e => (settings.mode === 'exam' ? settings.examOpts : settings.trainingOpts).sim = e.target.checked, '#optSim'));
  $('optShuffle') && ($('optShuffle').onchange = change(e => settings.examOpts.shuffle = e.target.checked, '#optShuffle'));
  $('startBtn') && ($('startBtn').onclick = start);
  document.querySelectorAll('[data-choose]').forEach(b => b.onclick = () => choose(b.dataset.choose));
  document.querySelectorAll('[data-nav]').forEach(b => b.onclick = () => go(state.pos + Number(b.dataset.nav)));
  document.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(Number(b.dataset.go)));
  $('flagBtn') && ($('flagBtn').onclick = toggleFlag);
  document.querySelectorAll('[data-review]').forEach(b => b.onclick = () => review(Number(b.dataset.review)));
  ['finishBtn', 'finishBtn2'].forEach(id => $(id) && ($(id).onclick = askFinish));
  ['backToResult', 'backToResult2'].forEach(id => $(id) && ($(id).onclick = () => { state.view = 'result'; render(); window.scrollTo(0, 0); }));
  $('restartBtn') && ($('restartBtn').onclick = () => { state.reviewMode = false; state.view = 'start'; render(); window.scrollTo(0, 0); });
  $('reviewAllBtn') && ($('reviewAllBtn').onclick = () => review(0));
  $('modalCancel') && ($('modalCancel').onclick = () => { state.modal = null; render(); });
  $('modalOk') && ($('modalOk').onclick = finish);
}

/* Tastatur: A–D wählen (angezeigte Buchstaben), Pfeile navigieren */
document.addEventListener('keydown', e => {
  if(state.view !== 'exam' || state.modal) return;
  if(e.target.closest && e.target.closest('input, textarea')) return;
  const k = e.key.toUpperCase();
  if(LETTERS.includes(k)) choose(k);
  else if(e.key === 'ArrowRight') go(state.pos + 1);
  else if(e.key === 'ArrowLeft') go(state.pos - 1);
});

/* ---------- Theme ---------- */
let theme = document.documentElement.dataset.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
function applyTheme(){
  document.documentElement.dataset.theme = theme;
  iconSun.hidden = theme === 'dark'; iconMoon.hidden = theme !== 'dark';
}
themeBtn.onclick = () => { theme = theme === 'dark' ? 'light' : 'dark'; applyTheme(); };
applyTheme();

render();
loadCatalog();

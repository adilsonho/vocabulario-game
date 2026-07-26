'use strict';

/* ==========================================================================
   Teacher Adilson · Vocabulary Challenge
   Vanilla JS game engine — no frameworks, no external libraries.

   Game flow per lesson (20 vocabulary cards):
     1. Click a card       - flips, revealing the image
     2. Type the word      - checked against the answer, card locks in
                              green (correct) or red (wrong)
     3. Error review       - once all 20 are answered, any wrong ones are
                              replayed (same grid, same rules) until every
                              word has been answered correctly
     4. Score              - Correct / Wrong / Accuracy from the first pass
   ========================================================================== */

/* --------------------------------------------------------------------------
   Config
   -------------------------------------------------------------------------- */
const CONFIG = {
  dataPath: '../data/lesson',
  fallbackImage: '../images/placeholder.svg',
  blankImage: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
  openverseSearch: 'https://api.openverse.org/v1/images/',
  maxLessonProbe: 60,       // highest lessonN.json id to look for
  wordsPerLesson: 20,
};

const STORAGE_KEYS = {
  THEME: 'ta_vocab_theme',
  LAST_LESSON: 'ta_vocab_last_lesson',
  HISTORY: 'ta_vocab_history',
};

/* --------------------------------------------------------------------------
   Small DOM / utility helpers
   -------------------------------------------------------------------------- */
const $ = (selector) => document.querySelector(selector);

function shuffle(array) {
  const copy = array.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function normalizeAnswer(text) {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/* --------------------------------------------------------------------------
   LocalStorage helpers
   -------------------------------------------------------------------------- */
const Storage = {
  getTheme() {
    return localStorage.getItem(STORAGE_KEYS.THEME) || 'dark';
  },
  setTheme(theme) {
    localStorage.setItem(STORAGE_KEYS.THEME, theme);
  },
  getLastLesson() {
    return localStorage.getItem(STORAGE_KEYS.LAST_LESSON);
  },
  setLastLesson(lessonId) {
    localStorage.setItem(STORAGE_KEYS.LAST_LESSON, String(lessonId));
  },
  getHistory() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEYS.HISTORY)) || {};
    } catch {
      return {};
    }
  },
  saveResult(lessonId, correct, wrong) {
    const total = correct + wrong;
    const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0;
    const history = Storage.getHistory();
    history[lessonId] = { correct, wrong, accuracy, date: new Date().toISOString() };
    localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(history));
  },
};

/* --------------------------------------------------------------------------
   Sound effects — synthesized with the Web Audio API.
   No mp3 assets required, so the game works fully offline with zero
   external downloads or licensing concerns.
   -------------------------------------------------------------------------- */
const SFX = (() => {
  let ctx = null;

  function getContext() {
    if (!ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      ctx = new AudioCtx();
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, duration, type = 'sine', delay = 0, volume = 0.15) {
    try {
      const audioCtx = getContext();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      osc.connect(gain).connect(audioCtx.destination);
      const start = audioCtx.currentTime + delay;
      gain.gain.setValueAtTime(volume, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
      osc.start(start);
      osc.stop(start + duration);
    } catch {
      // Audio unsupported / blocked — fail silently, game keeps working.
    }
  }

  return {
    flip: () => tone(520, 0.12, 'triangle'),
    correct: () => { tone(660, 0.12, 'sine'); tone(880, 0.16, 'sine', 0.1); },
    wrong: () => tone(160, 0.25, 'sawtooth'),
    victory: () => [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.22, 'sine', i * 0.12)),
  };
})();

/* --------------------------------------------------------------------------
   Automatic image generation
   Every word is searched live on Openverse (free, key-less, openly-licensed
   image search with real relevance ranking — chosen over simple tag-lookup
   APIs after testing showed those returning unrelated photos for plain
   nouns). Results are cached per word so the same lesson never queries the
   same word twice (Phase 4 review reuses Phase 3's words) and so the image
   stays consistent if a word repeats. Anonymous Openverse usage is capped
   at 200 requests/day — a failed or exhausted lookup falls back to the
   local default icon.

   Safety note: Openverse's own `mature` flag does not catch everything —
   testing turned up a Flickr result for "do aerobics" that was a nightclub
   photo with a punny caption, not actually mature-flagged but clearly wrong
   for a classroom tool. Flickr's personal, caption-driven uploads are the
   main source of that risk, so among the top results we prefer the first
   one NOT sourced from Flickr (museums, Wikimedia Commons, etc. are far
   more consistently classroom-appropriate) and only fall back to a Flickr
   result if nothing else matched.

   Query overrides: the word itself is usually a fine search query, but a
   lot of everyday-object words are ambiguous or return photos with several
   competing named objects in frame (a student can't guess "which one" —
   e.g. plain "pen" returned a desk with glasses AND a pen AND paperwork).
   This map rewrites the search query for just those words — the displayed
   word and the typed answer are unaffected, only what gets searched for.
   Built from a manual visual audit of every "concrete object" word in the
   wordlist; each entry below was checked by eye, not just by title.
   -------------------------------------------------------------------------- */
const IMAGE_QUERY_OVERRIDES = {
  'man': 'a man portrait',
  'board': 'blank whiteboard',
  'pen': 'ballpoint pen',
  'book': 'book on white background',
  'notebook': 'notebook closed',
  'credit card': 'credit card white background',
  'driving licence': 'driving license card',
  'make-up': 'cosmetics on white background',
  'purse': 'coin purse',
  'piece of paper': 'blank paper sheet',
  'stamp': 'postage stamp',
  'scissors': 'pair of scissors',
  'glasses': 'reading glasses',
  'hairbrush': 'hair brush',
  'nail file': 'nail file manicure',
  'address book': 'rolodex',
  'ice': 'ice cube white background',
  'spoon': 'tablespoon',
  'sugar': 'sugar cubes white background',
  'soup': 'vegetable soup bowl',
  'noodles': 'noodle bowl close up',
  'vegetable': 'fresh vegetables',
  'soft drink': 'can of soda',
  'mouse': 'computer mouse white background',
  'plasters': 'adhesive bandage box',
  'mouse mat': 'mouse pad computer',
  'tie': 'silk necktie',
  't-shirt': 'plain t-shirt white background',
  'screen': 'computer screen monitor',
  'jumper': 'wool jumper sweater',
  'mirror': 'wall mirror',
  'disk': 'cd rom disc reflective',
  'top': 'camisole top',
  'postcard': 'travel postcard scenic',
  'coffee': 'cup of coffee',
  'note': 'sticky note reminder',
  'letter': 'handwritten letter envelope',
};

const imageCache = new Map();
let imageRequestSeq = 0;

async function resolveImageUrl(word) {
  const key = word.trim().toLowerCase();
  if (imageCache.has(key)) return imageCache.get(key);

  let resolved = CONFIG.fallbackImage;
  try {
    const query = IMAGE_QUERY_OVERRIDES[key] || word;
    const url = `${CONFIG.openverseSearch}?q=${encodeURIComponent(query)}&page_size=8&mature=false`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      const results = data.results || [];
      const hit = results.find((r) => r.source !== 'flickr') || results[0];
      // Prefer the direct source URL over Openverse's own thumbnail proxy —
      // testing found the proxy occasionally 424s on otherwise-fine images
      // (e.g. a verified-good Wikimedia photo) while the original loads fine.
      if (hit) resolved = hit.url || hit.thumbnail || CONFIG.fallbackImage;
    }
  } catch {
    // Network / rate-limit error — keep the fallback icon.
  }

  imageCache.set(key, resolved);
  return resolved;
}

// Loads a word's image into `img` without blocking the caller, and ignores
// the result if a newer card has since been requested (fast Next clicks).
async function loadWordImage(word, img) {
  const requestId = ++imageRequestSeq;
  const src = await resolveImageUrl(word);
  if (requestId !== imageRequestSeq) return;
  img.onerror = () => { img.onerror = null; img.src = CONFIG.fallbackImage; };
  img.src = src;
}

/* --------------------------------------------------------------------------
   Lesson discovery
   Probes /data/lessonN.json for every id up to maxLessonProbe in parallel.
   No manifest, no HTML edits needed — dropping in lesson7.json or
   lesson20.json just works.
   -------------------------------------------------------------------------- */
async function discoverLessons() {
  const ids = Array.from({ length: CONFIG.maxLessonProbe }, (_, i) => i + 1);
  const attempts = await Promise.all(ids.map(async (id) => {
    try {
      const res = await fetch(`${CONFIG.dataPath}${id}.json`, { cache: 'no-store' });
      if (!res.ok) return null;
      const words = await res.json();
      if (!Array.isArray(words) || words.length === 0) return null;
      return { id, words };
    } catch {
      return null;
    }
  }));
  return attempts.filter(Boolean).sort((a, b) => a.id - b.id);
}

/* --------------------------------------------------------------------------
   Game state
   -------------------------------------------------------------------------- */
const state = {
  lessons: [],
  currentLesson: null,   // { id, words: [{ word }] }
  roundWords: [],         // words in the current grid round (first pass or a review round)
  isReview: false,
  answeredCount: 0,
  reviewQueue: [],        // words answered wrong this round — feeds the next round
  score: { correct: 0, wrong: 0 },   // only updated during the first (non-review) pass
};

/* --------------------------------------------------------------------------
   Screen navigation
   -------------------------------------------------------------------------- */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.remove('active'));
  $(`#${id}`).classList.add('active');
}

function goHome() {
  showScreen('screen-home');
  renderHome();
}

/* --------------------------------------------------------------------------
   Home screen — lesson picker + score history badges
   -------------------------------------------------------------------------- */
function renderHome() {
  const list = $('#lesson-list');
  const empty = $('#home-empty');
  list.innerHTML = '';

  if (state.lessons.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  const history = Storage.getHistory();
  const lastLessonId = Storage.getLastLesson();

  state.lessons.forEach((lesson) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'lesson-card';

    const title = document.createElement('span');
    title.className = 'lesson-card-title';
    title.textContent = `Lesson ${lesson.id}`;

    const count = document.createElement('span');
    count.className = 'lesson-card-count';
    count.textContent = `${lesson.words.length} vocabulary`;

    card.append(title, count);

    const record = history[lesson.id];
    if (record) {
      const badge = document.createElement('span');
      badge.className = 'lesson-card-badge';
      badge.textContent = `${record.accuracy}%`;
      card.append(badge);
    }

    if (String(lesson.id) === String(lastLessonId)) {
      const tag = document.createElement('span');
      tag.className = 'lesson-card-last';
      tag.textContent = 'Última aula';
      card.append(tag);
    }

    card.addEventListener('click', () => startLesson(lesson));
    list.append(card);
  });
}

/* --------------------------------------------------------------------------
   Lesson bootstrap
   -------------------------------------------------------------------------- */
function startLesson(lesson) {
  state.currentLesson = lesson;
  state.score = { correct: 0, wrong: 0 };
  Storage.setLastLesson(lesson.id);
  startGridRound(lesson.words, false);
}

/* --------------------------------------------------------------------------
   Vocabulary grid — click a card, see the image, type the word.
   The same round logic runs twice: once for all 20 words, then again
   (title "Revisão dos erros") for only the words answered wrong, looping
   until every word in the review queue has been answered correctly.
   -------------------------------------------------------------------------- */
function startGridRound(words, isReview) {
  state.roundWords = shuffle(words);
  state.isReview = isReview;
  state.answeredCount = 0;
  state.reviewQueue = [];

  $('#grid-title').textContent = isReview ? 'Revisão dos erros' : `Lesson ${state.currentLesson.id}`;
  $('#btn-grid-continue').classList.add('hidden');
  updateGridProgress();
  renderGrid();
  showScreen('screen-grid');
}

function updateGridProgress() {
  const total = state.roundWords.length;
  $('#grid-progress-label').textContent = `${state.answeredCount} / ${total}`;
  $('#grid-progress-fill').style.width = `${(state.answeredCount / total) * 100}%`;
}

function renderGrid() {
  const grid = $('#card-grid');
  grid.innerHTML = '';
  state.roundWords.forEach((wordEntry) => grid.append(buildCard(wordEntry)));
}

function buildCard(wordEntry) {
  const card = document.createElement('div');
  card.className = 'card';

  const inner = document.createElement('div');
  inner.className = 'card-inner';

  const front = document.createElement('div');
  front.className = 'card-face card-front';
  front.tabIndex = 0;
  front.setAttribute('role', 'button');
  front.setAttribute('aria-label', 'Abrir carta');
  front.innerHTML = '<span class="card-mark">?</span>';

  const back = document.createElement('div');
  back.className = 'card-face card-back';

  const img = document.createElement('img');
  img.className = 'card-image';
  img.src = CONFIG.blankImage;
  img.alt = 'Vocabulary image';

  const answerZone = document.createElement('div');
  answerZone.className = 'card-answer-zone';

  const form = document.createElement('form');
  form.className = 'card-quiz-form';
  form.autocomplete = 'off';
  const input = document.createElement('input');
  input.className = 'card-quiz-input';
  input.type = 'text';
  input.placeholder = 'Digite...';
  input.autocapitalize = 'off';
  input.autocorrect = 'off';
  input.spellcheck = false;
  const checkBtn = document.createElement('button');
  checkBtn.className = 'card-quiz-check';
  checkBtn.type = 'submit';
  checkBtn.textContent = '✓';
  form.append(input, checkBtn);
  answerZone.append(form);

  back.append(img, answerZone);
  inner.append(front, back);
  card.append(inner);

  const flip = () => {
    if (card.classList.contains('flipped')) return;
    card.classList.add('flipped');
    SFX.flip();
    loadWordImage(wordEntry.word, img);
    setTimeout(() => input.focus(), 350);
  };
  front.addEventListener('click', flip);
  front.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); }
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    handleCardCheck(card, answerZone, wordEntry, input.value);
  });

  return card;
}

function handleCardCheck(card, answerZone, wordEntry, typedValue) {
  const isCorrect = normalizeAnswer(typedValue) === normalizeAnswer(wordEntry.word);

  card.classList.add('answered', isCorrect ? 'correct' : 'wrong');

  const feedback = document.createElement('p');
  feedback.className = 'card-feedback';
  if (isCorrect) {
    SFX.correct();
    feedback.textContent = `✅ ${wordEntry.word}`;
    if (!state.isReview) state.score.correct += 1;
  } else {
    SFX.wrong();
    feedback.textContent = `❌ ${wordEntry.word}`;
    if (!state.isReview) state.score.wrong += 1;
    state.reviewQueue.push(wordEntry);
  }
  answerZone.replaceChildren(feedback);

  state.answeredCount += 1;
  updateGridProgress();

  if (state.answeredCount === state.roundWords.length) {
    const continueBtn = $('#btn-grid-continue');
    continueBtn.textContent = state.reviewQueue.length > 0
      ? 'Revisar erros →'
      : 'Ver resultado →';
    continueBtn.classList.remove('hidden');
  }
}

function handleGridContinue() {
  if (state.reviewQueue.length > 0) {
    startGridRound(state.reviewQueue, true);
    return;
  }
  finishLesson();
}

/* --------------------------------------------------------------------------
   Results
   -------------------------------------------------------------------------- */
function finishLesson() {
  const { correct, wrong } = state.score;
  const total = correct + wrong;
  const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0;

  Storage.saveResult(state.currentLesson.id, correct, wrong);

  $('#result-correct').textContent = String(correct);
  $('#result-wrong').textContent = String(wrong);
  $('#result-accuracy').textContent = `${accuracy}%`;
  $('#result-message').textContent = resultMessage(accuracy);

  SFX.victory();
  showScreen('screen-results');
}

function resultMessage(accuracy) {
  if (accuracy >= 90) return 'Excellent!';
  if (accuracy >= 75) return 'Great job!';
  if (accuracy >= 50) return 'Good effort, keep practicing!';
  return "Keep practicing, you'll get it!";
}

/* --------------------------------------------------------------------------
   Theme toggle
   -------------------------------------------------------------------------- */
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('#theme-toggle').textContent = theme === 'dark' ? '🌙' : '☀️';
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  Storage.setTheme(next);
  applyTheme(next);
}

/* --------------------------------------------------------------------------
   Event wiring
   -------------------------------------------------------------------------- */
function wireEvents() {
  $('#theme-toggle').addEventListener('click', toggleTheme);

  document.querySelectorAll('[data-action="back-home"]').forEach((btn) => {
    btn.addEventListener('click', goHome);
  });

  $('#btn-grid-continue').addEventListener('click', handleGridContinue);

  $('#btn-play-again').addEventListener('click', () => startLesson(state.currentLesson));
  $('#btn-choose-lesson').addEventListener('click', goHome);
}

/* --------------------------------------------------------------------------
   Init
   -------------------------------------------------------------------------- */
async function init() {
  applyTheme(Storage.getTheme());
  wireEvents();

  state.lessons = await discoverLessons();
  renderHome();
}

document.addEventListener('DOMContentLoaded', init);

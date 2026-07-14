/* =============================================================
   NCLEX Prep - SPA Application Logic
   ============================================================= */

const API = 'http://localhost:3001';

// ── State ────────────────────────────────────────────────────
const state = {
  user: null,
  decks: [],
  currentDeck: null,
  studyQueue: [],
  studyIndex: 0,
  cardFlipped: false,
};

// ── API helpers ───────────────────────────────────────────────
async function api(method, path, body, isForm = false) {
  const opts = {
    method,
    credentials: 'include',
    headers: isForm ? {} : { 'Content-Type': 'application/json' },
    body: isForm ? body : (body ? JSON.stringify(body) : undefined),
  };
  const res = await fetch(`${API}${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.error || err.message || 'Request failed');
  }
  return res.json();
}

const get  = (path)        => api('GET',    path);
const post = (path, body)  => api('POST',   path, body);
const form = (path, fd)    => api('POST',   path, fd, true);

// ── Toast ─────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ── Router ────────────────────────────────────────────────────
const routes = {};

function navigate(view, params = {}) {
  window.history.pushState({ view, params }, '', `#${view}`);
  render(view, params);
}

window.addEventListener('popstate', (e) => {
  const { view = 'home', params = {} } = e.state || {};
  render(view, params);
});

// ── App boot ──────────────────────────────────────────────────
async function boot() {
  try {
    const data = await get('/api/me');
    state.user = data.user;
    if (state.user.kind === 'anonymous') {
      render('auth');
    } else {
      render('home');
    }
  } catch {
    render('auth');
  }
}

// ── Render dispatcher ─────────────────────────────────────────
function render(view, params = {}) {
  const app = document.getElementById('app');
  app.innerHTML = '';

  switch (view) {
    case 'auth':      return renderAuth(app);
    case 'home':      return renderHome(app);
    case 'deck':      return renderDeck(app, params);
    case 'study':     return renderStudy(app, params);
    case 'progress':  return renderProgress(app, params);
    default:          return renderHome(app);
  }
}

// ─────────────────────────────────────────────────────────────
// VIEWS
// ─────────────────────────────────────────────────────────────

// ── AUTH VIEW ─────────────────────────────────────────────────
function renderAuth(app) {
  app.innerHTML = `
    <div class="auth-screen">
      <div class="auth-card animate-in">
        <div class="auth-logo">
          <div class="auth-logo-text">NCLEX Prep</div>
          <div class="auth-tagline">AI-powered flashcards for nursing students</div>
        </div>

        <div id="auth-step-email">
          <div class="auth-title">Sign in</div>
          <div class="auth-sub">Enter your email to receive a magic link. No password needed.</div>
          <div class="form-group" style="margin-bottom:16px">
            <label class="form-label">Email address</label>
            <input id="auth-email" class="input" type="email" placeholder="you@example.com" autocomplete="email" />
          </div>
          <button id="auth-submit" class="btn btn-primary" style="width:100%;justify-content:center">
            Send Magic Link
          </button>
        </div>

        <div id="auth-step-token" style="display:none">
          <div class="auth-title">Check your email ✉️</div>
          <div class="auth-sub" id="auth-token-sub">We sent a magic link. In dev mode, paste the token below:</div>
          <div class="form-group" style="margin-bottom:16px">
            <label class="form-label">Magic Link Token</label>
            <input id="auth-token" class="input" placeholder="Paste token here..." />
          </div>
          <button id="auth-verify" class="btn btn-primary" style="width:100%;justify-content:center">
            Verify & Sign In
          </button>
          <button id="auth-back" class="btn btn-ghost" style="width:100%;justify-content:center;margin-top:10px">
            ← Back
          </button>
        </div>
      </div>
    </div>
  `;

  let pendingEmail = '';

  document.getElementById('auth-submit').addEventListener('click', async () => {
    const email = document.getElementById('auth-email').value.trim();
    if (!email) { toast('Please enter your email', 'error'); return; }
    const btn = document.getElementById('auth-submit');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Sending...';
    try {
      const res = await post('/api/auth/magic-link', { email });
      pendingEmail = email;
      document.getElementById('auth-step-email').style.display = 'none';
      document.getElementById('auth-step-token').style.display = 'block';
      if (res.token) {
        document.getElementById('auth-token').value = res.token;
        document.getElementById('auth-token-sub').textContent =
          '✅ Dev mode: token auto-filled below. Click Verify.';
      }
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Send Magic Link';
    }
  });

  document.getElementById('auth-verify').addEventListener('click', async () => {
    const token = document.getElementById('auth-token').value.trim();
    if (!token) { toast('Please paste the token', 'error'); return; }
    const btn = document.getElementById('auth-verify');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Verifying...';
    try {
      const data = await post('/api/auth/verify', { token });
      state.user = data.user;
      toast(`Welcome, ${state.user.email}! 🎉`, 'success');
      render('home');
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Verify & Sign In';
    }
  });

  document.getElementById('auth-back').addEventListener('click', () => {
    document.getElementById('auth-step-email').style.display = 'block';
    document.getElementById('auth-step-token').style.display = 'none';
  });

  document.getElementById('auth-email').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('auth-submit').click();
  });

  document.getElementById('auth-token').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('auth-verify').click();
  });
}

// ── HOME / DASHBOARD VIEW ─────────────────────────────────────
async function renderHome(app) {
  app.innerHTML = `
    <div class="shell">
      ${sidebar('home')}
      <main class="main animate-in">
        <div class="page-header">
          <div class="page-title">Dashboard</div>
          <div class="page-subtitle">Upload study materials and manage your flashcard decks</div>
        </div>

        <!-- Upload Zone -->
        <div class="upload-zone" id="upload-zone">
          <div class="upload-icon">📄</div>
          <div class="upload-title">Upload Study PDF</div>
          <div class="upload-sub">Drag & drop a PDF, or click to browse</div>
          <button class="btn btn-primary" id="browse-btn" onclick="event.stopPropagation()">Browse Files</button>
          <input type="file" id="file-input" accept=".pdf" style="display:none" />
        </div>

        <!-- Upload Config (hidden until file selected) -->
        <div id="upload-form" style="display:none;margin-top:20px">
          <div class="card">
            <div style="font-size:15px;font-weight:700;margin-bottom:16px">Configure Deck</div>
            <div id="file-preview" style="margin-bottom:16px;padding:12px;background:var(--bg-elevated);border-radius:8px;font-size:13px;color:var(--text-secondary)"></div>
            <div class="upload-form-grid">
              <div class="form-group">
                <label class="form-label">Deck Title</label>
                <input id="deck-title" class="input" type="text" placeholder="e.g. Pharmacology Notes" />
              </div>
              <div class="form-group">
                <label class="form-label">Target Card Count</label>
                <input id="card-count" class="input" type="number" value="20" min="5" max="100" />
              </div>
            </div>
            <div style="display:flex;gap:10px;margin-top:16px">
              <button id="upload-btn" class="btn btn-primary">🚀 Generate Flashcards</button>
              <button id="cancel-upload" class="btn btn-ghost">Cancel</button>
            </div>
          </div>
        </div>

        <!-- Decks -->
        <div class="section-divider" style="margin-top:32px">
          <hr/><span>Your Decks</span><hr/>
        </div>
        <div id="decks-area">
          <div style="text-align:center;padding:40px"><span class="spinner spinner-lg"></span></div>
        </div>
      </main>
    </div>
  `;

  setupSidebar();
  setupUploadZone();
  loadDecks();
}

function setupUploadZone() {
  const zone = document.getElementById('upload-zone');
  const fileInput = document.getElementById('file-input');
  const browseBtn = document.getElementById('browse-btn');
  let selectedFile = null;

  browseBtn.addEventListener('click', () => fileInput.click());
  zone.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) selectFile(fileInput.files[0]);
  });

  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) selectFile(e.dataTransfer.files[0]);
  });

  function selectFile(file) {
    if (!file.name.endsWith('.pdf')) { toast('Only PDF files are supported', 'error'); return; }
    selectedFile = file;
    const title = file.name.replace(/\.pdf$/i, '').replace(/[-_]/g, ' ');
    document.getElementById('deck-title').value = title;
    document.getElementById('file-preview').innerHTML =
      `📄 <strong>${file.name}</strong> &nbsp;·&nbsp; ${(file.size / 1024).toFixed(0)} KB`;
    document.getElementById('upload-form').style.display = 'block';
    zone.style.opacity = '0.5';
  }

  document.getElementById('cancel-upload').addEventListener('click', () => {
    document.getElementById('upload-form').style.display = 'none';
    zone.style.opacity = '1';
    selectedFile = null;
    fileInput.value = '';
  });

  document.getElementById('upload-btn').addEventListener('click', async () => {
    if (!selectedFile) return;
    const title = document.getElementById('deck-title').value.trim() || selectedFile.name;
    const count = parseInt(document.getElementById('card-count').value) || 20;
    const btn = document.getElementById('upload-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Uploading...';

    try {
      const fd = new FormData();
      fd.append('file', selectedFile);
      fd.append('title', title);
      fd.append('targetCardCount', String(count));
      const res = await form('/api/decks', fd);
      toast('PDF uploaded! AI is generating your flashcards...', 'success');
      navigate('progress', { jobId: res.jobId, deckId: res.deck?.id, title });
    } catch (e) {
      toast(e.message, 'error');
      btn.disabled = false;
      btn.innerHTML = '🚀 Generate Flashcards';
    }
  });
}

async function loadDecks() {
  try {
    const data = await get('/api/decks');
    state.decks = data.decks || data;
    renderDecksGrid(document.getElementById('decks-area'), state.decks);
  } catch (e) {
    document.getElementById('decks-area').innerHTML =
      `<div class="empty-state"><span class="empty-state-icon">⚠️</span><div class="empty-state-title">Failed to load decks</div><div class="empty-state-sub">${e.message}</div></div>`;
  }
}

function renderDecksGrid(container, decks) {
  if (!decks || decks.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="empty-state-icon">📚</span>
        <div class="empty-state-title">No decks yet</div>
        <div class="empty-state-sub">Upload a PDF above to generate your first flashcard deck</div>
      </div>`;
    return;
  }

  container.innerHTML = `<div class="deck-grid">${decks.map(deck => `
    <div class="deck-card" data-id="${deck.id}">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
        <div class="deck-card-title">${escHtml(deck.title)}</div>
        <span class="chip">${deck.cardCount || deck.card_count || '?'} cards</span>
      </div>
      <div class="deck-card-meta">
        <span>Created ${formatDate(deck.createdAt || deck.created_at)}</span>
      </div>
      <div class="deck-card-actions">
        <button class="btn btn-primary btn-sm study-btn" data-id="${deck.id}" style="flex:1;justify-content:center;padding:8px">Study Now</button>
        <button class="btn btn-ghost btn-sm view-btn" data-id="${deck.id}" style="flex:1;justify-content:center;padding:8px">View Cards</button>
      </div>
    </div>
  `).join('')}</div>`;

  container.querySelectorAll('.study-btn').forEach(btn =>
    btn.addEventListener('click', (e) => { e.stopPropagation(); navigate('study', { deckId: btn.dataset.id }); }));
  container.querySelectorAll('.view-btn').forEach(btn =>
    btn.addEventListener('click', (e) => { e.stopPropagation(); navigate('deck', { deckId: btn.dataset.id }); }));
  container.querySelectorAll('.deck-card').forEach(card =>
    card.addEventListener('click', () => navigate('deck', { deckId: card.dataset.id })));
}

// ── DECK DETAIL VIEW ──────────────────────────────────────────
async function renderDeck(app, { deckId }) {
  app.innerHTML = `
    <div class="shell">
      ${sidebar()}
      <main class="main animate-in">
        <button class="back-btn" id="back-btn">← Back to Dashboard</button>
        <div id="deck-content">
          <div style="text-align:center;padding:60px"><span class="spinner spinner-lg"></span></div>
        </div>
      </main>
    </div>
  `;

  setupSidebar();
  document.getElementById('back-btn').addEventListener('click', () => navigate('home'));

  try {
    const data = await get(`/api/decks/${deckId}`);
    const deck = data.deck || data;
    const cards = data.cards || [];

    document.getElementById('deck-content').innerHTML = `
      <div class="page-header" style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px">
        <div>
          <div class="page-title">${escHtml(deck.title)}</div>
          <div class="page-subtitle">${cards.length} flashcards generated from PDF</div>
        </div>
        <div style="display:flex;gap:10px;flex-shrink:0">
          <button class="btn btn-primary" id="study-now-btn">📖 Study Now</button>
          <button class="btn btn-ghost" id="export-btn">⬇️ Export Anki</button>
        </div>
      </div>

      <div class="cards-list">
        ${cards.map((card, i) => `
          <div class="card-item">
            <div style="display:flex;align-items:flex-start;gap:10px">
              <div style="min-width:22px;height:22px;border-radius:50%;background:var(--bg-elevated);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--text-muted);flex-shrink:0;margin-top:1px">${i+1}</div>
              <div style="flex:1">
                <div class="card-item-front">${escHtml(card.front)}</div>
                <div class="card-item-back">${escHtml(card.back)}</div>
                ${card.topic ? `<div style="margin-top:8px"><span class="chip">${escHtml(card.topic)}</span></div>` : ''}
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    `;

    document.getElementById('study-now-btn').addEventListener('click', () =>
      navigate('study', { deckId }));

    document.getElementById('export-btn').addEventListener('click', async () => {
      try {
        toast('Preparing Anki export...', 'info');
        const res = await fetch(`${API}/api/decks/${deckId}/export`, { credentials: 'include' });
        if (!res.ok) throw new Error('Export failed');
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${deck.title.replace(/\s+/g, '_')}.apkg`;
        a.click();
        URL.revokeObjectURL(url);
        toast('Anki deck downloaded!', 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  } catch (e) {
    document.getElementById('deck-content').innerHTML =
      `<div class="empty-state"><span class="empty-state-icon">⚠️</span><div class="empty-state-title">${e.message}</div></div>`;
  }
}

// ── STUDY VIEW ────────────────────────────────────────────────
async function renderStudy(app, { deckId }) {
  app.innerHTML = `
    <div class="shell">
      ${sidebar()}
      <main class="main animate-in">
        <button class="back-btn" id="back-btn">← Back</button>
        <div id="study-content">
          <div style="text-align:center;padding:60px"><span class="spinner spinner-lg"></span></div>
        </div>
      </main>
    </div>
  `;

  setupSidebar();
  document.getElementById('back-btn').addEventListener('click', () => navigate('deck', { deckId }));

  try {
    const [deckData, dueData] = await Promise.all([
      get(`/api/decks/${deckId}`),
      get(`/api/decks/${deckId}/due`),
    ]);

    const deck = deckData.deck || deckData;
    const queue = dueData.cards || dueData || [];

    if (queue.length === 0) {
      document.getElementById('study-content').innerHTML = `
        <div style="max-width:560px;margin:0 auto">
          <div class="page-title" style="margin-bottom:8px">${escHtml(deck.title)}</div>
          <div class="empty-state" style="margin-top:32px">
            <span class="empty-state-icon">🎉</span>
            <div class="empty-state-title">All caught up!</div>
            <div class="empty-state-sub">No cards are due for review right now. Check back later.</div>
            <button class="btn btn-ghost" onclick="navigate('deck',{deckId:'${deckId}'})">View All Cards</button>
          </div>
        </div>
      `;
      return;
    }

    state.studyQueue = queue;
    state.studyIndex = 0;
    state.cardFlipped = false;

    renderStudyCard(document.getElementById('study-content'), deck);

  } catch (e) {
    document.getElementById('study-content').innerHTML =
      `<div class="empty-state"><span class="empty-state-icon">⚠️</span><div class="empty-state-title">${e.message}</div></div>`;
  }
}

function renderStudyCard(container, deck) {
  const total = state.studyQueue.length;
  const idx = state.studyIndex;

  if (idx >= total) {
    container.innerHTML = `
      <div class="study-container" style="text-align:center;padding:60px 0">
        <div style="font-size:64px;margin-bottom:20px">🏆</div>
        <div class="page-title" style="margin-bottom:8px">Session Complete!</div>
        <div style="color:var(--text-secondary);font-size:15px;margin-bottom:32px">You reviewed ${total} cards.</div>
        <div style="display:flex;gap:12px;justify-content:center">
          <button class="btn btn-primary" onclick="navigate('study',{deckId:'${deck.id}'})">Study Again</button>
          <button class="btn btn-ghost" onclick="navigate('deck',{deckId:'${deck.id}'})">View Deck</button>
        </div>
      </div>`;
    return;
  }

  const card = state.studyQueue[idx];
  const pct = Math.round((idx / total) * 100);

  container.innerHTML = `
    <div class="study-container">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div style="font-size:15px;font-weight:700">${escHtml(deck.title)}</div>
        <div style="font-size:13px;color:var(--text-muted)">${idx+1} / ${total}</div>
      </div>
      <div class="study-progress-bar">
        <div class="study-progress-fill" style="width:${pct}%"></div>
      </div>

      <div class="flashcard" id="flashcard">
        <div class="flashcard-inner">
          <div class="flashcard-face">
            <div class="flashcard-label">Question</div>
            <div class="flashcard-text">${escHtml(card.front)}</div>
            <div class="flashcard-hint">Click to reveal answer</div>
          </div>
          <div class="flashcard-face flashcard-back">
            <div class="flashcard-label">Answer</div>
            <div class="flashcard-text">${escHtml(card.back)}</div>
          </div>
        </div>
      </div>

      <div id="rating-area" style="display:none">
        <div style="text-align:center;font-size:13px;color:var(--text-muted);margin-bottom:12px;font-weight:600">How well did you know this?</div>
        <div class="rating-buttons">
          <button class="rating-btn" data-rating="1" data-card-id="${card.id}">
            😣 <div class="rating-label">Again</div>
          </button>
          <button class="rating-btn" data-rating="2" data-card-id="${card.id}">
            😐 <div class="rating-label">Hard</div>
          </button>
          <button class="rating-btn" data-rating="3" data-card-id="${card.id}">
            🙂 <div class="rating-label">Good</div>
          </button>
          <button class="rating-btn" data-rating="4" data-card-id="${card.id}">
            😄 <div class="rating-label">Easy</div>
          </button>
        </div>
      </div>

      <div id="flip-hint" style="text-align:center;margin-top:16px">
        <button class="btn btn-ghost" id="flip-btn" style="margin:0 auto">Reveal Answer →</button>
      </div>
    </div>
  `;

  const fc = document.getElementById('flashcard');
  const ratingArea = document.getElementById('rating-area');
  const flipHint = document.getElementById('flip-hint');

  function flipCard() {
    fc.classList.toggle('flipped');
    state.cardFlipped = !state.cardFlipped;
    ratingArea.style.display = state.cardFlipped ? 'block' : 'none';
    flipHint.style.display = state.cardFlipped ? 'none' : 'block';
  }

  fc.addEventListener('click', flipCard);
  document.getElementById('flip-btn').addEventListener('click', flipCard);

  ratingArea.querySelectorAll('.rating-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const rating = parseInt(btn.dataset.rating);
      const cardId = btn.dataset.cardId;
      try {
        await post(`/api/cards/${cardId}/review`, { rating });
        state.studyIndex++;
        state.cardFlipped = false;
        renderStudyCard(container, deck);
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  });
}

// ── PROGRESS VIEW ─────────────────────────────────────────────
function renderProgress(app, { jobId, deckId, title }) {
  const STAGES = [
    { key: 'parse',    label: 'Parsing PDF',           icon: '📄' },
    { key: 'chunk',    label: 'Chunking Text',          icon: '✂️' },
    { key: 'dedup',    label: 'Deduplicating',          icon: '🔍' },
    { key: 'embed',    label: 'Generating Embeddings',  icon: '🔢' },
    { key: 'generate', label: 'Generating Cards',       icon: '✨' },
    { key: 'verify',   label: 'Verifying Cards',        icon: '✅' },
    { key: 'rank',     label: 'Ranking & Selecting',    icon: '🏆' },
    { key: 'persist',  label: 'Saving to Database',     icon: '💾' },
    { key: 'done',     label: 'Complete!',              icon: '🎉' },
  ];

  app.innerHTML = `
    <div class="shell">
      ${sidebar()}
      <main class="main animate-in">
        <div style="max-width:600px">
          <div class="page-header">
            <div class="page-title">Generating Flashcards</div>
            <div class="page-subtitle">${escHtml(title || 'Processing your PDF...')}</div>
          </div>

          <div class="progress-panel">
            <div id="progress-status" style="font-size:14px;color:var(--text-secondary);margin-bottom:20px;display:flex;align-items:center;gap:10px">
              <span class="spinner"></span> Connecting to AI pipeline...
            </div>
            <div class="pipeline-stages" id="pipeline-stages">
              ${STAGES.map(s => `
                <div class="stage" id="stage-${s.key}">
                  <div class="stage-icon">${s.icon}</div>
                  <div class="stage-info">
                    <div class="stage-name">${s.label}</div>
                    <div class="stage-detail" id="stage-detail-${s.key}">Waiting...</div>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>

          <div id="done-actions" style="display:none;margin-top:20px;display:flex;gap:12px">
            <button class="btn btn-primary" id="view-deck-btn">View Generated Cards</button>
            <button class="btn btn-ghost" onclick="navigate('home')">Back to Dashboard</button>
          </div>
        </div>
      </main>
    </div>
  `;

  setupSidebar();

  // Connect WebSocket
  const wsUrl = `ws://localhost:3001/api/jobs/${jobId}/progress`;
  let ws;
  let finalDeckId = deckId;
  let completedNormally = false;

  try {
    ws = new WebSocket(wsUrl);
  } catch {
    document.getElementById('progress-status').innerHTML = '⚠️ Could not connect to progress stream. Check the worker is running.';
    return;
  }

  ws.onopen = () => {
    document.getElementById('progress-status').innerHTML =
      '<span class="spinner"></span> Pipeline running...';
  };

  ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }

    const { stage, data: payload } = msg;

    // Update stages
    document.querySelectorAll('.stage').forEach(el => {
      const key = el.id.replace('stage-', '');
      const stageIdx = STAGES.findIndex(s => s.key === key);
      const currentIdx = STAGES.findIndex(s => s.key === stage);
      if (stageIdx < currentIdx) {
        el.className = 'stage done';
      } else if (stageIdx === currentIdx) {
        el.className = 'stage active';
      }
    });

    // Stage detail messages
    const detail = document.getElementById(`stage-detail-${stage}`);
    if (detail && payload) {
      if (stage === 'generate' && payload.count !== undefined)
        detail.textContent = `${payload.count} draft cards generated`;
      else if (stage === 'verify' && payload.accepted !== undefined)
        detail.textContent = `${payload.accepted} cards passed verification`;
      else if (stage === 'rank' && payload.selected !== undefined)
        detail.textContent = `${payload.selected} cards selected`;
      else if (stage === 'chunk' && payload.count !== undefined)
        detail.textContent = `${payload.count} chunks created`;
      else if (stage === 'done') {
        detail.textContent = 'All done!';
        if (payload.deckId) finalDeckId = payload.deckId;
      }
    }

    if (stage === 'done') {
      completedNormally = true;
      document.getElementById('progress-status').innerHTML = '🎉 Your flashcards are ready!';
      document.querySelectorAll('.stage').forEach(el => el.className = 'stage done');
      const doneActions = document.getElementById('done-actions');
      doneActions.style.display = 'flex';
      const btn = document.getElementById('view-deck-btn');
      if (btn && finalDeckId) {
        btn.addEventListener('click', () => navigate('deck', { deckId: finalDeckId }));
      } else if (btn) {
        btn.addEventListener('click', () => navigate('home'));
      }
    }

    if (stage === 'failed') {
      document.getElementById('progress-status').innerHTML =
        `⚠️ Pipeline failed: ${payload?.error || 'Unknown error'}`;
    }
  };

  ws.onerror = () => {
    if (!completedNormally) {
      document.getElementById('progress-status').innerHTML =
        '⚠️ Lost connection to pipeline. Check the worker terminal for errors.';
    }
  };

  ws.onclose = () => {
    if (!completedNormally) {
      setTimeout(() => {
        document.getElementById('progress-status').innerHTML =
          '⚠️ Pipeline stream closed. If generation completed, check the Dashboard.';
        const doneActions = document.getElementById('done-actions');
        doneActions.style.display = 'flex';
      }, 800);
    }
  };
}

// ── SIDEBAR ───────────────────────────────────────────────────
function sidebar(active = '') {
  const email = state.user?.email || 'Anonymous';
  const initials = email === 'Anonymous' ? '?' : email[0].toUpperCase();
  const kind = state.user?.kind || 'anonymous';

  return `
    <nav class="sidebar">
      <div class="sidebar-logo">
        <div class="logo-text">NCLEX Prep</div>
        <div class="logo-sub">AI Flashcards</div>
      </div>
      <a class="nav-item ${active === 'home' ? 'active' : ''}" data-nav="home">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
        Dashboard
      </a>
      <a class="nav-item" data-nav="home">
        <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
        My Decks
      </a>
      <div class="sidebar-footer">
        <div class="user-chip">
          <div class="user-avatar">${initials}</div>
          <div class="user-info">
            <div class="user-email">${escHtml(email)}</div>
            <div class="user-badge">${kind}</div>
          </div>
        </div>
        ${kind !== 'anonymous' ? `<button class="nav-item" id="logout-btn" style="margin-top:8px;width:100%;text-align:left">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
          Sign Out
        </button>` : `<button class="nav-item" id="signin-btn" style="margin-top:8px;width:100%;text-align:left">
          <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
          Sign In
        </button>`}
      </div>
    </nav>
  `;
}

function setupSidebar() {
  document.querySelectorAll('[data-nav]').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.nav));
  });
  const logout = document.getElementById('logout-btn');
  if (logout) {
    logout.addEventListener('click', async () => {
      try {
        await post('/api/auth/logout', {});
      } catch {}
      state.user = null;
      render('auth');
    });
  }
  const signin = document.getElementById('signin-btn');
  if (signin) signin.addEventListener('click', () => render('auth'));
}

// ── Utilities ─────────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(str) {
  if (!str) return '';
  const d = new Date(str);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Boot ──────────────────────────────────────────────────────
boot();

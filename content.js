// Threads Mutualan Bot - content script
// Semua selector dikumpulkan di sini supaya gampang diperbarui kalau Threads mengubah tampilan.
const SEL = {
  postCard: 'div[data-pressable-container="true"]',
  postLink: 'a[href*="/post/"]',
  profileLink: 'a[href^="/@"]',
  dialog: '[role="dialog"]',
  editor: '[contenteditable="true"]',
  clickable: '[role="button"], button, a'
};
const RE = {
  follow: /^(follow|ikuti)$/i,
  followed: /^(following|mengikuti|diikuti)$/i,
  reply: /^(reply|balas|balasan|komentar|komentari|beri komentar|tanggapi|comment)$/i,
  like: /^(like|unlike|suka|sukai|batal suka|tidak suka)$/i,
  post: /^(post|posting|kirim|balas|reply|send)$/i,  // JANGAN tambah 'bagikan' = tombol Share
  share: /(share|bagikan|repost|posting ulang|like|suka)/i,
  discard: /^(discard|buang|hapus)$/i,
  profileNav: /^(profile|profil)$/i,
  homeNav: /^(home|beranda)$/i,
  login: /^(log in|masuk|login)$/i,
  limited: /(try again later|coba lagi nanti|action blocked|tindakan diblokir|we limit how often|kami membatasi)/i
};
const STEP_MIN = 1000, STEP_MAX = 3000;
const MAX_IDLE_SCROLLS = 15;

let running = false;
let settings = null;
let state = null;
let processed = new Set();
const seen = new Set();

// ---------- helpers ----------
const rand = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function sleep(ms) {
  const end = Date.now() + ms;
  while (running && Date.now() < end) {
    await new Promise((r) => setTimeout(r, Math.min(300, end - Date.now())));
  }
}
const step = () => sleep(rand(STEP_MIN, STEP_MAX));

async function waitFor(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

const visible = (el) => !!el && el.getClientRects().length > 0;

// Cari elemen yang aria-label / <title> svg / teksnya cocok dengan regex, kembalikan elemen yang bisa diklik.
function findClickable(root, re) {
  for (const el of root.querySelectorAll('[aria-label]')) {
    if (re.test((el.getAttribute('aria-label') || '').trim()) && visible(el)) {
      return el.closest(SEL.clickable) || el;
    }
  }
  for (const t of root.querySelectorAll('svg title')) {
    const svg = t.closest('svg');
    if (re.test((t.textContent || '').trim()) && visible(svg)) {
      return svg.closest(SEL.clickable) || svg;
    }
  }
  for (const el of root.querySelectorAll(SEL.clickable)) {
    if (re.test((el.innerText || '').trim()) && visible(el)) return el;
  }
  return null;
}

function realClick(el) {
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const opts = { bubbles: true, cancelable: true, view: window };
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.click();
}

function normalize(s) {
  return ' ' + s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
}

// ---------- state & log ----------
async function saveState() {
  await chrome.storage.local.set({ botState: state });
}

function log(msg) {
  const t = new Date().toLocaleTimeString('id-ID');
  state.logs.unshift(`[${t}] ${msg}`);
  state.logs = state.logs.slice(0, 20);
  console.log('[ThreadsBot]', msg);
  saveState();
}

async function markProcessed(id) {
  processed.add(id);
  const arr = [...processed].slice(-2000);
  await chrome.storage.local.set({ processed: arr });
}

// ---------- page checks ----------
function myUsername() {
  for (const a of document.querySelectorAll(SEL.profileLink)) {
    const lbl = a.querySelector('[aria-label]');
    if (lbl && RE.profileNav.test(lbl.getAttribute('aria-label').trim())) {
      return a.getAttribute('href').split('/')[1].slice(1).toLowerCase();
    }
  }
  return null;
}

function isLoggedIn() {
  if (myUsername()) return true;
  return !findClickable(document, RE.login);
}

const isHome = () => location.pathname === '/' || location.pathname === '';

function limitDetected() {
  for (const d of document.querySelectorAll('[role="dialog"], [role="alert"]')) {
    if (RE.limited.test(d.innerText || '')) return true;
  }
  return false;
}

// ---------- post parsing ----------
function getPosts() {
  return [...document.querySelectorAll(SEL.postCard)]
    // abaikan kartu bersarang (mis. postingan yang di-quote)
    .filter((c) => !c.parentElement.closest(SEL.postCard));
}

function parsePost(card) {
  const link = card.querySelector(SEL.postLink);
  if (!link) return null;
  const path = new URL(link.href).pathname; // /@user/post/ID
  const m = path.match(/^\/@([^/]+)\/post\/([^/?#]+)/);
  if (!m) return null;
  return { id: m[2], username: m[1].toLowerCase(), text: card.innerText || '' };
}

function isMutualPost(text) {
  const n = normalize(text);
  return settings.keywords.some((k) => {
    const kn = normalize(k).trim();
    return kn && n.includes(' ' + kn);
  });
}

// ---------- actions ----------
async function doFollow(card, post) {
  const btn = findClickable(card, RE.follow);
  if (!btn) {
    log(`@${post.username}: tombol follow tidak ada (mungkin sudah follow)`);
    return false;
  }
  realClick(btn);
  await step();

  // Kadang klik "+" membuka kartu profil dengan tombol Follow
  const dlg = [...document.querySelectorAll(SEL.dialog)].find(visible);
  if (dlg) {
    const inner = findClickable(dlg, RE.follow);
    if (inner) { realClick(inner); await step(); }
  }

  // Cek di kartu & dialog saja (tab "Following" di beranda jangan sampai ikut terhitung)
  const ok = await waitFor(() =>
    !findClickable(card, RE.follow) || findClickable(card, RE.followed) ||
    (dlg && document.contains(dlg) && findClickable(dlg, RE.followed)), 5000);
  if (ok) {
    state.stats.followed++;
    log(`✅ Follow @${post.username}`);
  }
  // Kartu/modal profil sering masih terbuka setelah klik Mengikuti → tutup dulu sebelum lanjut
  await closeProfilePopup(btn);
  if (ok) return true;
  log(`⚠️ Follow @${post.username} tidak terkonfirmasi`);
  return false;
}

async function closeComposer() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(800);
  const confirm = [...document.querySelectorAll(SEL.dialog)].map((d) => findClickable(d, RE.discard)).find(Boolean);
  if (confirm) { realClick(confirm); await sleep(800); }
}

// Fallback: tombol reply biasanya tepat setelah tombol like di baris aksi (like, reply, repost, share)
function findReplyByPosition(card) {
  const like = findClickable(card, RE.like);
  if (!like) return null;
  let bar = like.parentElement;
  while (bar && bar !== card) {
    const btns = [...bar.querySelectorAll('[role="button"], button')]
      .filter((b) => visible(b) && b.querySelector('svg') && !b.parentElement.closest('[role="button"], button'));
    if (btns.length >= 3) {
      const i = btns.findIndex((b) => b === like || b.contains(like));
      if (i >= 0 && btns[i + 1]) return btns[i + 1];
    }
    bar = bar.parentElement;
  }
  return null;
}

function describeButtons(card) {
  const labels = [...card.querySelectorAll('[aria-label], svg title')]
    .map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim())
    .filter(Boolean);
  return [...new Set(labels)].slice(0, 12).join(' | ') || '(tidak ada label)';
}

const visibleEditors = () => [...document.querySelectorAll(SEL.editor)].filter(visible);

// Area composer = dialog, atau (inline) ancestor editor terbesar yang BELUM mencakup baris aksi kartu
// (like/reply/repost/share). Dengan begitu ikon Share/Bagikan tidak pernah ikut jadi kandidat.
function composerScope(editor, replyBtn) {
  const dialog = editor.closest(SEL.dialog);
  if (dialog) return dialog;
  let scope = editor.parentElement;
  for (let i = 0; i < 8; i++) {
    const up = scope.parentElement;
    if (!up || up === document.body || (replyBtn && up.contains(replyBtn))) break;
    scope = up;
  }
  return scope;
}

const labelOf = (b) => ((b.innerText || '').trim() ||
  b.getAttribute('aria-label') ||
  b.querySelector('[aria-label]')?.getAttribute('aria-label') ||
  b.querySelector('svg title')?.textContent || '').trim();

function sendCandidates(editor, replyBtn) {
  return [...composerScope(editor, replyBtn).querySelectorAll('[role="button"], button')]
    .filter((b) => visible(b) && b !== replyBtn && !b.contains(editor) && !editor.contains(b));
}

// Prioritas: 1) tombol bertulisan Post/Posting/Kirim/Balas, 2) ikon dengan label yang sama
function findSendButton(editor, replyBtn) {
  const cands = sendCandidates(editor, replyBtn);
  return cands.find((b) => RE.post.test((b.innerText || '').trim())) ||
    cands.find((b) => RE.post.test(labelOf(b)) && !RE.share.test(labelOf(b))) || null;
}

function describeComposer(editor, replyBtn) {
  const labels = sendCandidates(editor, replyBtn).map((b) => labelOf(b) || '(ikon tanpa label)');
  return labels.length ? labels.slice(0, 10).join(' | ') : '(tidak ada tombol)';
}

const isEnabled = (b) => b.getAttribute('aria-disabled') !== 'true' && !b.disabled;

async function doComment(card, post) {
  const replyBtn = findClickable(card, RE.reply) || findReplyByPosition(card);
  if (!replyBtn) {
    log(`@${post.username}: tombol reply tidak ditemukan. Label di kartu: ${describeButtons(card)}`);
    return false;
  }

  const before = new Set(visibleEditors());
  realClick(replyBtn);

  // Editor bisa muncul di dialog (popup) atau langsung di bawah postingan (inline)
  const editor = await waitFor(() => {
    const eds = visibleEditors();
    return eds.find((e) => e.closest(SEL.dialog)) || eds.find((e) => !before.has(e)) || null;
  }, 8000);
  if (!editor) {
    log(`@${post.username}: kotak komentar tidak muncul`);
    return false;
  }
  await step();

  const text = pick(settings.comments).replace(/\{username\}/g, '@' + post.username);
  editor.focus();
  document.execCommand('insertText', false, text);
  await step();

  const sendBtn = await waitFor(() => {
    const b = findSendButton(editor, replyBtn);
    return b && isEnabled(b) ? b : null;
  }, 5000);
  if (sendBtn) {
    // klik langsung tanpa scroll supaya posisi dialog tidak bergeser
    log(`@${post.username}: klik tombol "${labelOf(sendBtn)}"`);
    sendBtn.click();
  } else {
    // cadangan: Ctrl+Enter di kotak komentar
    log(`@${post.username}: tombol Posting tidak ketemu (tombol di composer: ${describeComposer(editor, replyBtn)}), coba Ctrl+Enter`);
    editor.focus();
    for (const type of ['keydown', 'keyup']) {
      editor.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, ctrlKey: true, bubbles: true }));
    }
  }

  // Sukses kalau editor hilang (dialog tertutup) atau kosong lagi (inline)
  const done = await waitFor(() =>
    !document.contains(editor) || !visible(editor) || !(editor.innerText || '').trim(), 15000);
  if (!done) {
    log(`⚠️ Komentar ke @${post.username} gagal terkirim`);
    await closeComposer();
    return false;
  }
  state.stats.commented++;
  log(`💬 Komentar ke @${post.username}: "${text}"`);
  return true;
}

// ---------- navigasi & bersih-bersih popup ----------
const pressEscape = () => {
  for (const t of [document.activeElement || document.body, document]) {
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  }
};

// Klik area kosong (bukan tombol/link) untuk menutup popup / kartu profil
// Urutan: pojok kanan atas dulu (biasanya kosong), lalu pinggir kanan, lalu pojok kiri bawah
function clickEmptySpot() {
  const spots = [
    [window.innerWidth - 10, 10],
    [window.innerWidth - 10, 60],
    [window.innerWidth - 10, window.innerHeight / 2],
    [10, window.innerHeight - 10]
  ];
  for (const [x, y] of spots) {
    const el = document.elementFromPoint(x, y);
    if (!el || el.closest('a, button, [role="button"], [contenteditable="true"], input, textarea')) continue;
    if (el.closest('[role="dialog"], [role="menu"]') || isFloatingCard(el)) continue;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    // pindahkan "mouse" ke titik ini dulu supaya hover card ikut tertutup
    el.dispatchEvent(new PointerEvent('pointermove', opts));
    el.dispatchEvent(new MouseEvent('mousemove', opts));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    return true;
  }
  return false;
}

// Kartu profil melayang (hover card) tidak selalu ber-role dialog. Cirinya: ada tombol
// Ikuti/Mengikuti di luar kartu postingan, dan salah satu ancestor-nya position fixed/absolute.
function isFloatingCard(el) {
  for (let n = el, i = 0; n && n !== document.body && i < 12; n = n.parentElement, i++) {
    const pos = getComputedStyle(n).position;
    if (pos === 'fixed' || pos === 'absolute') return n;
  }
  return null;
}

function findProfileCards() {
  const cards = new Set();
  for (const b of document.querySelectorAll('[role="button"], button')) {
    const t = (b.innerText || '').trim();
    if (!visible(b) || !(RE.follow.test(t) || RE.followed.test(t))) continue;
    if (b.closest(SEL.postCard) || b.closest('nav, header')) continue;
    const floating = isFloatingCard(b);
    if (floating) cards.add(floating);
  }
  return [...cards];
}

const openPopups = () => [
  ...[...document.querySelectorAll('[role="dialog"], [role="menu"], [role="tooltip"]')].filter(visible),
  ...findProfileCards()
];

function leaveHover(el) {
  if (!el || !document.contains(el)) return;
  const opts = { bubbles: true, cancelable: true, view: window };
  for (const type of ['pointerout', 'pointerleave', 'mouseout', 'mouseleave']) {
    el.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, opts));
  }
}

// Tutup modal/kartu profil yang muncul setelah follow: lepas hover, Esc, klik pojok kanan atas
async function closeProfilePopup(followBtn) {
  for (let i = 0; i < 4; i++) {
    if (!openPopups().length) return true;
    leaveHover(followBtn);
    pressEscape();
    await sleep(300);
    clickEmptySpot();
    await sleep(rand(700, 1100));
  }
  const still = openPopups().length === 0;
  if (!still) log('⚠️ Popup profil belum tertutup, lanjut cleanUp');
  return still;
}

async function dismissPopups() {
  for (let i = 0; i < 3 && openPopups().length; i++) {
    pressEscape();
    await sleep(400);
    clickEmptySpot();
    await sleep(600);
    // composer yang masih ada isinya kadang minta konfirmasi "Buang"
    const discard = openPopups().map((d) => findClickable(d, RE.discard)).find(Boolean);
    if (discard) { realClick(discard); await sleep(600); }
  }
  clickEmptySpot();
  await sleep(500);
}

// Kembali ke Beranda tanpa reload (klik menu Beranda), kalau gagal pakai history.back / reload
async function goHome() {
  if (isHome()) return true;
  const nav = findClickable(document, RE.homeNav) ||
    [...document.querySelectorAll('a[href="/"]')].find(visible);
  if (nav) {
    realClick(nav);
    if (await waitFor(isHome, 6000)) { await sleep(rand(1500, 2500)); return true; }
  }
  history.back();
  if (await waitFor(isHome, 6000)) { await sleep(rand(1500, 2500)); return true; }
  // terakhir: reload ke Beranda, bot lanjut otomatis setelah halaman termuat
  await chrome.storage.local.set({ resume: { stats: state.stats } });
  log('↩️ Reload ke Beranda, bot lanjut otomatis...');
  location.assign('/');
  return false;
}

// Cari ulang kartu postingan di feed (kartu lama bisa hilang setelah pindah halaman)
async function findCard(postId) {
  for (let i = 0; i < 8; i++) {
    const card = getPosts().find((c) => parsePost(c)?.id === postId);
    if (card) return card;
    window.scrollBy({ top: window.innerHeight * 0.6 });
    await sleep(1200);
  }
  return null;
}

async function cleanUp() {
  await dismissPopups();
  if (!isHome()) {
    const ok = await goHome();
    if (!ok) running = false; // halaman akan reload
    await dismissPopups();
  }
}

// ---------- main loop ----------
async function stop(reason) {
  running = false;
  state.running = false;
  state.reason = reason;
  log(`⏹ Berhenti: ${reason}`);
}

async function run() {
  const me = myUsername();
  let idleScrolls = 0;
  let actions = state.stats.processed || 0;

  while (running) {
    await cleanUp();
    if (!running) return;
    if (limitDetected()) return stop('Terdeteksi limit dari Threads, istirahat dulu');

    let target = null;
    for (const card of getPosts()) {
      const post = parsePost(card);
      if (!post || seen.has(post.id)) continue;
      seen.add(post.id);
      if (processed.has(post.id) || post.username === me) continue;
      if (isMutualPost(post.text)) { target = { card, post }; break; }
      state.stats.skipped++;
    }

    if (!target) {
      if (++idleScrolls > MAX_IDLE_SCROLLS) return stop('Tidak ada postingan mutualan baru');
      window.scrollBy({ top: window.innerHeight * 0.8, behavior: 'smooth' });
      await sleep(rand(2000, 3500));
      continue;
    }
    idleScrolls = 0;

    const { card, post } = target;
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.style.outline = '3px solid #22c55e';
    await step();

    if (settings.dryRun) {
      log(`🔎 [Dry run] Mutualan terdeteksi: @${post.username}`);
    } else {
      // tandai dulu supaya tidak diulang kalau halaman reload
      await markProcessed(post.id);
      if (settings.doFollow && running) {
        await doFollow(card, post);
        if (limitDetected()) return stop('Terdeteksi limit dari Threads, istirahat dulu');
        await step();
        await cleanUp();
      }
      if (settings.doComment && running) {
        const fresh = document.contains(card) && visible(card) ? card : await findCard(post.id);
        if (fresh) {
          fresh.scrollIntoView({ block: 'center', behavior: 'smooth' });
          await step();
          await doComment(fresh, post);
        } else {
          log(`@${post.username}: postingan hilang dari Beranda, komentar dilewati`);
        }
        if (limitDetected()) return stop('Terdeteksi limit dari Threads, istirahat dulu');
        await step();
        await cleanUp();
      }
      if (!running) return;
    }

    actions++;
    state.stats.processed = actions;
    await saveState();
    if (actions >= settings.maxActions) return stop(`Batas ${settings.maxActions} aksi tercapai`);

    const wait = rand(settings.delayMin, settings.delayMax);
    log(`⏳ Jeda ${wait} detik...`);
    await sleep(wait * 1000);
  }
}

async function start(resume = null) {
  if (running) return { ok: false, error: 'Bot sudah berjalan' };
  if (!isLoggedIn()) return { ok: false, error: 'Belum login di Threads. Login dulu ya.' };

  const data = await chrome.storage.local.get(['settings', 'processed']);
  settings = { ...THREADS_BOT_DEFAULTS, ...(data.settings || {}) };
  processed = new Set(data.processed || []);
  state = {
    running: true,
    reason: '',
    stats: resume?.stats || { processed: 0, followed: 0, commented: 0, skipped: 0 },
    logs: resume ? (await chrome.storage.local.get('botState')).botState?.logs || [] : []
  };
  running = true;
  log(resume ? '▶️ Lanjut setelah reload' : `▶️ Mulai${settings.dryRun ? ' (dry run)' : ''}`);
  if (!isHome()) log('🏠 Bukan di Beranda, kembali ke Beranda dulu...');
  run().catch((e) => stop('Error: ' + e.message)).finally(saveState);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'start') {
    start().then(sendResponse);
    return true;
  }
  if (msg.type === 'stop') {
    if (running) stop('Dihentikan manual').then(saveState);
    sendResponse({ ok: true });
  }
  if (msg.type === 'ping') {
    sendResponse({ ok: true, running });
  }
});

// Lanjutkan otomatis kalau tadi bot me-reload halaman ke Beranda
(async () => {
  const { resume } = await chrome.storage.local.get('resume');
  if (!resume) return;
  await chrome.storage.local.remove('resume');
  const fail = async (reason) => {
    const { botState } = await chrome.storage.local.get('botState');
    if (botState) await chrome.storage.local.set({ botState: { ...botState, running: false, reason } });
  };
  if (!(await waitFor(() => isHome() && getPosts().length, 15000))) return fail('Beranda tidak termuat setelah reload');
  await new Promise((r) => setTimeout(r, 2000));
  const res = await start(resume);
  if (!res.ok) await fail(res.error);
})();

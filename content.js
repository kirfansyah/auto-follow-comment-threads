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
  close: /^(close|tutup|dismiss|batal|cancel|kembali|back|x)$/i,
  profileNav: /^(profile|profil)$/i,
  homeNav: /^(home|beranda)$/i,
  login: /^(log in|masuk|login)$/i,
  limited: /(try again later|coba lagi nanti|action blocked|tindakan diblokir|we limit how often|kami membatasi)/i
};
const STEP_MIN = 1000, STEP_MAX = 3000;
const MAX_IDLE_SCROLLS = 15;

let running = false;
let reloading = false;   // true kalau goHome() sudah memutuskan reload halaman
let hiddenIdleLogged = false;   // supaya log "menunggu tab dibuka" tidak diulang tiap siklus
let settings = null;
let state = null;
let processed = new Set();
const seen = new Set();

// ---------- helpers ----------
const rand = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Chrome menahan timer di tab tersembunyi: ~1 detik, dan setelah tab tersembunyi 5 menit jadi
// ~1x per MENIT ("intensive throttling"). Hukuman 1x/menit itu hanya menyasar timer BERANTAI —
// setTimeout yang dipanggil dari dalam callback timer menaikkan "nesting level". Dengan memantul
// lewat MessageChannel dulu (macrotask yang tidak diratakan), nesting level balik ke 0 sehingga
// timernya cuma kena perataan 1 detik. JANGAN pakai setTimeout telanjang untuk jeda berulang.
const chan = new MessageChannel();
const tick = () => new Promise((r) => { chan.port1.onmessage = r; chan.port2.postMessage(0); });
async function delay(ms) {
  await tick();
  await new Promise((r) => setTimeout(r, ms));
}

async function sleep(ms) {
  const end = Date.now() + ms;
  while (running && Date.now() < end) {
    await delay(Math.min(300, end - Date.now()));
    beat();
  }
}
const step = () => sleep(rand(STEP_MIN, STEP_MAX));

// Jeda yang TIDAK peduli `running`. Hanya untuk sapuan popup setelah bot berhenti:
// di sana sleep() akan langsung lewat sehingga Esc/klik tidak diberi waktu bereaksi.
const hold = (ms) => delay(ms);

// Tunggu sampai fn() bernilai truthy. Digerakkan MutationObserver, bukan polling: callback
// observer datang sebagai microtask setelah DOM berubah, jadi jalur SUKSES sama sekali tidak
// bergantung timer — itulah yang membuat ini tetap bekerja di tab tersembunyi. Poll delay(250)
// tetap ada sebagai jaring untuk kondisi yang bukan mutasi DOM (mis. isHome() yang baca location).
async function waitFor(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  const first = fn();
  if (first) return first;

  // `wake` harus di-arm ulang tiap kali dipicu: promise yang sudah resolve akan selalu menang
  // lomba berikutnya, dan itu membuat loop ini berputar tanpa jeda sampai batas waktu.
  let wake, arm;
  const rearm = () => { wake = new Promise((r) => { arm = r; }); };
  rearm();

  const obs = new MutationObserver(() => arm());
  obs.observe(document.documentElement, {
    childList: true, subtree: true, attributes: true, characterData: true
  });
  try {
    while (Date.now() < end) {
      await Promise.race([wake, delay(Math.min(250, end - Date.now()))]);
      rearm();          // di-arm SEBELUM fn() supaya mutasi yang datang setelahnya tidak hilang
      const v = fn();
      if (v) return v;
    }
  } finally {
    obs.disconnect();
  }
  return null;
}

const visible = (el) => !!el && el.getClientRects().length > 0;

// Scroll mulus digerakkan animation frame, dan itu tidak jalan di tab tersembunyi — di sana
// scroll-nya bisa tidak pernah selesai. Jadi mulus kalau terlihat, instan kalau tersembunyi.
const scrollBehavior = () => (document.hidden ? 'auto' : 'smooth');

// Denyut nadi: popup memakainya untuk membedakan "loop masih maju" dari "tab sudah dibuang Chrome".
// Ditulis dari dalam loop sleep() karena itu yang selalu berdenyut, bahkan selama jeda 90 detik.
let lastBeat = 0;
function beat() {
  if (!running || Date.now() - lastBeat < 20000) return;
  lastBeat = Date.now();
  chrome.storage.local.set({ heartbeat: lastBeat });
}

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
  el.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
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
  await closeProfilePopup(btn, card);
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

// Tulis teks ke composer dan PASTIKAN benar-benar masuk sebelum tombol kirim diklik.
// execCommand bergantung pada selection/focus dokumen, jadi di tab yang tidak fokus dia bisa
// gagal diam-diam — dan tanpa verifikasi bot akan menekan kirim pada composer kosong.
async function typeInto(editor, text) {
  const landed = () => (editor.innerText || '').includes(text);

  editor.focus();
  document.execCommand('insertText', false, text);
  if (await waitFor(landed, 2000)) return true;

  // Cadangan: beforeinput sintetis. Editor Threads berbasis Lexical membaca event.data.
  log('✏️ execCommand tidak menulis apa pun, coba beforeinput');
  editor.focus();
  editor.dispatchEvent(new InputEvent('beforeinput', {
    inputType: 'insertText', data: text, bubbles: true, cancelable: true
  }));
  return !!(await waitFor(landed, 2000));
}

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
  if (!(await typeInto(editor, text))) {
    log(`@${post.username}: teks komentar gagal dimasukkan, komentar dibatalkan`);
    await closeComposer();
    return false;
  }
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
// Escape ditembakkan ke activeElement, document, DAN ke tiap popup yang terbuka: sebagian
// handler Threads terpasang di elemen popup-nya sendiri, bukan di document. keyup ikut dikirim
// karena ada handler yang menunggu itu, bukan keydown.
const pressEscape = () => {
  const targets = [document.activeElement || document.body, document, ...openPopups()];
  for (const t of targets) {
    for (const type of ['keydown', 'keyup']) {
      t.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    }
  }
};

// Klik area kosong (bukan tombol/link) untuk menutup popup / kartu profil
// Urutan: pojok kanan atas dulu (biasanya kosong), lalu pinggir kanan, lalu pojok kiri bawah
const INTERACTIVE = 'a, button, [role="button"], [contenteditable="true"], input, textarea';
const viewportArea = () => window.innerWidth * window.innerHeight;
const spotList = () => [
  [window.innerWidth - 10, 10],
  [window.innerWidth - 10, 60],
  [window.innerWidth - 10, window.innerHeight / 2],
  [10, window.innerHeight / 2],
  [window.innerWidth - 10, window.innerHeight - 10],
  [10, window.innerHeight - 10]
];

function clickPoint(el, x, y) {
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
}

// Tahap 1: titik yang benar-benar di luar semua popup. Jangan pakai isFloatingCard() di sini:
// fungsi itu cuma mencari ancestor fixed/absolute mana pun, dan chrome halaman Threads sendiri
// (header/sidebar) posisinya fixed — semua titik bisa tertolak dan fungsi ini gagal diam-diam.
function clickOutsideSpot() {
  const popups = openPopups();
  for (const [x, y] of spotList()) {
    const el = document.elementFromPoint(x, y);
    if (!el || el.closest(INTERACTIVE)) continue;
    if (popups.some((p) => p === el || p.contains(el))) continue;
    clickPoint(el, x, y);
    return true;
  }
  return false;
}

// Pada overlay selebar viewport, cari rect kartu yang benar-benar terlihat di tengahnya.
function contentRect(popup) {
  const big = viewportArea() * 0.8;
  let best = null;
  for (const el of popup.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (!area || area > big) continue;
    if (!best || area > best.width * best.height) best = r;
  }
  return best;
}

// Tahap 2: popup yang menutupi seluruh viewport tidak menyisakan "luar" sama sekali, jadi
// tahap 1 pasti gagal. Jalan keluarnya justru mengklik OVERLAY-nya di area kosong di luar rect
// kartu — itu persis gestur yang ditunggu handler outside-click mereka.
function clickOverlaySpot() {
  for (const p of openPopups()) {
    const pr = p.getBoundingClientRect();
    if (pr.width * pr.height < viewportArea() * 0.8) continue;
    const card = contentRect(p);
    for (const [x, y] of spotList()) {
      if (card && x >= card.left && x <= card.right && y >= card.top && y <= card.bottom) continue;
      const el = document.elementFromPoint(x, y);
      if (!el || el.closest(INTERACTIVE)) continue;
      clickPoint(el, x, y);
      return true;
    }
  }
  return false;
}

// Tahap 3: banyak handler outside-click berbentuk
//   document.addEventListener('mousedown', e => { if (!card.contains(e.target)) close(); })
// dan menembakkan di documentElement membuat e.target dijamin di luar kartu.
// CATATAN: listener React terpasang di root container, jadi event di documentElement (ancestor
// dari root itu) TIDAK terlihat oleh handler React. Ini cuma menolong listener document biasa —
// karena itu dia tingkat terakhir, jangan dipindah ke depan dengan harapan keliru.
const clickDocument = () => clickPoint(document.documentElement, 5, 5);

// Mengembalikan nama tahap yang dipakai (untuk log), atau null kalau tidak ada yang dilakukan.
// Nilai string selalu truthy, jadi pemanggil yang memperlakukannya sebagai boolean tetap benar.
function clickEmptySpot() {
  if (clickOutsideSpot()) return 'luar';
  if (!openPopups().length) return null;   // tidak ada popup, tidak perlu mengetuk lebih keras
  if (clickOverlaySpot()) return 'overlay';
  clickDocument();
  return 'document';
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

const POPUP_ROLES = '[role="dialog"], [role="menu"], [role="tooltip"], [role="alert"], [aria-modal="true"]';

// Popup = dialog/menu/tooltip/alert/modal, kartu profil melayang, atau composer yang masih berisi teks.
// Composer KOSONG tidak dihitung: kotak tulis di Beranda selalu ada, kalau ikut terhitung maka
// dismissPopups() akan looping dan menulis warning palsu setiap siklus. Editor yang ada isinya
// hanya bisa berasal dari doComment() yang belum selesai.
function openPopups() {
  const found = new Set([
    ...[...document.querySelectorAll(POPUP_ROLES)].filter(visible),
    ...findProfileCards(),
    ...visibleEditors().filter((e) => (e.innerText || '').trim())
  ]);
  // buang node yang bersarang di dalam node lain supaya jumlah & isi log tidak menggelembung
  const all = [...found];
  return all.filter((el) => !all.some((o) => o !== el && o.contains(el)));
}

// Dipakai di log kalau popup tidak mau tertutup, supaya label aslinya bisa ditambahkan ke RE.close / RE.discard
function describePopup(el) {
  const role = el.getAttribute('role') ||
    (el.getAttribute('aria-modal') === 'true' ? 'modal' : el.isContentEditable ? 'composer' : 'melayang');
  // Ukuran relatif viewport ikut dicatat: popup 100%x100% berarti dia overlay yang menutupi
  // seluruh layar, dan itu menjelaskan kenapa tidak ada titik "di luar" yang bisa diklik.
  const r = el.getBoundingClientRect();
  const size = `${Math.round((r.width / window.innerWidth) * 100)}%x${Math.round((r.height / window.innerHeight) * 100)}%`;
  const labels = [...new Set([...el.querySelectorAll('[aria-label], svg title')]
    .map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim())
    .filter(Boolean))].slice(0, 8);
  const text = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  return `${role} ${size}${labels.length ? ` [${labels.join(' | ')}]` : ''}${text ? ` "${text}"` : ''}`;
}

// Scroll kecil: hover card & popover umumnya bubar begitu halaman digeser. Paling murah dan
// paling tidak berisiko, jadi dipakai di tingkat awal. Instan supaya posisi kartu tidak bergeser.
function scrollNudge() {
  window.scrollBy({ top: 1, behavior: 'auto' });
  window.scrollBy({ top: -1, behavior: 'auto' });
}

// Pamungkas kalau semua cara halus gagal: sembunyikan node-nya. display:none dipilih (bukan
// remove()) supaya masih reversibel dan struktur yang dipegang React tidak dirusak.
function forceHide(el) {
  // Yang disembunyikan HARUS elemen yang ditandai popup oleh aplikasinya sendiri, bukan ancestor
  // hasil heuristik. openPopups() menyimpan node terluar, dan findProfileCards() mengembalikan
  // ancestor fixed/absolute — itu bisa berupa kontainer portal yang DIPAKAI BERSAMA. Kalau
  // kontainer itu di-display:none lalu dialog composer dirender ke tempat yang sama, komentar
  // akan gagal terus ("kotak komentar tidak muncul") sampai halaman di-refresh.
  const node = el.matches(POPUP_ROLES) ? el : el.querySelector(POPUP_ROLES);
  if (!node) return false;
  if (isBlockingPopup(node)) return false;              // composer/konfirmasi jangan pernah dipaksa:
                                                        // menyembunyikannya tanpa membatalkan state
                                                        // justru membuat Threads bingung setelahnya
  if (node.querySelector(SEL.postCard)) return false;   // memuat kartu postingan = bagian feed, bukan popup
  const r = node.getBoundingClientRect();
  if (r.width * r.height > viewportArea() * 0.6) return false;   // sebesar layar = overlay/layout
  node.style.display = 'none';
  return true;
}

function leaveHover(el) {
  if (!el || !document.contains(el)) return;
  const opts = { bubbles: true, cancelable: true, view: window };
  for (const type of ['pointerout', 'pointerleave', 'mouseout', 'mouseleave']) {
    el.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, opts));
  }
}

// Tutup modal/kartu profil yang muncul setelah follow: lepas hover, Esc, klik pojok kanan atas
async function closeProfilePopup(followBtn, card) {
  // Pemicu hover card biasanya avatar / tautan username di kartu, BUKAN tombol follow-nya.
  // Mengirim mouseleave cuma ke tombol follow tidak akan menutup kartu yang dipicu avatar.
  const triggers = [followBtn, ...(card ? card.querySelectorAll(SEL.profileLink) : [])];
  for (let i = 0; i < 4; i++) {
    if (!openPopups().length) return true;
    triggers.forEach(leaveHover);
    pressEscape();
    scrollNudge();
    await sleep(300);
    clickEmptySpot();
    await sleep(rand(700, 1100));
  }
  const still = openPopups().length === 0;
  if (!still) log('⚠️ Popup profil belum tertutup, lanjut cleanUp');
  return still;
}

// Popup yang betul-betul menghalangi aksi berikutnya. Kartu profil melayang & tooltip
// menjengkelkan tapi tidak memblokir klik, jadi cukup dicatat dan bot boleh lanjut.
//
// PENTING: kartu profil Threads juga memakai role="dialog" padahal cuma preview — tidak punya
// tombol tutup, tidak aria-modal, dan biasanya hilang sendiri begitu kita mengklik di tempat lain.
// Menghentikan sesi gara-gara itu terlalu galak. Jadi sebuah dialog baru dihitung memblokir kalau
// ada buktinya memang modal: aria-modal, ada composer, atau ada tombol tutup/buang/kirim.
function isBlockingPopup(el) {
  if (el.isContentEditable || el.matches('[aria-modal="true"], [role="menu"]')) return true;
  if (!el.matches('[role="dialog"]')) return false;
  return !!(el.querySelector(SEL.editor) || findClickable(el, RE.close) ||
    findClickable(el, RE.discard) || findClickable(el, RE.post));
}

// Popup yang sudah dilaporkan dan ternyata tidak bisa ditutup. Tetap ikut openPopups() (supaya
// clickEmptySpot tidak mengkliknya), tapi tidak dilawan & dicatat ulang tiap siklus.
const stuck = new WeakSet();
const freshPopups = () => openPopups().filter((el) => !stuck.has(el));

// Tutup semua popup yang terbuka, bertingkat: Esc → klik area kosong → konfirmasi "Buang" →
// (percobaan terakhir) tombol tutup milik popup itu sendiri. Mengembalikan true kalau akhirnya bersih.
// `wait` diganti `hold` untuk sapuan setelah bot berhenti, karena sleep() langsung lewat kalau !running.
const TRIES_DISMISS = 4;

// force = true mengabaikan daftar `stuck`, dipakai sapuan terakhir yang tidak berlomba dengan apa pun.
async function dismissPopups(wait = sleep, force = false) {
  const targets = () => (force ? openPopups() : freshPopups());
  let spot = null;
  for (let i = 0; i < TRIES_DISMISS && targets().length; i++) {
    pressEscape();
    scrollNudge();
    await wait(400);
    spot = clickEmptySpot();
    await wait(600);
    // composer yang masih ada isinya kadang minta konfirmasi "Buang"
    const discard = openPopups().map((d) => findClickable(d, RE.discard)).find(Boolean);
    if (discard) { realClick(discard); await wait(600); }

    // Langkah pamungkas: tombol tutup di dalam popup. Jangan menebak lewat posisi — kartu profil
    // tidak punya tombol tutup, dan klik sembarangan di situ bisa pindah ke halaman profil orang.
    if (i === TRIES_DISMISS - 1) {
      for (const p of targets()) {
        const close = findClickable(p, RE.close);
        if (!close) continue;
        const lbl = labelOf(close);
        if (RE.post.test(lbl) || RE.share.test(lbl)) continue;   // jangan sampai Kirim/Bagikan terklik
        log(`🧹 Klik tombol tutup "${lbl || 'tanpa label'}" di popup`);
        realClick(close);
        await wait(600);
      }
    }
  }
  // dorongan terakhir untuk hover card yang tidak terdeteksi openPopups()
  spot = clickEmptySpot() || spot;
  await wait(500);

  const left = targets();
  if (!left.length) return true;

  // Pamungkas: sembunyikan yang non-blocking. describePopup() dipanggil SEBELUM disembunyikan,
  // karena innerText elemen ber-display:none sudah kosong.
  const hidden = [];
  for (const el of left) {
    const desc = describePopup(el);
    if (forceHide(el)) hidden.push(desc);
  }
  if (hidden.length) log(`🧹 ${hidden.length} popup disembunyikan paksa: ${hidden.join(' // ')}`);

  const stillLeft = targets();
  if (!stillLeft.length) return true;
  stillLeft.forEach((el) => stuck.add(el));   // laporkan sekali saja, jangan spam log tiap siklus
  // Tahap klik yang terpakai ikut dicatat: kalau null, berarti tidak ada titik yang bisa diklik
  // sama sekali, dan itulah sebab utamanya — tanpa dilaporkan, kegagalan itu tidak kelihatan.
  log(`⚠️ ${stillLeft.length} popup masih nyangkut (klik: ${spot || 'TIDAK ADA'}): ` +
    stillLeft.map(describePopup).join(' // '));
  return false;
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
  reloading = true;   // sapuan popup tidak perlu: reload menghapus semuanya
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
  if (!(await dismissPopups())) {
    // Modal/menu/composer yang tidak mau tutup akan membuat semua klik berikutnya gagal.
    // Lebih jujur berhenti dengan alasan jelas daripada terus menggiling tanpa hasil.
    // detail tiap popup sudah dicatat dismissPopups(), di sini cukup alasan singkat untuk status popup
    // `running` dicek supaya Stop manual tidak tertimpa alasan ini: kalau bot sudah berhenti,
    // sleep() di dalam dismissPopups() langsung lewat sehingga kegagalannya palsu. finalSweep yang urus.
    const blocking = running ? openPopups().filter(isBlockingPopup) : [];
    if (blocking.length) {
      const roles = [...new Set(blocking.map((el) => el.getAttribute('role') || 'composer'))].join(', ');
      await stop(`Popup "${roles}" tidak bisa ditutup, lihat log`);
      return;
    }
  }
  if (!isHome()) {
    const ok = await goHome();
    if (!ok) running = false; // halaman akan reload
    await dismissPopups();
  }
}

// Sapuan terakhir setelah loop selesai. Semua jalur keluar (batas aksi, idle scroll, limit,
// Stop manual, error) bisa meninggalkan dialog composer / kartu profil menempel di layar,
// dan tidak ada cleanUp() lagi setelah itu. Pakai hold(): running sudah false di titik ini.
async function finalSweep() {
  if (reloading || !state) return;
  const open = openPopups();
  if (!open.length) return;
  log(`🧹 Membersihkan ${open.length} popup sisa...`);
  if (await dismissPopups(hold, true)) log('✅ Popup sisa sudah tertutup');
  await saveState();
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
      // Di tab tersembunyi, Threads tidak menambah postingan baru ke feed (pagination-nya
      // dipicu IntersectionObserver yang ikut siklus rendering, dan itu dilewati untuk halaman
      // tersembunyi). Jadi "tidak ada postingan baru" di situ kesimpulan yang salah — tunggu saja
      // sampai tabnya dibuka lagi, jangan habiskan kuota idle scroll.
      if (document.hidden) {
        if (!hiddenIdleLogged) {
          log('👁️ Tab tersembunyi & postingan yang ter-load habis. Menunggu tab dibuka lagi...');
          hiddenIdleLogged = true;
        }
        window.scrollBy({ top: window.innerHeight * 0.8, behavior: scrollBehavior() });
        await sleep(rand(5000, 10000));
        continue;
      }
      // baru kembali terlihat: feed akan memuat lagi, jadi kuota idle scroll dimulai dari nol
      if (hiddenIdleLogged) { hiddenIdleLogged = false; idleScrolls = 0; }
      if (++idleScrolls > MAX_IDLE_SCROLLS) return stop('Tidak ada postingan mutualan baru');
      window.scrollBy({ top: window.innerHeight * 0.8, behavior: scrollBehavior() });
      await sleep(rand(2000, 3500));
      continue;
    }
    idleScrolls = 0;

    const { card, post } = target;
    card.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
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
          fresh.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
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
  lastBeat = 0;
  beat();   // denyut awal, supaya popup tidak membaca heartbeat sesi lama sebagai "tidak merespons"
  log(resume ? '▶️ Lanjut setelah reload' : `▶️ Mulai${settings.dryRun ? ' (dry run)' : ''}`);
  if (!isHome()) log('🏠 Bukan di Beranda, kembali ke Beranda dulu...');
  // finalSweep di .then(), bukan di dalam stop(): stop() juga dipanggil dari listener pesan
  // (Stop manual) dan kerja async di sana akan berlomba dengan aksi yang sedang jalan.
  // Menunggu run() selesai mengurai diri membuat sapuan ini menutup semua jalur keluar tepat sekali.
  run()
    .catch((e) => stop('Error: ' + e.message))
    .then(finalSweep)
    .catch((e) => console.log('[ThreadsBot] finalSweep gagal:', e))
    .finally(saveState);
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

// Catat perubahan visibilitas supaya log menjelaskan kenapa bot melambat di tab tersembunyi.
// Di-debounce dan hanya dicatat kalau keadaannya benar-benar berubah: log cuma menyimpan 20 baris,
// dan pindah-pindah tab beberapa kali sudah cukup untuk mengusir baris-baris yang penting.
let visTimer = null, visLogged = null;
document.addEventListener('visibilitychange', () => {
  if (!running || !state) return;
  clearTimeout(visTimer);
  visTimer = setTimeout(() => {
    if (!running || !state || document.hidden === visLogged) return;
    visLogged = document.hidden;
    log(visLogged
      ? '👁️ Tab tersembunyi. Bot lanjut, tapi feed mungkin tidak memuat postingan baru.'
      : '👁️ Tab terlihat lagi.');
  }, 3000);
});

// Lanjutkan otomatis kalau tadi bot me-reload halaman ke Beranda
(async () => {
  const { resume } = await chrome.storage.local.get('resume');
  if (!resume) {
    // Tidak ada `resume` tapi state bilang masih jalan → sesi sebelumnya mati bersama halamannya
    // (tab dibuang Chrome, atau user reload sendiri). Jangan biarkan popup mengaku "Berjalan...".
    const { botState } = await chrome.storage.local.get('botState');
    if (botState?.running) {
      await chrome.storage.local.set({
        botState: { ...botState, running: false, reason: 'Halaman sempat dimuat ulang, bot berhenti' }
      });
    }
    return;
  }
  await chrome.storage.local.remove('resume');
  const fail = async (reason) => {
    const { botState } = await chrome.storage.local.get('botState');
    if (botState) await chrome.storage.local.set({ botState: { ...botState, running: false, reason } });
  };
  if (!(await waitFor(() => isHome() && getPosts().length, 15000))) return fail('Beranda tidak termuat setelah reload');
  await delay(2000);
  const res = await start(resume);
  if (!res.ok) await fail(res.error);
})();

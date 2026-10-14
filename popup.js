const $ = (id) => document.getElementById(id);
const THREADS_URL = /^https:\/\/(www\.)?threads\.(com|net)\//;

function setStatus(text, cls = '') {
  $('status').textContent = text;
  $('status').className = 'status ' + cls;
}

function lines(id) {
  return $(id).value.split('\n').map((s) => s.trim()).filter(Boolean);
}

function fillForm(s) {
  $('keywords').value = s.keywords.join('\n');
  $('comments').value = s.comments.join('\n');
  $('delayMin').value = s.delayMin;
  $('delayMax').value = s.delayMax;
  $('maxActions').value = s.maxActions;
  $('doFollow').checked = s.doFollow;
  $('doComment').checked = s.doComment;
  $('dryRun').checked = s.dryRun;
}

function readForm() {
  const min = Math.max(5, +$('delayMin').value || THREADS_BOT_DEFAULTS.delayMin);
  const max = Math.max(min, +$('delayMax').value || THREADS_BOT_DEFAULTS.delayMax);
  return {
    keywords: lines('keywords'),
    comments: lines('comments'),
    delayMin: min,
    delayMax: max,
    maxActions: Math.max(1, +$('maxActions').value || THREADS_BOT_DEFAULTS.maxActions),
    doFollow: $('doFollow').checked,
    doComment: $('doComment').checked,
    dryRun: $('dryRun').checked
  };
}

async function saveSettings() {
  const s = readForm();
  if (!s.keywords.length) throw new Error('Kata kunci tidak boleh kosong');
  if (s.doComment && !s.comments.length) throw new Error('Template komentar tidak boleh kosong');
  await chrome.storage.local.set({ settings: s });
  fillForm(s);
}

function renderState(st) {
  if (!st) return;
  for (const k of ['processed', 'followed', 'commented', 'skipped']) {
    $('s-' + k).textContent = st.stats?.[k] ?? 0;
  }
  $('logs').innerHTML = '';
  for (const l of st.logs || []) {
    const li = document.createElement('li');
    li.textContent = l;
    $('logs').appendChild(li);
  }
}

async function getThreadsTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && THREADS_URL.test(tab.url || '') ? tab : null;
}

async function send(type) {
  const tab = await getThreadsTab();
  if (!tab) throw new Error('Buka threads.com di tab ini dulu.');
  try {
    return await chrome.tabs.sendMessage(tab.id, { type });
  } catch {
    throw new Error('Bot belum aktif di tab ini. Refresh halaman Threads lalu coba lagi.');
  }
}

async function refreshRunning() {
  try {
    const res = await send('ping');
    $('start').disabled = res.running;
    $('stop').disabled = !res.running;
    if (res.running) setStatus('Berjalan...', 'running');
    return res.running;
  } catch (e) {
    $('start').disabled = false;
    $('stop').disabled = true;
    setStatus(e.message, 'error');
    return false;
  }
}

// Denyut nadi: `ping` cuma membuktikan content script-nya ADA, bukan bahwa loop-nya MAJU.
// Chrome bisa membuang tab background (Memory Saver) atau menahannya sampai nyaris diam, dan
// tanpa ini popup akan terus memasang "Berjalan..." padahal sudah tidak ada yang bekerja.
// Ambangnya longgar: bot berdenyut ~20 detik sekali, atau ~60 detik kalau timernya ditahan Chrome.
const STALE_MS = 3 * 60 * 1000;

async function checkAlive() {
  const { botState, heartbeat } = await chrome.storage.local.get(['botState', 'heartbeat']);
  if (!botState?.running || !heartbeat) return;
  const idle = Date.now() - heartbeat;
  if (idle < STALE_MS) return;
  const mins = Math.round(idle / 60000);
  setStatus(`Bot tidak merespons (${mins} menit terakhir diam). Refresh tab Threads.`, 'error');
  $('start').disabled = false;
  $('stop').disabled = true;
}

// popup adalah halaman aktif, jadi intervalnya tidak ditahan Chrome. Berhenti sendiri saat popup ditutup.
setInterval(checkAlive, 5000);

$('start').onclick = async () => {
  try {
    await saveSettings();
    const res = await send('start');
    if (!res.ok) return setStatus(res.error, 'error');
    setStatus('Berjalan...', 'running');
    $('start').disabled = true;
    $('stop').disabled = false;
  } catch (e) {
    setStatus(e.message, 'error');
  }
};

$('stop').onclick = async () => {
  try { await send('stop'); } catch (e) { setStatus(e.message, 'error'); }
};

$('save').onclick = async () => {
  try { await saveSettings(); setStatus('Pengaturan disimpan'); } catch (e) { setStatus(e.message, 'error'); }
};

$('resetDefaults').onclick = () => fillForm(THREADS_BOT_DEFAULTS);

$('resetHistory').onclick = async () => {
  await chrome.storage.local.remove('processed');
  setStatus('Riwayat postingan yang sudah diproses dihapus');
};

chrome.storage.onChanged.addListener((changes) => {
  if (!changes.botState) return;
  const st = changes.botState.newValue;
  renderState(st);
  if (st && !st.running) {
    setStatus('Berhenti: ' + (st.reason || '-'));
    $('start').disabled = false;
    $('stop').disabled = true;
  }
});

(async () => {
  const data = await chrome.storage.local.get(['settings', 'botState']);
  fillForm({ ...THREADS_BOT_DEFAULTS, ...(data.settings || {}) });
  renderState(data.botState);
  const isRunning = await refreshRunning();
  if (!isRunning && data.botState?.reason && $('status').className.trim() === 'status') {
    setStatus('Berhenti: ' + data.botState.reason);
  }
  await checkAlive();   // jangan tunggu interval pertama kalau tab-nya sudah lama diam
})();

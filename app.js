'use strict';

// ---- 設定（このスマホの localStorage だけに保存する） ----
const SETTINGS_KEY = 'walk-companion-settings';
const DEFAULTS = {
  apiKey: '',
  model: 'claude-opus-5-5',
  imageSize: 512,   // 長い辺のピクセル数
  rate: 1.0,        // 読み上げの速さ
  pitch: 1.0,       // 声の高さ
  voiceURI: '',     // 読み上げの声（空なら日本語の標準の声）
  savePhotos: true, // 撮った写真をスマホに保存する
  photoMode: 'manual',  // 'manual': ボタンで撮る / 'auto': カメラをつけたまま一定の間隔で撮る
  interval: 1,          // 自動のときの間隔（分）
  photoWithTalk: true,  // 自動のとき、話しかけたら今の景色も一緒に送る
  facing: 'environment',  // 使うカメラ。'environment': 外カメラ / 'user': 内カメラ（自撮り）
};

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    addLog('sys', '設定を保存できませんでした（プライベートモードかもしれません）');
  }
}

let settings = loadSettings();

// ---- 画面の部品 ----
const $ = (id) => document.getElementById(id);
const video = $('video');
const shot = $('shot');
const shotHint = $('shotHint');
const fileInput = $('fileInput');
const canvas = $('canvas');
const statusEl = $('status');
const usageEl = $('usage');
const logEl = $('log');
const photoBtn = $('photoBtn');
const talkBtn = $('talkBtn');
const dialog = $('settings');

function setStatus(text) {
  statusEl.textContent = text;
}

function addLog(kind, text) {
  const div = document.createElement('div');
  div.className = `msg ${kind}`;
  div.textContent = text;
  appendLog(div);
}

function appendLog(el) {
  logEl.appendChild(el);
  while (logEl.children.length > 60) logEl.firstChild.remove();
  logEl.scrollTop = logEl.scrollHeight;
}

// 撮った写真（Claude に送ったものと同じ大きさ）を会話の中に出す。押すと大きく表示
function addPhotoLog(photo) {
  const img = document.createElement('img');
  img.className = 'msg me photo';
  img.src = 'data:image/jpeg;base64,' + photo;
  img.alt = '撮った写真';
  img.addEventListener('click', () => {
    $('viewerImg').src = img.src;
    $('viewer').hidden = false;
  });
  img.addEventListener('load', () => (logEl.scrollTop = logEl.scrollHeight));
  appendLog(img);
}

$('viewer').addEventListener('click', () => ($('viewer').hidden = true));

// ---- カメラ ----
// 写真のモードは 2 つ。
// ・手動: 電池を減らさないように、「写真」ボタンを押したときだけスマホのカメラアプリを開く。
//         画面には最後に撮った写真だけを出す。
// ・自動: 「開始」を押すとカメラをつけたままにし、一定の間隔で今の景色を撮って送る。
//         話しかけたときも今の景色を一緒に送れる。「停止」でカメラを止める。

// 撮った写真を小さく縮めて JPEG の base64 にする（料金を抑えるため）
async function shrinkPhoto(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const { width: w, height: h } = bitmap;
  const scale = Math.min(1, settings.imageSize / Math.max(w, h));
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.6).split(',')[1];
}

// 元の大きさの写真をスマホの「ダウンロード」フォルダに保存する
function savePhoto(file) {
  const d = new Date();
  const p2 = (x) => String(x).padStart(2, '0');
  const name = `walk_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_` +
               `${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.jpg`;
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
}

let shotUrl = null;

function showShot(file) {
  if (shotUrl) URL.revokeObjectURL(shotUrl);
  shotUrl = URL.createObjectURL(file);
  shot.src = shotUrl;
  shot.hidden = autoRunning;  // 自動で撮っている間はカメラの映像を出す
  shotHint.hidden = true;
}

// ---- 内カメラ・外カメラの切り替え ----
const flipBtn = $('flipBtn');

function updateFlipUI() {
  const selfie = settings.facing === 'user';
  flipBtn.textContent = selfie ? '🔄 内カメラ（自撮り）' : '🔄 外カメラ';
  fileInput.setAttribute('capture', settings.facing);  // 「ボタンで撮る」で開くカメラ
}

flipBtn.addEventListener('click', async () => {
  settings.facing = settings.facing === 'user' ? 'environment' : 'user';
  saveSettings(settings);
  updateFlipUI();
  // 自動で撮影中なら、すぐにカメラを切り替える
  if (autoRunning) {
    stopCamera();
    try {
      await startCamera();
    } catch (e) {
      addLog('sys', 'カメラを切り替えられませんでした: ' + e.message);
    }
  }
});

// 写真の説明に、どちらのカメラで撮ったかを添える
function cameraNote() {
  return settings.facing === 'user' ? '内カメラ（自撮り）で' : '';
}

// ---- 自動モード ----
let autoRunning = false;
let autoTimer = null;

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: settings.facing },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
    audio: false,
  });
  video.srcObject = stream;
  video.classList.toggle('mirror', settings.facing === 'user');  // 内カメラは鏡のように見せる
  await video.play().catch(() => {});
}

function stopCamera() {
  video.srcObject?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
}

// 今のカメラの映像を 1 枚の写真（JPEG）にする
function captureFrame() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return Promise.resolve(null);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(video, 0, 0, w, h);
  return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.9));
}

// 撮った写真を画面に出し、設定に合わせて保存する
async function takeAutoPhoto() {
  const blob = await captureFrame();
  if (!blob) return null;
  showShot(blob);
  if (settings.savePhotos) savePhoto(blob);
  return blob;
}

function scheduleAuto() {
  clearTimeout(autoTimer);
  const minutes = Math.max(0.5, Number(settings.interval) || DEFAULTS.interval);
  autoTimer = setTimeout(async () => {
    if (!autoRunning) return;
    // 考え中・読み上げ中・こちらが話している途中・画面が隠れているときは今回は撮らない
    if (!busy && !speechSynthesis.speaking && !userSpeaking && !pendingText && !document.hidden) {
      const blob = await takeAutoPhoto();
      if (blob) await send('auto', null, blob);
    }
    if (autoRunning) scheduleAuto();
  }, minutes * 60 * 1000);
}

async function startAuto() {
  try {
    await startCamera();
  } catch (e) {
    addLog('sys', 'カメラを使えませんでした: ' + e.message);
    return;
  }
  autoRunning = true;
  video.hidden = false;
  shot.hidden = true;
  shotHint.hidden = true;
  updatePhotoUI();
  const blob = await takeAutoPhoto();
  if (blob) send('auto', null, blob);
  scheduleAuto();
}

function stopAuto() {
  autoRunning = false;
  clearTimeout(autoTimer);
  stopCamera();
  video.hidden = true;
  if (shotUrl) shot.hidden = false;
  else shotHint.hidden = false;
  updatePhotoUI();
}

// モードに合わせてボタンと案内の文字を変える
function updatePhotoUI() {
  if (settings.photoMode === 'auto') {
    photoBtn.textContent = autoRunning ? '■ 停止' : '▶ 開始';
    photoBtn.classList.toggle('primary', !autoRunning);
    photoBtn.classList.toggle('stop', autoRunning);
    shotHint.innerHTML = '「▶ 開始」を押すとカメラがつき、<br>' +
      `${settings.interval}分ごとに今の景色を撮って送ります。`;
  } else {
    photoBtn.textContent = '📷 写真';
    photoBtn.classList.add('primary');
    photoBtn.classList.remove('stop');
    shotHint.innerHTML = '「📷 写真」を押すとカメラが開きます。<br>撮った写真がここに出ます。';
  }
  if (!busy) setStatus(idleStatus());
}

// ---- 会話の記録 ----
// history: { role: 'user' | 'assistant', text } の並び。写真はそのとき撮った 1 枚だけ送る。
const RECENT_MESSAGES = 12;   // そのまま送る直前のやりとり（6 往復）
const OLD_TOPICS = 15;        // それより前の Claude の発言は話題メモとして短く送る
let history = [];

const SYSTEM_PROMPT = `あなたはユーザーと一緒に散歩している仲のいい友だちです。
ユーザーのスマホの背面カメラで撮った写真が届きます。ユーザーが気になったところで撮ることも、一定の間隔で自動で撮ることもあります。写っているものを見て、隣を歩いている友だちのように話しかけてください。
内カメラ（自撮り）で撮った写真のときは、ユーザー自身や一緒にいる人が写っています。そのときは、楽しそうな様子や身につけているもの、うしろに写っている景色などに軽く触れてください。
ユーザーが写真なしで声だけで話しかけてくることもあります。そのときは今の景色は見えていないので、それまでの会話の流れをふまえて答えてください。

話し方:
- 日本語の話し言葉で、1〜2文くらいの短さ。読み上げられるので、絵文字・記号・箇条書き・かっこ書きは使わない。
- 景色の中の具体的なもの（空、木、花、建物、看板、道、人や動物の気配など）に触れる。季節や時間帯の感じも自由に。
- それまでの会話とつながるように話す。ユーザーが話しかけてきたら、まずそれにちゃんと答える。
- 同じものの話、同じ言い回し、同じ感想をくり返さない。似た景色の写真が続いたら、別の細かいところに目を向けるか、ちょっとした雑談や質問をする。
- 写真がぶれていたり暗かったりしても、それを長々と説明しない。軽く触れるくらいにする。
- 安全第一。足元や車に気をつけてほしいときは、さりげなく声をかける。`;

function nowText() {
  const d = new Date();
  return `${d.getHours()}時${String(d.getMinutes()).padStart(2, '0')}分`;
}

function buildMessages(userText, photo) {
  const recent = history.slice(-RECENT_MESSAGES);
  const older = history.slice(0, -RECENT_MESSAGES)
    .filter((m) => m.role === 'assistant')
    .slice(-OLD_TOPICS)
    .map((m) => '・' + m.text.slice(0, 50));

  const messages = [];
  for (const m of recent) {
    // 最初はユーザーの発言から始める必要がある
    if (messages.length === 0 && m.role !== 'user') continue;
    messages.push({ role: m.role, content: m.text });
  }

  let text = userText;
  if (older.length) {
    text = `（もっと前にあなたが話したこと。くり返さないように）\n${older.join('\n')}\n\n${userText}`;
  }

  const content = [];
  if (photo) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: photo },
    });
  }
  content.push({ type: 'text', text });
  messages.push({ role: 'user', content });
  return messages;
}

// ---- Claude API ----
// 端末から直接呼ぶ。キーは設定画面で入力したものだけを使う。
async function callClaude(messages, useFallbacks = true) {
  const model = settings.model;
  const body = {
    model,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    output_config: { effort: 'low' },
    messages,
  };
  const headers = {
    'content-type': 'application/json',
    'x-api-key': settings.apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  // Opus / Sonnet は安全判定で断られたとき、別のモデルで自動的に答え直してもらう
  if (useFallbacks && !model.startsWith('claude-haiku')) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    if (res.status === 400 && useFallbacks && body.fallbacks && /fallback/i.test(msg)) {
      return callClaude(messages, false);
    }
    if (res.status === 401) throw new Error('API キーが正しくないようです。設定を確認してください。');
    if (res.status === 429) throw new Error('少し混み合っています。しばらく待ってからまた送ります。');
    throw new Error(msg);
  }

  addUsage(data.model || model, data.usage);
  if (data.stop_reason === 'refusal') {
    return 'ごめん、それにはうまく答えられないや。';
  }
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

// ---- 使ったトークンの表示 ----
// 1M トークンあたりの料金（ドル）。[入力, 出力]
const PRICES = {
  'claude-opus-5-5': [4, 20],
  'claude-sonnet-5-5': [2, 10],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-sonnet-5': [2, 10],
};
const YEN_PER_DOLLAR = 150;  // 円の目安
const USAGE_KEY = 'walk-companion-usage';

function loadTotal() {
  try {
    return { input: 0, output: 0, dollars: 0, ...JSON.parse(localStorage.getItem(USAGE_KEY) || '{}') };
  } catch {
    return { input: 0, output: 0, dollars: 0 };
  }
}

let usageTotal = loadTotal();
let usageLast = null;

function addUsage(model, usage) {
  if (!usage) return;
  // 入力はキャッシュに書いた分・読んだ分も含めて数える
  const input = (usage.input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0);
  const output = usage.output_tokens || 0;  // Claude が考えた分も含む
  const price = PRICES[model] || PRICES[settings.model] || [0, 0];
  const dollars = (input * price[0] + output * price[1]) / 1e6;
  usageLast = { input, output, dollars };
  usageTotal.input += input;
  usageTotal.output += output;
  usageTotal.dollars += dollars;
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify(usageTotal));
  } catch {
    // 保存できなくても表示は続ける
  }
  showUsage();
}

function yen(dollars) {
  const y = dollars * YEN_PER_DOLLAR;
  return y < 1 ? `約${y.toFixed(2)}円` : `約${y.toFixed(1)}円`;
}

function showUsage() {
  const n = (x) => x.toLocaleString('ja-JP');
  const last = usageLast
    ? `今回 入力${n(usageLast.input)}・出力${n(usageLast.output)}（${yen(usageLast.dollars)}）\n`
    : '';
  usageEl.textContent =
    `${last}合計 ${n(usageTotal.input + usageTotal.output)}トークン（${yen(usageTotal.dollars)}）`;
}

let busy = false;

async function send(kind, spokenText, file, alreadyLogged = false) {
  if (busy) return;
  if (!settings.apiKey) {
    addLog('sys', '設定画面で API キーを入力してください');
    openSettings();
    return;
  }
  busy = true;  // 写真を用意している間にほかの送信が始まらないように先に立てる
  // 声で話しかけたときは、自動モードで撮っている間だけ（設定がオンなら）今の景色も一緒に送る
  const said = kind === 'talk' || kind === 'text';  // 声か文字で話しかけた
  if (said && !file && autoRunning && settings.photoWithTalk) {
    file = await takeAutoPhoto().catch(() => null);
  }
  let photo = null;
  if (file) {
    try {
      photo = await shrinkPhoto(file);
    } catch (e) {
      addLog('sys', '写真を読み込めませんでした: ' + e.message);
      if (!said) {
        busy = false;
        return;
      }
    }
  }
  let userText;
  if (kind === 'photo') {
    userText = `（${nowText()}・${cameraNote()}撮った写真）`;
  } else if (kind === 'auto') {
    userText = `（${nowText()}・${cameraNote()}自動で撮った今の様子）`;
  } else {
    const how = kind === 'text' ? '文字で' : '声で';
    const pic = photo ? `${cameraNote()}撮った今の写真つき` : '写真なし';
    userText = `（${nowText()}・${pic}、${how}話しかけた）\n${spokenText}`;
  }
  if (photo) addPhotoLog(photo);
  if (said && !alreadyLogged) addLog('me', spokenText);

  photoBtn.disabled = settings.photoMode === 'manual';
  setStatus('Claude が考え中…');

  try {
    const reply = await callClaude(buildMessages(userText, photo));
    if (reply) {
      history.push({ role: 'user', text: userText });
      history.push({ role: 'assistant', text: reply });
      history = history.slice(-(RECENT_MESSAGES + OLD_TOPICS * 2));
      addLog('ai', reply);
      speak(reply);
    }
  } catch (e) {
    addLog('sys', 'エラー: ' + e.message);
  } finally {
    busy = false;
    photoBtn.disabled = false;
    setStatus(idleStatus());
    flushPending();
  }
}

// ---- 読み上げ ----
// 声はスマホに入っている読み上げの声を使う（Claude の API には声の機能がないため）
let voices = [];

function loadVoices() {
  const all = speechSynthesis.getVoices();
  // 日本語の声を先に、ほかの言語の声はうしろに並べる
  voices = [
    ...all.filter((v) => v.lang.toLowerCase().startsWith('ja')),
    ...all.filter((v) => !v.lang.toLowerCase().startsWith('ja')),
  ];
  if (dialog.open) fillVoiceList();
}

function currentVoice() {
  return voices.find((v) => v.voiceURI === settings.voiceURI) ||
         voices.find((v) => v.lang === 'ja-JP') ||
         voices.find((v) => v.lang.toLowerCase().startsWith('ja')) || null;
}

if ('speechSynthesis' in window) {
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
}

let speakingText = '';   // 読み上げ中（または直前に読み上げた）文
let lastSpokenEnd = 0;

function speak(text, opts = settings) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const voice = voices.find((v) => v.voiceURI === opts.voiceURI) || currentVoice();
  u.lang = voice?.lang || 'ja-JP';
  if (voice) u.voice = voice;
  u.rate = Number(opts.rate) || 1;
  u.pitch = Number(opts.pitch) || 1;
  u.onend = () => (lastSpokenEnd = Date.now());
  speakingText = text;
  speechSynthesis.speak(u);
}

// Android の Chrome はボタンを押したときに一度鳴らしておかないと、あとで読み上げないことがある
let speechUnlocked = false;
function unlockSpeech() {
  if (speechUnlocked || !('speechSynthesis' in window)) return;
  speechUnlocked = true;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  speechSynthesis.speak(u);
}

// ---- 写真ボタン ----
let wantWakeLock = false;

// 散歩中に画面が消えないようにする（ボタンを一度押したあとから）
async function keepScreenOn() {
  wantWakeLock = true;
  try {
    if ('wakeLock' in navigator) await navigator.wakeLock.request('screen');
  } catch {
    // 画面をつけたままにできなくても動作は続ける
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wantWakeLock) keepScreenOn();
});

photoBtn.addEventListener('click', () => {
  unlockSpeech();
  keepScreenOn();
  if (settings.photoMode === 'auto') {
    if (autoRunning) stopAuto();
    else startAuto();
    return;
  }
  if (busy) return;
  speechSynthesis.cancel();
  fileInput.value = '';
  fileInput.click();  // スマホのカメラが開く
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (!file) return;  // 撮らずに戻ったとき
  showShot(file);
  if (settings.savePhotos) savePhoto(file);
  send('photo', null, file);
});

shot.addEventListener('click', () => {
  $('viewerImg').src = shot.src;
  $('viewer').hidden = false;
});

// ---- 会話モード（音声認識） ----
// 「会話」をオンにすると、ずっと声を聞き続ける。話が途切れたところで Claude に送り、
// Claude の読み上げ中にこちらが話し始めたら、読み上げを止めて聞く。
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let recognizing = false;
let convo = false;
let pendingText = '';  // Claude が考えている間に話したこと
let pendingHow = 'talk';
let userSpeaking = false;  // こちらが話している途中か

function idleStatus() {
  const parts = [];
  if (autoRunning) parts.push(`自動で撮影中（${settings.interval}分ごと）`);
  if (convo) parts.push('会話中・聞いています');
  return parts.join('・') || '待機中';
}

// 記号や空白を除いて比べやすくする
function normalize(t) {
  return t.replace(/[\s、。！？!?,.・「」『』（）()…ー〜~]/g, '');
}

// スピーカーから出た Claude の声を、マイクが拾っただけかどうか
function isEcho(text) {
  const recent = speechSynthesis.speaking || Date.now() - lastSpokenEnd < 1500;
  if (!recent || !speakingText) return false;
  const heard = normalize(text);
  const spoken = normalize(speakingText);
  if (!heard) return true;
  if (spoken.includes(heard)) return true;
  // 2 文字ずつの組が、読み上げた文にどれだけ含まれるか
  let hit = 0;
  let total = 0;
  for (let i = 0; i < heard.length - 1; i++) {
    total++;
    if (spoken.includes(heard.slice(i, i + 2))) hit++;
  }
  return total > 0 && hit / total >= 0.6;
}

// how: 'talk'（声）か 'text'（文字）
function userSaid(text, how = 'talk') {
  addLog('me', text);
  if (busy) {
    pendingText = pendingText ? `${pendingText}\n${text}` : text;
    pendingHow = how;
    return;
  }
  send(how, text, null, true);
}

// Claude の返事が終わったあと、その間に話したことがあれば続けて送る
function flushPending() {
  if (!pendingText) return;
  const text = pendingText;
  pendingText = '';
  send(pendingHow, text, null, true);
}

function startRecognition() {
  if (!convo || recognizing || document.hidden) return;
  recognizer = new Recognition();
  recognizer.lang = 'ja-JP';
  recognizer.interimResults = true;
  recognizer.continuous = false;  // 話が途切れると終わるので、そのたびにまた始める
  recognizer.maxAlternatives = 1;

  recognizer.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const text = e.results[i][0].transcript.trim();
      if (!text || isEcho(text)) continue;
      // こちらが話し始めたら、Claude の読み上げを止める
      if (speechSynthesis.speaking) speechSynthesis.cancel();
      userSpeaking = !e.results[i].isFinal;
      if (e.results[i].isFinal) userSaid(text);
    }
  };
  recognizer.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      addLog('sys', 'マイクを使えません。Chrome の設定でマイクを許可してください');
      setConvo(false);
    }
    // no-speech（無言）などは、そのまま聞き直す
  };
  recognizer.onend = () => {
    recognizing = false;
    userSpeaking = false;
    if (convo) setTimeout(startRecognition, 250);
  };

  try {
    recognizer.start();
    recognizing = true;
  } catch (e) {
    recognizing = false;
    addLog('sys', '音声入力を始められませんでした: ' + e.message);
  }
}

function setConvo(on) {
  convo = on;
  talkBtn.textContent = on ? '■ 会話終了' : '🎤 会話';
  talkBtn.classList.toggle('listening', on);
  if (on) {
    startRecognition();
  } else {
    recognizer?.abort();
  }
  if (!busy) setStatus(idleStatus());
}

if (!Recognition) {
  talkBtn.disabled = true;
  talkBtn.title = 'このブラウザは音声入力に対応していません';
}

talkBtn.addEventListener('click', () => {
  if (!Recognition) return;
  unlockSpeech();
  keepScreenOn();
  setConvo(!convo);
});

// ---- 文字で送る（声を出せないとき用） ----
$('textForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('textInput');
  const text = input.value.trim();
  if (!text) return;
  unlockSpeech();
  keepScreenOn();
  speechSynthesis.cancel();
  input.value = '';
  input.blur();  // キーボードを閉じる
  userSaid(text, 'text');
});

// カメラアプリから戻ってきたら、また聞き始める
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') startRecognition();
});

// ---- 設定画面 ----
function openSettings() {
  $('apiKey').value = settings.apiKey;
  $('model').value = settings.model;
  $('imageSize').value = String(settings.imageSize);
  $('rate').value = settings.rate;
  $('pitch').value = settings.pitch;
  $('savePhotos').checked = settings.savePhotos;
  $('photoMode').value = settings.photoMode;
  $('interval').value = settings.interval;
  $('photoWithTalk').checked = settings.photoWithTalk;
  fillVoiceList();
  dialog.returnValue = '';
  dialog.showModal();
}

$('settingsBtn').addEventListener('click', openSettings);

function fillVoiceList() {
  const select = $('voice');
  const chosen = select.value || settings.voiceURI;
  select.textContent = '';
  select.add(new Option('自動（日本語の標準の声）', ''));
  for (const v of voices) {
    const ja = v.lang.toLowerCase().startsWith('ja');
    select.add(new Option(`${ja ? '' : '［日本語以外］'}${v.name}（${v.lang}）`, v.voiceURI));
  }
  select.value = voices.some((v) => v.voiceURI === chosen) ? chosen : '';
}

$('testVoice').addEventListener('click', () => {
  unlockSpeech();
  speak('こんにちは。今日もいっしょに歩こうね。', {
    voiceURI: $('voice').value,
    rate: $('rate').value,
    pitch: $('pitch').value,
  });
});

$('resetUsage').addEventListener('click', () => {
  usageTotal = { input: 0, output: 0, dollars: 0 };
  usageLast = null;
  try {
    localStorage.removeItem(USAGE_KEY);
  } catch {
    // 何もしない
  }
  showUsage();
  addLog('sys', 'トークンの合計をリセットしました');
});

dialog.addEventListener('close', () => {
  if (dialog.returnValue !== 'save') return;
  settings = {
    ...settings,  // 設定画面にない項目（使うカメラなど）はそのまま残す
    apiKey: $('apiKey').value.trim(),
    model: $('model').value,
    imageSize: Number($('imageSize').value) || DEFAULTS.imageSize,
    rate: Number($('rate').value) || DEFAULTS.rate,
    pitch: Number($('pitch').value) || DEFAULTS.pitch,
    voiceURI: $('voice').value,
    savePhotos: $('savePhotos').checked,
    photoMode: $('photoMode').value,
    interval: Math.max(0.5, Number($('interval').value) || DEFAULTS.interval),
    photoWithTalk: $('photoWithTalk').checked,
  };
  saveSettings(settings);
  // 手動に切り替えたら自動の撮影は止める。間隔を変えたら次の撮影から反映する
  if (autoRunning && settings.photoMode !== 'auto') stopAuto();
  else if (autoRunning) scheduleAuto();
  updatePhotoUI();
  addLog('sys', settings.photoMode === 'auto'
    ? `設定を保存しました（自動で撮る・${settings.interval}分ごと）`
    : '設定を保存しました（ボタンで撮る）');
});

$('clearHistory').addEventListener('click', () => {
  history = [];
  logEl.textContent = '';
  addLog('sys', '会話をリセットしました');
});

// ---- 起動 ----
showUsage();
updatePhotoUI();
updateFlipUI();
if (!settings.apiKey) {
  addLog('sys', '右下の ⚙ から API キーを入力してください');
}

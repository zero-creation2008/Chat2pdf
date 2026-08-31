/* ============================================================
   Chat2PDF — script.js
   100% client-side WhatsApp chat -> PDF converter
   ============================================================ */

/* ------------------------------------------------------------
   0. GLOBAL STATE
   ------------------------------------------------------------ */
const state = {
  zip: null,
  rawChatText: '',
  messages: [],          // parsed message objects, chronological
  mediaFiles: new Map(), // filename -> JSZip file object
  mediaBlobUrls: new Map(), // filename -> object URL (created lazily)
  participants: [],       // unique sender names in order of first appearance
  warnings: [],
  chatTitle: 'WhatsApp Chat',
  renderedCount: 0,       // how many messages currently rendered in preview (lazy load)
  pdfBlobUrl: null,
};

const PREVIEW_BATCH_SIZE = 40;

const SUPPORTED_IMAGE = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
const SUPPORTED_VIDEO = ['mp4', 'mov'];
const SUPPORTED_AUDIO = ['m4a', 'ogg', 'mp3', 'opus'];
const SUPPORTED_DOC = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'rar', 'txt'];

/* ------------------------------------------------------------
   1. DOM REFS
   ------------------------------------------------------------ */
const el = (id) => document.getElementById(id);

const screens = {
  home: el('screen-home'),
  processing: el('screen-processing'),
  workspace: el('screen-workspace'),
  generating: el('screen-generating'),
  done: el('screen-done'),
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

/* ------------------------------------------------------------
   2. HOME SCREEN — FILE INPUT / DRAG & DROP
   ------------------------------------------------------------ */
const dropzone = el('dropzone');
const fileInput = el('file-input');

el('btn-choose-zip').addEventListener('click', () => fileInput.click());
dropzone.addEventListener('click', (e) => {
  if (e.target.closest('#btn-choose-zip')) return;
  fileInput.click();
});
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') fileInput.click();
});

fileInput.addEventListener('change', () => {
  if (fileInput.files.length) handleZipFile(fileInput.files[0]);
});

['dragenter', 'dragover'].forEach(evt => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
});
['dragleave', 'drop'].forEach(evt => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  });
});
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) handleZipFile(file);
});

/* ------------------------------------------------------------
   3. PIPELINE ORCHESTRATION
   ------------------------------------------------------------ */
async function handleZipFile(file) {
  if (!file.name.toLowerCase().endsWith('.zip')) {
    alert('Please select a .zip file exported from WhatsApp.');
    return;
  }

  resetState();
  showScreen('processing');
  setProcessing('Extracting chat...', 0, '');

  try {
    await extractZip(file);
  } catch (err) {
    console.error(err);
    showScreen('home');
    alert('❌ WhatsApp chat file not found.');
    return;
  }

  setProcessing('Matching media...', 30, `${state.mediaFiles.size} media files found`);
  await sleep(50); // let UI paint

  setProcessing('Building conversation...', 55, `Parsing ${state.rawChatText.split('\n').length} lines`);
  parseChat(state.rawChatText);

  if (state.messages.length === 0) {
    showScreen('home');
    alert('❌ WhatsApp chat file not found or empty.');
    return;
  }

  setProcessing('Building conversation...', 85, `${state.messages.length} messages reconstructed`);
  await sleep(50);

  matchMediaToMessages();

  setProcessing('Building conversation...', 100, 'Done');
  await sleep(150);

  initWorkspace();
  showScreen('workspace');
}

function resetState() {
  state.zip = null;
  state.rawChatText = '';
  state.messages = [];
  state.mediaFiles = new Map();
  // revoke old blob urls to free memory
  state.mediaBlobUrls.forEach(url => URL.revokeObjectURL(url));
  state.mediaBlobUrls = new Map();
  state.participants = [];
  state.warnings = [];
  state.renderedCount = 0;
  if (state.pdfBlobUrl) {
    URL.revokeObjectURL(state.pdfBlobUrl);
    state.pdfBlobUrl = null;
  }
}

function setProcessing(step, pct, detail) {
  el('processing-step').textContent = step;
  el('progress-bar-fill').style.width = pct + '%';
  el('processing-detail').textContent = detail || '';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ------------------------------------------------------------
   4. ZIP EXTRACTION
   ------------------------------------------------------------ */
async function extractZip(file) {
  const zip = await JSZip.loadAsync(file);
  state.zip = zip;

  // Find _chat.txt (WhatsApp sometimes nests it, or names it differently per locale)
  let chatFile = null;
  zip.forEach((relPath, zipEntry) => {
    if (!zipEntry.dir && /(_chat|chat)\.txt$/i.test(zipEntry.name.split('/').pop())) {
      if (!chatFile) chatFile = zipEntry;
    }
  });

  if (!chatFile) {
    throw new Error('_chat.txt not found in ZIP');
  }

  state.rawChatText = await chatFile.async('string');

  // Index all other files as potential media, keyed by their base filename
  const mediaPromises = [];
  zip.forEach((relPath, zipEntry) => {
    if (zipEntry.dir) return;
    const baseName = zipEntry.name.split('/').pop();
    if (baseName === chatFile.name.split('/').pop()) return;
    state.mediaFiles.set(baseName, zipEntry);
  });
}

/* ------------------------------------------------------------
   5. CHAT PARSER
   ------------------------------------------------------------
   Handles common WhatsApp export line formats:
     "DD/MM/YYYY, HH:MM - Sender: Message"
     "DD/MM/YYYY, HH:MM:SS - Sender: Message"
     "[DD/MM/YYYY, HH:MM:SS] Sender: Message"   (iOS style)
     "MM/DD/YY, H:MM AM/PM - Sender: Message"
     System messages (no colon-delimited sender)
     Multi-line messages (continuation lines don't match the header regex)
   ------------------------------------------------------------ */

// Android style: "28/08/2026, 19:20 - Seron: message"  or  "8/28/26, 7:20 PM - Seron: message"
const RE_ANDROID = /^(\d{1,2}\/\d{1,2}\/\d{2,4}),\s(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp][Mm])?)\s-\s(.*)$/;

// iOS style: "[28/08/2026, 19:20:05] Seron: message"
const RE_IOS = /^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),\s(\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp][Mm])?)\]\s(.*)$/;

function parseChat(rawText) {
  // Normalize: strip BOM, normalize newlines, remove WhatsApp's invisible LRM/RLM marks
  let text = rawText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\u200e|\u200f/g, '');
  const lines = text.split('\n');

  const messages = [];
  let current = null;
  const seenSenders = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' && current === null) continue;

    let match = line.match(RE_ANDROID) || line.match(RE_IOS);

    if (match) {
      // push previous message
      if (current) messages.push(current);

      const [, dateStr, timeStr, rest] = match;
      const colonIdx = findSenderDelimiter(rest);

      let sender = null;
      let text = rest;
      let isSystem = true;

      if (colonIdx !== -1) {
        sender = rest.slice(0, colonIdx).trim();
        text = rest.slice(colonIdx + 1).trim();
        isSystem = false;
      }

      const timestamp = parseDateTime(dateStr, timeStr);

      current = {
        id: messages.length,
        sender: isSystem ? null : sender,
        isSystem,
        text: text,
        timestamp,
        dateStr,
        timeStr,
        media: null, // filled in during media matching
      };

      if (sender && !seenSenders.has(sender)) {
        seenSenders.add(sender);
        state.participants.push(sender);
      }
    } else {
      // continuation of previous message (multi-line)
      if (current) {
        current.text += (current.text ? '\n' : '') + line;
      } else {
        // orphan line before any timestamp matched — ignore/log
        if (line.trim() !== '') {
          state.warnings.push(`Skipped unrecognized line ${i + 1}`);
        }
      }
    }
  }
  if (current) messages.push(current);

  // re-id sequentially and sort by timestamp (should already be chronological, but be safe)
  messages.sort((a, b) => (a.timestamp?.getTime() || 0) - (b.timestamp?.getTime() || 0));
  messages.forEach((m, idx) => (m.id = idx));

  state.messages = messages;
}

// WhatsApp uses ": " to separate sender from message, but message text could
// itself contain a colon. We find the FIRST ": " occurrence which is safe
// because sender names cannot contain a colon in WhatsApp.
function findSenderDelimiter(rest) {
  const idx = rest.indexOf(': ');
  return idx;
}

function parseDateTime(dateStr, timeStr) {
  const dateParts = dateStr.split('/').map(s => parseInt(s, 10));
  let [d1, d2, yearRaw] = dateParts;
  let year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;

  // Ambiguous DD/MM vs MM/DD — WhatsApp locale dependent.
  // Heuristic: if first part > 12, it must be a day (DD/MM/YYYY).
  // Otherwise default to DD/MM/YYYY (most common WhatsApp export format worldwide).
  let day, month;
  if (d1 > 12) {
    day = d1; month = d2;
  } else if (d2 > 12) {
    month = d1; day = d2;
  } else {
    day = d1; month = d2; // default assumption
  }

  let hours = 0, minutes = 0, seconds = 0;
  const ampmMatch = timeStr.match(/([AaPp][Mm])$/);
  const timeCore = timeStr.replace(/\s?[AaPp][Mm]$/, '');
  const timeParts = timeCore.split(':').map(s => parseInt(s, 10));
  hours = timeParts[0] || 0;
  minutes = timeParts[1] || 0;
  seconds = timeParts[2] || 0;

  if (ampmMatch) {
    const isPM = ampmMatch[1].toLowerCase() === 'pm';
    if (isPM && hours < 12) hours += 12;
    if (!isPM && hours === 12) hours = 0;
  }

  const date = new Date(year, (month - 1), day, hours, minutes, seconds);
  return isNaN(date.getTime()) ? null : date;
}

/* ------------------------------------------------------------
   6. MEDIA MATCHING
   ------------------------------------------------------------
   WhatsApp messages that contain attached media reference the
   filename directly in the message text, e.g.:
     "IMG-20260828-WA0001.jpg (file attached)"
     "IMG-20260828-WA0001.jpg"
   We scan each message's text for a known filename token.
   ------------------------------------------------------------ */
const FILENAME_RE = /([\w\-. ]+\.(jpg|jpeg|png|webp|gif|mp4|mov|m4a|ogg|opus|mp3|pdf|docx?|xlsx?|pptx?|zip|rar))/i;
const ATTACHED_SUFFIX_RE = /\s*\(file attached\)\s*$/i;
const OMITTED_RE = /<Media omitted>|image omitted|video omitted|audio omitted|GIF omitted|sticker omitted|document omitted/i;

function matchMediaToMessages() {
  for (const msg of state.messages) {
    if (msg.isSystem) continue;

    const cleanedText = msg.text.replace(ATTACHED_SUFFIX_RE, '').trim();
    const fnMatch = cleanedText.match(FILENAME_RE);

    if (fnMatch) {
      const filename = fnMatch[1].trim();
      const ext = filename.split('.').pop().toLowerCase();
      const zipEntry = state.mediaFiles.get(filename);

      const caption = cleanedText.replace(fnMatch[1], '').trim();

      msg.media = {
        filename,
        ext,
        type: classifyExt(ext),
        found: !!zipEntry,
        zipEntry: zipEntry || null,
      };
      msg.text = caption; // remaining text (if any) becomes the caption
    } else if (OMITTED_RE.test(msg.text)) {
      // Media was referenced but not exported (common with "without media" exports)
      msg.media = {
        filename: null,
        ext: null,
        type: 'unknown',
        found: false,
        zipEntry: null,
        omitted: true,
      };
      msg.text = '';
    }
  }

  // Any zip media files never referenced by a message are logged as a warning,
  // not silently dropped and not force-appended (keeps chronological fidelity).
  const referenced = new Set(
    state.messages.filter(m => m.media && m.media.filename).map(m => m.media.filename)
  );
  const unreferenced = [...state.mediaFiles.keys()].filter(f => !referenced.has(f));
  if (unreferenced.length > 0) {
    state.warnings.push(`${unreferenced.length} media file(s) in the ZIP were not referenced by any message and were skipped.`);
  }
}

function classifyExt(ext) {
  if (SUPPORTED_IMAGE.includes(ext)) return 'image';
  if (SUPPORTED_VIDEO.includes(ext)) return 'video';
  if (SUPPORTED_AUDIO.includes(ext)) return 'audio';
  if (SUPPORTED_DOC.includes(ext)) return 'document';
  return 'unknown';
}

/* ------------------------------------------------------------
   7. WORKSPACE INIT (chat info + settings defaults)
   ------------------------------------------------------------ */
function initWorkspace() {
  const msgs = state.messages;
  const withTimestamps = msgs.filter(m => m.timestamp);
  const first = withTimestamps[0]?.timestamp;
  const last = withTimestamps[withTimestamps.length - 1]?.timestamp;

  const guessedTitle = state.participants.length === 1
    ? state.participants[0]
    : (state.participants.length === 2
        ? state.participants.join(' & ')
        : 'Group Chat');
  state.chatTitle = guessedTitle;

  el('info-chat-name').textContent = guessedTitle;
  el('info-msg-count').textContent = msgs.length.toLocaleString();
  el('info-participants').textContent = state.participants.length
    ? state.participants.join(', ')
    : '—';
  const mediaWithFile = msgs.filter(m => m.media && m.media.found).length;
  el('info-media-count').textContent = `${mediaWithFile} / ${state.mediaFiles.size}`;
  el('info-date-range').textContent = (first && last)
    ? `${formatDateShort(first)} – ${formatDateShort(last)}`
    : '—';

  el('setting-title').value = guessedTitle;

  // warnings
  const warningsBox = el('warnings-box');
  if (state.warnings.length) {
    warningsBox.hidden = false;
    warningsBox.innerHTML = state.warnings
      .slice(0, 20)
      .map(w => `<div>⚠️ ${escapeHtml(w)}</div>`)
      .join('');
  } else {
    warningsBox.hidden = true;
  }

  // reset + render preview
  state.renderedCount = 0;
  el('chat-preview').innerHTML = '';
  el('preview-count').textContent = `${msgs.length.toLocaleString()} messages`;
  renderNextPreviewBatch();
  setupInfiniteScroll();
}

function formatDateShort(date) {
  return date.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

/* ------------------------------------------------------------
   8. LIVE PREVIEW RENDERING (WhatsApp-style, lazy-loaded)
   ------------------------------------------------------------ */
const senderColorMap = new Map();
function getSenderColorClass(sender) {
  if (!senderColorMap.has(sender)) {
    senderColorMap.set(sender, senderColorMap.size % 6);
  }
  return `sender-color-${senderColorMap.get(sender)}`;
}

// determine "self" sender = first participant found (heuristic: usually the
// export owner's messages are the ones marked as "sent"/green in WhatsApp's
// own UI convention isn't preserved in the export, so we treat the FIRST
// participant to appear as the "left/received" reference and everyone else's
// messages relative to them — simplest convention: first participant = you).
function isSentBySelf(sender) {
  return sender === state.participants[0];
}

function renderNextPreviewBatch() {
  const container = el('chat-preview');
  const msgs = state.messages;
  const start = state.renderedCount;
  const end = Math.min(start + PREVIEW_BATCH_SIZE, msgs.length);
  if (start >= end) return;

  let lastDate = null;
  if (start > 0) {
    const prev = msgs[start - 1];
    lastDate = prev.timestamp ? dateKey(prev.timestamp) : null;
  }

  const frag = document.createDocumentFragment();

  for (let i = start; i < end; i++) {
    const msg = msgs[i];
    const currentDateKey = msg.timestamp ? dateKey(msg.timestamp) : null;

    if (currentDateKey && currentDateKey !== lastDate) {
      frag.appendChild(buildDateSeparator(msg.timestamp));
      lastDate = currentDateKey;
    }

    frag.appendChild(buildMessageEl(msg));
  }

  container.appendChild(frag);
  state.renderedCount = end;
  el('preview-count').textContent = `${msgs.length.toLocaleString()} messages — showing ${end.toLocaleString()}`;
}

function dateKey(d) { return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }

function buildDateSeparator(date) {
  const div = document.createElement('div');
  div.className = 'chat-date-sep';
  const span = document.createElement('span');
  span.textContent = formatDateShort(date);
  div.appendChild(span);
  return div;
}

function buildMessageEl(msg) {
  if (msg.isSystem) {
    const div = document.createElement('div');
    div.className = 'chat-system-msg';
    const span = document.createElement('span');
    span.textContent = msg.text;
    div.appendChild(span);
    return div;
  }

  const row = document.createElement('div');
  const sent = isSentBySelf(msg.sender);
  row.className = `chat-row ${sent ? 'sent' : 'received'}`;

  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';

  const showSenderNames = el('setting-sendernames').checked;
  const showTimestamps = el('setting-timestamps').checked;
  const showMedia = el('setting-media').checked;

  if (showSenderNames && !sent && state.participants.length > 2 && msg.sender) {
    const senderEl = document.createElement('div');
    senderEl.className = `bubble-sender ${getSenderColorClass(msg.sender)}`;
    senderEl.textContent = msg.sender;
    bubble.appendChild(senderEl);
  }

  if (msg.media && showMedia) {
    bubble.appendChild(buildMediaEl(msg.media));
  } else if (msg.media && msg.media.filename && !showMedia) {
    // media hidden by settings — show nothing extra
  }

  if (msg.text && msg.text.trim()) {
    const textEl = document.createElement('div');
    textEl.className = msg.media ? 'bubble-text bubble-caption' : 'bubble-text';
    textEl.textContent = msg.text;
    bubble.appendChild(textEl);
  }

  if (showTimestamps && msg.timestamp) {
    const meta = document.createElement('div');
    meta.className = 'bubble-meta';
    meta.textContent = msg.timestamp.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    bubble.appendChild(meta);
  }

  row.appendChild(bubble);
  return row;
}

function buildMediaEl(media) {
  if (media.omitted || !media.filename) {
    const div = document.createElement('div');
    div.className = 'media-unavailable';
    div.textContent = '⚠️ Media unavailable';
    return div;
  }

  if (!media.found) {
    const div = document.createElement('div');
    div.className = 'media-unavailable';
    div.textContent = `⚠️ Media unavailable — ${media.filename}`;
    return div;
  }

  if (media.type === 'image') {
    const wrap = document.createElement('div');
    wrap.className = 'bubble-image';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = media.filename;
    img.dataset.filename = media.filename; // resolved lazily via IntersectionObserver
    wrap.appendChild(img);
    lazyResolveImage(img, media);
    return wrap;
  }

  // video / audio / document -> attachment card
  const card = document.createElement('div');
  card.className = 'attach-card';

  const icon = document.createElement('div');
  icon.className = `attach-icon ${media.type === 'video' ? 'video' : media.type === 'audio' ? 'audio' : 'doc'}`;
  icon.textContent = media.type === 'video' ? '▶' : media.type === 'audio' ? '🎤' : '📄';
  card.appendChild(icon);

  const info = document.createElement('div');
  info.className = 'attach-info';
  const fn = document.createElement('div');
  fn.className = 'attach-filename';
  fn.textContent = media.filename;
  const sub = document.createElement('div');
  sub.className = 'attach-sub';
  sub.textContent = media.ext.toUpperCase();
  info.appendChild(fn);
  info.appendChild(sub);
  card.appendChild(info);

  return card;
}

// Resolve actual image bytes only when the <img> scrolls near the viewport,
// keeping memory bounded for very large chats.
const imageObserver = new IntersectionObserver((entries) => {
  entries.forEach(async (entry) => {
    if (!entry.isIntersecting) return;
    const img = entry.target;
    imageObserver.unobserve(img);
    const filename = img.dataset.filename;
    const url = await getMediaBlobUrl(filename);
    if (url) img.src = url;
  });
}, { root: null, rootMargin: '400px' });

function lazyResolveImage(img, media) {
  imageObserver.observe(img);
}

async function getMediaBlobUrl(filename) {
  if (state.mediaBlobUrls.has(filename)) return state.mediaBlobUrls.get(filename);
  const entry = state.mediaFiles.get(filename);
  if (!entry) return null;
  try {
    const blob = await entry.async('blob');
    const url = URL.createObjectURL(blob);
    state.mediaBlobUrls.set(filename, url);
    return url;
  } catch (err) {
    console.warn('Failed to load media', filename, err);
    return null;
  }
}

function setupInfiniteScroll() {
  const sentinel = el('preview-sentinel');
  const wrap = el('chat-preview-wrap');
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) renderNextPreviewBatch();
    });
  }, { root: wrap, rootMargin: '600px' });
  observer.observe(sentinel);
}

/* Re-render preview when relevant settings toggles change */
['setting-sendernames', 'setting-timestamps', 'setting-media'].forEach(id => {
  el(id).addEventListener('change', rerenderPreview);
});

function rerenderPreview() {
  const container = el('chat-preview');
  container.innerHTML = '';
  const renderedTarget = state.renderedCount || PREVIEW_BATCH_SIZE;
  state.renderedCount = 0;
  senderColorMap.clear();
  while (state.renderedCount < renderedTarget && state.renderedCount < state.messages.length) {
    renderNextPreviewBatch();
  }
}

/* ------------------------------------------------------------
   9. START OVER
   ------------------------------------------------------------ */
el('btn-start-over').addEventListener('click', () => {
  resetState();
  fileInput.value = '';
  showScreen('home');
});
el('btn-create-another').addEventListener('click', () => {
  resetState();
  fileInput.value = '';
  showScreen('home');
});

/* ------------------------------------------------------------
   10. PDF GENERATION
   ------------------------------------------------------------ */
el('btn-generate-pdf').addEventListener('click', generatePdf);

const FONT_SIZE_PT = { small: 9, medium: 10.5, large: 12 };
const SPACING_PX = { compact: 3, normal: 6, relaxed: 10 };
const IMG_QUALITY = { low: 0.5, medium: 0.75, high: 0.92 };
const IMG_MAX_DIM = { low: 480, medium: 720, high: 1080 };

async function generatePdf() {
  const settings = readSettings();
  showScreen('generating');
  setGenProgress('Building conversation...', 0, '');

  try {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({
      orientation: settings.orientation,
      unit: 'pt',
      format: settings.pageSize,
    });

    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 36;
    const contentW = pageW - margin * 2;
    const bottomLimit = pageH - margin - 16; // reserve space for page number

    let y = margin;
    let pageNum = 1;

    doc.setProperties({ title: settings.title || 'WhatsApp Chat Export' });

    // ---- Title page ----
    drawTitlePage(doc, settings, pageW, pageH);
    doc.addPage();
    pageNum++;
    y = margin;
    if (settings.pageNumbers) drawPageNumber(doc, pageNum, pageW, pageH);

    const total = state.messages.length;
    let lastDate = null;

    for (let i = 0; i < total; i++) {
      const msg = state.messages[i];

      if (i % 25 === 0 || i === total - 1) {
        const pct = 15 + Math.round((i / total) * 70);
        setGenProgress('Generating PDF...', pct, `Processing ${i + 1} / ${total} messages...`);
        await sleep(0); // yield to UI
      }

      // date separator
      if (msg.timestamp) {
        const dk = dateKey(msg.timestamp);
        if (dk !== lastDate) {
          y = ensureSpace(doc, y, 22, margin, bottomLimit, () => {
            pageNum++; if (settings.pageNumbers) drawPageNumber(doc, pageNum, pageW, pageH);
          });
          y = drawDateSeparatorPdf(doc, formatDateShort(msg.timestamp), y, pageW);
          lastDate = dk;
        }
      }

      if (msg.isSystem) {
        const h = estimateSystemHeight(doc, msg.text, contentW, settings);
        y = ensureSpace(doc, y, h, margin, bottomLimit, () => {
          pageNum++; if (settings.pageNumbers) drawPageNumber(doc, pageNum, pageW, pageH);
        });
        y = drawSystemMessagePdf(doc, msg.text, y, pageW, settings);
        continue;
      }

      // Skip media types excluded by settings (still show text/placeholder)
      let mediaToRender = msg.media;
      if (mediaToRender && !settings.showMedia) mediaToRender = null;
      if (mediaToRender && mediaToRender.type === 'video' && !settings.showVideos) mediaToRender = { ...mediaToRender, skip: true };
      if (mediaToRender && mediaToRender.type === 'audio' && !settings.showAudio) mediaToRender = { ...mediaToRender, skip: true };
      if (mediaToRender && mediaToRender.type === 'document' && !settings.showDocuments) mediaToRender = { ...mediaToRender, skip: true };

      const block = await buildMessageBlock(doc, msg, mediaToRender, contentW, settings);
      const blockH = block.height;

      y = ensureSpace(doc, y, blockH, margin, bottomLimit, () => {
        pageNum++; if (settings.pageNumbers) drawPageNumber(doc, pageNum, pageW, pageH);
      });

      drawMessageBlockPdf(doc, msg, block, y, pageW, margin, settings);
      y += blockH + SPACING_PX[settings.spacing];
    }

    setGenProgress('Generating PDF...', 92, 'Finalizing document...');
    await sleep(0);

    const blob = doc.output('blob');
    state.pdfBlobUrl = URL.createObjectURL(blob);

    setGenProgress('Generating PDF...', 100, 'Done');
    await sleep(150);

    el('btn-download').href = state.pdfBlobUrl;
    const safeName = (settings.title || 'whatsapp-chat').replace(/[^a-z0-9\-_ ]/gi, '').trim().replace(/\s+/g, '-') || 'whatsapp-chat';
    el('btn-download').download = `${safeName}.pdf`;
    el('done-summary').textContent = `${total.toLocaleString()} messages exported to a ${settings.pageSize.toUpperCase()} PDF.`;

    showScreen('done');
  } catch (err) {
    console.error(err);
    showScreen('workspace');
    alert('Something went wrong while generating the PDF. Please try again, or reduce image quality / message count if the chat is very large.');
  }
}

function readSettings() {
  return {
    title: el('setting-title').value.trim() || state.chatTitle,
    pageSize: el('setting-pagesize').value,
    orientation: el('setting-orientation').value,
    fontSize: el('setting-fontsize').value,
    spacing: el('setting-spacing').value,
    imgQuality: el('setting-imgquality').value,
    theme: el('setting-theme').value,
    showTimestamps: el('setting-timestamps').checked,
    showSenderNames: el('setting-sendernames').checked,
    showMedia: el('setting-media').checked,
    showVideos: el('setting-videos').checked,
    showAudio: el('setting-audio').checked,
    showDocuments: el('setting-documents').checked,
    pageNumbers: el('setting-pagenumbers').checked,
  };
}

function setGenProgress(step, pct, detail) {
  el('gen-step').textContent = step;
  el('gen-progress-fill').style.width = pct + '%';
  el('gen-detail').textContent = detail || '';
}

/* ---- PDF drawing helpers ---- */

function drawTitlePage(doc, settings, pageW, pageH) {
  const isDark = settings.theme === 'dark';
  if (isDark) {
    doc.setFillColor(17, 27, 33);
    doc.rect(0, 0, pageW, pageH, 'F');
  }
  doc.setFillColor(7, 94, 84);
  doc.rect(0, 0, pageW, 130, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(22);
  doc.setFont('helvetica', 'bold');
  doc.text('WhatsApp Chat Export', pageW / 2, 70, { align: 'center' });
  doc.setFontSize(12);
  doc.setFont('helvetica', 'normal');
  doc.text(`Chat: ${settings.title}`, pageW / 2, 95, { align: 'center' });

  doc.setTextColor(isDark ? 200 : 100, isDark ? 200 : 100, isDark ? 200 : 100);
  doc.setFontSize(10.5);
  const exportedStr = new Date().toLocaleDateString(undefined, { day: '2-digit', month: 'long', year: 'numeric' });
  doc.text(`Exported: ${exportedStr}`, pageW / 2, 160, { align: 'center' });
  doc.text(`${state.messages.length.toLocaleString()} messages`, pageW / 2, 178, { align: 'center' });
  if (state.participants.length) {
    doc.text(`Participants: ${state.participants.join(', ')}`, pageW / 2, 196, { align: 'center', maxWidth: pageW - 80 });
  }
}

function drawPageNumber(doc, pageNum, pageW, pageH) {
  doc.setFontSize(8.5);
  doc.setTextColor(140, 140, 140);
  doc.setFont('helvetica', 'normal');
  doc.text(String(pageNum), pageW / 2, pageH - 18, { align: 'center' });
}

function ensureSpace(doc, y, neededHeight, margin, bottomLimit, onNewPage) {
  if (y + neededHeight > bottomLimit) {
    doc.addPage();
    onNewPage();
    return margin;
  }
  return y;
}

function drawDateSeparatorPdf(doc, label, y, pageW) {
  doc.setFillColor(225, 240, 235);
  const w = doc.getTextWidth(label) + 20;
  const x = pageW / 2 - w / 2;
  doc.roundedRect(x, y, w, 16, 4, 4, 'F');
  doc.setFontSize(8.5);
  doc.setTextColor(84, 101, 111);
  doc.setFont('helvetica', 'bold');
  doc.text(label, pageW / 2, y + 11, { align: 'center' });
  return y + 26;
}

function estimateSystemHeight(doc, text, contentW, settings) {
  doc.setFontSize(8);
  const lines = doc.splitTextToSize(text, contentW * 0.7);
  return lines.length * 10 + 10;
}

function drawSystemMessagePdf(doc, text, y, pageW, settings) {
  doc.setFontSize(8);
  doc.setFont('helvetica', 'italic');
  doc.setTextColor(146, 64, 14);
  const lines = doc.splitTextToSize(text, pageW * 0.6);
  lines.forEach((line, idx) => {
    doc.text(line, pageW / 2, y + 8 + idx * 10, { align: 'center' });
  });
  return y + lines.length * 10 + 10;
}

// Precompute block content (wrapped text lines, image dims) before drawing,
// so we can measure height first and decide on page breaks.
async function buildMessageBlock(doc, msg, media, contentW, settings) {
  const fontSize = FONT_SIZE_PT[settings.fontSize];
  const bubbleMaxW = contentW * 0.72;
  const innerPad = 8;
  const textW = bubbleMaxW - innerPad * 2;

  doc.setFontSize(fontSize);
  doc.setFont('helvetica', 'normal');

  let height = innerPad; // top padding
  let senderLineH = 0;
  const showSender = settings.showSenderNames && state.participants.length > 2 && !isSentBySelf(msg.sender) && msg.sender;
  if (showSender) {
    senderLineH = fontSize + 3;
    height += senderLineH;
  }

  let imgData = null;
  let imgDrawW = 0, imgDrawH = 0;

  if (media && media.found && media.type === 'image' && !media.skip) {
    try {
      imgData = await loadImageForPdf(media.filename, settings);
      if (imgData) {
        const maxImgW = bubbleMaxW - innerPad * 2;
        const ratio = imgData.height / imgData.width;
        imgDrawW = Math.min(maxImgW, 220);
        imgDrawH = imgDrawW * ratio;
        if (imgDrawH > 260) { imgDrawH = 260; imgDrawW = imgDrawH / ratio; }
        height += imgDrawH + 6;
      }
    } catch (e) {
      imgData = null;
    }
  }

  let cardType = null;
  if (media && !media.skip && media.found && (media.type === 'video' || media.type === 'audio' || media.type === 'document')) {
    cardType = media.type;
    height += 34;
  }

  let unavailableLine = false;
  if (media && !media.skip && (!media.found || media.omitted)) {
    unavailableLine = true;
    height += 14;
  }

  const textLines = (msg.text && msg.text.trim()) ? doc.splitTextToSize(msg.text, textW) : [];
  const lineH = fontSize * 1.32;
  height += textLines.length * lineH;

  let metaH = 0;
  if (settings.showTimestamps && msg.timestamp) {
    metaH = 11;
    height += metaH;
  }

  height += innerPad; // bottom padding

  return {
    height, fontSize, bubbleMaxW, innerPad, textW, textLines, lineH,
    showSender, senderLineH, imgData, imgDrawW, imgDrawH, cardType, unavailableLine, metaH,
    media,
  };
}

function drawMessageBlockPdf(doc, msg, block, y, pageW, margin, settings) {
  const sent = isSentBySelf(msg.sender);
  const bubbleX = sent ? (pageW - margin - block.bubbleMaxW) : margin;
  const isDark = settings.theme === 'dark';

  // bubble background
  if (sent) {
    doc.setFillColor(220, 248, 198);
  } else {
    doc.setFillColor(isDark ? 32 : 255, isDark ? 44 : 255, isDark ? 48 : 255);
  }
  doc.roundedRect(bubbleX, y, block.bubbleMaxW, block.height, 5, 5, 'F');

  let cursorY = y + block.innerPad;
  const textX = bubbleX + block.innerPad;

  if (block.showSender) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(block.fontSize - 0.5);
    doc.setTextColor(...senderColorRgb(msg.sender));
    doc.text(msg.sender, textX, cursorY + block.fontSize * 0.8);
    cursorY += block.senderLineH;
  }

  if (block.imgData) {
    try {
      doc.addImage(block.imgData.dataUrl, block.imgData.format, textX, cursorY, block.imgDrawW, block.imgDrawH);
    } catch (e) { /* skip broken image */ }
    cursorY += block.imgDrawH + 6;
  }

  if (block.cardType) {
    drawAttachCardPdf(doc, block, textX, cursorY, block.media);
    cursorY += 34;
  }

  if (block.unavailableLine) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(block.fontSize - 1);
    doc.setTextColor(217, 119, 6);
    const label = block.media?.omitted ? '⚠ Media unavailable' : `⚠ Media unavailable — ${block.media?.filename || ''}`;
    doc.text(label, textX, cursorY + 9, { maxWidth: block.textW });
    cursorY += 14;
  }

  if (block.textLines.length) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(block.fontSize);
    doc.setTextColor(isDark ? 230 : 17, isDark ? 230 : 27, isDark ? 230 : 33);
    block.textLines.forEach((line, idx) => {
      doc.text(line, textX, cursorY + block.fontSize * 0.9 + idx * block.lineH);
    });
    cursorY += block.textLines.length * block.lineH;
  }

  if (block.metaH) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(134, 150, 160);
    const timeStr = msg.timestamp.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    doc.text(timeStr, bubbleX + block.bubbleMaxW - block.innerPad, cursorY + 7, { align: 'right' });
  }
}

function drawAttachCardPdf(doc, block, x, y, media) {
  const w = block.textW;
  doc.setFillColor(0, 0, 0, 0.04);
  doc.setDrawColor(230, 230, 230);
  doc.roundedRect(x, y, w, 28, 4, 4, 'FD');

  const iconColors = { video: [108, 142, 191], audio: [123, 160, 91], document: [176, 86, 76] };
  const c = iconColors[media.type] || [128, 128, 128];
  doc.setFillColor(...c);
  doc.circle(x + 14, y + 14, 9, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(9);
  const symbol = media.type === 'video' ? '>' : media.type === 'audio' ? '~' : 'D';
  doc.text(symbol, x + 14, y + 17, { align: 'center' });

  doc.setTextColor(17, 27, 33);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  const fnTrunc = truncateForWidth(doc, media.filename, w - 34);
  doc.text(fnTrunc, x + 30, y + 12);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(102, 119, 129);
  doc.text(media.ext.toUpperCase(), x + 30, y + 22);
}

function truncateForWidth(doc, text, maxW) {
  if (doc.getTextWidth(text) <= maxW) return text;
  let t = text;
  while (t.length > 3 && doc.getTextWidth(t + '…') > maxW) {
    t = t.slice(0, -1);
  }
  return t + '…';
}

function senderColorRgb(sender) {
  const palette = [
    [225, 112, 118], [123, 160, 91], [108, 142, 191],
    [181, 137, 214], [209, 154, 102], [79, 163, 166],
  ];
  const idx = getSenderColorClass(sender).split('-').pop();
  return palette[Number(idx) % palette.length];
}

// Load + downscale/compress image from the zip for embedding into the PDF.
const pdfImageCache = new Map();
async function loadImageForPdf(filename, settings) {
  const cacheKey = filename + '|' + settings.imgQuality;
  if (pdfImageCache.has(cacheKey)) return pdfImageCache.get(cacheKey);

  const entry = state.mediaFiles.get(filename);
  if (!entry) return null;

  const blob = await entry.async('blob');
  const bitmap = await createImageBitmapSafe(blob);
  if (!bitmap) return null;

  const maxDim = IMG_MAX_DIM[settings.imgQuality];
  let { width, height } = bitmap;
  if (width > maxDim || height > maxDim) {
    const scale = maxDim / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);

  const format = 'JPEG';
  const dataUrl = canvas.toDataURL('image/jpeg', IMG_QUALITY[settings.imgQuality]);

  const result = { dataUrl, format, width, height };
  pdfImageCache.set(cacheKey, result);
  return result;
}

async function createImageBitmapSafe(blob) {
  try {
    return await createImageBitmap(blob);
  } catch (e) {
    // Fallback for formats createImageBitmap can't handle in some browsers
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => { resolve(img); URL.revokeObjectURL(url); };
      img.onerror = () => { resolve(null); URL.revokeObjectURL(url); };
      img.src = url;
    });
  }
}

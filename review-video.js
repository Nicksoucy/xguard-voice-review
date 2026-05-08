/**
 * review-video.js — Logique de la review video.
 *
 * Pattern miroir de review.js mais pour videos MP4 :
 * - Charge la lecon depuis Supabase REST
 * - Verifie que voice = approved (sinon affiche banner + bloque)
 * - Charge video_metadata, set vid.src
 * - Charge video_reviews existant (flags)
 * - Permet add/delete/jump-to flag, save, approve, reject
 */

var SUPA_URL = 'https://ctjsdpfegpsfpwjgusyi.supabase.co';
var SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0anNkcGZlZ3BzZnB3amd1c3lpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MDU2NDQsImV4cCI6MjA4OTE4MTY0NH0.Uv2pbxbmvcbXhyDa7Y_M0HqkLuV7uJaNxl1N01q5wMo';
var STORAGE = SUPA_URL + '/storage/v1/object/public/videos';
var API = SUPA_URL + '/rest/v1';
var H = {apikey:SUPA_KEY, Authorization:'Bearer '+SUPA_KEY};

var params = new URLSearchParams(location.search);
var lessonKey = params.get('key') || '';

// Etat global
var L = null;          // lesson row
var VM = null;         // video_metadata row
var VOICE_STATUS = null; // 'approved' | autres
var flags = [];        // array de flag objects
var vid = null;        // <video> element
var saveTimer = null;
var dirty = false;
var addFlagTimestamp = 0;

// Categories de flags video (centralisees)
var FLAG_CATEGORIES = {
  visual:           {label:'Visuel',     emoji:'👀'},
  audio_sync:       {label:'Audio sync', emoji:'🔊'},
  transition:       {label:'Transition', emoji:'⚡'},
  text_cut:         {label:'Texte coupe',emoji:'✂'},
  animation_jitter: {label:'Animation',  emoji:'📺'},
  typo:             {label:'Typo',       emoji:'✏'},
  other:            {label:'Autre',      emoji:'❓'}
};

// Utils
function fmtTime(s) {
  if (!s || isNaN(s)) return '0:00';
  var m = Math.floor(s/60), sec = Math.floor(s%60);
  return m + ':' + (sec < 10 ? '0' : '') + sec;
}
function fmtDate(iso) {
  if (!iso) return '';
  var d = new Date(iso);
  return d.toLocaleDateString('fr-CA', {day:'numeric', month:'short', year:'numeric'}) + ', ' +
         d.toLocaleTimeString('fr-CA', {hour:'2-digit', minute:'2-digit'});
}
function genId() { return 'f_' + Math.random().toString(36).slice(2, 8); }

// === Resolve lesson ===
function resolveLesson(cb) {
  if (!lessonKey) { cb(null); return; }
  fetch(API+'/lessons?lesson_key=eq.'+encodeURIComponent(lessonKey)+'&select=*', {headers:H})
    .then(function(r){return r.json()})
    .then(function(rows){ cb(rows[0] || null) })
    .catch(function(){ cb(null) });
}

// === Resolve voice status (gating) ===
function resolveVoiceStatus(cb) {
  fetch(API+'/lesson_status?lesson_key=eq.'+encodeURIComponent(lessonKey)+'&select=status', {headers:H})
    .then(function(r){return r.json()})
    .then(function(rows){
      cb(rows[0] ? rows[0].status : null);
    })
    .catch(function(){ cb(null) });
}

// === Resolve video metadata ===
function resolveVideoMetadata(cb) {
  fetch(API+'/video_metadata?lesson_key=eq.'+encodeURIComponent(lessonKey)+'&select=*', {headers:H})
    .then(function(r){return r.json()})
    .then(function(rows){ cb(rows[0] || null) })
    .catch(function(){ cb(null) });
}

// === Init ===
resolveLesson(function(lesson) {
  if (!lesson) {
    document.body.innerHTML = '<a href="index.html" style="color:#94A3B8">&larr; Retour</a><div class="err" style="color:#E74C3C;padding:20px">Lecon introuvable.</div>';
    return;
  }
  L = lesson;

  // Titre avec numero de sous-lecon
  var baseTitle = L.short_title || L.title;
  var lessonIdx = parseFloat(L.lesson_index);
  if (lessonIdx && lessonIdx !== Math.floor(lessonIdx)) {
    var subNum = lessonIdx.toFixed(1);
    if (baseTitle.match(/^M\d+\s*\/\s*/)) {
      baseTitle = baseTitle.replace(/^(M\d+\s*\/)\s*/, '$1 ' + subNum + ' — ');
    }
  }
  document.getElementById('title').textContent = '🎬 ' + baseTitle;

  // Nav
  document.getElementById('nav').innerHTML =
    '<a href="course.html?course='+encodeURIComponent(L.course_id)+'">← Cours</a>' +
    '<a href="review.html?key='+encodeURIComponent(L.lesson_key)+'">🎙 Voice</a>' +
    '<a href="index.html">Index</a>';

  // Verifier voice status
  resolveVoiceStatus(function(voiceStatus) {
    VOICE_STATUS = voiceStatus;
    if (voiceStatus !== 'approved') {
      // Afficher banner blocage
      var banner = document.getElementById('voice-not-approved-banner');
      banner.classList.remove('hidden');
      document.getElementById('back-to-voice-link').href = 'review.html?key=' + encodeURIComponent(L.lesson_key);
      return; // bloque la suite
    }
    // Voice OK → continuer avec video metadata
    resolveVideoMetadata(function(vm) {
      VM = vm;
      if (!vm) {
        document.getElementById('no-video-banner').classList.remove('hidden');
        return;
      }
      initVideoPlayer();
      loadExistingReview();
      loadHistory();
    });
  });
});

function initVideoPlayer() {
  vid = document.getElementById('vid');
  // Build URL : VM.video_path peut etre soit absolu soit relatif au bucket
  var videoUrl = VM.video_path.indexOf('http') === 0
    ? VM.video_path
    : STORAGE + '/' + VM.video_path.replace(/^videos\//, '') + '?v=' + encodeURIComponent(VM.produced_at || Date.now());
  vid.src = videoUrl;

  vid.addEventListener('loadedmetadata', function() {
    document.getElementById('video-controls').classList.add('ready');
    document.getElementById('flags-panel').classList.add('ready');
    renderInfoBar();
    updateTimeDisplay();
    renderMarkers();
  });
  vid.addEventListener('timeupdate', function() {
    updateTimeDisplay();
    var p = (vid.currentTime / vid.duration) * 100;
    document.getElementById('timeline-progress').style.width = p + '%';
  });
  vid.addEventListener('error', function() {
    document.getElementById('video-wrapper').innerHTML =
      '<div style="color:#E74C3C;padding:40px;text-align:center;font-size:13px">Impossible de charger la video.<br><small>' + (videoUrl) + '</small></div>';
  });
}

function renderInfoBar() {
  var bar = document.getElementById('info-bar');
  var parts = [];
  parts.push('<strong>Version ' + (VM.version || 1) + '</strong>');
  if (VM.produced_at) parts.push('Produite : <strong>' + fmtDate(VM.produced_at) + '</strong>');
  if (VM.duration_seconds) parts.push('Duree : <strong>' + fmtTime(VM.duration_seconds) + '</strong>');
  if (VM.produced_by) parts.push('Source : <strong>' + VM.produced_by + '</strong>');
  parts.push('Voice : <strong style="color:#27AE60">✓ Approuve</strong>');
  bar.innerHTML = parts.join('<span class="sep">·</span>');
  bar.style.display = 'flex';
}

function updateTimeDisplay() {
  if (!vid) return;
  document.getElementById('time-display').textContent = fmtTime(vid.currentTime) + ' / ' + fmtTime(vid.duration);
}

// === Player controls ===
function seekTimeline(event) {
  if (!vid || !vid.duration) return;
  var rect = event.currentTarget.getBoundingClientRect();
  var x = (event.clientX - rect.left) / rect.width;
  vid.currentTime = x * vid.duration;
}
function seekRel(delta) {
  if (!vid) return;
  vid.currentTime = Math.max(0, Math.min(vid.duration || 0, vid.currentTime + delta));
}
function togglePlay() {
  if (!vid) return;
  if (vid.paused) vid.play(); else vid.pause();
}

// === Markers (timeline visuelle) ===
function renderMarkers() {
  var container = document.getElementById('timeline-markers');
  if (!vid || !vid.duration) { container.innerHTML = ''; return; }
  var html = '';
  flags.forEach(function(f) {
    var pct = (f.time / vid.duration) * 100;
    var cls = 'timeline-marker' + (f.severity === 'minor' ? ' minor' : '');
    html += '<div class="' + cls + '" style="left:' + pct + '%" data-flag-id="' + f.id + '" title="' + (f.note || FLAG_CATEGORIES[f.category].label) + '" onclick="jumpToFlag(\'' + f.id + '\')"></div>';
  });
  container.innerHTML = html;
}

// === Flags ===
function openAddFlagModal() {
  if (!vid) return;
  vid.pause();
  addFlagTimestamp = vid.currentTime;
  document.getElementById('addflag-time').textContent = fmtTime(addFlagTimestamp);
  document.getElementById('addflag-note').value = '';
  // Reset radios
  document.querySelectorAll('input[name="flagCat"]').forEach(function(r) { r.checked = false; });
  document.querySelectorAll('input[name="flagSev"]').forEach(function(r) { r.checked = (r.value === 'blocker'); });
  document.getElementById('addflag-msg').textContent = '';
  document.getElementById('addflag-modal-bg').classList.add('open');
}
function closeAddFlagModal() {
  document.getElementById('addflag-modal-bg').classList.remove('open');
}
function submitFlag() {
  var catEl = document.querySelector('input[name="flagCat"]:checked');
  if (!catEl) {
    document.getElementById('addflag-msg').textContent = 'Choisis une categorie.';
    document.getElementById('addflag-msg').style.color = '#E74C3C';
    return;
  }
  var sevEl = document.querySelector('input[name="flagSev"]:checked');
  flags.push({
    id: genId(),
    time: addFlagTimestamp,
    category: catEl.value,
    severity: sevEl ? sevEl.value : 'blocker',
    note: document.getElementById('addflag-note').value.trim(),
    created_at: new Date().toISOString()
  });
  // Sort by time
  flags.sort(function(a,b){ return a.time - b.time; });
  closeAddFlagModal();
  renderMarkers();
  renderFlagsList();
  scheduleAutoSave();
}
function deleteFlag(id) {
  flags = flags.filter(function(f){ return f.id !== id; });
  renderMarkers();
  renderFlagsList();
  scheduleAutoSave();
}
function jumpToFlag(id) {
  var f = flags.find(function(f){ return f.id === id; });
  if (!f || !vid) return;
  vid.currentTime = f.time;
  vid.pause();
}

function renderFlagsList() {
  var container = document.getElementById('flags-list');
  document.getElementById('flags-section-title').innerHTML = '🚩 Issues flaggees (' + flags.length + ')';
  if (flags.length === 0) {
    container.innerHTML = '<div class="empty">Clique sur "ADD FLAG ICI" pendant la lecture pour signaler un probleme.</div>';
    return;
  }
  var html = '';
  flags.forEach(function(f) {
    var cat = FLAG_CATEGORIES[f.category] || {label:f.category, emoji:'❓'};
    var rowCls = 'flag-row' + (f.severity === 'minor' ? ' minor' : '');
    html += '<div class="' + rowCls + '" onclick="jumpToFlag(\'' + f.id + '\')">' +
      '<span class="flag-time">' + fmtTime(f.time) + '</span>' +
      '<span class="flag-cat-pill">' + cat.emoji + ' ' + cat.label + '</span>' +
      '<span class="flag-note">' + (f.note ? escapeHtml(f.note) : '<em style="color:#555">aucune note</em>') + '</span>' +
      '<button class="flag-delete" onclick="event.stopPropagation();deleteFlag(\'' + f.id + '\')" title="Supprimer">&times;</button>' +
      '</div>';
  });
  container.innerHTML = html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

// === Load existing review ===
function loadExistingReview() {
  var rn = (localStorage.getItem('rn') || 'Anonyme').trim();
  fetch(API+'/video_reviews?lesson_key=eq.'+encodeURIComponent(L.lesson_key)+'&reviewer_name=eq.'+encodeURIComponent(rn)+'&select=*', {headers:H})
    .then(function(r){return r.json()})
    .then(function(rows){
      if (rows && rows[0]) {
        flags = (rows[0].flags || []).slice();
        flags.sort(function(a,b){ return a.time - b.time; });
        if (rows[0].approved) {
          var banner = document.getElementById('approved-banner');
          banner.innerHTML = '<strong>✓ Cette video est deja approuvee</strong><br>Approuvee par <strong>' + escapeHtml(rn) + '</strong> le <strong>' + fmtDate(rows[0].updated_at) + '</strong>';
          banner.classList.remove('hidden');
        }
        if (rows[0].rejected) {
          var banner2 = document.getElementById('recheck-banner');
          banner2.innerHTML = '<strong>✗ Cette video a ete rejetee</strong><br>' + (rows[0].reject_reason ? '<em>"' + escapeHtml(rows[0].reject_reason) + '"</em>' : '');
          banner2.classList.remove('hidden');
        }
      }
      renderFlagsList();
      renderMarkers();
    })
    .catch(function(){
      renderFlagsList();
    });
}

// === Save review ===
function scheduleAutoSave() {
  dirty = true;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(function(){ saveReview(false, false, true); }, 2000);
}

function saveReview(approved, rejected, isAuto, rejectReason) {
  if (!L) return;
  var rn = (localStorage.getItem('rn') || 'Anonyme').trim();
  if (!rn || rn === 'Anonyme') {
    rn = prompt('Ton prenom (sera affiche dans la review) :', '') || 'Anonyme';
    localStorage.setItem('rn', rn);
  }

  var body = {
    lesson_key: L.lesson_key,
    course_id: L.course_id,
    lesson_id: L.lesson_id || L.lesson_slug,
    lesson_title: L.title,
    reviewer_name: rn,
    flags: flags,
    approved: !!approved,
    rejected: !!rejected,
    reject_reason: rejectReason || null,
    video_version: VM ? VM.version : null,
    updated_at: new Date().toISOString()
  };

  fetch(API+'/video_reviews?on_conflict=lesson_key,reviewer_name', {
    method: 'POST',
    headers: Object.assign({}, H, {
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    }),
    body: JSON.stringify(body)
  })
  .then(function(r){
    if (r.ok || r.status === 201 || r.status === 204) {
      dirty = false;
      var msg = document.getElementById('msg');
      if (msg) {
        msg.textContent = isAuto ? '✓ Auto-sauvegarde' : '✓ Sauvegarde';
        msg.style.color = '#27AE60';
        setTimeout(function(){ msg.textContent = ''; }, 2000);
      }
    } else {
      console.error('Save failed:', r.status);
      var msg2 = document.getElementById('msg');
      if (msg2) {
        msg2.textContent = '✗ Erreur sauvegarde';
        msg2.style.color = '#E74C3C';
      }
    }
  })
  .catch(function(e){
    console.error('Save error:', e);
  });
}

// === Approve / Reject modals ===
function askApprove() {
  document.getElementById('approve-modal-bg').classList.add('open');
}
function closeApproveModal() {
  document.getElementById('approve-modal-bg').classList.remove('open');
}
function confirmApprove() {
  saveReview(true, false, false);
  closeApproveModal();
  setTimeout(function(){ location.reload(); }, 800);
}
function askReject() {
  document.getElementById('reject-reason').value = '';
  document.getElementById('reject-modal-bg').classList.add('open');
}
function closeRejectModal() {
  document.getElementById('reject-modal-bg').classList.remove('open');
}
function confirmReject() {
  var reason = document.getElementById('reject-reason').value.trim();
  if (!reason) {
    alert('Donne une raison globale.');
    return;
  }
  saveReview(false, true, false, reason);
  closeRejectModal();
  setTimeout(function(){ location.reload(); }, 800);
}

// === Copy review (text) ===
function copyReview() {
  if (!flags.length) {
    var msg = document.getElementById('msg');
    msg.textContent = 'Aucun flag a copier.';
    msg.style.color = '#94A3B8';
    return;
  }
  var lines = ['VIDEO REVIEW : ' + (L.short_title || L.title) + ' (v' + (VM.version||1) + ')', ''];
  flags.forEach(function(f){
    var cat = FLAG_CATEGORIES[f.category] || {label:f.category, emoji:''};
    lines.push('[' + fmtTime(f.time) + '] ' + cat.emoji + ' ' + cat.label + (f.severity==='minor'?' (mineur)':'') + (f.note ? ' — ' + f.note : ''));
  });
  navigator.clipboard.writeText(lines.join('\n')).then(function(){
    var msg = document.getElementById('msg');
    msg.textContent = '✓ Copie dans le presse-papier';
    msg.style.color = '#27AE60';
    setTimeout(function(){ msg.textContent = ''; }, 2000);
  });
}

// === Load history ===
function loadHistory() {
  fetch(API+'/video_review_history?lesson_key=eq.'+encodeURIComponent(L.lesson_key)+'&order=archived_at.desc&select=*', {headers:H})
    .then(function(r){return r.json()})
    .then(function(rows){
      if (!rows || rows.length === 0) return;
      var panel = document.getElementById('history-panel');
      var list = document.getElementById('history-list');
      document.getElementById('history-title').textContent = 'Historique (' + rows.length + ' revisions archivees)';
      list.innerHTML = rows.map(function(r){
        return '<div class="history-row">' +
          '<strong>v' + (r.video_version||1) + '</strong> — ' + fmtDate(r.archived_at) +
          ' — ' + (r.flags ? r.flags.length : 0) + ' flags' +
          (r.approved ? ' <span style="color:#27AE60">✓</span>' : '') +
          (r.rejected ? ' <span style="color:#E74C3C">✗</span>' : '') +
          '</div>';
      }).join('');
      panel.classList.remove('hidden');
    })
    .catch(function(){});
}

// === Keyboard shortcuts ===
document.addEventListener('keydown', function(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  // Ctrl+S = save
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveReview(false, false, false);
    return;
  }
  // Ne pas trigger si modal ouverte
  if (document.querySelector('.modal-bg.open')) return;

  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); openAddFlagModal(); }
  else if (e.key === 'j' || e.key === 'J') { seekRel(-10); }
  else if (e.key === 'k' || e.key === 'K') { seekRel(10); }
});

// Modal close on backdrop click
['addflag-modal-bg', 'approve-modal-bg', 'reject-modal-bg'].forEach(function(id){
  var el = document.getElementById(id);
  if (el) el.addEventListener('click', function(e){
    if (e.target === el) el.classList.remove('open');
  });
});

// Beforeunload : warn si dirty
window.addEventListener('beforeunload', function(e){
  if (dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

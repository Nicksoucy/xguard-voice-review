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

// Credentials Supabase : prod par defaut, override par sentry-init.js si staging
var SUPA_URL = window.SUPA_URL_OVERRIDE || 'https://ctjsdpfegpsfpwjgusyi.supabase.co';
var SUPA_KEY = window.SUPA_KEY_OVERRIDE || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0anNkcGZlZ3BzZnB3amd1c3lpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MDU2NDQsImV4cCI6MjA4OTE4MTY0NH0.Uv2pbxbmvcbXhyDa7Y_M0HqkLuV7uJaNxl1N01q5wMo';
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
// Verdict de la reviseuse sur la version COURANTE (chantier 03, 2026-11-10). Avant, chaque
// autosauvegarde ecrivait approved=false, rejected=false, reject_reason=null : ajouter un
// flag apres un rejet ANNULAIT le rejet. Le verdict vit maintenant ici, il est relu au
// chargement et renvoye tel quel a chaque sauvegarde. Seul « J'ai fini cette video » le change.
var verdict = { approved: false, rejected: false, reason: null };

// Defauts video (correctif 8, chantier 03) : des defauts CONCRETS, que l'equipe sait
// corriger. Les anciennes cles (visual, transition, animation_jitter) restent pour afficher
// les flags deja poses, mais ne sont plus proposees.
var FLAG_CATEGORIES = {
  text_overlap:          {label:'Texte par-dessus un autre texte', emoji:'🔤'},
  text_cut:              {label:'Texte coupé ou qui déborde',      emoji:'✂'},
  typo:                  {label:'Faute à l’écran',                 emoji:'✏'},
  screen_voice_mismatch: {label:'L’écran ne dit pas la même chose que la voix', emoji:'↔'},
  number_sync:           {label:'Numéro qui ne suit pas la voix',  emoji:'🔢'},
  audio_sync:            {label:'Écran en retard sur la voix',     emoji:'⏱'},
  frozen_screen:         {label:'Écran vide ou figé',              emoji:'⏸'},
  wrong_image:           {label:'Mauvaise image',                  emoji:'🖼'},
  other:                 {label:'Autre',                           emoji:'❓'},
  // Anciennes cles (affichage seulement)
  visual:                {label:'Visuel (ancien)',                 emoji:'👀'},
  transition:            {label:'Transition (ancien)',             emoji:'⚡'},
  animation_jitter:      {label:'Animation (ancien)',              emoji:'📺'}
};
var VOICE_STORAGE = SUPA_URL + '/storage/v1/object/public/voiceovers';
var motsVoix = null; // timestamps de la voix de la lecon (charges au premier « Problème de voix »)

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
// Une panne reseau n'appelle PAS cb : XGNet affiche le bandeau « Pas pu charger... » avec
// « Réessayer ». Avant, elle tombait dans cb(null) et s'affichait « Lecon introuvable » ou
// « Voiceover pas encore approuve » (review-video.js:76-79, 121 au 2026-11-10).
function chargementEchoue() {
  var t = document.getElementById('title');
  if (t && t.textContent === 'Chargement...') t.textContent = '🎬 Chargement impossible pour le moment';
}
function resolveLesson(cb) {
  if (!lessonKey) { cb(null); return; }
  XGNet.requete(API+'/lessons?lesson_key=eq.'+encodeURIComponent(lessonKey)+'&select=*', {headers:H}, {action:'charger la leçon'})
    .then(function(rows){ cb(rows[0] || null) })
    .catch(chargementEchoue);
}

// === Resolve voice status (gating) ===
function resolveVoiceStatus(cb) {
  XGNet.requete(API+'/lesson_status?lesson_key=eq.'+encodeURIComponent(lessonKey)+'&select=status', {headers:H}, {action:'vérifier l’état de la voix'})
    .then(function(rows){ cb(rows[0] ? rows[0].status : null); })
    .catch(chargementEchoue);
}

// === Resolve video metadata ===
function resolveVideoMetadata(cb) {
  XGNet.requete(API+'/video_metadata?lesson_key=eq.'+encodeURIComponent(lessonKey)+'&select=*', {headers:H}, {action:'charger la vidéo'})
    .then(function(rows){ cb(rows[0] || null) })
    .catch(chargementEchoue);
}

// === Init ===
resolveLesson(function(lesson) {
  if (!lesson) {
    document.body.innerHTML = '<a href="index.html" style="color:#94A3B8">&larr; Retour</a><div class="err" style="color:#E74C3C;padding:20px">Leçon introuvable.</div>';
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
    '<a href="review.html?key='+encodeURIComponent(L.lesson_key)+'">🎙 Voix</a>' +
    '<a href="index.html">Accueil</a>';

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
      loadVoiceRequests();
    });
  });
});

function initVideoPlayer() {
  vid = document.getElementById('vid');
  // Build URL : VM.video_path peut etre soit absolu soit relatif au bucket
  // Correctif 13 : une adresse absolue n'est acceptee que si elle pointe vers NOTRE stockage
  // Supabase en https (avant : n'importe quel http:// passait tel quel dans la page).
  var vp = String(VM.video_path || '');
  var videoUrl;
  if (/^https?:\/\//i.test(vp)) {
    if (vp.indexOf(SUPA_URL + '/storage/') !== 0) {
      XGNet.signaler(new Error('video_path refuse : ' + vp), 'video_path hors stockage');
      document.getElementById('video-wrapper').innerHTML =
        '<div style="color:#FF8A7D;padding:40px;text-align:center;font-size:15px">Adresse de la vidéo invalide — signale-le à Nicolas.</div>';
      return;
    }
    videoUrl = vp;
  } else {
    videoUrl = STORAGE + '/' + vp.replace(/^videos\//, '').split('/').map(encodeURIComponent).join('/') + '?v=' + encodeURIComponent(VM.produced_at || Date.now());
  }
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
      '<div style="color:#FF8A7D;padding:40px;text-align:center;font-size:15px">Impossible de charger la vidéo (connexion, ou fichier absent). Recharge la page dans un moment.<br><small>' + escapeHtml(videoUrl) + '</small></div>';
  });
}

function renderInfoBar() {
  var bar = document.getElementById('info-bar');
  // Construction deleguee a XGReview.buildInfoBar qui ECHAPPE produced_by / produced_at
  // (donnees Supabase) avant injection dans innerHTML — sinon risque XSS. Teste par vitest.
  bar.innerHTML = XGReview.buildInfoBar(VM, escapeHtml, fmtDate, fmtTime);
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
    var pct = (Number(f.time) / vid.duration) * 100;
    var cls = 'timeline-marker' + (f.severity === 'minor' ? ' minor' : '');
    var cat = FLAG_CATEGORIES[f.category] || {label: f.category || '?'};
    // Correctif 13 : note et id viennent de la base -> echappes (avant : injectes tels quels).
    html += '<div class="' + cls + '" style="left:' + pct + '%" data-flag-id="' + escapeHtml(f.id) + '" title="' + escapeHtml(f.note || cat.label) + '" onclick="jumpToFlag(this.getAttribute(\'data-flag-id\'))"></div>';
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
  onFlagCatChange();
  document.querySelectorAll('input[name="flagSev"]').forEach(function(r) { r.checked = (r.value === 'blocker'); });
  document.getElementById('addflag-msg').textContent = '';
  document.getElementById('addflag-modal-bg').classList.add('open');
}
function closeAddFlagModal() {
  document.getElementById('addflag-modal-bg').classList.remove('open');
}
// Adapte le formulaire au defaut choisi : « Problème de voix » montre le choix de la phrase
// et demande de dire ce qui cloche ; « Autre » exige une description.
function onFlagCatChange() {
  var cat = document.querySelector('input[name="flagCat"]:checked');
  var v = cat ? cat.value : null;
  var label = document.getElementById('addflag-note-label');
  var note = document.getElementById('addflag-note');
  document.getElementById('addflag-voice').style.display = v === 'voice' ? 'block' : 'none';
  document.getElementById('addflag-severity').style.display = v === 'voice' ? 'none' : 'flex';
  if (v === 'voice') {
    label.textContent = 'Ce qui cloche (obligatoire) : quel mot, comment il devrait sonner';
    note.placeholder = 'Ex. : « CNESST » est dit lettre par lettre trop vite';
    chargerPhrasesVoix();
  } else if (v === 'other') {
    label.textContent = 'Décris le problème (obligatoire) :';
    note.placeholder = 'Ce que tu vois, et ce qu’il faudrait à la place';
  } else {
    label.textContent = 'Ce que tu vois (facultatif) :';
    note.placeholder = 'Ex. : le titre cache la 2e ligne de la liste';
  }
}

// Propose la phrase dite a cet instant (+ celle d'avant et d'apres : le montage peut decaler
// de quelques dixiemes). Les timestamps viennent du meme bucket que la page voix.
function chargerPhrasesVoix() {
  var boite = document.getElementById('addflag-voice-phrases');
  function afficher() {
    var si = XGReview.sentenceAtTime(motsVoix, addFlagTimestamp);
    var choix = [si - 1, si, si + 1].filter(function(i){ return i >= 0 && XGReview.sentenceText(motsVoix, i); });
    if (!choix.length) {
      boite.innerHTML = '<em>Phrase introuvable. Signale-le plutôt dans la <a href="review.html?key=' + encodeURIComponent(L.lesson_key) + '" style="color:#85C1E9">page voix</a>.</em>';
      return;
    }
    boite.innerHTML = choix.map(function(i){
      return '<label><input type="radio" name="voicePhrase" value="' + i + '"' + (i === si ? ' checked' : '') + '><span>' +
        escapeHtml(XGReview.sentenceText(motsVoix, i)) + '</span></label>';
    }).join('');
  }
  if (motsVoix) { afficher(); return; }
  boite.innerHTML = '<em>Chargement des phrases…</em>';
  var bust = '?v=' + Date.now();
  var urls = ['/preview/' + L.lesson_key + '/voiceover-timestamps.json', '/preview/' + L.lesson_key + '/timestamps.json',
              '/' + L.lesson_key + '/voiceover-timestamps.json', '/' + L.lesson_key + '/timestamps.json'];
  Promise.all(urls.map(function(u){
    return fetch(VOICE_STORAGE + u + bust).then(function(r){ return r.ok ? r.json() : null; })
      .catch(function(e){ XGNet.signaler(e, 'timestamps voix ' + u); return null; });
  })).then(function(res){
    var sel = XGReview.pickBestTimestamps(res);
    motsVoix = sel && sel.words ? sel.words : [];
    afficher();
  });
}

function submitFlag() {
  var catEl = document.querySelector('input[name="flagCat"]:checked');
  var msg = document.getElementById('addflag-msg');
  msg.style.color = '#FF8A7D';
  if (!catEl) { msg.textContent = 'Choisis ce qui ne va pas.'; return; }
  var note = document.getElementById('addflag-note').value.trim();
  if ((catEl.value === 'voice' || catEl.value === 'other') && !note) {
    msg.textContent = catEl.value === 'voice' ? 'Dis ce qui cloche dans la voix : la refaire à l’identique ne changerait rien.' : 'Décris le problème.';
    return;
  }
  if (catEl.value === 'voice') { envoyerCoteVoix(note); return; }
  var sevEl = document.querySelector('input[name="flagSev"]:checked');
  flags.push({
    id: genId(),
    time: addFlagTimestamp,
    category: catEl.value,
    severity: sevEl ? sevEl.value : 'blocker',
    note: note,
    created_at: new Date().toISOString()
  });
  // Sort by time
  flags.sort(function(a,b){ return a.time - b.time; });
  closeAddFlagModal();
  renderMarkers();
  renderFlagsList();
  scheduleAutoSave();
}

// « Problème de voix » : une demande dans sentence_flags (type regen + note), exactement ce
// que fait le crayon « Voix bizarre » de la page voix. Elle n'entre PAS dans les flags de la
// video : elle ne rejette pas la video et n'empeche pas le robot de reparer les autres flags.
function envoyerCoteVoix(note) {
  var msg = document.getElementById('addflag-msg');
  var ph = document.querySelector('input[name="voicePhrase"]:checked');
  if (!ph) { msg.textContent = 'Choisis la phrase concernée.'; return; }
  var si = parseInt(ph.value, 10);
  var rn = (localStorage.getItem('rn') || 'Anonyme').trim();
  var corps = {
    lesson_key: L.lesson_key,
    sentence_index: si,
    flag_type: 'regen',
    original_text: XGReview.sentenceText(motsVoix, si),
    note: '[depuis la vidéo à ' + fmtTime(addFlagTimestamp) + '] ' + note,
    reviewer_name: rn
  };
  msg.style.color = '#94A3B8';
  msg.textContent = 'Envoi…';
  XGNet.requete(API+'/sentence_flags', {
    method: 'POST',
    headers: Object.assign({}, H, {'Content-Type':'application/json','Prefer':'return=minimal'}),
    body: JSON.stringify(corps)
  }, {action: 'envoyer ta demande côté voix', cle: 'voix-depuis-video', reessayer: function(){ envoyerCoteVoix(note); }})
    .then(function(){
      msg.style.color = '#2ECC71';
      msg.textContent = '✓ Envoyé côté voix';
      loadVoiceRequests();
      setTimeout(closeAddFlagModal, 900);
    }, function(){
      msg.style.color = '#FF8A7D';
      msg.textContent = '✗ Pas envoyé — voir le bandeau rouge en haut';
    });
}

// Demandes cote voix de la lecon (crayon + « Problème de voix »), avec leur etat reel.
function loadVoiceRequests() {
  var boite = document.getElementById('voice-requests');
  if (!boite || !L) return;
  XGNet.requete(API+'/sentence_flags?lesson_key=eq.'+encodeURIComponent(L.lesson_key)+
      '&select=id,sentence_index,flag_type,applied,applied_at,auto_status,skip_reason,note,created_at&order=created_at.desc&limit=10', {headers:H},
      {action: 'lire tes demandes côté voix', reessayer: loadVoiceRequests})
    .then(function(rows){
      if (!rows || !rows.length) { boite.innerHTML = ''; return; }
      boite.innerHTML = '<div class="sec" style="color:#85C1E9;margin-top:12px">🎙 Demandes côté voix sur cette leçon (' + rows.length + ')</div>' +
        rows.map(function(f){
          var st = XGReview.sentenceFlagStatusLabel(f);
          return '<div class="voice-req">Phrase #' + escapeHtml(f.sentence_index) + ' — ' + escapeHtml(f.note || f.flag_type) +
            ' <span class="rfixstatus ' + st.c + '">' + escapeHtml(st.t) + '</span></div>';
        }).join('');
    }, function(e){ XGNet.signaler(e, 'loadVoiceRequests'); });
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
  document.getElementById('flags-section-title').innerHTML = '🚩 Problèmes notés (' + flags.length + ')';
  if (flags.length === 0) {
    container.innerHTML = '<div class="empty">Clique « Problème ici » pendant la lecture pour noter un problème.</div>';
    return;
  }
  var html = '';
  flags.forEach(function(f) {
    var cat = FLAG_CATEGORIES[f.category] || {label:f.category, emoji:'❓'};
    var rowCls = 'flag-row' + (f.severity === 'minor' ? ' minor' : '');
    html += '<div class="' + rowCls + '" data-flag-id="' + escapeHtml(f.id) + '" onclick="jumpToFlag(this.getAttribute(\'data-flag-id\'))">' +
      '<span class="flag-time">' + fmtTime(f.time) + '</span>' +
      '<span class="flag-cat-pill">' + cat.emoji + ' ' + escapeHtml(cat.label) + '</span>' +
      '<span class="flag-note">' + (f.note ? escapeHtml(f.note) : '<em style="color:#A3ACB9">aucune note</em>') + '</span>' +
      '<button class="flag-delete" onclick="event.stopPropagation();deleteFlag(this.parentNode.getAttribute(\'data-flag-id\'))" title="Supprimer">&times;</button>' +
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
  // Lecture seule tant que la revue n'est pas lue (reessais compris) : voir plus bas.
  revueNonChargee = true;
  // Correctif 12 : on charge TOUTES les revues de la lecon et on retrouve la sienne sans tenir
  // compte de la casse ni des espaces (« Rawen » = « rawen »), comme la page voix
  // (loader.js). Avant : filtre exact reviewer_name=eq.<nom> -> une majuscule de difference
  // et la reviseuse repartait d'une revue vide, puis l'autosauvegarde creait un doublon.
  XGNet.requete(API+'/video_reviews?lesson_key=eq.'+encodeURIComponent(L.lesson_key)+'&select=*&order=updated_at.desc', {headers:H},
      {action:'charger ta revue de cette vidéo'})
    .then(function(toutes){
      revueNonChargee = false;
      var rows = (toutes || []).filter(function(r){ return XGReview.memeReviseur(r.reviewer_name, rn); });
      if (rows[0] && rows[0].reviewer_name !== rn) {
        // Aligner le nom local sur celui enregistre : on reecrit la MEME ligne (pas de doublon).
        rn = rows[0].reviewer_name;
        try { localStorage.setItem('rn', rn); } catch (e) { XGNet.signaler(e, 'localStorage rn video'); }
      }
      if (rows && rows[0]) {
        // Nouvelle version produite depuis le dernier passage de la reviseuse ?
        // (audit 2026-06-10 : Hela confondait ancienne et nouvelle video.)
        var versionRevue = rows[0].video_version || 1;
        var versionCourante = (VM && VM.version) || 1;

        // Un flag est horodate sur UN montage : il ne veut plus rien dire sur la
        // version suivante. On ne les recharge donc PAS quand la revue portait sur
        // une version anterieure. Sans ca, l'autosave (2 s apres la premiere frappe)
        // les reecrivait avec le video_version courant et la lecon retombait en
        // 'rejected' sur des flags perimes — c'est ainsi que pemp m02-l04 s'est
        // retrouvee en v7 avec des flags du 11 juillet, et m03-l01 en v8 avec des
        // flags de la v1. Le trigger archive_video_review_on_regen purge desormais
        // en base (migration 018) ; ce garde-ci empeche un onglet reste ouvert de
        // les reinjecter par-dessus.
        flags = versionCourante > versionRevue ? [] : (rows[0].flags || []).slice();
        flags.sort(function(a,b){ return a.time - b.time; });

        if (versionCourante > versionRevue) {
          var nb = document.getElementById('new-version-banner');
          if (nb) {
            nb.innerHTML =
              '<strong>🆕 NOUVELLE VIDÉO — version ' + versionCourante + '</strong>' +
              (VM.produced_at ? ', produite le <strong>' + fmtDate(VM.produced_at) + '</strong>' : '') + '<br>' +
              'Tu avais regardé la version ' + versionRevue +
              (rows[0].rejected ? ' et tu l\'avais renvoyée à corriger — la vidéo a été refaite depuis.' : '.') +
              ' Regarde celle-ci au complet, puis clique « J\'ai fini cette vidéo ».';
            nb.classList.remove('hidden');
          }
          // Les verdicts (approuvee/rejetee) concernent l'ANCIENNE version : on repart
          // d'un verdict vide, ce serait trompeur sur la nouvelle.
        } else {
          verdict = { approved: !!rows[0].approved, rejected: !!rows[0].rejected, reason: rows[0].reject_reason || null };
          verdictDate = rows[0].updated_at || null;
        }
      }
      renderFlagsList();
      renderMarkers();
      afficherVerdict();
    })
    .catch(function(){
      // Le bandeau XGNet dit deja que la revue n'a pas pu etre chargee. On NE montre PAS une
      // liste vide modifiable : une autosauvegarde ecraserait la vraie revue en base.
      revueNonChargee = true;
      var bt = document.getElementById('finish-btn'); if (bt) bt.disabled = true;
      renderFlagsList();
    });
}
var verdictDate = null;
var leconSuivanteCherchee = false;
var revueNonChargee = false;

// Flags qui empechent l'approbation : severite « bloquant » et pas deja repares par le robot.
function flagsBloquants() {
  return flags.filter(function(f){ return f.severity !== 'minor' && !f.resolved_at && f.category !== 'voice'; });
}

// Bandeaux d'etat, recalcules a chaque changement (pas seulement au chargement).
function afficherVerdict() {
  var rn = (localStorage.getItem('rn') || 'Anonyme').trim();
  var ok = document.getElementById('approved-banner');
  var ko = document.getElementById('recheck-banner');
  var st = document.getElementById('verdict-state');
  var nbB = flagsBloquants().length;
  ok.classList.add('hidden');
  ko.classList.add('hidden');
  var etat;
  if (verdict.approved) {
    ok.innerHTML = '<strong>✓ Tu as approuvé cette vidéo</strong><br>Approuvée par <strong>' + escapeHtml(rn) + '</strong>' +
      (verdictDate ? ' le <strong>' + fmtDate(verdictDate) + '</strong>' : '');
    ok.classList.remove('hidden');
    etat = '✓ Approuvée';
  } else if (verdict.rejected) {
    ko.innerHTML = '<strong>✗ Renvoyée à corriger — 🔧 à refaire</strong><br>' +
      (verdict.reason ? '<em>« ' + escapeHtml(verdict.reason) + ' »</em><br>' : '') +
      '<span style="opacity:.85">Une nouvelle version apparaîtra ici une fois la vidéo refaite. ' +
      'Tu peux encore ajouter des problèmes : ils partent avec le renvoi.</span>';
    ko.classList.remove('hidden');
    etat = '🔧 À corriger';
  } else if (nbB > 0) {
    etat = '● Revue en cours — ' + nbB + ' problème' + (nbB > 1 ? 's' : '') + ' bloquant' + (nbB > 1 ? 's' : '') +
      '. Clique « J\'ai fini cette vidéo » pour l\'envoyer à corriger.';
  } else {
    etat = '● Revue en cours — clique « J\'ai fini cette vidéo » quand tu as tout regardé.';
  }
  if (st) st.textContent = etat;
  checkPushToGhlVisibility();
  // Revue finie (approuvee ou renvoyee) : lien vers la prochaine video a reviser du cours.
  if ((verdict.approved || verdict.rejected) && !leconSuivanteCherchee) {
    leconSuivanteCherchee = true;
    XGNet.afficherLeconSuivante({ api: API, headers: H, lecon: L, stages: ['video_review'],
      page: 'review-video.html', idLien: 'next-lesson', texte: 'Vidéo suivante à réviser →' });
  }
}

// === Save review ===
function scheduleAutoSave() {
  if (revueNonChargee) {
    var m0 = document.getElementById('msg');
    if (m0) { m0.textContent = '✗ Ta revue n’est pas encore chargée : rien n’est sauvegardé. Clique « Réessayer » en haut.'; m0.style.color = '#FF8A7D'; }
    return;
  }
  dirty = true;
  // Une video approuvee qui recoit un probleme bloquant n'est plus approuvee : on retire
  // l'approbation (sans inventer un rejet) et le bandeau dit quoi faire. Un rejet, lui,
  // reste un rejet quoi qu'on ajoute (c'etait le bogue : le flag de trop l'annulait).
  if (verdict.approved && flagsBloquants().length > 0) {
    verdict.approved = false;
  }
  afficherVerdict();
  if (saveTimer) clearTimeout(saveTimer);
  var msg = document.getElementById('msg');
  if (msg) { msg.textContent = '● modifié — sauvegarde dans 2 s'; msg.style.color = '#94A3B8'; }
  saveTimer = setTimeout(function(){ saveReview(true); }, 2000);
}

// Ecrit la revue avec le verdict COURANT. Retourne une promesse : resolue seulement apres une
// reponse 2xx du serveur, rejetee sinon (le bandeau XGNet propose alors « Réessayer »).
function saveReview(isAuto, reessayer) {
  if (!L) return Promise.reject(new Error('lecon absente'));
  if (revueNonChargee) return Promise.reject(new Error('revue non chargee'));
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  var rn = (localStorage.getItem('rn') || 'Anonyme').trim();
  if (!rn || rn === 'Anonyme') {
    rn = prompt('Ton prénom (sera affiché dans la revue) :', '') || 'Anonyme';
    localStorage.setItem('rn', rn);
  }

  var body = {
    lesson_key: L.lesson_key,
    course_id: L.course_id,
    lesson_id: L.lesson_id || L.lesson_slug,
    lesson_title: L.title,
    reviewer_name: rn,
    flags: flags,
    approved: !!verdict.approved,
    rejected: !!verdict.rejected,
    reject_reason: verdict.rejected ? (verdict.reason || null) : null,
    video_version: VM ? VM.version : null,
    updated_at: new Date().toISOString()
  };
  var msg = document.getElementById('msg');
  if (msg) { msg.textContent = 'Sauvegarde…'; msg.style.color = '#94A3B8'; }

  // Upsert idempotent (on_conflict) : on peut le reessayer sans risque de doublon.
  return XGNet.requete(API+'/video_reviews?on_conflict=lesson_key,reviewer_name', {
    method: 'POST',
    headers: Object.assign({}, H, {
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    }),
    body: JSON.stringify(body)
  }, {
    action: 'enregistrer ta revue (tes problèmes notés sont encore sur cette page, ne la ferme pas)',
    cle: 'save-video-review',
    essais: 3,
    reessayer: reessayer || function(){ saveReview(false).catch(function(e){ XGNet.signaler(e, 'reessai save video'); }); }
  }).then(function(){
    dirty = false;
    verdictDate = body.updated_at;
    if (msg) {
      msg.textContent = isAuto ? '✓ Sauvegardé automatiquement' : '✓ Sauvegardé';
      msg.style.color = '#27AE60';
    }
  }, function(e){
    if (msg) { msg.textContent = '✗ Pas sauvegardé — voir le bandeau rouge en haut'; msg.style.color = '#E74C3C'; }
    throw e;
  });
}

// === Fin de revue : UN seul bouton (chantier 03) ===
// Avant : « Approuver » et « Renvoyer » separes. Des flags bloquants poses sans clic sur
// « Renvoyer » restaient invisibles deux heures (migration 025, rejet implicite), puis le
// robot les sautait. Maintenant « J'ai fini cette video » decide : aucun bloquant =
// approuvee ; au moins un bloquant = a corriger, tout de suite.
function resumeBloquants() {
  return flagsBloquants().map(function(f){
    var cat = FLAG_CATEGORIES[f.category] || {label: f.category};
    return fmtTime(f.time) + ' ' + cat.label + (f.note ? ' — ' + f.note : '');
  }).join(' | ');
}
function askFinish() {
  var bl = flagsBloquants();
  var mineurs = flags.length - bl.length;
  var titre = document.getElementById('finish-title');
  var texte = document.getElementById('finish-text');
  var champ = document.getElementById('finish-reason-wrap');
  var bouton = document.getElementById('finish-confirm');
  document.getElementById('finish-msg').textContent = '';
  bouton.disabled = false;
  if (bl.length === 0) {
    titre.textContent = '✓ Approuver cette vidéo ?';
    texte.innerHTML = 'Tu n\'as noté <strong>aucun problème bloquant</strong> : la vidéo sera <strong>approuvée</strong>' +
      (mineurs ? ' (tes ' + mineurs + ' remarque' + (mineurs > 1 ? 's' : '') + ' mineure' + (mineurs > 1 ? 's' : '') + ' sont gardées pour les prochaines vidéos).' : '.');
    champ.style.display = 'none';
    bouton.textContent = 'Oui, approuver';
    bouton.className = 'btn bg';
  } else {
    titre.textContent = '🔧 Envoyer cette vidéo à corriger ?';
    texte.innerHTML = 'Tu as noté <strong>' + bl.length + ' problème' + (bl.length > 1 ? 's' : '') + ' bloquant' + (bl.length > 1 ? 's' : '') +
      '</strong> : la vidéo part <strong>à corriger</strong> avec ta liste. Une nouvelle version reviendra ici.';
    champ.style.display = 'block';
    document.getElementById('finish-reason').value = verdict.rejected ? (verdict.reason || '') : '';
    bouton.textContent = 'Envoyer à corriger';
    bouton.className = 'btn br';
  }
  document.getElementById('finish-modal-bg').classList.add('open');
}
function closeFinishModal() {
  document.getElementById('finish-modal-bg').classList.remove('open');
}
function confirmFinish() {
  var bl = flagsBloquants();
  if (bl.length === 0) {
    verdict = { approved: true, rejected: false, reason: null };
  } else {
    var resume = document.getElementById('finish-reason').value.trim();
    verdict = { approved: false, rejected: true, reason: resume || (bl.length + ' problème(s) bloquant(s) : ' + resumeBloquants()).slice(0, 500) };
  }
  var bouton = document.getElementById('finish-confirm');
  var fm = document.getElementById('finish-msg');
  bouton.disabled = true;
  fm.textContent = 'Envoi…';
  fm.style.color = '#94A3B8';
  afficherVerdict();
  saveReview(false, confirmFinish).then(function(){
    // Rechargement SEULEMENT apres la confirmation du serveur (avant : apres 800 ms quoi
    // qu'il arrive, ce qui effacait un verdict jamais enregistre).
    fm.textContent = '✓ Enregistré';
    fm.style.color = '#27AE60';
    setTimeout(function(){ location.reload(); }, 400);
  }, function(){
    bouton.disabled = false;
    bouton.textContent = 'Réessayer';
    fm.textContent = '✗ Pas envoyé : le serveur ne répond pas. Rien n\'est perdu tant que cette page reste ouverte — clique « Réessayer ».';
    fm.style.color = '#E74C3C';
  });
}

// Phase 3 : Push de cette lecon individuelle vers GHL
async function pushLessonToGhl() {
  if (!L) return;
  var msg = document.getElementById('msg');
  msg.textContent = 'Préparation du fichier GHL…';
  msg.style.color = '#bb8fce';

  try {
    var payload = await GhlPayload.buildForLesson(L.lesson_key);
    var slug = L.lesson_key.split('/').pop();
    var filename = slug + '-ghl-import-' + new Date().toISOString().split('T')[0] + '.json';
    GhlPayload.downloadAsFile(payload, filename);
    msg.innerHTML = '✓ <strong>' + escapeHtml(filename) + '</strong> téléchargé. Téléverse-le dans GHL, puis confirme.';
    msg.style.color = '#27AE60';

    // Ask if user wants to mark as pushed
    setTimeout(function() {
      if (confirm('As-tu téléversé le fichier dans GHL ?\n\nClique OK pour marquer cette leçon comme « mise en ligne ».')) {
        GhlPayload.markPushed(L.lesson_key, 'ghl').then(function() {
          msg.textContent = '✓ Leçon marquée comme mise en ligne';
          msg.style.color = '#27AE60';
          setTimeout(function(){ location.reload(); }, 1500);
        }).catch(function(e) {
          msg.textContent = 'Pas pu marquer la leçon comme mise en ligne : ' + e.message;
          msg.style.color = '#E74C3C';
          if (window.captureWithContext) captureWithContext(e, {action:'mark_lesson_pushed', lesson_key:L.lesson_key});
        });
      }
    }, 500);
  } catch (e) {
    msg.textContent = 'Erreur : ' + e.message;
    msg.style.color = '#E74C3C';
    if (window.captureWithContext) captureWithContext(e, {action:'push_lesson_to_ghl', lesson_key:L.lesson_key});
  }
}

// Show "Push to GHL" button if video is approved (or already approved on load)
function checkPushToGhlVisibility() {
  var btn = document.getElementById('lms-lesson-push-btn');
  if (btn) btn.style.display = verdict.approved && !dirty ? 'inline-block' : 'none';
}

// === Copy review (text) ===
function copyReview() {
  if (!flags.length) {
    var msg = document.getElementById('msg');
    msg.textContent = 'Aucun problème à copier.';
    msg.style.color = '#94A3B8';
    return;
  }
  var lines = ['RÉVISION VIDÉO : ' + (L.short_title || L.title) + ' (v' + (VM.version||1) + ')', ''];
  flags.forEach(function(f){
    var cat = FLAG_CATEGORIES[f.category] || {label:f.category, emoji:''};
    lines.push('[' + fmtTime(f.time) + '] ' + cat.emoji + ' ' + cat.label + (f.severity==='minor'?' (mineur)':'') + (f.note ? ' — ' + f.note : ''));
  });
  navigator.clipboard.writeText(lines.join('\n')).then(function(){
    var msg = document.getElementById('msg');
    msg.textContent = '✓ Copié dans le presse-papier';
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
      document.getElementById('history-title').textContent = 'Historique (' + rows.length + ' révisions archivées)';
      list.innerHTML = rows.map(function(r){
        return '<div class="history-row">' +
          '<strong>v' + (r.video_version||1) + '</strong> — ' + fmtDate(r.archived_at) +
          ' — ' + (r.flags ? r.flags.length : 0) + ' problème(s)' +
          (r.approved ? ' <span style="color:#27AE60">✓</span>' : '') +
          (r.rejected ? ' <span style="color:#E74C3C">✗</span>' : '') +
          '</div>';
      }).join('');
      panel.classList.remove('hidden');
    })
    .catch(function(err){
      if (window.captureWithContext) captureWithContext(err, {action:'load_video_history', lesson_key:L.lesson_key});
    });
}

// === Keyboard shortcuts ===
document.addEventListener('keydown', function(e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  // Ctrl+S = save
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    saveReview(false).catch(function(err){ XGNet.signaler(err, 'ctrl-s video'); });
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
['addflag-modal-bg', 'finish-modal-bg'].forEach(function(id){
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

var SUPA_URL = 'https://ctjsdpfegpsfpwjgusyi.supabase.co';
var SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN0anNkcGZlZ3BzZnB3amd1c3lpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2MDU2NDQsImV4cCI6MjA4OTE4MTY0NH0.Uv2pbxbmvcbXhyDa7Y_M0HqkLuV7uJaNxl1N01q5wMo';
var STORAGE = SUPA_URL + '/storage/v1/object/public/voiceovers';
var API = SUPA_URL + '/rest/v1';
var H = {apikey:SUPA_KEY,Authorization:'Bearer '+SUPA_KEY};

var params = new URLSearchParams(location.search);
var lessonKey = params.get('key') || '';
var legacyIdx = params.get('lesson');

// Etat global
var L = null;
var W = [];
var els = [];
var flags = new Map();
var glitches = [];
var prevIdx = -1;
var au = null;
var saveTimer = null;
var dirty = false;
// Mode filtre : quand actif, n'affiche que les phrases regenerees (regenIndices)
var regenIndices = null; // null = pas de filtre disponible pour cette lecon
var filterModeActive = false;
// Ranges temporels par sentenceIndex, calcules depuis W (timestamps mot-a-mot).
// Ex: sentenceRanges[5] = {start: 12.3, end: 15.7}
var sentenceRanges = {};

// Extrait un contexte autour du mot a l'index i :
// - on reste dans la meme phrase (sentenceIndex) que le mot flagge
// - on veut au moins MIN_BEFORE/MIN_AFTER mots, et au plus MAX_BEFORE/MAX_AFTER
// - si la phrase est plus longue, on tronque et on prefixe/suffixe par "..."
// Objectif : toujours avoir assez de mots autour pour reconnaitre le mot a l'oreille,
// sans jamais enjamber une phrase (ex: pas "...proximite. Declenchez les...").
function getCtx(i){
  var MIN_BEFORE = 6, MIN_AFTER = 6;
  var MAX_BEFORE = 10, MAX_AFTER = 10;
  if (!W[i]) return '';
  var si = W[i].sentenceIndex;
  // Trouver le debut de la phrase courante
  var sentStart = i;
  while (sentStart > 0 && W[sentStart-1].sentenceIndex === si) sentStart--;
  // Trouver la fin de la phrase courante
  var sentEnd = i;
  while (sentEnd < W.length-1 && W[sentEnd+1].sentenceIndex === si) sentEnd++;
  // Calculer la fenetre : au moins MIN, au plus MAX, sans sortir de la phrase
  var s = Math.max(sentStart, i - MAX_BEFORE);
  var e = Math.min(sentEnd, i + MAX_AFTER);
  // Si la phrase est courte, on prend tout (pas besoin de tronquer)
  if (sentEnd - sentStart <= MIN_BEFORE + MIN_AFTER) {
    s = sentStart;
    e = sentEnd;
  }
  var prefix = s > sentStart ? '... ' : '';
  var suffix = e < sentEnd ? ' ...' : '';
  var r = [];
  for (var k = s; k <= e; k++) {
    r.push(k === i ? '**'+W[k].word+'**' : W[k].word);
  }
  return prefix + r.join(' ') + suffix;
}
function gsi(i){return W[i] && W[i].sentenceIndex!=null ? W[i].sentenceIndex : '?'}
function fmt(s){return Math.floor(s/60)+':'+('0'+Math.floor(s%60)).slice(-2)}
// Un flag est "resolved" si la phrase (sentenceIndex) a ete regeneree depuis
// la derniere fois qu'il a ete pose. Se base sur regenerated_sentence_indices
// de voiceover_metadata (rempli par regen-from-reviews.mjs).
// Si le reviewer re-clique sur le mot apres regen, le flag repasse en "unresolved"
// (= c'est un nouveau probleme sur la phrase deja regeneree).
function isResolved(flag){
  if (!regenIndices) return false;
  if (flag.reflagged) return false; // re-flagge manuellement apres regen
  if (flag.sentenceIndex === null || flag.sentenceIndex === undefined || flag.sentenceIndex === '?') return false;
  return regenIndices.indexOf(flag.sentenceIndex) !== -1;
}
// Un flag est "approved_after_regen" quand Nicolas a explicitement confirme
// qu'apres regen le mot sonne bien. Il est cache de la liste par defaut.
function isApproved(flag){ return !!flag.approved_after_regen; }
// Un flag est "auto_resolved" quand le mot flagged n'existe plus dans le texte
// apres reformulation (detecte automatiquement par auto-resolve-orphan-flags.mjs).
// Cache par defaut comme isApproved.
function isAutoResolved(flag){ return !!flag.auto_resolved; }
// Combine : flag a cacher de la liste active
function isHidden(flag){ return isApproved(flag) || isAutoResolved(flag); }
// Variable de controle UI : afficher ou non les flags deja approuves
var showApproved = false;
function fmtDate(iso){try{return new Date(iso).toLocaleString('fr-CA',{dateStyle:'medium',timeStyle:'short'})}catch(e){return iso}}

function resolveLesson(cb){
  if (lessonKey) {
    fetch(API+'/lessons?lesson_key=eq.'+encodeURIComponent(lessonKey)+'&select=*',{headers:H})
      .then(function(r){return r.json()})
      .then(function(rows){ cb(rows[0] || null) });
    return;
  }
  if (legacyIdx !== null && /^\d+$/.test(legacyIdx)) {
    fetch(API+'/lesson_status?select=lesson_key&order=course_id.asc,sort_order.asc',{headers:H})
      .then(function(r){return r.json()})
      .then(function(rows){
        var idx = parseInt(legacyIdx,10);
        if (idx >= 0 && idx < rows.length) {
          lessonKey = rows[idx].lesson_key;
          resolveLesson(cb);
        } else cb(null);
      });
    return;
  }
  cb(null);
}

function loadExistingReview(){
  var rn = (localStorage.getItem('rn') || 'Anonyme').trim();
  fetch(API+'/voice_reviews?lesson_key=eq.'+encodeURIComponent(L.lesson_key)+'&reviewer_name=eq.'+encodeURIComponent(rn)+'&select=*',{headers:H})
    .then(function(r){return r.json()})
    .then(function(rows){
      if (!rows.length) return;
      var rev = rows[0];
      if (Array.isArray(rev.flags)) {
        rev.flags.forEach(function(f){
          // Regenerer le contexte avec la nouvelle fonction getCtx (snippets plus
          // longs et bornes par la phrase). Si l'index est valide, on remplace le
          // context en DB pour que la prochaine sauvegarde ait un meilleur contexte.
          if (typeof f.index === 'number' && W[f.index]) {
            var newCtx = getCtx(f.index);
            if (newCtx && newCtx !== f.context) {
              f.context = newCtx;
              dirty = true; // forcer la prochaine auto-save
            }
          }
          flags.set(f.index, f);
          if (els[f.index]) {
            if (isApproved(f)) els[f.index].classList.add('approved');
            else if (isResolved(f)) els[f.index].classList.add('resolved');
            else els[f.index].classList.add('flagged');
          }
        });
      }
      if (Array.isArray(rev.glitches)) glitches = rev.glitches.slice();
      renderFlags();
      renderGlitches();
    });
}

function loadStatus(){
  fetch(API+'/lesson_status?lesson_key=eq.'+encodeURIComponent(L.lesson_key),{headers:H})
    .then(function(r){return r.json()})
    .then(function(rows){
      if (!rows.length) return;
      var s = rows[0];

      // Info bar (E3) : nb phrases + derniere regen
      var infoBar = document.getElementById('info-bar');
      var parts = [];
      if (W.length) {
        var sentences = Math.max.apply(null, W.map(function(w){return w.sentenceIndex || 0})) + 1;
        parts.push('<strong>'+sentences+'</strong> phrases · <strong>'+W.length+'</strong> mots');
      }
      if (L.duration_seconds) parts.push('<strong>'+Math.round(L.duration_seconds/60)+' min</strong> de voiceover');
      if (s.voiceover_uploaded_at) parts.push('Dernier upload : <strong>'+fmtDate(s.voiceover_uploaded_at)+'</strong>');
      if (s.voiceover_version && s.voiceover_version > 1) parts.push('Version <strong>'+s.voiceover_version+'</strong>');
      if (s.regen_source) parts.push('Source : <strong>'+s.regen_source+'</strong>');
      if (parts.length) {
        infoBar.innerHTML = parts.join('<span class="sep">·</span>');
        infoBar.style.display = 'flex';
      }

      if (s.status === 'needs_recheck') {
        document.getElementById('recheck-banner').innerHTML =
          '<strong>⚠ Cette lecon a ete regeneree depuis ta derniere approbation</strong><br>'
          + 'Voiceover regenere : ' + fmtDate(s.voiceover_uploaded_at) + '<br>'
          + 'Tu l\'avais approuvee : ' + fmtDate(s.latest_review_at) + '<br>'
          + (s.regen_source ? 'Source : ' + s.regen_source : '');
        document.getElementById('recheck-banner').classList.remove('hidden');
      } else if (s.status === 'approved') {
        document.getElementById('approved-banner').innerHTML =
          '<strong>✓ Cette lecon est deja approuvee</strong><br>'
          + 'Approuvee par ' + (s.latest_reviewer || 'Anonyme') + ' le ' + fmtDate(s.latest_review_at);
        document.getElementById('approved-banner').classList.remove('hidden');
      }
    });
}

// Load history (E1)
function loadHistory(){
  fetch(API+'/voice_review_history?lesson_key=eq.'+encodeURIComponent(L.lesson_key)+'&order=archived_at.desc&limit=10',{headers:H})
    .then(function(r){return r.json()})
    .then(function(rows){
      if (!rows.length) return;
      var panel = document.getElementById('history-panel');
      var list = document.getElementById('history-list');
      document.getElementById('history-title').textContent = 'Historique (' + rows.length + ' revisions archivees)';
      list.innerHTML = rows.map(function(r){
        var flagsCnt = Array.isArray(r.flags) ? r.flags.length : 0;
        var approved = r.approved ? '<span style="color:#2ECC71">✓ approuvee</span>' : (flagsCnt+' flags');
        return '<div class="history-row"><strong>'+fmtDate(r.archived_at)+'</strong> · '+r.reviewer_name+' · '+approved+'</div>';
      }).join('');
      panel.classList.remove('hidden');
    }).catch(function(){});
}

resolveLesson(function(lesson){
  if (!lesson) {
    document.body.innerHTML = '<a href="index.html" style="color:#94A3B8">← Retour</a><div class="err">Lecon introuvable.</div>';
    return;
  }
  L = lesson;

  document.getElementById('title').textContent = L.short_title || L.title;

  var nav = document.getElementById('nav');
  nav.innerHTML = '<a href="course.html?course='+encodeURIComponent(L.course_id)+'">← Cours</a>'
    + '<a href="index.html">Index</a>';

  au = new Audio(STORAGE + '/' + L.lesson_key + '/voiceover.mp3');
  au.onplay = function(){document.getElementById('bp').textContent='\u23f8';requestAnimationFrame(sync)};
  au.onpause = function(){document.getElementById('bp').textContent='\u25b6'};
  au.onended = function(){document.getElementById('bp').textContent='\u25b6'};
  au.onseeked = function(){var t=au.currentTime;for(var i=0;i<els.length;i++){if(W[i].start>t){els[i].classList.remove('spoken');els[i].classList.remove('now')}else{els[i].classList.add('spoken')}}prevIdx=-1;sync()};

  // Charger les timestamps en essayant les 2 fichiers possibles.
  // On garde celui qui a la premiere phrase (sentenceIndex 0), parce que
  // certains anciens timestamps.json sont corrompus (partiels, ne contiennent
  // qu'une sous-partie des phrases du voiceover).
  loadTimestamps();
});

function loadTimestamps(){
  var urls = [
    STORAGE + '/' + L.lesson_key + '/voiceover-timestamps.json',
    STORAGE + '/' + L.lesson_key + '/timestamps.json'
  ];
  var results = [];
  var done = 0;
  urls.forEach(function(url, idx){
    fetch(url)
      .then(function(r){return r.ok ? r.json() : null})
      .catch(function(){return null})
      .then(function(data){
        results[idx] = data;
        done++;
        if (done === urls.length) pickBestTimestamps(results);
      });
  });
}

function pickBestTimestamps(candidates){
  // Trouver le meilleur : celui qui a sentenceIndex 0 ET le plus de mots
  var best = null;
  candidates.forEach(function(c){
    if (!Array.isArray(c) || !c.length) return;
    var hasStart = c.some(function(w){return w.sentenceIndex === 0});
    if (!hasStart) return;  // fichier corrompu, ignore
    if (!best || c.length > best.length) best = c;
  });
  // Si aucun fichier n'a sentenceIndex 0, on fallback sur celui qui a le plus de mots
  if (!best) {
    candidates.forEach(function(c){
      if (!Array.isArray(c) || !c.length) return;
      if (!best || c.length > best.length) best = c;
    });
  }
  if (!best) {
    document.getElementById('wc').innerHTML = '<div class="err">Impossible de charger les timestamps pour cette lecon.</div>';
    return;
  }
  W = best;
  computeSentenceRanges();
  buildWords();
  loadExistingReview();
  loadStatus();
  loadHistory();
  loadRegenIndices();
}

// Calcule le range temporel de chaque phrase (start du premier mot, end du dernier mot)
// pour pouvoir sauter d'une phrase a l'autre en mode filtre.
function computeSentenceRanges(){
  sentenceRanges = {};
  for (var i = 0; i < W.length; i++) {
    var w = W[i];
    var si = w.sentenceIndex;
    if (si === null || si === undefined) continue;
    if (!sentenceRanges[si]) {
      sentenceRanges[si] = {start: w.start, end: (w.end != null ? w.end : w.start)};
    } else {
      if (w.start < sentenceRanges[si].start) sentenceRanges[si].start = w.start;
      var we = (w.end != null ? w.end : w.start);
      if (we > sentenceRanges[si].end) sentenceRanges[si].end = we;
    }
  }
}

// Charger la liste des phrases regenerees depuis voiceover_metadata.
// Si la lecon a ete regeneree recemment via regen-from-reviews.mjs, cette colonne
// contient un JSON array d'indices (ex: [0, 5, 12, 18]). On affiche le bouton
// Filtrer et, si la lecon est en needs_recheck, on active le mode filtre
// automatiquement pour que le reviewer ne voie que les phrases a revoir.
//
// IMPORTANT : le bouton "X a revoir" ne doit apparaitre QUE si la lecon a deja
// ete reviewee au moins une fois en DB. Pour une lecon fraichement generee
// (1ere upload, aucune review), on cache le bouton — l'utilisateur ecoute
// et flag au fil de l'eau, pas besoin de filtre "a revoir".
//
// On fetch EXPLICITEMENT voice_reviews en DB (pas flags.size local) parce que
// loadExistingReview tourne en parallele et peut ne pas avoir fini au moment
// ou on verifie l'existence de flags.
function loadRegenIndices(){
  fetch(API+'/voiceover_metadata?lesson_key=eq.'+encodeURIComponent(L.lesson_key)+'&select=regenerated_sentence_indices',{headers:H})
    .then(function(r){return r.json()})
    .then(function(rows){
      if (!rows.length) return;
      var indices = rows[0].regenerated_sentence_indices;
      if (!Array.isArray(indices) || indices.length === 0) return;
      regenIndices = indices;
      // Verifier explicitement dans la DB si une review existe pour cette lecon
      return fetch(API+'/voice_reviews?lesson_key=eq.'+encodeURIComponent(L.lesson_key)+'&select=flags',{headers:H})
        .then(function(r){return r.json()})
        .then(function(reviews){
          var btn = document.getElementById('filterBtn');
          // Verifier si au moins une review existe avec au moins un flag
          var hasExistingFlags = false;
          if (Array.isArray(reviews)) {
            for (var i = 0; i < reviews.length; i++) {
              var flagsInDb = reviews[i].flags;
              if (Array.isArray(flagsInDb) && flagsInDb.length > 0) {
                hasExistingFlags = true;
                break;
              }
            }
          }
          if (!hasExistingFlags) {
            // 1ere ecoute : ne pas afficher le bouton.
            btn.style.display = 'none';
            return;
          }
          // Lecon deja reviewee et regeneree : afficher le bouton filtre.
          btn.style.display = 'inline-block';
          updateFilterBtnCount();
          refreshFlagClasses();
          renderFlags();
          // Auto-enable si la lecon est en needs_recheck (workflow principal)
          return fetch(API+'/lesson_status?lesson_key=eq.'+encodeURIComponent(L.lesson_key)+'&select=status',{headers:H})
            .then(function(r){return r.json()})
            .then(function(rr){
              if (rr.length && rr[0].status === 'needs_recheck') {
                filterModeActive = true;
                btn.classList.add('on');
                buildWords();
              }
            });
        });
    }).catch(function(){});
}

// Met a jour le compteur du bouton filtre ("X a revoir") en temps reel.
// Compte uniquement les phrases regenerees qui ont un flag NON-approuve.
// Une phrase regeneree SANS flag = Nicolas a deja accepte (pas besoin de la revoir).
// Quand tous les flags sont approuves, le compteur disparait.
function updateFilterBtnCount(){
  var btn = document.getElementById('filterBtn');
  if (!btn || !regenIndices) return;
  // Compter les phrases regenerees qui ont encore au moins 1 flag actif
  // (non approved_after_regen, non auto_resolved)
  var phrasesWithUnresolved = new Set();
  flags.forEach(function(f){
    if (!isHidden(f) && regenIndices.indexOf(f.sentenceIndex) !== -1) {
      phrasesWithUnresolved.add(f.sentenceIndex);
    }
  });
  var total = phrasesWithUnresolved.size;
  if (total === 0) {
    // Plus rien a revoir : cacher le bouton completement.
    btn.style.display = 'none';
  } else {
    btn.textContent = '\u{1F50D} ' + total + ' a revoir';
    btn.style.display = 'inline-block';
    btn.style.opacity = '1';
  }
}

// Re-applique les classes flagged/resolved sur tous les mots actuellement rendus.
// Utile quand regenIndices arrive APRES loadExistingReview (async race).
function refreshFlagClasses(){
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (!el || !el.classList) continue;
    el.classList.remove('flagged');
    el.classList.remove('resolved');
    el.classList.remove('approved');
    if (flags.has(i)) {
      var f = flags.get(i);
      if (isApproved(f)) el.classList.add('approved');
      else if (isResolved(f)) el.classList.add('resolved');
      else el.classList.add('flagged');
    }
  }
}

function buildWords(){
  var c=document.getElementById('wc');c.innerHTML='';els=[];
  var ls=-1;
  var regenSet = (filterModeActive && regenIndices) ? new Set(regenIndices) : null;
  var lastSiWasHidden = false;
  var hiddenCount = 0;

  for(var i=0;i<W.length;i++){
    var w=W[i];
    var si=w.sentenceIndex!=null?w.sentenceIndex:-1;

    // Mode filtre : sauter les phrases non regenerees
    if (regenSet && si >= 0 && !regenSet.has(si)) {
      // Toujours pousser un placeholder pour que els[i] reste aligne avec W[i]
      // (le sync audio utilise els[i] pour highlighter les mots).
      var hidden = document.createElement('span');
      hidden.style.display = 'none';
      els.push(hidden);
      if (!lastSiWasHidden) {
        // Afficher un petit separateur "..." cliquable pour rappeler qu'il y a du contenu cache
        var gap = document.createElement('span');
        gap.className = 'sentence-gap';
        gap.textContent = '· · ·';
        gap.title = 'Phrases non regenerees masquees. Cliquer pour tout afficher.';
        gap.onclick = function(){ toggleFilterMode(); };
        c.appendChild(gap);
      }
      lastSiWasHidden = true;
      hiddenCount++;
      continue;
    }
    lastSiWasHidden = false;

    if(si!==ls&&si>=0){
      var m=document.createElement('span');m.className='sm';m.textContent='['+si+']';c.appendChild(m);
      // Bouton flag phrase : cliquable pour ouvrir le modal "Flag phrase"
      var flagBtn=document.createElement('span');
      flagBtn.className='sm-flag';
      flagBtn.textContent='\u2691'; // drapeau
      flagBtn.title='Flagger cette phrase (reformuler, regen, etc.)';
      (function(sentenceIdx){
        flagBtn.onclick=function(e){e.stopPropagation();openSentenceModal(sentenceIdx)};
      })(si);
      c.appendChild(flagBtn);
      ls=si;
    }
    var s=document.createElement('span');s.className='w';s.textContent=w.word;
    // Re-appliquer le statut flagged/resolved/approved si cette phrase avait deja un flag
    if (flags.has(i)) {
      var fg = flags.get(i);
      if (isApproved(fg)) s.classList.add('approved'); // cache visuel mais flag reste en DB
      else if (isResolved(fg)) s.classList.add('resolved');
      else s.classList.add('flagged');
    }
    (function(ii,sp){
      sp.onclick=function(){
        // Cas 0 : mot "approved" (vert masque). Clic = annule l'approbation, repasse en resolved (vert visible)
        if(sp.classList.contains('approved')){
          sp.classList.remove('approved');
          sp.classList.add('resolved');
          var ex0 = flags.get(ii);
          if (ex0) { delete ex0.approved_after_regen; flags.set(ii, ex0); }
        }
        // Cas 1 : mot "resolved" (vert). Clic = "ce mot est encore pas bon" -> repasse rouge (reflagged)
        else if(sp.classList.contains('resolved')){
          sp.classList.remove('resolved');
          sp.classList.add('flagged');
          var existing = flags.get(ii) || {index:ii,word:W[ii].word,context:getCtx(ii),time:fmt(W[ii].start),sentenceIndex:gsi(ii),note:''};
          existing.reflagged = true; // marqueur : reste rouge meme si la phrase est dans regenIndices
          flags.set(ii, existing);
        }
        // Cas 2 : mot "flagged" (rouge). Clic = retirer le flag
        else if(sp.classList.contains('flagged')){
          sp.classList.remove('flagged');
          flags.delete(ii);
        }
        // Cas 3 : mot normal. Clic = ajoute un flag (rouge, sauf si phrase deja regeneree -> vert)
        else {
          var nf = {index:ii,word:W[ii].word,context:getCtx(ii),time:fmt(W[ii].start),sentenceIndex:gsi(ii),note:''};
          flags.set(ii, nf);
          if (isResolved(nf)) sp.classList.add('resolved');
          else sp.classList.add('flagged');
        }
        renderFlags();
        scheduleAutoSave();
      };
      sp.ondblclick=function(){au.currentTime=Math.max(0,W[ii].start-0.15);if(au.paused)au.play()};
    })(i,s);
    c.appendChild(s);c.appendChild(document.createTextNode(' '));els.push(s);
  }
}

// Toggle le mode filtre (affiche seulement les phrases regenerees ou toutes)
function toggleFilterMode(){
  if (!regenIndices) return; // Rien a filtrer
  filterModeActive = !filterModeActive;
  var btn = document.getElementById('filterBtn');
  btn.classList.toggle('on', filterModeActive);
  buildWords();
  // Si l'audio joue dans une phrase non-a-revoir, sauter immediatement
  if (filterModeActive && au && !au.paused) maybeSkipUnregen();
}

function flagStutter(){
  if (!au) return;
  var t=au.currentTime;var i=0;for(var j=0;j<W.length;j++){if(W[j].start<=t)i=j}
  glitches.unshift({time:fmt(t),timeSec:t,context:getCtx(i),sentenceIndex:gsi(i),note:''});
  var b=document.getElementById('stb');b.classList.add('flash');b.textContent='\u2713';
  setTimeout(function(){b.classList.remove('flash');b.textContent='\u26a1 Stutter'},700);
  renderGlitches();
  scheduleAutoSave();
}

function hl(ctx){return (ctx||'').replace(/\*\*(.+?)\*\*/g,'<b style="color:#E74C3C">$1</b>')}

function renderGlitches(){var l=document.getElementById('gl');
  if(!glitches.length){l.innerHTML='<div class="empty">Appuie \u26a1 Stutter pendant l\'ecoute (raccourci: S)</div>';return}
  l.innerHTML='';for(var gi=0;gi<glitches.length;gi++){(function(g,ii){var d=document.createElement('div');d.className='ri g';
    d.innerHTML='<span class="rt" onclick="jmp('+g.timeSec+')">'+g.time+'</span><span class="rs">#'+g.sentenceIndex+'</span><span class="rc">'+hl(g.context)+'</span><input placeholder="Note" value="'+(g.note||'').replace(/"/g,'&quot;')+'" oninput="glitches['+ii+'].note=this.value;scheduleAutoSave()"><button class="rm" onclick="glitches.splice('+ii+',1);renderGlitches();scheduleAutoSave()">\u2715</button>';
    l.appendChild(d)})(glitches[gi],gi)}}

function renderFlags(){
  var l=document.getElementById('fl');
  // Mettre a jour le compteur "X a revoir" du bouton filtre en temps reel
  updateFilterBtnCount();
  // Compter les categories
  var greenCount = 0, approvedCount = 0;
  flags.forEach(function(f){
    if (isApproved(f)) approvedCount++;
    else if (isResolved(f)) greenCount++;
  });
  // Afficher/cacher le bouton batch "Approuver les verts"
  var btnApprove = document.getElementById('btnApproveGreens');
  if (btnApprove) {
    if (greenCount > 0) {
      btnApprove.textContent = '\u2713 Approuver les ' + greenCount + ' corrige' + (greenCount>1?'s':'');
      btnApprove.style.display = 'inline-block';
    } else {
      btnApprove.style.display = 'none';
    }
  }
  // Mettre a jour le toggle "Afficher approuves"
  var tog = document.getElementById('toggleApproved');
  if (tog) {
    if (approvedCount > 0) {
      tog.textContent = showApproved
        ? 'Cacher les ' + approvedCount + ' approuve' + (approvedCount>1?'s':'')
        : 'Afficher les ' + approvedCount + ' approuve' + (approvedCount>1?'s':'');
      tog.style.display = 'inline-block';
    } else {
      tog.style.display = 'none';
    }
  }
  // Empty state
  var totalVisible = 0;
  flags.forEach(function(f){ if (showApproved || !isHidden(f)) totalVisible++; });
  if(!totalVisible){l.innerHTML='<div class="empty">'+(flags.size?'Tous les flags ont ete approuves apres regen':'Clique sur les mots qui sonnent mal')+'</div>';return}
  l.innerHTML='';var sorted=Array.from(flags.entries()).sort(function(a,b){return a[0]-b[0]});
  for(var k=0;k<sorted.length;k++){(function(ii,d){
    // Masquer les flags approuves OU auto_resolved sauf si showApproved
    if (isHidden(d) && !showApproved) return;
    var resolved = isResolved(d);
    var approved = isApproved(d);
    var autoResolved = isAutoResolved(d);
    var el=document.createElement('div');
    el.className='ri ' + (approved || autoResolved ? 'ok' : (resolved ? 'ok' : 'f'));
    if (approved || autoResolved) el.style.opacity = '0.55';
    // Selecteur de categorie : permet a Nicolas de distinguer
    // - pronunciation : ElevenLabs prononce mal un mot correctement ecrit -> enrichir le dict
    // - typo : le scriptwriter a ecrit un mot qui n'existe pas -> corriger le .md, NE PAS enrichir dict
    // - rewrite : la phrase entiere est mal tournee -> phrase_patterns Supabase
    var currentCat = d.category || 'pronunciation';
    var catSelect = '<select class="rcat" onchange="flags.get('+ii+').category=this.value;scheduleAutoSave()" title="Categorie du flag">'
      + '<option value="pronunciation"' + (currentCat==='pronunciation'?' selected':'') + '>prononciation</option>'
      + '<option value="typo"' + (currentCat==='typo'?' selected':'') + '>faute de frappe</option>'
      + '<option value="rewrite"' + (currentCat==='rewrite'?' selected':'') + '>phrase a reecrire</option>'
      + '</select>';
    el.innerHTML='<span class="rt" onclick="jmp('+(W[ii]?W[ii].start:0)+')">'+d.time+'</span><span class="rs">#'+(d.sentenceIndex!=null?d.sentenceIndex:'?')+'</span><span class="rw">'+d.word+'</span>'+catSelect+'<span class="rc">'+hl(d.context)+'</span><input placeholder="Note" value="'+(d.note||'').replace(/"/g,'&quot;')+'" oninput="flags.get('+ii+').note=this.value;scheduleAutoSave()"><button class="rm" onclick="flags.delete('+ii+');if(els['+ii+']){els['+ii+'].classList.remove(\'flagged\');els['+ii+'].classList.remove(\'resolved\');els['+ii+'].classList.remove(\'approved\')}renderFlags();scheduleAutoSave()">\u2715</button>';
    l.appendChild(el)})(sorted[k][0],sorted[k][1])}
}

// Approuve tous les flags verts (resolved) d'un coup
function approveAllGreens(){
  var changed = 0;
  flags.forEach(function(f,ii){
    if (isResolved(f) && !isApproved(f)) {
      f.approved_after_regen = true;
      f.approved_at = new Date().toISOString();
      flags.set(ii, f);
      if (els[ii]) {
        els[ii].classList.remove('resolved');
        els[ii].classList.add('approved');
      }
      changed++;
    }
  });
  if (changed > 0) {
    renderFlags();
    scheduleAutoSave();
  }
}

// Toggle affichage des flags approuves
function toggleShowApproved(){
  showApproved = !showApproved;
  renderFlags();
}

function jmp(t){if(!au)return;au.currentTime=Math.max(0,t-0.5);if(au.paused)au.play()}

// Auto-save (D4) : debounce de 2s apres la derniere modification
function scheduleAutoSave(){
  dirty = true;
  if (saveTimer) clearTimeout(saveTimer);
  showMsg('●', 'saving');
  saveTimer = setTimeout(function(){
    saveReview(false, true);
  }, 2000);
}

function saveReview(approved, isAuto){
  if (!L) return;
  var rn = (localStorage.getItem('rn') || 'Anonyme').trim();
  var lessonId = L.lesson_key.split('/').slice(1).join('/');
  if (isAuto) showMsg('Sauvegarde...', 'saving');
  fetch(API+'/voice_reviews?on_conflict=lesson_key,reviewer_name',{
    method:'POST',
    headers:Object.assign({},H,{'Content-Type':'application/json','Prefer':'resolution=merge-duplicates,return=minimal'}),
    body:JSON.stringify({
      lesson_key: L.lesson_key,
      course_id: L.course_id,
      lesson_id: lessonId,
      lesson_title: L.short_title ? '['+L.course_id+'] '+L.short_title : L.title,
      reviewer_name: rn,
      flags: Array.from(flags.values()),
      glitches: glitches,
      approved: !!approved,
      updated_at: new Date().toISOString()
    })
  }).then(function(r){
    if (r.ok) {
      dirty = false;
      showMsg(approved ? '\u2713 Approuve!' : (isAuto ? '\u2713 Auto-sauvegarde' : '\u2713 Sauvegarde!'));
    } else {
      showMsg('Erreur '+r.status);
    }
  }).catch(function(e){
    showMsg('Erreur: '+e.message);
  });
}

// Confirm approve modal (D5)
function askApprove(){
  document.getElementById('modal-bg').classList.add('open');
}
function closeModal(){
  document.getElementById('modal-bg').classList.remove('open');
}
function confirmApprove(){
  closeModal();
  saveReview(true);
}

function copyReview(){var t='Lecon: '+(L.short_title||L.title)+'\n';
  if(glitches.length){t+='\nStutters:\n';for(var i=0;i<glitches.length;i++){var g=glitches[i];t+='- ['+g.time+'] #'+g.sentenceIndex+' "'+((g.context||'').replace(/\*\*/g,''))+'"';if(g.note)t+=' \u2192 '+g.note;t+='\n'}}
  var sf=Array.from(flags.values()).sort(function(a,b){return a.index-b.index});
  if(sf.length){t+='\nMots:\n';for(var j=0;j<sf.length;j++){var f=sf[j];t+='- ['+f.time+'] #'+f.sentenceIndex+' "'+((f.context||'').replace(/\*\*/g,''))+'"';if(f.note)t+=' \u2192 '+f.note;t+='\n'}}
  navigator.clipboard.writeText(t);showMsg('Copie!')}

function showMsg(t, cls){var m=document.getElementById('msg');m.textContent=t;m.className='msg'+(cls?' '+cls:'');if(!cls)setTimeout(function(){m.textContent=''},2500)}

// Cherche le debut de la prochaine phrase regeneree (>=t). Retourne null si aucune.
function nextRegenStart(t){
  if (!regenIndices || !regenIndices.length) return null;
  var best = null;
  for (var i = 0; i < regenIndices.length; i++) {
    var si = regenIndices[i];
    var r = sentenceRanges[si];
    if (!r) continue;
    if (r.start >= t - 0.05 && (best === null || r.start < best)) best = r.start;
  }
  return best;
}

// Verifie si le temps t tombe dans une phrase qu'on doit skipper en mode filtre.
// Si oui, avance currentTime a la prochaine phrase regeneree (ou pause a la fin).
function maybeSkipUnregen(){
  if (!filterModeActive || !regenIndices || !au) return false;
  var t = au.currentTime;
  // Chercher dans quelle phrase on se trouve actuellement
  var currentSi = -1;
  for (var i = 0; i < W.length; i++) {
    if (W[i].start > t) break;
    if (W[i].sentenceIndex != null) currentSi = W[i].sentenceIndex;
  }
  if (currentSi < 0) return false;
  // Si la phrase courante est dans regenIndices -> on laisse jouer
  if (regenIndices.indexOf(currentSi) !== -1) return false;
  // Sinon : chercher la prochaine phrase a revoir et y sauter
  var jumpTo = nextRegenStart(t);
  if (jumpTo !== null) {
    au.currentTime = jumpTo;
    return true;
  }
  // Plus aucune phrase a revoir apres ce point -> pause
  au.pause();
  return true;
}

// Audio sync
// LEAD_TIME : on avance le surlignage de 80ms pour compenser la latence de perception
// (l'oeil voit le mot avant de l'entendre, ce qui donne l'impression que c'est synchronise).
// Si un mot a un word.end, on retire le "now" des que t > end pour eviter qu'un mot
// termine reste allume pendant les pauses.
var LEAD_TIME = 0.08;
function sync(){var t=au.currentTime + LEAD_TIME;
  // Auto-skip en mode filtre : saute les phrases non a revoir pendant la lecture
  if (maybeSkipUnregen()) { if(!au.paused) requestAnimationFrame(sync); return; }
  // Recherche binaire : dernier mot dont start <= t
  var ii=-1,lo=0,hi=W.length-1;
  while(lo<=hi){var m=(lo+hi)>>1;if(t>=W[m].start){ii=m;lo=m+1}else{hi=m-1}}
  // Si le mot courant a un word.end et qu'on l'a depasse, aucun mot "now" actuellement
  // (on est dans une pause inter-mots). On garde ii pour marquer "spoken" jusqu'a la mais
  // on ne met pas la classe .now.
  var activeIdx = ii;
  if (ii >= 0 && W[ii] && W[ii].end != null && t > W[ii].end) {
    activeIdx = -1; // pause, pas de mot actif
  }
  if(activeIdx!==prevIdx){
    if(prevIdx>=0&&els[prevIdx])els[prevIdx].classList.remove('now');
    // Marquer "spoken" tous les mots jusqu'a ii (inclus) meme si on est en pause apres
    for(var i=Math.max(0,prevIdx);i<=ii&&i<els.length;i++)if(els[i])els[i].classList.add('spoken');
    if(activeIdx>=0&&els[activeIdx]){els[activeIdx].classList.add('now');els[activeIdx].classList.add('spoken');
      var r=els[activeIdx].getBoundingClientRect(),cr=document.getElementById('wc').getBoundingClientRect();
      if(r.bottom>cr.bottom-20||r.top<cr.top+20)els[activeIdx].scrollIntoView({behavior:'smooth',block:'center'})}
    prevIdx=activeIdx
  }
  var d=au.duration||0;var rt=au.currentTime;
  document.getElementById('pfill').style.width=d?(rt/d*100)+'%':'0%';
  document.getElementById('ti').textContent=fmt(rt)+' / '+fmt(d);
  if(!au.paused)requestAnimationFrame(sync)}

function tg(){
  if(!au)return;
  if(au.paused){
    // Si mode filtre actif et qu'on est sur une phrase non-a-revoir, sauter direct au bon endroit
    if (filterModeActive && regenIndices) {
      var t = au.currentTime;
      var currentSi = -1;
      for (var i=0;i<W.length;i++){ if(W[i].start>t)break; if(W[i].sentenceIndex!=null) currentSi = W[i].sentenceIndex; }
      if (currentSi < 0 || regenIndices.indexOf(currentSi) === -1) {
        var jumpTo = nextRegenStart(t);
        if (jumpTo !== null) au.currentTime = jumpTo;
      }
    }
    au.play();
  } else au.pause();
}
function seek(e){if(!au)return;var b=document.getElementById('pbar');var go=function(ev){var r=b.getBoundingClientRect();au.currentTime=Math.max(0,Math.min(1,(ev.clientX-r.left)/r.width))*(au.duration||0)};
  go(e);var mv=function(ev){go(ev)};var up=function(){document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up)};
  document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up)}
function setSpd(s,b){if(!au)return;au.playbackRate=s;var btns=document.querySelectorAll('.spd');for(var i=0;i<btns.length;i++)btns[i].classList.remove('on');b.classList.add('on')}

// Keyboard shortcuts (D3)
document.addEventListener('keydown', function(e){
  // Ne pas intercepter si on tape dans un input
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  // Space : play/pause
  if (e.code === 'Space') { e.preventDefault(); tg(); return; }
  // J : -10s
  if (e.key === 'j' || e.key === 'J') {
    if (au) { au.currentTime = Math.max(0, au.currentTime - 10); }
    return;
  }
  // K : +10s
  if (e.key === 'k' || e.key === 'K') {
    if (au) { au.currentTime = Math.min(au.duration || 0, au.currentTime + 10); }
    return;
  }
  // S : stutter
  if (e.key === 's' || e.key === 'S') {
    if (!e.ctrlKey && !e.metaKey) { flagStutter(); return; }
  }
  // Ctrl+S : save
  if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    saveReview(false);
    return;
  }
  // F : toggle filtre phrases regenerees
  if (e.key === 'f' || e.key === 'F') {
    if (!e.ctrlKey && !e.metaKey) { toggleFilterMode(); return; }
  }
  // Escape : fermer le modal
  if (e.key === 'Escape') closeModal();
});

// ═══════════════════════════════════════════════════════════════
// SENTENCE FLAGS — flagger une phrase entiere (pas juste un mot)
// ═══════════════════════════════════════════════════════════════
// Table Supabase : sentence_flags (migration 011)
// 4 types : rewrite | regen | partial | delete
// Traite par apply-review-corrections.mjs --sentences

var currentFlaggingSi = null; // sentenceIndex en cours d'edition

// Extrait le texte complet d'une phrase a partir des mots W
function getSentenceText(si){
  var parts = [];
  for (var i=0; i<W.length; i++){
    if (W[i].sentenceIndex === si) parts.push(W[i].word);
  }
  return parts.join(' ');
}

// Ouvre le modal Flag phrase pour un sentenceIndex donne
function openSentenceModal(si){
  currentFlaggingSi = si;
  var text = getSentenceText(si);
  document.getElementById('sentence-modal-title').innerHTML = '\uD83D\uDCCD Flagger phrase #' + si;
  document.getElementById('sentence-modal-preview').textContent = text;
  // Reset form
  document.querySelectorAll('input[name="flagType"]').forEach(function(r){r.checked=false});
  document.getElementById('sentence-corrected').value = '';
  document.getElementById('sentence-partial-from').value = '';
  document.getElementById('sentence-partial-to').value = '';
  document.getElementById('sentence-note').value = '';
  document.getElementById('field-corrected').style.display = 'none';
  document.getElementById('field-partial').style.display = 'none';
  document.getElementById('sentence-modal-msg').textContent = '';
  // Charger les flags existants pour cette phrase (pour voir ceux deja poses)
  loadExistingSentenceFlags(si);
  // Afficher
  document.getElementById('sentence-modal-bg').classList.add('open');
}

function closeSentenceModal(){
  document.getElementById('sentence-modal-bg').classList.remove('open');
  currentFlaggingSi = null;
}

// Affiche/cache les champs selon le type selectionne
function onFlagTypeChange(){
  var type = document.querySelector('input[name="flagType"]:checked');
  if (!type) return;
  document.getElementById('field-corrected').style.display = (type.value === 'rewrite') ? 'block' : 'none';
  document.getElementById('field-partial').style.display = (type.value === 'partial') ? 'block' : 'none';
}

// Recupere les flags existants pour cette phrase et les affiche en note
function loadExistingSentenceFlags(si){
  if (!L) return;
  fetch(API+'/sentence_flags?lesson_key=eq.'+encodeURIComponent(L.lesson_key)+'&sentence_index=eq.'+si+'&order=created_at.desc',{headers:H})
    .then(function(r){return r.json()})
    .then(function(rows){
      if (!rows.length) return;
      var msg = document.getElementById('sentence-modal-msg');
      msg.textContent = '\u26A0 ' + rows.length + ' flag(s) deja pose(s) sur cette phrase';
    }).catch(function(){});
}

// Envoie le flag vers Supabase
function submitSentenceFlag(){
  if (currentFlaggingSi === null || !L) return;
  var type = document.querySelector('input[name="flagType"]:checked');
  if (!type) {
    document.getElementById('sentence-modal-msg').textContent = 'Choisis un type d\'abord';
    return;
  }
  var rn = (localStorage.getItem('rn') || 'Anonyme').trim();
  var payload = {
    lesson_key: L.lesson_key,
    sentence_index: currentFlaggingSi,
    flag_type: type.value,
    original_text: getSentenceText(currentFlaggingSi),
    note: document.getElementById('sentence-note').value || null,
    reviewer_name: rn,
  };
  if (type.value === 'rewrite') {
    payload.corrected_text = document.getElementById('sentence-corrected').value || null;
    if (!payload.corrected_text) {
      document.getElementById('sentence-modal-msg').textContent = 'Le nouveau texte est requis';
      return;
    }
  } else if (type.value === 'partial') {
    payload.partial_original = document.getElementById('sentence-partial-from').value || null;
    payload.partial_replacement = document.getElementById('sentence-partial-to').value || null;
    if (!payload.partial_original || !payload.partial_replacement) {
      document.getElementById('sentence-modal-msg').textContent = 'Les deux morceaux sont requis';
      return;
    }
  }
  document.getElementById('sentence-modal-msg').textContent = 'Sauvegarde...';
  fetch(API+'/sentence_flags', {
    method: 'POST',
    headers: Object.assign({}, H, {'Content-Type':'application/json','Prefer':'return=minimal'}),
    body: JSON.stringify(payload),
  }).then(function(r){
    if (r.ok) {
      document.getElementById('sentence-modal-msg').textContent = '\u2713 Sauvegarde !';
      setTimeout(closeSentenceModal, 800);
    } else {
      r.text().then(function(t){
        document.getElementById('sentence-modal-msg').textContent = 'Erreur ' + r.status + ' : ' + t.slice(0,100);
      });
    }
  }).catch(function(e){
    document.getElementById('sentence-modal-msg').textContent = 'Erreur : ' + e.message;
  });
}

// Fermer le modal avec Escape (en plus du modal approve existant)
document.addEventListener('keydown', function(e){
  if (e.key === 'Escape' && document.getElementById('sentence-modal-bg').classList.contains('open')) {
    closeSentenceModal();
  }
});

// Warn avant de quitter si dirty
window.addEventListener('beforeunload', function(e){
  if (dirty) {
    e.preventDefault();
    e.returnValue = 'Tu as des changements non sauvegardes. Quitter quand meme ?';
  }
});

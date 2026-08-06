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
  // rnRaw = nom EXPLICITEMENT choisi par le reviseur (vide s'il n'en a jamais mis).
  var rnRaw = (localStorage.getItem('rn') || '').trim();
  var rn = rnRaw || 'Anonyme';
  // Charger TOUTES les reviews de la lecon (plus seulement la sienne). On prefere la sienne si elle
  // existe ; sinon on AFFICHE celle d'un autre reviseur (ex. Hela) pour que Nicolas voie son travail.
  // (Avant : filtre reviewer_name=eq.moi -> on ne voyait jamais les flags des autres.)
  fetch(API+'/voice_reviews?lesson_key=eq.'+encodeURIComponent(L.lesson_key)+'&select=*&order=updated_at.desc',{headers:H})
    .then(function(r){return r.json()})
    .then(function(rows){
      if (!Array.isArray(rows) || !rows.length) { window.viewingOtherReview = null; maybeOfferLocalRestore(null); return; }
      // SIMPLIFICATION (2026-07-01) : sans nom explicite, on ADOPTE le reviseur existant de la lecon.
      // Sinon Hela — dont la review est deja sous "héla" mais dont le navigateur n'a pas de nom
      // enregistre — se retrouvait bloquee en LECTURE SEULE sur SA PROPRE review, incapable
      // d'approuver. (Nicolas garde la lecture seule seulement s'il a mis son propre nom.)
      if (!rnRaw && rows[0] && rows[0].reviewer_name) {
        rn = rows[0].reviewer_name.trim();
        try { localStorage.setItem('rn', rn); } catch (e) {}
      }
      var rnN = rn.toLowerCase();
      var mine = null, other = null;
      for (var i = 0; i < rows.length; i++) {
        var rname = (rows[i].reviewer_name || '').trim();
        // Match INSENSIBLE a la casse/aux espaces : "Héla" / "héla" / "hela " = la meme personne.
        // Avant, une simple difference de casse bloquait Hela en LECTURE SEULE sur sa PROPRE review
        // (« je ne peux pas approuver », 2026-07-01).
        if (rname.toLowerCase() === rnN) { if (!mine) mine = rows[i]; }
        else if (!other && Array.isArray(rows[i].flags) && rows[i].flags.length) other = rows[i];
      }
      var rev = mine || other || rows[0];
      // Si on a retrouve NOTRE review malgre une casse differente, aligner le nom local sur celui
      // enregistre -> on edite/sauvegarde la BONNE ligne (pas de doublon) et on n'est pas en lecture seule.
      if (mine && mine.reviewer_name && mine.reviewer_name !== rn) {
        try { localStorage.setItem('rn', mine.reviewer_name); } catch (e) {}
        rn = mine.reviewer_name;
      }
      // Etat d'approbation persistant : seule MA propre review compte (pas celle d'un autre).
      lessonApproved = !!(mine && mine.approved);
      // Mode LECTURE si on affiche la review d'un AUTRE reviseur : on ne sauvegarde pas sous son nom.
      if (rev && rev.reviewer_name !== rn) {
        window.viewingOtherReview = rev.reviewer_name;
        if (typeof showViewingBanner === 'function') showViewingBanner(rev.reviewer_name);
      } else {
        window.viewingOtherReview = null;
      }
      if (Array.isArray(rev.flags)) {
        rev.flags.forEach(function(f){
          // Rafraichir le contexte depuis les timestamps actuels — MAIS seulement si le
          // re-calcul retombe bien sur le mot flagge. Apres une regen, les index bougent et
          // un re-calcul aveugle surlignerait le mauvais mot (bug Hela 2026-06-08). Si ca ne
          // correspond plus, on garde le contexte d'origine (correct au moment du flag).
          if (Array.isArray(f.groupIndices) && f.groupIndices.length > 0) {
            var newGCtx = getGroupCtx(f.groupIndices);
            if (newGCtx && newGCtx !== f.context && boldWords(newGCtx) === (f.word||'').trim()) {
              f.context = newGCtx;
              dirty = true;
            }
          } else if (typeof f.index === 'number' && W[f.index]) {
            var newCtx = getCtx(f.index);
            if (newCtx && newCtx !== f.context && ctxHasWord(newCtx, f.word)) {
              f.context = newCtx;
              dirty = true;
            }
          }
          flags.set(f.index, f);
          // Marquer le leader + tous les membres du groupe avec flagged/grouped
          var isGroup = Array.isArray(f.groupIndices) && f.groupIndices.length > 1;
          var memberIndices = isGroup ? f.groupIndices : [f.index];
          memberIndices.forEach(function(memberIdx){
            if (!els[memberIdx]) return;
            // Audit 2026-06-10 : un flag REGLE (approuve apres regen ou auto-
            // resolu) ne marque PLUS le mot — Hela voyait des soulignements
            // sur des mots deja corriges et les re-flaggait pour rien.
            if (f.reflagged) els[memberIdx].classList.add('flagged','reflagged');
            else if (isApproved(f) || isAutoResolved(f)) { /* regle : aucune marque */ }
            else if (isResolved(f)) els[memberIdx].classList.add('resolved');
            else els[memberIdx].classList.add('flagged');
            if (isGroup) els[memberIdx].classList.add('grouped');
          });
        });
      }
      if (Array.isArray(rev.glitches)) glitches = rev.glitches.slice();
      renderFlags();
      renderGlitches();
      if (typeof applyCorrectionStatuses === 'function') applyCorrectionStatuses();
      // Les flags viennent d'etre charges -> verdir ceux dont la correction est deja
      // faite ET visible (idempotent ; re-tente aussi au polling, quel que soit l'ordre).
      if (typeof augmentResolvedFromCorrections === 'function') augmentResolvedFromCorrections();
      // Le rafraichissement du contexte ci-dessus (apres une regen) a pu mettre dirty=true, mais ce
      // n'est PAS une edition de l'utilisateur -> une lecon fraichement chargee doit etre "propre".
      // Sinon le garde-fou beforeunload affiche « Leave site? » a CHAQUE navigation (bug signale).
      dirty = false;
      // Filet anti-perte : si un backup local plus recent que le serveur existe (crash/fermeture),
      // proposer de le restaurer. Jamais en lecture seule (rev est NOTRE review ici).
      if (!window.viewingOtherReview) maybeOfferLocalRestore(rev);
    })
    .catch(function(e){
      // Echec reseau/JSON : on degrade proprement (les mots sont deja affiches, la page reste
      // utilisable) au lieu de laisser une promesse rejetee non geree.
      if (typeof captureWithContext === 'function') captureWithContext(e, {action:'loadExistingReview', lesson_key: L && L.lesson_key});
      else if (typeof console !== 'undefined') console.error('loadExistingReview failed', e);
    });
}

// Bandeau « tu regardes la review d'un autre reviseur » (ex. Nicolas qui supervise Hela).
// Mode LECTURE : on voit ses flags + le panneau « Corrections faites », mais rien ne s'enregistre
// sous le nom de l'observateur (pas d'ecrasement du travail d'Hela).
function showViewingBanner(name){
  var el = document.getElementById('viewing-banner');
  if (!el) return;
  el.innerHTML = '<strong>\u{1F441}️ Tu regardes la review de ' + (name || '?') + '</strong><br>'
    + 'Lecture seule : tu vois ses mots flaggés et, dans « Corrections faites », ce qui a été corrigé. '
    + 'Tes clics ne sont pas enregistrés (pour ne pas écraser son travail).';
  el.classList.remove('hidden');
}

// Restauration du backup local (anti-perte). Appelee apres le chargement de la review serveur.
// Ne restaure QUE si le backup local est strictement plus recent que le serveur (crash avant flush).
// rev = la review serveur choisie (NOTRE review, car appelee seulement si !viewingOtherReview) ou null.
function maybeOfferLocalRestore(rev){
  if (window.viewingOtherReview) return;          // jamais par-dessus le travail d'un autre reviseur
  if (typeof backupKey !== 'function') return;    // player.js charge -> dispo au runtime
  var raw; try { raw = localStorage.getItem(backupKey()); } catch (e) { return; }
  if (!raw) return;
  var bak; try { bak = JSON.parse(raw); } catch (e) { clearLocalBackup(); return; }
  if (!bak || bak.lesson_key !== (L && L.lesson_key)) return;
  if (!XGReview.shouldRestoreBackup(bak.ts, rev && rev.updated_at)) { clearLocalBackup(); return; }
  var n = (bak.flags ? bak.flags.length : 0) + (bak.glitches ? bak.glitches.length : 0);
  if (!n) { clearLocalBackup(); return; }
  var ok = window.confirm('Recuperation : ' + n + ' element(s) non sauvegardes ont ete retrouves sur cet ordinateur (plus recents que la version serveur). Les restaurer ?');
  if (!ok) { clearLocalBackup(); return; }
  flags.clear();
  (bak.flags || []).forEach(function(f){ if (f && f.index != null) flags.set(f.index, f); });
  glitches = (bak.glitches || []).slice();
  if (typeof refreshFlagClasses === 'function') refreshFlagClasses();
  renderFlags();
  renderGlitches();
  dirty = true;
  scheduleAutoSave();   // re-sync immediat au serveur + re-ecrit le backup proprement
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
      if (s.voiceover_uploaded_at) {
        parts.push('Dernier upload : <strong>'+fmtDate(s.voiceover_uploaded_at)+'</strong>');
        // Cache-buster stable base sur la date d'upload : meme version = cache hit,
        // nouvelle version = re-download. Remplace le Date.now() initial.
        if (au) {
          var stableBust = encodeURIComponent(s.voiceover_uploaded_at);
          // Detecter si on est sur preview/ (Edge TTS) ou path final (ElevenLabs)
          var isPreviewSrc = au.src && au.src.indexOf('/preview/') !== -1;
          var basePath = isPreviewSrc ? '/preview/' : '/';
          var newSrc = STORAGE + basePath + L.lesson_key + '/voiceover.mp3?v=' + stableBust;
          if (au.src.indexOf('?v=' + stableBust) === -1) {
            var t = au.currentTime;
            var wasPlaying = !au.paused;
            au.src = newSrc;
            au.currentTime = t;
            if (wasPlaying) au.play();
          }
          // Mismatch timestamps/audio : les timestamps viennent d'un autre chemin
          // que l'audio (ex : timestamps preview mais audio ElevenLabs final).
          // On recharge les timestamps depuis le bon chemin pour corriger le desync.
          var expectedTsSource = isPreviewSrc ? 'preview' : 'final';
          if (W_source !== expectedTsSource) {
            var bust2 = '?v=' + Date.now();
            var tsBase = isPreviewSrc ? (STORAGE + '/preview/') : (STORAGE + '/');
            var tsUrl1 = tsBase + L.lesson_key + '/voiceover-timestamps.json' + bust2;
            var tsUrl2 = tsBase + L.lesson_key + '/timestamps.json' + bust2;
            // Recharger depuis le bon chemin, garder le meilleur des 2
            Promise.all([tsUrl1, tsUrl2].map(function(u){
              return fetch(u).then(function(r){return r.ok ? r.json() : null}).catch(function(){return null});
            })).then(function(res){
              // Prendre le premier valide avec sentenceIndex 0
              var fixed = null;
              for (var k = 0; k < res.length; k++) {
                var c = res[k];
                if (!Array.isArray(c) || !c.length) continue;
                if (c.some(function(w){return w.sentenceIndex === 0})) { fixed = c; break; }
              }
              if (fixed) {
                W = fixed;
                W_source = expectedTsSource;
                computeSentenceRanges();
                buildWords();
              }
            });
          }
        }
      }
      if (s.voiceover_version && s.voiceover_version > 1) parts.push('Version <strong>'+s.voiceover_version+'</strong>');
      if (s.regen_source) parts.push('Source : <strong>'+s.regen_source+'</strong>');
      if (parts.length) {
        infoBar.innerHTML = parts.join('<span class="sep">·</span>');
        infoBar.style.display = 'flex';
      }

      if (s.status === 'needs_recheck') {
        lessonNeedsRecheck = true;
        // Langage clair (audit 2026-06-10) : dire QUOI FAIRE, pas juste l'etat.
        // Le texte suppose qu'il y a des phrases en vert. Quand il n'y en a pas,
        // majBandeauRecheck() le reecrit — voir plus bas.
        document.getElementById('recheck-banner').innerHTML =
          '<strong>🆕 La voix a ete refaite le ' + fmtDate(s.voiceover_uploaded_at) + '</strong><br>'
          + 'Tu avais approuve l\'ancienne version le ' + fmtDate(s.latest_review_at) + '. '
          + 'Seules les phrases changees sont a re-ecouter — elles sont surlignees en vert '
          + 'et le filtre <strong>🔍 a revoir</strong> s\'active tout seul pour te les montrer.';
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

  // Ajouter le numero de sous-lecon (ex: "M3 / 1.2 - Introduction") quand c'est une sous-lecon
  var baseTitle = L.short_title || L.title;
  var lessonIdx = parseFloat(L.lesson_index);
  if (lessonIdx && lessonIdx !== Math.floor(lessonIdx)) {
    // Sous-lecon (ex 1.2, 3.3) — inserer le numero apres "MX / "
    var subNum = lessonIdx.toFixed(1);  // "1.2"
    if (baseTitle.match(/^M\d+\s*\/\s*/)) {
      baseTitle = baseTitle.replace(/^(M\d+\s*\/)\s*/, '$1 ' + subNum + ' — ');
    } else {
      baseTitle = subNum + ' — ' + baseTitle;
    }
  } else if (lessonIdx) {
    // Lecon entiere (ex 1, 2, 3) — ajouter le numero apres "MX / "
    if (baseTitle.match(/^M\d+\s*\/\s*/)) {
      baseTitle = baseTitle.replace(/^(M\d+\s*\/)\s*/, '$1 ' + lessonIdx + ' — ');
    }
  }
  document.getElementById('title').textContent = baseTitle;

  var nav = document.getElementById('nav');
  nav.innerHTML = '<a href="course.html?course='+encodeURIComponent(L.course_id)+'">← Cours</a>'
    + '<a href="index.html">Index</a>';

  // Cache-buster initial (Date.now) pour forcer un fresh load a chaque ouverture.
  // Sera remplace par ?v=<voiceover_uploaded_at> quand loadStatus() recoit la metadata.
  // Test si le voiceover existe au path final, sinon fallback sur preview/ (Edge TTS).
  var initialBust = Date.now();
  var primaryUrl = STORAGE + '/' + L.lesson_key + '/voiceover.mp3?v=' + initialBust;
  var previewUrl = STORAGE + '/preview/' + L.lesson_key + '/voiceover.mp3?v=' + initialBust;
  au = new Audio(primaryUrl);
  // HEAD check non bloquant — si primary 4xx, swap vers preview
  fetch(primaryUrl, {method:'HEAD'}).then(function(r){
    if (!r.ok) au.src = previewUrl;
  }).catch(function(){ au.src = previewUrl; });
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
  // Cache-buster pour eviter de servir un timestamps.json desync de la nouvelle MP3
  var bust = '?v=' + Date.now();
  // On essaie 4 paths. ORDRE DE PRIORITE:
  // 1-2. /preview/ (Edge TTS recent) — prioritaire car les vieux uploads ElevenLabs
  //      peuvent encore exister sur path final.
  // 3-4. path final (ElevenLabs production / fallback)
  var urls = [
    STORAGE + '/preview/' + L.lesson_key + '/voiceover-timestamps.json' + bust,
    STORAGE + '/preview/' + L.lesson_key + '/timestamps.json' + bust,
    STORAGE + '/' + L.lesson_key + '/voiceover-timestamps.json' + bust,
    STORAGE + '/' + L.lesson_key + '/timestamps.json' + bust
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
  // Strategie : prendre le PREMIER candidat valide (ordre = priorite).
  // /preview/ vient d'abord — si il existe, on l'utilise (Edge TTS recent).
  // Les anciens timestamps ElevenLabs sur path final sont ignores.
  // Note : si l'audio est au chemin final (ElevenLabs), loadStatus() corrigera
  // un eventuel mismatch en rechargeant les timestamps depuis le bon chemin.
  // Selection (logique pure testee dans lib/review-logic.js) : meilleur jeu de timestamps + source.
  var sel = XGReview.pickBestTimestamps(candidates);
  W_source = sel.source;
  var best = sel.words;
  if (!best) {
    // Pas de timestamps trouves. Deux cas tres differents a distinguer :
    //  (a) lecon-conteneur SANS voiceover (brouillon, jamais produite) -> etat propre.
    //  (b) vraie lecon produite mais timestamps absents/corrompus -> vrai bug technique.
    // On tranche en regardant voiceover_uploaded_at en base (lesson_status).
    fetch(API+'/lesson_status?lesson_key=eq.'+encodeURIComponent(L.lesson_key)+'&select=voiceover_uploaded_at',{headers:H})
      .then(function(r){return r.json()})
      .then(function(rows){
        var hasVoice = rows && rows.length && rows[0].voiceover_uploaded_at;
        if (hasVoice) renderTimestampError(); else renderDraftState();
      })
      .catch(function(){ renderTimestampError(); });
    return;
  }
  W = best;
  computeSentenceRanges();
  buildWords();
  loadExistingReview();
  loadStatus();
  loadHistory();
  try { if (typeof loadCorrectionsLog === 'function') loadCorrectionsLog(); } catch (e) {}
  loadRegenIndices();
  // Declencheur FIABLE du statut des corrections : avant, pollCorrectionStatus n'etait
  // appele que depuis renderFlags (apres un return anticipe si aucun flag visible) -> souvent
  // jamais lance -> correctionStatuses vide -> ni "Corrigé", ni verdissement (bug Hela). On le
  // lance ici, dans la sequence de chargement, quoi qu'il arrive.
  try { window._corrInit = true; if (typeof pollCorrectionStatus === 'function') pollCorrectionStatus(); } catch (e) {}
  checkCourseArchived();
}

// Recharge UNIQUEMENT les timestamps (W) apres une regeneration, puis reconstruit le
// TEXTE affiche — SANS recharger la review (les flags en cours d'Hela sont preserves).
// Corrige le bug "la correction approuvee n'apparait pas dans le texte de la lecon"
// (Hela 2026-06-30) : avant, le texte du haut restait fige sur l'ancien W tant qu'on
// ne rechargeait pas la page (et meme un refresh ne suffisait pas si le storage etait
// deja frais mais W en memoire perime). On reutilise le meme choix de timestamps que
// le chargement initial (XGReview.pickBestTimestamps), puis on repeint les flags depuis
// la Map en memoire (refreshFlagClasses) sans toucher voice_reviews.
function reloadWords(){
  if (!L) return;
  var bust = '?v=' + Date.now();
  var urls = [
    STORAGE + '/preview/' + L.lesson_key + '/voiceover-timestamps.json' + bust,
    STORAGE + '/preview/' + L.lesson_key + '/timestamps.json' + bust,
    STORAGE + '/' + L.lesson_key + '/voiceover-timestamps.json' + bust,
    STORAGE + '/' + L.lesson_key + '/timestamps.json' + bust
  ];
  var results = [];
  var done = 0;
  urls.forEach(function(url, idx){
    fetch(url)
      .then(function(r){ return r.ok ? r.json() : null; })
      .catch(function(){ return null; })
      .then(function(data){
        results[idx] = data;
        done++;
        if (done !== urls.length) return;
        var sel = XGReview.pickBestTimestamps(results);
        if (!sel || !sel.words) return; // rien de frais -> on garde l'affichage courant
        W = sel.words;
        W_source = sel.source;
        computeSentenceRanges();
        buildWords();
        try { if (typeof refreshFlagClasses === 'function') refreshFlagClasses(); } catch (e) {}
        try { if (typeof applyCorrectionStatuses === 'function') applyCorrectionStatuses(); } catch (e) {}
        // Le texte vient de changer -> re-verifier quelles corrections sont visibles.
        try { if (typeof augmentResolvedFromCorrections === 'function') augmentResolvedFromCorrections(); } catch (e) {}
      });
  });
}

// Etat "brouillon" : lecon-conteneur sans voiceover produit. On cache le lecteur audio ET
// tout le panneau de review (sinon Hela peut cliquer Approuver/Sauvegarder sur du vide) et
// on explique clairement, avec un retour vers le cours. Vu 2026-06-05 (Surete MET M08-15,
// 24 conteneurs vides "Introduction / Procedures / Application terrain" sans audio).
function renderDraftState(){
  var player = document.querySelector('.player'); if (player) player.style.display = 'none';
  var fp = document.querySelector('.fp'); if (fp) fp.style.display = 'none';
  var courseId = (L && L.lesson_key) ? L.lesson_key.split('/')[0] : '';
  document.getElementById('wc').innerHTML =
    '<div style="text-align:center;padding:42px 24px;color:#cbd5e1">'
    + '<div style="font-size:42px;margin-bottom:14px">📝</div>'
    + '<div style="font-size:17px;font-weight:700;color:#F0F0F0;margin-bottom:10px">Cette lecon n\'a pas de voiceover</div>'
    + '<div style="font-size:14px;line-height:1.65;max-width:520px;margin:0 auto;color:#94A3B8">'
    + 'C\'est un titre de section (brouillon), pas une vraie lecon a reviser. '
    + 'Le contenu se trouve dans les sous-lecons du module. Il n\'y a rien a corriger ici.'
    + '</div>'
    + '<div style="margin-top:24px">'
    + '<a href="course.html?course='+encodeURIComponent(courseId)+'" style="display:inline-block;background:#C0392B;color:#fff;text-decoration:none;padding:11px 20px;border-radius:7px;font-weight:600;font-size:14px">← Retour au cours</a>'
    + '</div></div>';
}

// Vraie lecon produite mais timestamps manquants/corrompus : vrai probleme technique a signaler.
function renderTimestampError(){
  document.getElementById('wc').innerHTML =
    '<div class="err">Impossible de charger les reperes de mots (timestamps) pour cette lecon. '
    + 'Le voiceover existe mais ses timestamps sont manquants ou corrompus — previens Nicolas pour qu\'il les regenere.</div>';
}

// Garde-fou : previent de reviser une formation ARCHIVEE (courses.visible=false). Hela peut
// arriver sur une telle lecon par un lien direct (favori d'avant l'archivage) ; sans ce
// bandeau, toutes ses corrections tombent en "Erreur" (lecon introuvable cote worker) sans
// explication. Bug vecu 2026-06-03 (prevention-incendie-p1, 93 corrections perdues).
function checkCourseArchived(){
  if (!L || !L.lesson_key) return;
  var courseId = L.lesson_key.split('/')[0];
  fetch(API+'/courses?id=eq.'+encodeURIComponent(courseId)+'&select=visible', {headers:H})
    .then(function(r){return r.json()})
    .then(function(rows){
      if (rows && rows.length && rows[0].visible === false) {
        var b = document.createElement('div');
        b.style.cssText = 'background:rgba(231,76,60,0.16);border:1px solid #E74C3C;border-left:4px solid #E74C3C;color:#F8CACE;padding:12px 16px;border-radius:8px;margin:10px 0;font-size:13px;line-height:1.5';
        b.innerHTML = '⚠ <strong>Cette formation est archivée (retirée).</strong> Pas besoin de la réviser — tes corrections ici ne seront pas traitées. Si tu penses qu’elle devrait être active, préviens Nicolas.';
        document.body.insertBefore(b, document.body.firstChild);
      }
    })
    .catch(function(){ /* non bloquant */ });
}

// Calcule le range temporel de chaque phrase (start du premier mot, end du dernier mot)
// pour pouvoir sauter d'une phrase a l'autre en mode filtre.
function computeSentenceRanges(){ sentenceRanges = XGReview.computeSentenceRanges(W); }

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
  fetch(API+'/voiceover_metadata?lesson_key=eq.'+encodeURIComponent(L.lesson_key)+'&select=regenerated_sentence_indices,voiceover_uploaded_at',{headers:H})
    .then(function(r){return r.json()})
    .then(function(rows){
      if (!rows.length) return;
      lessonRegenAt = rows[0].voiceover_uploaded_at || null;
      var indices = rows[0].regenerated_sentence_indices;
      // Poser d'abord les phrases regenerees "une a une" (si presentes)...
      if (Array.isArray(indices) && indices.length) regenIndices = indices;
      // ...PUIS verdir les corrections appliquees : augment FUSIONNE dans regenIndices
      // (jamais un ecrasement), donc l'ordre d'arrivee des fetch n'a pas d'importance.
      // Cas frequent : regenerated_sentence_indices vide (fix par dico + regen complete) ->
      // seules les phrases des corrections done deviennent vertes.
      try { augmentResolvedFromCorrections(); } catch (e) {}
      if (!Array.isArray(indices) || indices.length === 0) return;
      // CRITICAL: refresh des classes des mots dans le texte des que regenIndices arrive,
      // peu importe l'etat du bouton filtre. Sinon les mots restent marques 'flagged'
      // alors qu'ils devraient etre 'resolved' (vert) dans la phrase regeneree.
      // Le timing : loadExistingReview tourne en parallele et a deja marque les mots
      // en 'flagged' avant que regenIndices arrive.
      refreshFlagClasses();
      renderFlags();
      // Re-render des mots pour appliquer le surlignage vert .regenerated
      // (independant du mode filtre — visible des qu'il y a des indices regen).
      buildWords();
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

// SORTIE DE SECOURS QUAND IL N'Y A AUCUNE PHRASE EN VERT (blocage du 6 aout 2026)
//
// Le bandeau de recheck dit « re-ecoute les phrases en vert pour confirmer », et le
// bouton « Valider les corrections appliquees » ne s'affiche que s'il y a du vert.
// Or le vert vient de voiceover_metadata.regenerated_sentence_indices, que le bot de
// correction ne renseignait jamais (0 fois sur 69). Resultat : une consigne impossible
// a suivre et aucun bouton — Hela est restee bloquee deux jours sur deux lecons.
//
// Le pipeline est repare (le bot ecrit maintenant les vraies phrases changees), mais
// il restera des cas legitimes sans vert : une lecon entierement refaite n'a rien de
// particulier a surligner. Dans ces cas-la, on dit la verite et on propose un geste.
function majBandeauRecheck(nbVert){
  if (!lessonNeedsRecheck) return;
  var banniere = document.getElementById('recheck-banner');
  var bouton = document.getElementById('btnRecheckDone');
  if (nbVert > 0) { if (bouton) bouton.style.display = 'none'; return; }

  if (banniere) {
    banniere.innerHTML =
      '<strong>🆕 La voix a ete refaite</strong><br>'
      + 'On ne sait pas quelles phrases ont change — il n\'y a donc rien a surligner en vert. '
      + 'Re-ecoute la lecon en entier. Si tout va bien, clique sur '
      + '<strong>✓ J\'ai re-ecoute, c\'est bon</strong> ci-dessous ; sinon, flague comme d\'habitude.';
  }
  if (bouton) bouton.style.display = 'inline-block';
}

// Referme « a re-ecouter » SANS approuver la lecon : on ecrit la revue telle quelle,
// ce qui pousse voice_reviews.updated_at devant voiceover_uploaded_at — la seule chose
// qui renverse l'inegalite dont depend needs_recheck (migration 008). Une lecon jamais
// approuvee reste donc dans la file, au stade « voix a reviser », ce qui est correct :
// confirmer une re-ecoute n'est pas approuver.
function confirmerReecoute(){
  if (typeof roGuard === 'function' && roGuard()) return;
  var b = document.getElementById('btnRecheckDone');
  if (b) { b.disabled = true; b.textContent = 'Enregistrement...'; }
  saveReview(false);
  setTimeout(function(){
    if (b) { b.textContent = '✓ Enregistre'; }
    var banniere = document.getElementById('recheck-banner');
    if (banniere) banniere.classList.add('hidden');
  }, 900);
}

// Re-applique les classes flagged/resolved sur tous les mots actuellement rendus.
// Utile quand regenIndices arrive APRES loadExistingReview (async race).

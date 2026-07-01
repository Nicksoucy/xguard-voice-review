var correctionStatuses = {}; // phrase_index -> {status, completed_at, reason}
var correctionPollTimer = null;

function submitCorrectionRequest(ii){
  if (!L) return;
  var d = flags.get(ii);
  if (!d) return;
  var input = document.getElementById('rfix'+ii);
  var val = (input && input.value || '').trim();
  // L'INTENTION vient de la categorie du flag (prononciation / faute de frappe / phrase) + de la
  // note libre. Centralise et teste dans XGReview.buildCorrection.
  var built = XGReview.buildCorrection({ category: d.category || 'pronunciation', word: d.word, value: val, note: d.note });
  if (built.redirect === 'sentence') { if (d.sentenceIndex != null) openSentenceModal(d.sentenceIndex); return; }
  if (!built.ok) { setCorrectionStatusEl(ii, 'local', built.error); return; }
  var rn = (localStorage.getItem('rn') || 'Anonyme').trim();
  var note = built.correctionNote;
  var payload = {
    lesson_key: L.lesson_key,
    phrase_index: ii,
    sentence_index: (d.sentenceIndex != null ? d.sentenceIndex : null),
    phrase_text: d.context || null,
    correction_note: note,
    intent: built.intent,            // 'word' | 'pronunciation' — Nitro route dessus au lieu de deviner
    reviewer_note: built.reviewerNote, // la note libre voyage enfin avec la correction
    requested_by: rn
  };
  setCorrectionStatusEl(ii, 'pending', '⏳ Envoi…');
  // Dedup (audit 2026-06-10) : si la MEME demande est deja en traitement,
  // on ne la recree pas — re-cliquer ne fait pas avancer plus vite, ca
  // creait des doublons (neglige→negligé soumis 3 fois sur 3 jours).
  var dedupUrl = API+'/correction_requests?lesson_key=eq.'+encodeURIComponent(L.lesson_key)
    + '&correction_note=eq.'+encodeURIComponent(note)
    + '&status=in.(pending,processing,needs_review)&select=id,status,created_at&limit=1';
  fetch(dedupUrl, {headers:H}).then(function(r){ return r.ok ? r.json() : []; }).then(function(existing){
    if (existing && existing[0]) {
      var quand = new Date(existing[0].created_at);
      var quandTxt = quand.toLocaleDateString('fr-CA', {day:'numeric', month:'long'});
      var statutTxt = existing[0].status === 'needs_review'
        ? 'Nicolas doit trancher celle-la a la main'
        : 'elle est en traitement automatique';
      setCorrectionStatusEl(ii, 'pending', '⏳ Deja demande le ' + quandTxt + ' — ' + statutTxt + '. Pas besoin de re-cliquer.');
      return;
    }
    fetch(API+'/correction_requests', {
      method: 'POST',
      headers: Object.assign({}, H, {'Content-Type':'application/json','Prefer':'return=minimal'}),
      body: JSON.stringify(payload)
    }).then(function(r){
      if (r.ok) {
        correctionStatuses[ii] = {status:'pending'};
        applyCorrectionStatuses();
        if (input) input.value = '';
        startCorrectionPolling();
      } else {
        r.text().then(function(t){ setCorrectionStatusEl(ii, 'error', '⚠ ' + r.status + ' : ' + t.slice(0,80)); });
      }
    }).catch(function(e){ setCorrectionStatusEl(ii, 'error', '⚠ ' + e.message); });
  }).catch(function(e){ setCorrectionStatusEl(ii, 'error', '⚠ ' + e.message); });
}

// Bouton "Se répète" : la voix bégaie/répète ce mot. Le script étant correct, on refait juste
// ce bout (re-roll), sans toucher au texte. Crée une correction_request marquée [répétition].
function submitRepeat(ii){
  if (!L) return;
  var d = flags.get(ii);
  if (!d) return;
  // Garde-fou : le re-roll IGNORE tout texte. Si Hela a tapé un remplacement ou une note,
  // c'est une vraie correction -> ne pas l'avaler dans un re-roll aveugle (bug molette).
  var input = document.getElementById('rfix'+ii);
  var val = (input && input.value || '').trim();
  if (!XGReview.rerollAllowed({ value: val, note: d.note })) {
    setCorrectionStatusEl(ii, 'local', 'Tu as tapé une correction — clique « Corriger ». Le 🔁 ne sert que si la voix bégaie, sans texte.');
    return;
  }
  var rn = (localStorage.getItem('rn') || 'Anonyme').trim();
  var payload = {
    lesson_key: L.lesson_key,
    phrase_index: ii,
    sentence_index: (d.sentenceIndex != null ? d.sentenceIndex : null),
    phrase_text: d.context || null,
    correction_note: '[répétition]',
    intent: 'glitch',
    requested_by: rn
  };
  setCorrectionStatusEl(ii, 'pending', '⏳ Envoi…');
  fetch(API+'/correction_requests', {
    method: 'POST',
    headers: Object.assign({}, H, {'Content-Type':'application/json','Prefer':'return=minimal'}),
    body: JSON.stringify(payload)
  }).then(function(r){
    if (r.ok) {
      correctionStatuses[ii] = {status:'pending'};
      applyCorrectionStatuses();
      startCorrectionPolling();
    } else {
      r.text().then(function(t){ setCorrectionStatusEl(ii, 'error', '⚠ ' + r.status + ' : ' + t.slice(0,80)); });
    }
  }).catch(function(e){ setCorrectionStatusEl(ii, 'error', '⚠ ' + e.message); });
}

// Libelle + classe CSS selon le statut Supabase.
function correctionStatusLabel(s){ return XGReview.correctionStatusLabel(s); }

function setCorrectionStatusEl(ii, cls, text){
  var el = document.getElementById('rfixstatus'+ii);
  if (!el) return;
  el.textContent = text;
  el.className = 'rfixstatus ' + cls;
}

// Re-applique tous les statuts connus sur le DOM (apres un renderFlags).
function applyCorrectionStatuses(){
  Object.keys(correctionStatuses).forEach(function(idx){
    var el = document.getElementById('rfixstatus'+idx);
    if (!el) return;
    var lab = correctionStatusLabel(correctionStatuses[idx]);
    el.textContent = lab.t;
    el.className = 'rfixstatus ' + lab.c;
  });
}

// Marque un flag comme "resolu" (vert) quand sa correction est DONE **et reellement
// appliquee** — sans dependre de regenerated_sentence_indices (souvent vide pour les
// fixes par dico + regen complete). Verdict par intention :
//  - mot/typo : corrige si l'ancien mot flagge (f.word) n'apparait plus dans sa phrase
//    (ex "regle" devenu "règle" -> vert ; "cote" encore "cote" -> reste rouge).
//  - prononciation : le texte affiche ne change pas ; on se fie a une regen posterieure
//    a la correction (lessonRegenAt >= completed_at) pour confirmer que la voix est fraiche.
// Corrige la plainte Hela 2026-06-30 (« corrige mais reste rouge / rien corrige a partir du M3 »).
function augmentResolvedFromCorrections(){
  if (typeof flags === 'undefined' || !flags || !flags.size) return;
  if (typeof W === 'undefined' || !W || !W.length) return;
  var regenAt = lessonRegenAt ? new Date(lessonRegenAt).getTime() : 0;
  var changed = false;
  flags.forEach(function(f, idx){
    if (!f || f.correction_applied || f.reflagged) return;
    var cs = correctionStatuses[idx];
    if (!cs || cs.status !== 'done') return;
    var ok = false;
    if (cs.intent === 'pronunciation') {
      if (regenAt && cs.completed_at && regenAt >= new Date(cs.completed_at).getTime()) ok = true;
    } else {
      var si = f.sentenceIndex;
      if (si !== null && si !== undefined && si !== '?') {
        var stillThere = false;
        for (var i = 0; i < W.length; i++) {
          if (W[i].sentenceIndex === si && W[i].word === f.word) { stillThere = true; break; }
        }
        ok = !stillThere; // l'ancienne graphie a disparu => la correction est visible
      }
    }
    if (ok) { f.correction_applied = true; changed = true; }
  });
  if (changed) {
    try { if (typeof refreshFlagClasses === 'function') refreshFlagClasses(); } catch (e) {}
    try { if (typeof renderFlags === 'function') renderFlags(); } catch (e) {}
  }
}

// Lit les correction_requests de la lecon et met a jour les badges.
function pollCorrectionStatus(){
  if (!L) return;
  fetch(API+'/correction_requests?lesson_key=eq.'+encodeURIComponent(L.lesson_key)+'&select=phrase_index,status,completed_at,reason,intent&order=created_at.desc', {headers:H})
    .then(function(r){ return r.json(); })
    .then(function(rows){
      if (!Array.isArray(rows)) return;
      var seen = {}, anyActive = false, justDone = false;
      rows.forEach(function(row){
        if (row.phrase_index == null || seen[row.phrase_index]) return;
        seen[row.phrase_index] = 1; // rows triees desc -> on garde la plus recente
        var prev = correctionStatuses[row.phrase_index];
        // Transition d'un etat ACTIF -> 'done' = une correction vient d'aboutir : l'audio a
        // (peut-etre) ete refait. On declenche un rechargement cible pour que Hela entende la
        // version FRAICHE (avant : elle re-ecoutait l'ancienne voix et croyait que c'etait mal
        // corrige — reponses Hela 2026-06-24).
        if (row.status === 'done' && prev && (prev.status === 'pending' || prev.status === 'processing')) justDone = true;
        correctionStatuses[row.phrase_index] = {status:row.status, completed_at:row.completed_at, reason:row.reason, intent:row.intent};
        if (row.status === 'pending' || row.status === 'processing') anyActive = true;
      });
      applyCorrectionStatuses();
      augmentResolvedFromCorrections();
      loadCorrectionsLog();
      if (justDone) refreshAfterRegen();
      if (anyActive) startCorrectionPolling();
      else if (correctionPollTimer) { clearInterval(correctionPollTimer); correctionPollTimer = null; }
    }).catch(function(){});
}

// Une correction vient d'aboutir : recharger l'audio frais + les phrases regenerees SANS recharger
// la page. On reutilise les loaders existants, idempotents :
//  - loadStatus() ne re-swappe au.src que si voiceover_uploaded_at a change (garde ?v=), en
//    preservant la position de lecture et l'etat play/pause. Si l'audio n'a pas change (ex. worker
//    qui n'a pas re-uploade), il ne se passe rien -> on n'annonce pas a tort "reecoute".
//  - loadRegenIndices() repasse la phrase corrigee au vert + active le filtre "a revoir".
// Toast non bloquant pour prevenir Hela que la voix a change.
function refreshAfterRegen(){
  try { if (typeof loadStatus === 'function') loadStatus(); } catch (e) {}
  // Recharge le TEXTE affiche (W) depuis le storage frais, pas seulement l'audio :
  // c'est ce qui manquait -> la correction approuvee apparait enfin dans la lecon.
  try { if (typeof reloadWords === 'function') reloadWords(); } catch (e) {}
  try { if (typeof loadRegenIndices === 'function') loadRegenIndices(); } catch (e) {}
  try { if (typeof showMsg === 'function') showMsg('🔄 Une phrase vient d’être refaite — ré-écoute-la', 'saving'); } catch (e) {}
}

// Journal LISIBLE des corrections de cette lecon : quoi a ete flagge/corrige, le resultat, le
// mecanisme, qui et quand. Repond au besoin de visibilite « voir ce qui a ete fait » (Nicolas
// 2026-06-24). Lit correction_requests (toutes les infos y sont deja) et l'affiche dans un panneau
// repliable, comme l'Historique des revisions.
function corrlogEsc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
function loadCorrectionsLog(){
  if (!L) return;
  fetch(API+'/correction_requests?lesson_key=eq.'+encodeURIComponent(L.lesson_key)+'&select=correction_note,intent,status,applied_mode,completed_at,created_at,requested_by,sentence_index&order=created_at.desc&limit=60', {headers:H})
    .then(function(r){ return r.json(); })
    .then(function(rows){
      var panel = document.getElementById('corrlog-panel');
      var list = document.getElementById('corrlog-list');
      if (!panel || !list) return;
      if (!Array.isArray(rows) || !rows.length) { panel.classList.add('hidden'); return; }
      document.getElementById('corrlog-title').textContent = 'Corrections faites (' + rows.length + ')';
      var STAT = { done:'✅ corrigé', pending:'⏳ en file', processing:'⚙️ en cours', needs_review:'👁️ à trancher (Nicolas)', error:'⚠️ erreur' };
      var MODE = { 'dict-global':'dico (partout)', 'contextual':'cette phrase', 'accent-unique':'accent', glitch:'re-génération' };
      list.innerHTML = rows.map(function(r){
        var raw = r.correction_note || '';
        var what;
        if (/^\s*\[\s*r[ée]p[ée]t/i.test(raw)) what = '🔁 bégaiement refait';
        else if (r.intent === 'pronunciation') what = '🗣️ prononciation : ' + corrlogEsc(raw);
        else if (r.intent === 'word') what = '✏️ mot : ' + corrlogEsc(raw);
        else what = corrlogEsc(raw) || '—';
        var st = STAT[r.status] || corrlogEsc(r.status);
        var mode = MODE[r.applied_mode] ? ' <span style="color:#7681a0">('+MODE[r.applied_mode]+')</span>' : '';
        var phr = (r.sentence_index!=null) ? ('<span style="color:#7681a0">phrase #'+r.sentence_index+'</span> · ') : '';
        var when = r.completed_at || r.created_at;
        return '<div class="history-row">'+phr+'<strong>'+what+'</strong> — '+st+mode
          + '<br><span style="color:#7681a0;font-size:11px">'+(when?fmtDate(when):'')+' · '+corrlogEsc(r.requested_by||'?')+'</span></div>';
      }).join('');
      panel.classList.remove('hidden');
    }).catch(function(){});
}

function startCorrectionPolling(){
  if (correctionPollTimer) return;
  correctionPollTimer = setInterval(pollCorrectionStatus, 20000);
}

// L'employeur signale qu'une correction n'est toujours pas bonne -> reflag (violet).
// Le flag repasse en etat actif pour etre retraite a la prochaine regen.
function markReflag(ii){
  if (roGuard()) return;   // lecture seule : ne pas modifier la review d'un autre reviseur
  lessonApproved = false;  // re-ouverture : un mot mal corrige dés-approuve la lecon
  var f = flags.get(ii);
  if (!f) return;
  f.reflagged = true;
  f.reflagged_at = new Date().toISOString();
  delete f.approved_after_regen;
  delete f.approved_at;
  delete f.auto_resolved;
  flags.set(ii, f);
  var idxs = (Array.isArray(f.groupIndices) && f.groupIndices.length > 1) ? f.groupIndices : [ii];
  idxs.forEach(function(g){
    if (els[g]) {
      els[g].classList.remove('resolved','approved');
      els[g].classList.add('flagged','reflagged');
    }
  });
  renderFlags();
  flushAutoSave();   // decision importante -> persister tout de suite (pas d'attente du debounce)
}

// Annule un reflag -> le flag revient a son etat corrige (vert).
function undoReflag(ii){
  if (roGuard()) return;
  var f = flags.get(ii);
  if (!f) return;
  delete f.reflagged;
  delete f.reflagged_at;
  flags.set(ii, f);
  var idxs = (Array.isArray(f.groupIndices) && f.groupIndices.length > 1) ? f.groupIndices : [ii];
  var nowResolved = isResolved(f);
  idxs.forEach(function(g){
    if (els[g]) {
      els[g].classList.remove('reflagged');
      if (nowResolved) {
        els[g].classList.remove('flagged');
        els[g].classList.add('resolved');
      }
    }
  });
  renderFlags();
  flushAutoSave();
}

// Approuve tous les flags verts (resolved) d'un coup
function approveAllGreens(){
  if (roGuard()) return;   // lecture seule : ne pas approuver/ecraser la review d'un autre reviseur
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
    // Re-render des mots pour cacher le surlignage vert des phrases approuvees
    buildWords();
    renderFlags();
    flushAutoSave();
  }
}

// Écouter SEULEMENT la phrase corrigée : joue de son début à sa fin, puis s'arrête (ne continue PAS
// dans la suite — demande Nicolas). Un seul segment à la fois.
function listenSentence(si){
  if (si == null || typeof sentenceRanges === 'undefined' || !sentenceRanges[si]) {
    if (typeof showMsg === 'function') showMsg('Phrase introuvable (timestamps pas prêts ?)', '');
    return;
  }
  if (typeof au === 'undefined' || !au) return;
  var r = sentenceRanges[si];
  // Retirer un arrêt de segment précédent (si on clique une autre phrase).
  if (window._segStop) { try { au.removeEventListener('timeupdate', window._segStop); } catch (e) {} window._segStop = null; }
  au.currentTime = Math.max(0, r.start);
  window._segStop = function(){
    if (!au) return;   // l'audio a pu etre remplace (reload) entre deux timeupdate
    if (XGReview.segmentShouldStop(au.currentTime, r)) { au.pause(); au.removeEventListener('timeupdate', window._segStop); window._segStop = null; }
  };
  au.addEventListener('timeupdate', window._segStop);
  if (au.paused) au.play();
}

// Approuver UNE correction (version ciblée d'approveAllGreens) : valide la phrase corrigée du flag ii.
function approveOneFlag(ii){
  if (roGuard()) return;
  var f = flags.get(ii);
  if (!f) return;
  f.approved_after_regen = true;
  f.approved_at = new Date().toISOString();
  flags.set(ii, f);
  var idxs = (Array.isArray(f.groupIndices) && f.groupIndices.length > 1) ? f.groupIndices : [ii];
  idxs.forEach(function(g){ if (els[g]) { els[g].classList.remove('flagged','resolved','reflagged'); els[g].classList.add('approved'); } });
  buildWords();
  renderFlags();
  flushAutoSave();
  if (typeof showMsg === 'function') showMsg('✅ Phrase approuvée', '');
}

// Toggle affichage des flags approuves
function toggleShowApproved(){
  showApproved = !showApproved;
  renderFlags();
}


// Ouvre l'atelier du son (studio.html) avec le mot flagge + sa phrase pre-remplis.
function openAtelier(ii){
  var d = (typeof flags!=='undefined') ? flags.get(ii) : null; if(!d) return;
  var url = 'studio.html?word=' + encodeURIComponent(d.word||'') + '&phrase=' + encodeURIComponent(d.context||'');
  window.open(url, '_blank');
}

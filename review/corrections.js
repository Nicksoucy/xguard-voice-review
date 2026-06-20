var correctionStatuses = {}; // phrase_index -> {status, completed_at, reason}
var correctionPollTimer = null;

function submitCorrectionRequest(ii){
  if (!L) return;
  var d = flags.get(ii);
  if (!d) return;
  var input = document.getElementById('rfix'+ii);
  var val = (input && input.value || '').trim();
  if (!val) { setCorrectionStatusEl(ii, 'local', 'Tape la correction voulue d\'abord'); return; }
  var rn = (localStorage.getItem('rn') || 'Anonyme').trim();
  // Si Hela n'a pas mis de fleche, on prefixe avec le mot flagge -> "mot → correction".
  var note = /(?:->|=>|→|➜)/.test(val) ? val : ((d.word||'') + ' → ' + val);
  var payload = {
    lesson_key: L.lesson_key,
    phrase_index: ii,
    sentence_index: (d.sentenceIndex != null ? d.sentenceIndex : null),
    phrase_text: d.context || null,
    correction_note: note,
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
  var rn = (localStorage.getItem('rn') || 'Anonyme').trim();
  var payload = {
    lesson_key: L.lesson_key,
    phrase_index: ii,
    sentence_index: (d.sentenceIndex != null ? d.sentenceIndex : null),
    phrase_text: d.context || null,
    correction_note: '[répétition]',
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
function correctionStatusLabel(s){
  if (s.status === 'pending')      return {t:'✓ Envoyée — en traitement (Nitro)', c:'pending'};
  if (s.status === 'processing')   return {t:'⚙️ En cours…', c:'processing'};
  if (s.status === 'needs_review') return {t:'\u{1f441}️ À réviser (Nicolas)', c:'review'};
  if (s.status === 'error')        return {t:'⚠ Erreur', c:'error'};
  if (s.status === 'done') {
    var wt = '';
    if (s.completed_at) {
      var w = new Date(s.completed_at);
      function p(n){ return String(n).padStart(2,'0'); }
      wt = ' le ' + p(w.getDate()) + '/' + p(w.getMonth()+1) + ' à ' + p(w.getHours()) + 'h' + p(w.getMinutes());
    }
    return {t:'✅ Corrigé' + wt, c:'done'};
  }
  return {t:'', c:''};
}

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

// Lit les correction_requests de la lecon et met a jour les badges.
function pollCorrectionStatus(){
  if (!L) return;
  fetch(API+'/correction_requests?lesson_key=eq.'+encodeURIComponent(L.lesson_key)+'&select=phrase_index,status,completed_at,reason&order=created_at.desc', {headers:H})
    .then(function(r){ return r.json(); })
    .then(function(rows){
      if (!Array.isArray(rows)) return;
      var seen = {}, anyActive = false;
      rows.forEach(function(row){
        if (row.phrase_index == null || seen[row.phrase_index]) return;
        seen[row.phrase_index] = 1; // rows triees desc -> on garde la plus recente
        correctionStatuses[row.phrase_index] = {status:row.status, completed_at:row.completed_at, reason:row.reason};
        if (row.status === 'pending' || row.status === 'processing') anyActive = true;
      });
      applyCorrectionStatuses();
      if (anyActive) startCorrectionPolling();
      else if (correctionPollTimer) { clearInterval(correctionPollTimer); correctionPollTimer = null; }
    }).catch(function(){});
}

function startCorrectionPolling(){
  if (correctionPollTimer) return;
  correctionPollTimer = setInterval(pollCorrectionStatus, 20000);
}

// L'employeur signale qu'une correction n'est toujours pas bonne -> reflag (violet).
// Le flag repasse en etat actif pour etre retraite a la prochaine regen.
function markReflag(ii){
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
  scheduleAutoSave();
}

// Annule un reflag -> le flag revient a son etat corrige (vert).
function undoReflag(ii){
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
  scheduleAutoSave();
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
    // Re-render des mots pour cacher le surlignage vert des phrases approuvees
    buildWords();
    renderFlags();
    scheduleAutoSave();
  }
}

// Toggle affichage des flags approuves
function toggleShowApproved(){
  showApproved = !showApproved;
  renderFlags();
}


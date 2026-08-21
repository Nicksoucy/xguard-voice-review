var currentFlaggingSi = null; // sentenceIndex en cours d'edition

// Extrait le texte complet d'une phrase a partir des mots W.
// RECOLLAGE (audit 2026-07-02) : les timestamps audio decoupent "d'un" en
// "d" + "'un" et isolent la ponctuation — la jointure par espaces produisait
// "d 'un chantier ." et le worker ne retrouvait JAMAIS la phrase dans la
// source (74 crayons coinces). On recolle apostrophes et ponctuation.
function getSentenceText(si){
  var parts = [];
  for (var i=0; i<W.length; i++){
    if (W[i].sentenceIndex === si) parts.push(W[i].word);
  }
  return parts.join(' ')
    .replace(/\s+(['’])\s*/g, '$1')   // "d 'un" / "qu' est" -> "d'un" / "qu'est"
    .replace(/\s+([.,;:!?…»%])/g, '$1') // ponctuation collee au mot precedent
    .replace(/([«])\s+/g, '$1')       // guillemet ouvrant colle au mot suivant
    .replace(/\s{2,}/g, ' ').trim();
}

// Ouvre le modal Flag phrase pour un sentenceIndex donne
function openSentenceModal(si){
  currentFlaggingSi = si;
  var text = getSentenceText(si);
  document.getElementById('sentence-modal-title').innerHTML = '\uD83D\uDCCD Corriger la phrase #' + si;
  document.getElementById('sentence-modal-preview').textContent = text;
  // Reset form
  document.querySelectorAll('input[name="flagType"]').forEach(function(r){r.checked = (r.value==='rewrite')});
  document.getElementById('sentence-corrected').value = '';
  document.getElementById('sentence-partial-from').value = '';
  document.getElementById('sentence-partial-to').value = '';
  document.getElementById('sentence-note').value = '';
  document.getElementById('field-corrected').style.display = 'block';
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

// Recupere les flags existants pour cette phrase et montre leur STATUT reel
// (boucle de feedback : Hela voit enfin ce que sa demande est devenue).
function escHtml(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}
function loadExistingSentenceFlags(si){
  if (!L) return;
  fetch(API+'/sentence_flags?lesson_key=eq.'+encodeURIComponent(L.lesson_key)+'&sentence_index=eq.'+si
      +'&select=id,flag_type,applied,applied_at,auto_status,skip_reason,source_sentence,corrected_text,partial_original,partial_replacement,note,created_at&order=created_at.desc',{headers:H})
    .then(function(r){return r.json()})
    .then(function(rows){
      if (!Array.isArray(rows) || !rows.length) return;
      var f = rows[0]; // le plus recent fait foi
      var msg = document.getElementById('sentence-modal-msg');
      var st = (window.XGReview && XGReview.sentenceFlagStatusLabel) ? XGReview.sentenceFlagStatusLabel(f) : null;
      var html = st ? '<span class="rfixstatus '+st.c+'">'+escHtml(st.t)+'</span>' : '';
      // Echec definitif : montrer POURQUOI + le texte source actuel + bouton Renvoyer.
      if (!f.applied && (f.auto_status === 'skipped' || f.auto_status === 'dismissed')) {
        if (f.skip_reason) html += '<div style="margin-top:4px;font-size:12px">Raison : '+escHtml(f.skip_reason)+'</div>';
        if (f.source_sentence) html += '<div style="margin-top:4px;font-size:12px;opacity:.8">Texte actuel de la source : \u00AB&nbsp;'+escHtml(f.source_sentence)+'&nbsp;\u00BB</div>';
        html += '<button type="button" class="rfixbtn" style="margin-top:6px" onclick="resendSentenceFlag('+f.id+')">\uD83D\uDD01 Renvoyer avec le texte actuel</button>';
      }
      if (rows.length > 1) html += '<div style="margin-top:4px;font-size:11px;opacity:.7">'+rows.length+' demandes au total sur cette phrase</div>';
      msg.innerHTML = html;
    }).catch(function(){});
}

// Renvoie un flag skipped en re-ancrant original_text sur le texte ACTUEL de la
// source (stocke par le worker au moment du skip) : le nouveau flag redevient
// localisable. L'ancien est marque 'superseded' pour ne pas etre retraite.
function resendSentenceFlag(oldId){
  if (!L) return;
  var msg = document.getElementById('sentence-modal-msg');
  fetch(API+'/sentence_flags?id=eq.'+oldId+'&select=*',{headers:H})
    .then(function(r){return r.json()})
    .then(function(rows){
      var old = rows && rows[0];
      if (!old) { msg.textContent = 'Flag introuvable'; return; }
      if (!old.source_sentence) { msg.textContent = 'Pas de texte source disponible \u2014 re-soumets via le formulaire.'; return; }
      var rn = (localStorage.getItem('rn') || 'Anonyme').trim();
      var payload = {
        lesson_key: old.lesson_key,
        sentence_index: old.sentence_index,
        flag_type: old.flag_type,
        original_text: old.source_sentence, // re-ancre sur la source ACTUELLE
        corrected_text: old.corrected_text,
        partial_original: old.partial_original,
        partial_replacement: old.partial_replacement,
        note: old.note,
        reviewer_name: rn,
      };
      msg.textContent = 'Renvoi\u2026';
      fetch(API+'/sentence_flags', {
        method: 'POST',
        headers: Object.assign({}, H, {'Content-Type':'application/json','Prefer':'return=minimal'}),
        body: JSON.stringify(payload),
      }).then(function(r){
        if (!r.ok) { msg.textContent = 'Erreur ' + r.status; return; }
        // L'ancien flag ne doit plus jamais repasser dans la machine.
        fetch(API+'/sentence_flags?id=eq.'+oldId, {
          method: 'PATCH',
          headers: Object.assign({}, H, {'Content-Type':'application/json','Prefer':'return=minimal'}),
          body: JSON.stringify({ auto_status: 'superseded', skip_reason: 'remplace par un renvoi avec le texte actuel' }),
        }).catch(function(){});
        msg.textContent = '\u2713 Renvoye \u2014 en traitement';
        if (window.loadSentenceFlagStatuses) loadSentenceFlagStatuses();
        setTimeout(closeSentenceModal, 1400);
      }).catch(function(e){ msg.textContent = 'Erreur : ' + e.message; });
    }).catch(function(e){ msg.textContent = 'Erreur : ' + e.message; });
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
  // Normalisation des saisies : espaces multiples/insecables et bords propres,
  // pour que le worker compare des textes sains.
  var normIn = function(s){ return String(s||'').replace(/\u00A0/g,' ').replace(/\s+/g,' ').trim(); };
  var payload = {
    lesson_key: L.lesson_key,
    sentence_index: currentFlaggingSi,
    flag_type: type.value,
    original_text: getSentenceText(currentFlaggingSi),
    note: document.getElementById('sentence-note').value || null,
    reviewer_name: rn,
  };
  if (type.value === 'rewrite') {
    payload.corrected_text = normIn(document.getElementById('sentence-corrected').value) || null;
    if (!payload.corrected_text) {
      document.getElementById('sentence-modal-msg').textContent = 'Le nouveau texte est requis';
      return;
    }
    if (payload.corrected_text === normIn(payload.original_text)) {
      document.getElementById('sentence-modal-msg').textContent = 'Le nouveau texte est identique à la phrase actuelle — rien à corriger.';
      return;
    }
  } else if (type.value === 'partial') {
    payload.partial_original = normIn(document.getElementById('sentence-partial-from').value) || null;
    payload.partial_replacement = normIn(document.getElementById('sentence-partial-to').value) || null;
    if (!payload.partial_original || !payload.partial_replacement) {
      document.getElementById('sentence-modal-msg').textContent = 'Les deux morceaux sont requis';
      return;
    }
    if (payload.partial_original === payload.partial_replacement) {
      document.getElementById('sentence-modal-msg').textContent = 'Les deux morceaux sont identiques — rien à corriger.';
      return;
    }
  }
  document.getElementById('sentence-modal-msg').textContent = 'Envoi…';
  // Dedup (meme logique que les corrections de mots) : une demande ACTIVE existe
  // deja sur cette phrase ? Re-cliquer ne fait pas avancer plus vite.
  var dedupUrl = API+'/sentence_flags?lesson_key=eq.'+encodeURIComponent(L.lesson_key)
    + '&sentence_index=eq.'+currentFlaggingSi
    + '&applied=eq.false&or=(auto_status.is.null,auto_status.eq.processing)'
    + '&select=id,created_at&limit=1';
  fetch(dedupUrl, {headers:H}).then(function(r){ return r.ok ? r.json() : []; }).then(function(existing){
  if (existing && existing[0]) {
    var quand = new Date(existing[0].created_at).toLocaleDateString('fr-CA', {day:'numeric', month:'long'});
    document.getElementById('sentence-modal-msg').textContent = '⏳ Deja demande le '+quand+' — en traitement. Pas besoin de re-cliquer.';
    return;
  }
  fetch(API+'/sentence_flags', {
    method: 'POST',
    headers: Object.assign({}, H, {'Content-Type':'application/json','Prefer':'return=minimal'}),
    body: JSON.stringify(payload),
  }).then(function(r){
    if (r.ok) {
      document.getElementById('sentence-modal-msg').textContent = '✓ Correction de phrase envoyée — en traitement';
      if (window.loadSentenceFlagStatuses) loadSentenceFlagStatuses();
      setTimeout(closeSentenceModal, 1400);
    } else {
      r.text().then(function(t){
        document.getElementById('sentence-modal-msg').textContent = 'Erreur ' + r.status + ' : ' + t.slice(0,100);
      }).catch(function(){
        document.getElementById('sentence-modal-msg').textContent = 'Erreur ' + r.status;
      });
      if (window.captureWithContext) {
        captureWithContext(new Error('Sentence flag save HTTP ' + r.status), {
          action: 'save_sentence_flag',
          lesson_key: L.lesson_key,
          sentence_index: String(payload.sentence_index || ''),
          flag_type: String(payload.flag_type || ''),
          status: String(r.status)
        });
      }
    }
  }).catch(function(e){
    document.getElementById('sentence-modal-msg').textContent = 'Erreur : ' + e.message;
    if (window.captureWithContext) {
      captureWithContext(e, {
        action: 'save_sentence_flag_network',
        lesson_key: L.lesson_key,
        sentence_index: String(payload.sentence_index || '')
      });
    }
  });
  }).catch(function(e){
    // Dedup injoignable (reseau) : on n'empeche pas la soumission pour autant.
    document.getElementById('sentence-modal-msg').textContent = 'Erreur : ' + e.message;
  });
}

// Fermer le modal avec Escape (en plus du modal approve existant)
document.addEventListener('keydown', function(e){
  if (e.key === 'Escape' && document.getElementById('sentence-modal-bg').classList.contains('open')) {
    closeSentenceModal();
  }
});

// Warn avant de quitter si dirty — SAUF en mode lecture seule (review d'un autre reviseur :
// rien n'est sauvegarde sous notre nom, donc aucun changement a perdre -> pas de nag).
window.addEventListener('beforeunload', function(e){
  if (XGReview.shouldWarnBeforeUnload(dirty, window.viewingOtherReview)) {
    e.preventDefault();
    e.returnValue = 'Tu as des changements non sauvegardes. Quitter quand meme ?';
  }
});

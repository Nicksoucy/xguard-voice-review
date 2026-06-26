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
  document.getElementById('sentence-modal-msg').textContent = 'Envoi…';
  fetch(API+'/sentence_flags', {
    method: 'POST',
    headers: Object.assign({}, H, {'Content-Type':'application/json','Prefer':'return=minimal'}),
    body: JSON.stringify(payload),
  }).then(function(r){
    if (r.ok) {
      document.getElementById('sentence-modal-msg').textContent = '✓ Correction de phrase envoyée — en traitement';
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

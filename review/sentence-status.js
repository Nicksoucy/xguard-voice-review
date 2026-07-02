// sentence-status.js — Boucle de feedback du crayon (audit 2026-07-02).
// Le circuit "mot" (correction_requests) avait polling + badges ; le circuit
// "crayon" (sentence_flags) etait un trou noir : Hela soumettait une
// reformulation et ne savait JAMAIS ce qu'elle devenait. Ce module lit les
// sentence_flags de la lecon, accroche un badge a cote de chaque crayon
// (dom-builder cree un <span data-si-badge="N"> par phrase) et poll tant
// qu'une demande est active — meme vocabulaire visuel que les corrections.

var sentenceFlagRows = [];        // dernier fetch, tous les flags de la lecon
var sentenceFlagPollTimer = null;

// Charge les flags de la lecon puis rafraichit les badges.
function loadSentenceFlagStatuses(){
  if (!window.L || !L) return;
  var url = API+'/sentence_flags?lesson_key=eq.'+encodeURIComponent(L.lesson_key)
    + '&select=id,sentence_index,flag_type,applied,applied_at,auto_status,skip_reason,created_at'
    + '&order=created_at.desc';
  fetch(url, {headers:H})
    .then(function(r){ return r.ok ? r.json() : []; })
    .then(function(rows){
      sentenceFlagRows = Array.isArray(rows) ? rows : [];
      renderSentenceFlagBadges();
      // Poll tant qu'au moins une demande est active (en file ou en cours).
      var anyActive = sentenceFlagRows.some(function(f){
        return !f.applied && (f.auto_status == null || f.auto_status === 'processing');
      });
      if (anyActive) startSentenceFlagPolling();
      else if (sentenceFlagPollTimer) { clearInterval(sentenceFlagPollTimer); sentenceFlagPollTimer = null; }
    })
    .catch(function(){ /* reseau : re-essai au prochain poll/retour d'onglet */ });
}

function startSentenceFlagPolling(){
  if (sentenceFlagPollTimer) return;
  sentenceFlagPollTimer = setInterval(loadSentenceFlagStatuses, 20000);
}

// Remplit les badges <span data-si-badge> crees par dom-builder. Le flag le
// plus RECENT d'une phrase fait foi (les anciens sont superseded/obsolete).
function renderSentenceFlagBadges(){
  var byIdx = {};
  sentenceFlagRows.forEach(function(f){
    if (f.sentence_index == null) return;
    if (!(f.sentence_index in byIdx)) byIdx[f.sentence_index] = f; // rows triees desc
  });
  document.querySelectorAll('[data-si-badge]').forEach(function(el){
    var si = parseInt(el.getAttribute('data-si-badge'), 10);
    var f = byIdx[si];
    if (!f || f.auto_status === 'superseded') { el.textContent = ''; el.className = 'sflag-badge'; el.title=''; return; }
    var st = XGReview.sentenceFlagStatusLabel(f);
    // Badge compact : l'icone seulement ; le detail complet vit dans le modal du crayon.
    el.textContent = (st.t || '').split(' ')[0];
    el.className = 'sflag-badge sflag-' + (st.c || 'pending');
    el.title = st.t;
  });
}

// Chargement initial : quand la lecon et les mots sont prets (loader async).
document.addEventListener('DOMContentLoaded', function(){
  var tries = 0;
  var boot = setInterval(function(){
    tries++;
    if (window.L && L && L.lesson_key) { clearInterval(boot); loadSentenceFlagStatuses(); }
    else if (tries > 40) clearInterval(boot); // ~20 s : la lecon n'a pas charge
  }, 500);
});

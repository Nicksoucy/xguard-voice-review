function jmp(t){if(!au)return;au.currentTime=Math.max(0,t-0.5);if(au.paused)au.play()}

// Auto-save (D4) : debounce de 2s apres la derniere modification
function scheduleAutoSave(){
  // Mode lecture (on regarde la review d'un autre reviseur) : ne rien enregistrer sous notre nom.
  if (window.viewingOtherReview) return;
  dirty = true;
  saveLocalBackup();        // snapshot local SYNCHRONE immediat (filet anti-crash, independant du debounce 2s)
  if (saveTimer) clearTimeout(saveTimer);
  showMsg('●', 'saving');
  saveTimer = setTimeout(function(){
    saveReview(false, true);
  }, 2000);
}

// Flush : sauvegarde serveur IMMEDIATE (annule le debounce). A appeler sur les actions
// importantes (approbations, reflag) pour ne pas dependre des 2s si Hela ferme l'onglet juste apres.
function flushAutoSave(){
  if (window.viewingOtherReview) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (dirty) saveReview(false, true);
}

// ── Backup local (anti-perte de travail) ─────────────────────────
// Stocke un snapshot des flags/glitches dans localStorage a chaque modif. Cle unique par
// lecon ET par reviseur. Restaure au chargement si plus recent que le serveur (loader.js).
function backupKey(){
  return XGReview.buildBackupKey(L ? L.lesson_key : '?', (localStorage.getItem('rn') || 'Anonyme'));
}
function saveLocalBackup(){
  // Ne sauvegarder QUE s'il y a du travail non flushe (dirty). Sinon, un simple rafraichissement
  // de page (visibilitychange -> hidden) creerait un backup au timestamp courant qui paraitrait
  // « plus recent que le serveur » et declencherait un faux prompt de restauration (bug 2026-06-26).
  if (!XGReview.shouldWriteBackup(dirty, L, window.viewingOtherReview)) return;
  try {
    localStorage.setItem(backupKey(), JSON.stringify({
      lesson_key: L.lesson_key,
      reviewer: (localStorage.getItem('rn') || 'Anonyme').trim(),
      flags: Array.from(flags.values()),
      glitches: glitches,
      ts: Date.now()
    }));
  } catch (e) { /* quota plein / navigation privee : on degrade, le serveur reste la source */ }
}
function clearLocalBackup(){
  try { localStorage.removeItem(backupKey()); } catch (e) {}
}

function saveReview(approved, isAuto, force){
  if (!L) return;
  // Lecture seule : on affiche la review d'un AUTRE reviseur -> on ne l'ecrase pas sous notre nom.
  // EXCEPTION (force) : une APPROBATION explicite ecrit NOTRE propre enregistrement (reviewer_name = nous,
  // on_conflict lesson_key+reviewer_name) -> elle n'ecrase JAMAIS le travail de l'autre reviseur. Donc
  // Nicolas peut approuver une lecon meme en regardant la review d'Hela (bug : avant, ca ne faisait rien).
  if (!XGReview.shouldWriteReview(window.viewingOtherReview, force)) {
    if (!isAuto) showMsg('\u{1F441}\u{FE0F} Lecture seule — c\'est la review de ' + window.viewingOtherReview, '');
    return;
  }
  // Approbation EXPLICITE (confirmApprove passe approved=true) -> sticky. Les autosaves
  // (approved=false) NE remettent PAS la lecon en non-approuvee : on renvoie lessonApproved.
  lessonApproved = XGReview.approvedToPersist(approved, lessonApproved);
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
      approved: lessonApproved,
      updated_at: new Date().toISOString()
    })
  }).then(function(r){
    if (r.ok) {
      dirty = false;
      clearLocalBackup();   // le serveur a la version -> le backup local n'est plus necessaire
      showMsg(approved ? '\u2713 Approuve!' : (isAuto ? '\u2713 Auto-sauvegarde' : '\u2713 Sauvegarde!'));
    } else {
      showMsg('Erreur '+r.status+' \u2014 Nicolas a ete notifie');
      if (window.captureWithContext) {
        captureWithContext(new Error('Voice review save HTTP ' + r.status), {
          action: 'save_voice_review',
          lesson_key: L.lesson_key,
          reviewer: rn,
          status: String(r.status),
          flag_count: String(flags.size),
          glitch_count: String(glitches.length),
          approved: String(!!approved),
          is_auto: String(!!isAuto)
        });
      }
    }
  }).catch(function(e){
    showMsg('Erreur reseau: '+e.message);
    if (window.captureWithContext) {
      captureWithContext(e, {
        action: 'save_voice_review_network',
        lesson_key: L.lesson_key,
        reviewer: rn,
        flag_count: String(flags.size)
      });
    }
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
  // force=true : approuver fonctionne meme en mode lecture seule (ecrit notre propre enregistrement).
  saveReview(true, false, true);
  window.viewingOtherReview = null; // on vient d'ecrire NOTRE review approuvee -> on n'est plus en lecture seule
}

function copyReview(){if(!L)return;var t='Lecon: '+(L.short_title||L.title)+'\n';
  if(glitches.length){t+='\nStutters:\n';for(var i=0;i<glitches.length;i++){var g=glitches[i];t+='- ['+g.time+'] #'+g.sentenceIndex+' "'+((g.context||'').replace(/\*\*/g,''))+'"';if(g.note)t+=' \u2192 '+g.note;t+='\n'}}
  var sf=Array.from(flags.values()).sort(function(a,b){return a.index-b.index});
  if(sf.length){t+='\nMots:\n';for(var j=0;j<sf.length;j++){var f=sf[j];t+='- ['+f.time+'] #'+f.sentenceIndex+' "'+((f.context||'').replace(/\*\*/g,''))+'"';if(f.note)t+=' \u2192 '+f.note;t+='\n'}}
  navigator.clipboard.writeText(t);showMsg('Copie!')}

function showMsg(t, cls){var m=document.getElementById('msg');m.textContent=t;m.className='msg'+(cls?' '+cls:'');if(!cls)setTimeout(function(){m.textContent=''},2500)}

// Cherche le debut de la prochaine phrase regeneree (>=t). Retourne null si aucune.
// Logique pure deleguee a lib/review-logic.js (testee par vitest).
function nextRegenStart(t){
  return XGReview.nextRegenStart(regenIndices, sentenceRanges, t);
}

// Verifie si le temps t tombe dans une phrase qu'on doit skipper en mode filtre.
// Si oui, avance currentTime a la prochaine phrase regeneree (ou pause a la fin).
function maybeSkipUnregen(){
  if (!filterModeActive || !regenIndices || !au) return false;
  var t = au.currentTime;
  var currentSi = XGReview.currentSentenceAt(W, t);
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
function sync(){if(!au)return;var t=au.currentTime + LEAD_TIME;
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
      var currentSi = XGReview.currentSentenceAt(W, t);
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

// Filet anti-perte : quand l'onglet passe en arriere-plan / se ferme, on garantit un
// snapshot local (un fetch synchrone serait peu fiable ici). Le backup sera propose a la
// reouverture s'il est plus recent que le serveur (loader.js maybeOfferLocalRestore).
document.addEventListener('visibilitychange', function(){
  if (document.visibilityState === 'hidden') saveLocalBackup();
});

// ═══════════════════════════════════════════════════════════════
// SENTENCE FLAGS — flagger une phrase entiere (pas juste un mot)
// ═══════════════════════════════════════════════════════════════
// Table Supabase : sentence_flags (migration 011)
// 4 types : rewrite | regen | partial | delete
// Traite par apply-review-corrections.mjs --sentences


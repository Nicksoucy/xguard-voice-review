/**
 * studio.js — Atelier du son (studio de prononciation).
 *
 * Nicolas tape un mot, le worker (pipeline/scripts/studio-worker.mjs) genere
 * plusieurs versions (graphies / voix), la page les joue, Nicolas choisit la
 * bonne. Le choix part dans studio_decisions ; le worker l'applique :
 *   - mot a un seul sens  -> regle globale (pronunciations_word)
 *   - mot a double sens    -> a corriger dans la phrase de la lecon (jamais global)
 *
 * Tables Supabase : studio_words (file), studio_variants (audios), studio_decisions.
 * Config Supabase via window.XG (lib/app-config.js, chargee avant).
 */
var API = window.XG.API, H = window.XG.H;
var S = window.XGStudio; // lib/studio-logic.js (logique pure, testee)

// Lecon et phrase d'ou l'Atelier a ete ouvert (bouton « 🎵 Atelier » d'un mot, 2026-10-30).
// Sans elles, le worker devait retrouver la lecon par la phrase et renoncait sous 20
// caracteres : « Puis on redescend. » -> regle posee, voix pas refaite pendant 7 heures.
var QS = new URLSearchParams(location.search);
var LESSON_KEY = QS.get('lesson') || '';
var SENTENCE_INDEX = /^\d+$/.test(QS.get('s') || '') ? parseInt(QS.get('s'), 10) : null;

// Mots HOMOGRAPHES — copie de PROTECTED_FROM_WORDS (pipeline/scripts/lib/dict.mjs)
// Resynchronisee le 2026-10-21 (incident Rawen) : 36 mots manquaient (le, qui, site, ton, guide,
// refuse...) — l'Atelier promettait « un seul sens » puis le worker repondait needs_source.
// pour le bandeau de portee INSTANTANE. Le worker re-verifie cote serveur (source de verite).
var HOMOGRAPHES = new Set(['a','accepte','adaptes','administres','adopte','adresses','agent','agents','aligne','allonge','annonce','apporte','apportes','appropries','arme','arrive','attache','bordee','border','certifie','certifies','change','charge','comprimes','compte','concentre','concentres','concerne','confronte','consultes','contamine','cote','cotes','cour','cours','cree','crees','croise','delivre','depasse','deplace','deroule','des','designe','designes','destine','divises','do','donne','du','echappe','eclaire','efface','encadres','endommage','entoure','entrepose','equipe','equipes','etudie','evalue','evalues','exige','exiges','explique','expose','fabrique','fatigue','ferme','fermes','fige','fixe','forme','formes','genere','gere','guide','identifie','identifies','importe','importes','la','laisse','le','les','leve','libelle','lies','limite','livre','manipule','marche','marcher','melange','moderes','modernise','monte','normalise','normalises','observe','observes','organise','ou','parle','passes','penche','pense','piege','pieges','pose','prefere','preferes','presente','prive','prives','protege','que','qui','ranger','rassure','refuse','refuses','regle','remarques','renverse','respecte','resume','resumes','retourne','reutilise','si','signale','signales','signe','site','situe','sur','termines','tires','ton','touches','traite','traverse','trompe','trompes','utilise','verifie','vise','vises']);

function $(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
function deaccent(s){ return String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().trim(); }
function isHomograph(word){ return HOMOGRAPHES.has(deaccent(word)); }

var VOICES = ['Sylvie','Antoine','Jean','Thierry'];
var currentWordId = null;
var pollTimer = null;
var decisionTimer = null;

// ── Bandeau de portee (vert : mot simple / orange : homographe) ──
function renderScopeBanner(word){
  var el = $('scopeBanner');
  if (!word || !word.trim()){ el.innerHTML = ''; return; }
  if (isHomograph(word)){
    el.className = 'banner homograph';
    el.innerHTML = '⚠️ « '+esc(word)+' » est un mot courant ou à deux sens (ex. « il compte » / « un compte »). '
      + 'Ton choix sera posé SEULEMENT dans ta phrase, pas dans les autres leçons'
      + (LESSON_KEY ? '.' : ' — ouvre l\'Atelier avec le bouton « 🎵 Atelier » du mot, dans la leçon, pour que je sache laquelle.');
  } else {
    el.className = 'banner ok';
    el.innerHTML = '✅ « '+esc(word)+' » a un seul sens : le choix pourra devenir une règle valable partout dans les formations.';
  }
}

// Sigle (tout en majuscules) -> epele avec tirets (CNESST -> C-N-E-S-S-T).
function autoRespelling(word){
  var w = String(word||'').trim();
  if (/^[A-ZÀ-Ÿ]{2,6}$/.test(w)) return w.split('').join('-');
  return '';
}

// ── Lignes de graphies a tester ──
function graphieRowHtml(spelling, voice){
  var vopts = VOICES.map(function(v){ return '<option'+(v===voice?' selected':'')+'>'+v+'</option>'; }).join('');
  return '<div class="grow">'
    + '<input class="gspell" type="text" value="'+esc(spelling)+'" placeholder="graphie à essayer (ex. gardiyin)">'
    + '<select class="gvoice">'+vopts+'</select>'
    + '<button class="gdel" onclick="this.parentNode.remove()" title="Retirer">✕</button>'
    + '</div>';
}
function addGraphieRow(spelling, voice){
  $('graphies').insertAdjacentHTML('beforeend', graphieRowHtml(spelling||'', voice||'Sylvie'));
}
function resetGraphieRows(word){
  $('graphies').innerHTML = '';
  addGraphieRow(word, 'Sylvie');           // le mot tel quel, voix par defaut
  addGraphieRow(word, 'Antoine');          // le mot tel quel, autre voix
  var sig = autoRespelling(word);
  if (sig) addGraphieRow(sig, 'Sylvie');   // suggestion sigle si applicable
}

// Construit requested_variants depuis les lignes (dedup, max 5).
function buildRequestedVariants(){
  var rows = Array.prototype.slice.call(document.querySelectorAll('#graphies .grow'));
  var seen = {}, out = [];
  rows.forEach(function(r){
    var spelling = (r.querySelector('.gspell').value||'').trim();
    var voice = r.querySelector('.gvoice').value || 'Sylvie';
    if (!spelling) return;
    var key = spelling+'|'+voice;
    if (seen[key]) return;
    seen[key] = 1;
    out.push({ kind:'graphie', label: spelling+' · '+voice, spelling: spelling, voice: voice });
  });
  return out.slice(0, 5);
}

// ── Soumettre le mot ──
function go(){
  var word = ($('word').value||'').trim();
  if (!word){ setStatus('Tape un mot à tester.', 'warn'); return; }
  var variants = buildRequestedVariants();
  if (!variants.length){ setStatus('Ajoute au moins une graphie à essayer.', 'warn'); return; }
  var payload = {
    word: word,
    context_phrase: ($('phrase').value||'').trim() || null,
    requested_variants: variants,
    created_by: (localStorage.getItem('rn')||'Anonyme').trim()
  };
  if (LESSON_KEY) { payload.lesson_key = LESSON_KEY; payload.sentence_index = SENTENCE_INDEX; }
  setStatus('⏳ Envoi au worker… (génération en cours)', 'pending');
  $('variants').innerHTML = '';
  $('decision').innerHTML = '';
  var poster = function(body){
    return fetch(API+'/studio_words', { method:'POST', headers:Object.assign({},H,{'Content-Type':'application/json','Prefer':'return=representation'}), body:JSON.stringify(body) });
  };
  poster(payload)
    .then(function(r){
      // Migration 024 pas encore appliquee : la base refuse les colonnes inconnues.
      // On renvoie sans elles plutot que de bloquer l'Atelier.
      if (!r.ok && r.status === 400 && payload.lesson_key !== undefined) {
        delete payload.lesson_key; delete payload.sentence_index;
        return poster(payload);
      }
      return r;
    })
    .then(function(r){ return r.ok ? r.json() : r.text().then(function(t){ throw new Error(r.status+' '+t.slice(0,100)); }); })
    .then(function(rows){
      currentWordId = rows[0].id;
      startPolling();
    })
    .catch(function(e){ setStatus('⚠ '+e.message, 'error'); });
}

// ── Polling : statut du mot + variantes ──
function startPolling(){
  if (pollTimer) clearInterval(pollTimer);
  poll();
  pollTimer = setInterval(poll, 3000);
}
function poll(){
  if (!currentWordId) return;
  Promise.all([
    fetch(API+'/studio_words?id=eq.'+currentWordId+'&select=status,is_homograph,error', {headers:H}).then(function(r){return r.json();}),
    fetch(API+'/studio_variants?word_id=eq.'+currentWordId+'&select=id,label,kind,spelling,voice,duration_sec,audio_b64&order=created_at.asc', {headers:H}).then(function(r){return r.json();})
  ]).then(function(res){
    var w = (res[0]||[])[0]; var variants = res[1]||[];
    if (!w) return;
    if (typeof w.is_homograph === 'boolean') renderScopeBanner($('word').value); // (deja affiche, on garde)
    if (w.status === 'error'){ setStatus('⚠ Erreur du worker : '+esc(w.error||''), 'error'); if (pollTimer) clearInterval(pollTimer); return; }
    if (variants.length) renderVariants(variants);
    if (w.status === 'done'){
      if (pollTimer){ clearInterval(pollTimer); pollTimer = null; }
      setStatus('🎧 '+variants.length+' version(s) prête(s) — écoute et choisis la bonne.', 'ok');
    } else {
      setStatus('⏳ Génération… '+variants.length+' version(s) prête(s)', 'pending');
    }
  }).catch(function(){});
}

// ── Rendu des variantes (lecteur + bouton choisir) ──
// 2026-10-30 : le mot TEL QUEL n'est plus un choix. C'est la reference (« le son
// d'aujourd'hui ») : le choisir ne changeait rien, et le worker repondait « identite
// from = to » — Rawen l'a choisi 4 fois en une minute le 10-26. Les versions « dans la
// phrase » passent en premier : c'est dans la phrase que le defaut s'entend.
function renderVariants(list){
  var word = ($('word').value||'').trim();
  $('variants').innerHTML = S.rangerVersions(word, list).map(function(x){
    var v = x.v;
    var src = 'data:audio/mpeg;base64,'+v.audio_b64;
    var dur = v.duration_sec ? (' · '+Number(v.duration_sec).toFixed(1)+'s') : '';
    var titre = x.origine
      ? '🔈 Tel quel — le son d\'aujourd\'hui'+(x.phrase ? ', dans la phrase' : '')+' · '+esc(v.voice||'')
      : (x.phrase ? '🗣 ' : '')+esc(v.label||v.spelling);
    var action = x.origine
      ? '<div class="substatus">Référence pour comparer : la choisir ne changerait rien.</div>'
      : '<button class="choose" onclick="choose(\''+v.id+'\', '+JSON.stringify(v.spelling).replace(/"/g,'&quot;')+', \''+esc(v.voice)+'\')">✓ C\'est celle-ci</button>';
    return '<div class="vcard'+(x.origine ? ' vorigine' : '')+'">'
      + '<div class="vhead"><span class="vlabel">'+titre+'</span>'
      + '<span class="vmeta">graphie envoyée : <code>'+esc(v.spelling)+'</code>'+dur+'</span></div>'
      + '<audio controls preload="none" src="'+src+'"></audio>'
      + action
      + '</div>';
  }).join('');
}

// ── Choisir une version -> decision ──
function choose(variantId, spelling, voice){
  var word = ($('word').value||'').trim();
  // Garde immediate : la version d'origine ne change rien (meme si une vieille page l'affiche).
  if (S.estVersionOrigine(word, spelling)){
    $('decision').innerHTML = '<div class="banner homograph">« '+esc(word)+' » tel quel, c\'est le son d\'aujourd\'hui : rien ne changerait. '
      + 'Si le mot sonne mal dans la phrase, choisis une autre version, ou tape une autre graphie puis « Proposer des versions ».</div>';
    return;
  }
  var scope = isHomograph(word) ? 'contextual' : 'global';
  var payload = {
    word_id: currentWordId, chosen_variant_id: variantId,
    word: word, spelling: spelling, voice: voice, scope: scope,
    decided_by: (localStorage.getItem('rn')||'Anonyme').trim()
  };
  $('decision').innerHTML = '<div class="banner pending">⏳ Enregistrement du choix…</div>';
  fetch(API+'/studio_decisions', { method:'POST', headers:Object.assign({},H,{'Content-Type':'application/json','Prefer':'return=representation'}), body:JSON.stringify(payload) })
    .then(function(r){ return r.ok ? r.json() : r.text().then(function(t){ throw new Error(r.status+' '+t.slice(0,100)); }); })
    .then(function(rows){
      var did = rows[0].id;
      var intro = (scope==='global')
        ? '✅ Choix enregistré : « '+esc(word)+' » se dira « '+esc(spelling)+' » PARTOUT dans les formations.'
        : '✅ Choix enregistré : « '+esc(word)+' » est un mot courant — « '+esc(spelling)+' » sera posé SEULEMENT dans ta phrase (pas dans les autres leçons).';
      $('decision').innerHTML = '<div class="banner '+(scope==='global'?'ok':'homograph')+'">'+intro+'</div><div id="decstatus" class="substatus">⏳ en attente du worker…</div>';
      pollDecision(did);
    })
    .catch(function(e){ $('decision').innerHTML = '<div class="banner error">⚠ '+esc(e.message)+'</div>'; });
}
// 2026-10-30 : le statut suit la VOIX, pas seulement le dictionnaire. Avant, « Appliqué
// au dictionnaire. Les prochaines générations diront la bonne version » s'affichait que la
// voix de la leçon soit refaite ou non. Maintenant : « voix en cours de régénération »,
// puis « voix refaite à HH:MM, tu peux réécouter » (colonnes regen_* de la migration 024 ;
// sans elles, la note du worker le dit). Logique dans lib/studio-logic.js (etatDecision).
function pollDecision(did){
  if (decisionTimer) clearInterval(decisionTimer);
  var colonnes = 'status,note,applied_section,regen_status,regen_done_at,regen_note,regen_lesson_key';
  function check(){
    fetch(API+'/studio_decisions?id=eq.'+did+'&select='+colonnes, {headers:H})
      .then(function(r){
        // Migration 024 absente : on relit sans les colonnes regen_*.
        if (!r.ok && r.status === 400 && colonnes.indexOf('regen_') >= 0){ colonnes = 'status,note,applied_section'; return null; }
        return r.json();
      }).then(function(rows){
        var d = (rows||[])[0]; if (!d) return;
        var el = $('decstatus'); if (!el) return;
        var e = S.etatDecision(d);
        el.className = 'substatus '+e.c;
        var lecon = d.regen_lesson_key || LESSON_KEY;
        el.innerHTML = esc(e.t) + (e.reecouter && lecon
          ? ' <a class="navlink" href="review.html?key='+encodeURIComponent(lecon)+'" target="_blank">▶ Réécouter la leçon</a>' : '');
        if (e.fini){ clearInterval(decisionTimer); decisionTimer = null; }
      }).catch(function(){});
  }
  check();
  decisionTimer = setInterval(check, 3000);
}

// Un flag de prononciation arrive sous la forme « mot → graphie voulue »
// (fabrique par lib/review-logic.js:arrowed). Colle tel quel dans « Mot a tester »,
// ce LABEL COMPLET devenait la cle du dictionnaire : checkDictRule le refuse
// ("contient une fleche"), et la decision d'Hela mourait. 4 rejets sur ce seul
// motif entre le 19 et le 20 aout, dont « inspecte » qu'elle a redepose 4 fois.
// On separe : la gauche est le mot ECRIT dans le .md (donc la cle), la droite est
// la graphie qu'elle veut entendre (donc une variante a tester).
var FLECHE = /\s*(?:→|⇒|->|=>)\s*/;
function decouperLabelFlag(note){
  var parts = String(note || '').split(FLECHE);
  return { mot: (parts[0] || '').trim(), graphie: (parts[1] || '').trim() };
}

// ── File des mots flaggés (prononciation) — clic pour pré-remplir ──
function loadFlagged(){
  fetch(API+'/correction_requests?intent=eq.pronunciation&select=correction_note,lesson_key,phrase_text,sentence_index,created_at&order=created_at.desc&limit=25', {headers:H})
    .then(function(r){return r.json();}).then(function(rows){
      if (!Array.isArray(rows) || !rows.length){ $('flagged').innerHTML = '<div class="empty">Aucun mot signalé en prononciation pour l\'instant.</div>'; return; }
      var seen = {};
      $('flagged').innerHTML = rows.filter(function(r){ var k=deaccent(r.correction_note); if(seen[k])return false; seen[k]=1; return !!k; }).slice(0,15).map(function(r){
        var note = (r.correction_note||'').replace(/\[[^\]]*\]/g,'').trim();
        var d = decouperLabelFlag(note);
        return '<div class="frow"><span class="fword">'+esc(note)+'</span>'
          + '<span class="fctx">'+esc((r.lesson_key||'').split('/').pop())+'</span>'
          + '<button class="ftest" onclick="prefill('+JSON.stringify(d.mot).replace(/"/g,'&quot;')+', '+JSON.stringify(r.phrase_text||'').replace(/"/g,'&quot;')+', '+JSON.stringify(d.graphie).replace(/"/g,'&quot;')
          + ', '+JSON.stringify(r.lesson_key||'').replace(/"/g,'&quot;')+', '+(Number.isInteger(r.sentence_index) ? r.sentence_index : 'null')+')">Tester</button></div>';
      }).join('');
    }).catch(function(){ $('flagged').innerHTML = '<div class="empty">—</div>'; });
}
function prefill(word, phrase, graphieVoulue, lessonKey, sentenceIndex){
  // La demande de correction connait sa lecon : l'Atelier la garde (regen + regle de phrase).
  if (lessonKey){ LESSON_KEY = lessonKey; SENTENCE_INDEX = Number.isInteger(sentenceIndex) ? sentenceIndex : null; }
  // Securite : meme si l'appelant passe encore un label complet, on ne met JAMAIS
  // une fleche dans le champ « Mot a tester ».
  var d = decouperLabelFlag(word);
  $('word').value = d.mot; $('phrase').value = phrase || '';
  renderScopeBanner(d.mot); resetGraphieRows(d.mot);
  var voulue = (graphieVoulue || d.graphie || '').trim();
  if (voulue && voulue !== d.mot) addGraphieRow(voulue, 'Sylvie');  // sa proposition, prete a ecouter
  window.scrollTo({top:0, behavior:'smooth'});
}

function setStatus(msg, cls){ var el=$('status'); el.className = 'status '+(cls||''); el.innerHTML = msg; }

// ── Init ──
(function init(){
  var nm = $('name'); if (nm){ nm.value = localStorage.getItem('rn')||''; nm.oninput = function(){ localStorage.setItem('rn', this.value); }; }
  var q = QS.get('word');
  // Meme garde que prefill : un ?word= peut porter un label « mot → graphie ».
  var d0 = decouperLabelFlag(q || '');
  var w0 = d0.mot;
  $('word').value = w0;
  var ph0 = QS.get('phrase') || '';
  if (ph0 && $('phrase')) $('phrase').value = ph0;
  $('word').addEventListener('input', function(){ renderScopeBanner(this.value); });
  $('go').addEventListener('click', go);
  $('addGraphie').addEventListener('click', function(){ addGraphieRow('', 'Sylvie'); });
  $('word').addEventListener('change', function(){ resetGraphieRows(this.value); });
  resetGraphieRows(w0);
  if (d0.graphie && d0.graphie !== w0) addGraphieRow(d0.graphie, 'Sylvie');
  renderScopeBanner(w0);
  loadFlagged();
})();

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

// Mots HOMOGRAPHES — copie de PROTECTED_FROM_WORDS (pipeline/scripts/lib/dict.mjs)
// pour le bandeau de portee INSTANTANE. Le worker re-verifie cote serveur (source de verite).
var HOMOGRAPHES = new Set(['accepte','adaptes','administres','adopte','agent','agents','aligne','annonce','apporte','apportes','appropries','arrive','attache','change','charge','comprimes','compte','concentre','concentres','concerne','confronte','consultes','contamine','cote','cotes','cree','crees','croise','delivre','depasse','deplace','destine','divises','donne','echappe','efface','encadres','endommage','entoure','entrepose','equipe','equipes','etudie','evalue','evalues','exige','exiges','explique','expose','fabrique','fatigue','ferme','fermes','fige','fixe','forme','formes','genere','gere','identifie','identifies','importe','importes','laisse','leve','libelle','lies','limite','livre','manipule','melange','moderes','modernise','monte','normalise','normalises','observe','observes','organise','ou','parle','passes','penche','pense','piege','pieges','pose','presente','protege','rassure','regle','remarques','renverse','respecte','resume','resumes','retourne','reutilise','signale','signales','signe','situe','termines','tires','touches','traite','traverse','trompe','trompes','utilise','verifie','vise','vises']);

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
    el.innerHTML = '⚠️ « '+esc(word)+' » a deux sens (ex. « il compte » / « un compte »). '
      + 'Le choix ne sera PAS appliqué partout — la bonne graphie devra être écrite dans la phrase de la leçon. C\'est ce qui évite de casser l\'autre sens.';
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
  setStatus('⏳ Envoi au worker… (génération en cours)', 'pending');
  $('variants').innerHTML = '';
  $('decision').innerHTML = '';
  fetch(API+'/studio_words', { method:'POST', headers:Object.assign({},H,{'Content-Type':'application/json','Prefer':'return=representation'}), body:JSON.stringify(payload) })
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
function renderVariants(list){
  var word = ($('word').value||'').trim();
  $('variants').innerHTML = list.map(function(v){
    var src = 'data:audio/mpeg;base64,'+v.audio_b64;
    var dur = v.duration_sec ? (' · '+Number(v.duration_sec).toFixed(1)+'s') : '';
    return '<div class="vcard">'
      + '<div class="vhead"><span class="vlabel">'+esc(v.label||v.spelling)+'</span>'
      + '<span class="vmeta">graphie envoyée : <code>'+esc(v.spelling)+'</code>'+dur+'</span></div>'
      + '<audio controls preload="none" src="'+src+'"></audio>'
      + '<button class="choose" onclick="choose(\''+v.id+'\', '+JSON.stringify(v.spelling).replace(/"/g,'&quot;')+', \''+esc(v.voice)+'\')">✓ C\'est celle-ci</button>'
      + '</div>';
  }).join('');
}

// ── Choisir une version -> decision ──
function choose(variantId, spelling, voice){
  var word = ($('word').value||'').trim();
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
        : '✅ Choix enregistré : « '+esc(word)+' » est un mot à double sens — à écrire « '+esc(spelling)+' » dans la phrase de la leçon (pas de règle globale).';
      $('decision').innerHTML = '<div class="banner '+(scope==='global'?'ok':'homograph')+'">'+intro+'</div><div id="decstatus" class="substatus">⏳ en attente du worker…</div>';
      pollDecision(did);
    })
    .catch(function(e){ $('decision').innerHTML = '<div class="banner error">⚠ '+esc(e.message)+'</div>'; });
}
function pollDecision(did){
  if (decisionTimer) clearInterval(decisionTimer);
  function check(){
    fetch(API+'/studio_decisions?id=eq.'+did+'&select=status,note,applied_section', {headers:H})
      .then(function(r){return r.json();}).then(function(rows){
        var d = (rows||[])[0]; if (!d) return;
        var el = $('decstatus'); if (!el) return;
        if (d.status === 'applied'){ el.className='substatus done'; el.innerHTML = '✅ Appliqué au dictionnaire ('+esc(d.applied_section||'')+'). Les prochaines générations diront la bonne version.'; clearInterval(decisionTimer); }
        else if (d.status === 'needs_source'){ el.className='substatus done'; el.innerHTML = '📝 '+esc(d.note||'À corriger dans la phrase de la leçon.'); clearInterval(decisionTimer); }
        else if (d.status === 'rejected'){ el.className='substatus warn'; el.innerHTML = '⛔ Non appliqué : '+esc(d.note||''); clearInterval(decisionTimer); }
        else if (d.status === 'error'){ el.className='substatus warn'; el.innerHTML = '⚠ Erreur : '+esc(d.note||''); clearInterval(decisionTimer); }
      }).catch(function(){});
  }
  check();
  decisionTimer = setInterval(check, 3000);
}

// ── File des mots flaggés (prononciation) — clic pour pré-remplir ──
function loadFlagged(){
  fetch(API+'/correction_requests?intent=eq.pronunciation&select=correction_note,lesson_key,phrase_text,created_at&order=created_at.desc&limit=25', {headers:H})
    .then(function(r){return r.json();}).then(function(rows){
      if (!Array.isArray(rows) || !rows.length){ $('flagged').innerHTML = '<div class="empty">Aucun mot signalé en prononciation pour l\'instant.</div>'; return; }
      var seen = {};
      $('flagged').innerHTML = rows.filter(function(r){ var k=deaccent(r.correction_note); if(seen[k])return false; seen[k]=1; return !!k; }).slice(0,15).map(function(r){
        var note = (r.correction_note||'').replace(/\[[^\]]*\]/g,'').trim();
        return '<div class="frow"><span class="fword">'+esc(note)+'</span>'
          + '<span class="fctx">'+esc((r.lesson_key||'').split('/').pop())+'</span>'
          + '<button class="ftest" onclick="prefill('+JSON.stringify(note).replace(/"/g,'&quot;')+', '+JSON.stringify(r.phrase_text||'').replace(/"/g,'&quot;')+')">Tester</button></div>';
      }).join('');
    }).catch(function(){ $('flagged').innerHTML = '<div class="empty">—</div>'; });
}
function prefill(word, phrase){
  $('word').value = word; $('phrase').value = phrase || '';
  renderScopeBanner(word); resetGraphieRows(word);
  window.scrollTo({top:0, behavior:'smooth'});
}

function setStatus(msg, cls){ var el=$('status'); el.className = 'status '+(cls||''); el.innerHTML = msg; }

// ── Init ──
(function init(){
  var nm = $('name'); if (nm){ nm.value = localStorage.getItem('rn')||''; nm.oninput = function(){ localStorage.setItem('rn', this.value); }; }
  var q = new URLSearchParams(location.search).get('word');
  var w0 = q || '';
  $('word').value = w0;
  var ph0 = new URLSearchParams(location.search).get('phrase') || '';
  if (ph0 && $('phrase')) $('phrase').value = ph0;
  $('word').addEventListener('input', function(){ renderScopeBanner(this.value); });
  $('go').addEventListener('click', go);
  $('addGraphie').addEventListener('click', function(){ addGraphieRow('', 'Sylvie'); });
  $('word').addEventListener('change', function(){ resetGraphieRows(this.value); });
  resetGraphieRows(w0);
  renderScopeBanner(w0);
  loadFlagged();
})();

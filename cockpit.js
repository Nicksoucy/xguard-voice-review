/**
 * cockpit.js — Logique du cockpit XGuard, organisé en 5 ONGLETS par phase du pipeline :
 *   audio (révision voix) → video (révision vidéo) → prod (production) → done (finies) → ghl (import GHL)
 *
 * Données : vue lesson_status_full (colonne pipeline_stage), courses, correction_requests,
 * watchdog_heartbeat, et course_lms_status (suivi import GHL au niveau cours).
 * Config Supabase via window.XG (lib/app-config.js).
 */
var API = window.XG.API, H = window.XG.H;

// Config des étapes du pipeline (clé = pipeline_stage de la vue lesson_status_full).
var STAGE = {
  voice_recheck:    {label:'Voix corrigées — à ré-écouter', emoji:'↻',  color:'#E74C3C', link:'review.html',       hint:'La voix a été refaite après tes flags. Ré-écoute les phrases en vert pour confirmer.'},
  voice_review:     {label:'Voix à réviser',                emoji:'🎙️', color:'#3B82F6', link:'review.html',       hint:'Écoute et clique sur les mots qui sonnent mal.'},
  video_review:     {label:'Vidéos à regarder',             emoji:'🎬', color:'#1ABC9C', link:'review-video.html', hint:'Regarde la vidéo au complet, puis approuve ou refuse.'},
  video_production: {label:'Vidéos à produire',             emoji:'🎬', color:'#9B59B6', link:'review-video.html', hint:'Voix approuvée, vidéo pas encore produite.'},
  video_redo:       {label:'Vidéos en re-production',       emoji:'🔧', color:'#E67E22', link:'review-video.html', hint:'Voix changée ou vidéo refusée — Nicolas re-produit, rien à faire côté révision.'},
  done:             {label:'Prêt',                          emoji:'✅', color:'#27AE60', link:'course.html',       hint:''}
};
var STAGE_ORDER = XGCockpit.STAGE_ORDER; // source unique dans lib/cockpit-logic.js

// Stades par phase de révision (Héla). Valeur = priorité d'affichage.
var AUDIO_STAGES = { voice_recheck:0, voice_review:1 };
var VIDEO_STAGES = { video_review:0 };

// Onglets, dans l'ordre du pipeline.
var TABS = [
  {id:'audio', emoji:'🎙️', label:'Révision audio'},
  {id:'video', emoji:'🎬', label:'Révision vidéo'},
  {id:'prod',  emoji:'🛠️', label:'Production'},
  {id:'done',  emoji:'✅', label:'Formations finies'},
  {id:'ghl',   emoji:'🚀', label:'Import GHL'}
];

function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function tab(){ var t = localStorage.getItem('tab'); return TABS.some(function(x){return x.id===t}) ? t : 'audio'; }
function setTab(t){ localStorage.setItem('tab', t); render(); }
window.setTab = setTab;

var DATA = null, CT = {};

document.getElementById('name').value = localStorage.getItem('rn') || '';

Promise.all([
  window.XG.api('courses?visible=eq.true&order=sort_order.asc'),
  window.XG.api('lesson_status_full?select=lesson_key,course_id,module_id,module_index,lesson_index,sort_order,title,short_title,status,pipeline_stage,video_stale,video_status,video_reject_reason,video_flags_count,voiceover_version,video_version'),
  window.XG.api('correction_requests?status=eq.needs_review&select=id,lesson_key,sentence_index,intent,correction_note,reason,requested_by,created_at&order=created_at.asc'),
  window.XG.api('correction_requests?md_sync_failed=eq.true&select=lesson_key,correction_note,reason,requested_by,completed_at&order=completed_at.desc'),
  window.XG.api('correction_requests?status=eq.error&select=lesson_key,correction_note,reason,attempts,requested_by,completed_at&order=completed_at.desc').catch(function(){return []}),
  // TOUTES les lignes de sante (une par machine et par worker depuis 2026-07-02) :
  // xguard-correction@HOST, xguard-sflags@HOST, xguard-studio@HOST + la ligne legacy.
  window.XG.api('watchdog_heartbeat?id=like.xguard*&select=id,status,last_heartbeat,next_jobs,version').catch(function(){return []}),
  window.XG.api('course_lms_status?target=eq.ghl&select=course_id,status,exported_at,imported_at,live_at,updated_by,folder').catch(function(){return []}),
  // Corrections actuellement en attente (auto-traitees par la boucle) — sert au bandeau
  // intelligent : on n'alarme que si du travail est coince, pas juste parce que le Mac dort.
  window.XG.api('correction_requests?status=eq.pending&select=lesson_key').catch(function(){return []}),
  // Reformulations de phrases (crayon) pas encore appliquees — nouvelle section Production.
  window.XG.api('sentence_flags?applied=eq.false&select=id,lesson_key,sentence_index,flag_type,auto_status,skip_reason,reviewer_name,created_at&order=created_at.asc').catch(function(){return []})
]).then(function(res){
  var hb = res[5]||[];
  var legacy = hb.filter(function(r){ return r.id === 'xguard-correction'; })[0] || null;
  DATA = { courses:res[0], lessons:res[1]||[], needsReview:res[2]||[], syncFailed:res[3]||[], failed:res[4]||[],
           health:legacy, healthAll:hb, lms:res[6]||[], pending:(res[7]||[]).length, sflags:res[8]||[] };
  render();
}).catch(function(err){
  document.getElementById('view').innerHTML = '<div class="err">Erreur de chargement: '+esc(err.message)+'</div>';
  console.error(err);
});

// ───────────────────────── Helpers partagés ─────────────────────────

// Logique pure deleguee a lib/cockpit-logic.js (window.XGCockpit) — testee par vitest.
function byStage(lessons){ return XGCockpit.byStage(lessons); }
function courseTitleMap(courses){ var t={}; courses.forEach(function(c){t[c.id]=c.title||c.id}); return t; }

// Comptes par stage par cours, calculés une fois.
function perCourseCounts(){ return XGCockpit.perCourseCounts(DATA.courses, DATA.lessons); }

function lessonRow(l, link, why){
  var name = XGCockpit.lessonName(l);
  var ctx = (CT[l.course_id]||l.course_id);
  return '<a class="qrow" style="--c:'+(STAGE[l.pipeline_stage]?STAGE[l.pipeline_stage].color:'#3B82F6')+'" href="'+link+'?key='+encodeURIComponent(l.lesson_key)+'">'
    + '<span class="qname">'+esc(name)+'</span>'
    + '<span class="qctx">'+esc(ctx)+'</span>'
    + (why?'<span class="qwhy">'+esc(why)+'</span>':'')
    + '<span class="qarrow">→</span></a>';
}

function sectionList(stageKey, lessons){
  var st = STAGE[stageKey];
  if (!lessons.length) return '';
  var rows = lessons.map(function(l){
    var why = '';
    if (stageKey === 'video_redo') {
      if (l.video_status === 'rejected') {
        why = 'rejetée'
            + (l.video_flags_count ? ' — '+l.video_flags_count+' issue'+(l.video_flags_count>1?'s':'') : '')
            + (l.video_reject_reason ? ' · '+l.video_reject_reason : '');
      } else {
        why = 'voix v'+(l.voiceover_version||'?')+' › vidéo v'+(l.video_version||'?');
      }
    }
    return lessonRow(l, st.link, why);
  }).join('');
  return '<div class="sec"><h2>'+st.emoji+' '+st.label+' <span class="count">'+lessons.length+'</span></h2>'
       + (st.hint?'<div class="hint">'+st.hint+'</div>':'') + rows + '</div>';
}

// Ligne leçon dans une carte de formation : emoji stade + nom + (why) + flèche.
function reviewerLessonRow(l){
  var st = STAGE[l.pipeline_stage] || {};
  var name = XGCockpit.lessonName(l);
  var why = l.pipeline_stage === 'voice_recheck' ? 'voix corrigée' : '';
  return '<a class="qrow" style="--c:'+(st.color||'#3B82F6')+'" href="'+(st.link||'review.html')+'?key='+encodeURIComponent(l.lesson_key)+'">'
    + '<span class="qstage">'+(st.emoji||'')+'</span>'
    + '<span class="qname">'+esc(name)+'</span>'
    + (why?'<span class="qwhy">'+why+'</span>':'')
    + '<span class="qarrow">→</span></a>';
}

// Leçons groupées par étape avec une ligne d'explication permanente.
function reviewerRowsGrouped(tasks){
  var html = '', lastStage = null;
  tasks.forEach(function(l){
    if (l.pipeline_stage !== lastStage) {
      lastStage = l.pipeline_stage;
      var st = STAGE[lastStage] || {};
      html += '<div style="font-size:11px;font-weight:700;color:'+(st.color||'#94A3B8')+';margin:10px 2px 4px;display:flex;gap:6px;align-items:baseline;flex-wrap:wrap">'
        + (st.emoji||'') + ' ' + esc(st.label||lastStage)
        + (st.hint ? ' <span style="color:#94A3B8;font-weight:400">— '+esc(st.hint)+'</span>' : '')
        + '</div>';
    }
    html += reviewerLessonRow(l);
  });
  return html;
}

// Replier/déplier les leçons d'une formation (état mémorisé par formation + onglet).
function toggleRevCard(courseId){
  var body = document.getElementById('revbody-'+courseId);
  if (!body) return;
  var collapsed = body.classList.toggle('collapsed');
  localStorage.setItem('rev_open_'+tab()+'_'+courseId, collapsed ? '0' : '1');
  var chev = document.getElementById('revchev-'+courseId);
  if (chev) chev.textContent = collapsed ? '▸' : '▾';
  var head = document.getElementById('revhead-'+courseId);
  if (head) head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}
window.toggleRevCard = toggleRevCard;

// Une formation est "finie" si toutes ses leçons produites sont à done (conteneurs vides ignorés).
// Logique pure + testée dans lib/cockpit-logic.js (test de régression MET inclus).
function finishedCourses(pc){ return XGCockpit.finishedCourses(DATA.courses, pc); }

// ───────────────────────── Compteurs d'onglets ─────────────────────────

function tabCounts(pc){
  return XGCockpit.tabCounts(DATA.courses, DATA.lessons, DATA.lms, pc, AUDIO_STAGES, VIDEO_STAGES);
}

// ───────────────────────── Rendu principal ─────────────────────────

function render(){
  if (!DATA) return;
  CT = courseTitleMap(DATA.courses);
  var pc = perCourseCounts();
  var t = tab();
  var counts = tabCounts(pc);

  // Barre d'onglets
  document.getElementById('tabs').innerHTML = TABS.map(function(tb){
    var n = counts[tb.id]||0;
    return '<button class="'+(tb.id===t?'on':'')+'" onclick="setTab(\''+tb.id+'\')">'
      + tb.emoji+' '+esc(tb.label)
      + '<span class="tcount'+(n?'':' zero')+'">'+n+'</span></button>';
  }).join('');

  // Nav contextuelle + sous-titre
  document.getElementById('nav').innerHTML = (t==='prod')
    ? '<a class="navlink" href="studio.html">🎛️ Atelier du son</a><a class="navlink" href="analytics.html">📊 Analytics</a><a class="navlink" href="exports.html">📥 Exports</a><a class="navlink" href="guide.html">📖 Guide</a>'
    : '<a class="navlink" href="studio.html">🎛️ Atelier du son</a><a class="navlink" href="guide.html">📖 Guide</a>';
  var SUBS = {audio:'Révision audio — écoute et flag les voix',video:'Révision vidéo — regarde et approuve les vidéos',prod:'Production — vidéos à produire et corrections (Nicolas)',done:'Formations 100% terminées',ghl:'Formations prêtes à importer dans GoHighLevel'};
  document.getElementById('subtitle').textContent = SUBS[t]||'Pipeline de production des formations';

  // Bandeau santé : sur TOUS les onglets (Héla vit dans « audio », pas dans « prod »).
  // Une machine morte ou périmée doit se voir partout.
  document.getElementById('health').innerHTML = healthBannerHtml();

  if (t==='audio')      renderReviewCards(AUDIO_STAGES, pc, 'Rien à réviser côté voix pour l\'instant.');
  else if (t==='video') renderReviewCards(VIDEO_STAGES, pc, 'Aucune vidéo à regarder pour l\'instant.');
  else if (t==='prod')  renderProduction(pc);
  else if (t==='done')  renderFinies(pc);
  else if (t==='ghl')   renderGhl(pc);
}

// Bandeau santé PAR MACHINE (audit 2026-07-02) : une puce par worker et par machine
// (Mac + Nitro), version affichée, rouge si erreur/code périmé/travail coincé.
// N'affiche que les machines qui ont un problème — silence = tout va bien.
function healthBannerHtml(){
  var ms = XGCockpit.machinesState(DATA && DATA.healthAll, Date.now(), DATA && DATA.pending);
  if (ms.show) {
    var bad = ms.machines.filter(function(m){ return m.level === 'error' || m.level === 'alert'; });
    if (!bad.length) return '';
    var chips = bad.map(function(m){
      var why = m.status === 'stale-version' || m.staleVersion ? 'code périmé ('+esc(m.version)+')'
        : m.status === 'error' ? 'erreur au dernier passage'
        : 'silencieux depuis '+Math.round(m.ageMin)+' min avec du travail en attente';
      return '<div class="health-down">⚠ '+esc(m.worker)+' sur '+esc(m.host)+' : '+why
        + ' <span style="opacity:0.7;font-weight:400;font-size:11px">· '+esc(m.version)+'</span></div>';
    }).join('');
    return chips;
  }
  // Repli legacy (transition) : l'ancienne ligne unique si aucune ligne par machine.
  var st = XGCockpit.healthState(DATA && DATA.health, Date.now(), DATA && DATA.pending);
  if (!st.show) return '';
  var ver = st.version && st.version !== 'correction-loop' ? ' <span style="opacity:0.7;font-weight:400;font-size:11px">· worker '+esc(st.version)+'</span>' : '';
  if (st.level === 'idle') {
    return '<div class="health-idle">💤 Boucle de correction au repos — rien en attente.'+ver+'</div>';
  }
  var msg = st.level === 'error'
    ? '⚠ La boucle de correction a signalé une erreur à son dernier passage.'
    : '⚠ '+st.pending+' correction'+(st.pending>1?'s':'')+' en attente et la boucle ne tourne plus depuis '+Math.round(st.ageMin)+' min — réveille le Mac (ou relance la boucle).';
  return '<div class="health-down">'+msg+ver+'</div>';
}

// ───────────────────────── Onglets Audio / Vidéo ─────────────────────────

// Cartes de formation pour une phase de révision (taskStages = AUDIO_STAGES ou VIDEO_STAGES).
// N'affiche QUE les formations qui ont du travail dans cette phase.
function renderReviewCards(taskStages, pc, emptyMsg){
  var byCourse = {};
  DATA.lessons.forEach(function(l){
    if (!(l.pipeline_stage in taskStages)) return;
    (byCourse[l.course_id] = byCourse[l.course_id] || []).push(l);
  });

  var courses = DATA.courses.filter(function(c){ return (byCourse[c.id]||[]).length > 0; })
    .sort(function(a,b){ return (byCourse[b.id].length - byCourse[a.id].length) || (a.sort_order||0)-(b.sort_order||0); });

  if (!courses.length){ document.getElementById('view').innerHTML = '<div class="allgood">🎉 '+esc(emptyMsg)+'</div>'; return; }

  var html = courses.map(function(c){
    var s = pc[c.id];
    var t = STAGE_ORDER.reduce(function(a,k){return a+s[k];},0);
    var tasks = byCourse[c.id].slice().sort(function(a,b){
      return taskStages[a.pipeline_stage]-taskStages[b.pipeline_stage] || (a.sort_order||0)-(b.sort_order||0);
    });
    var n = tasks.length;
    var bar = STAGE_ORDER.map(function(k){
      var p = t ? s[k]/t*100 : 0;
      return p>0 ? '<span style="width:'+p+'%;background:'+STAGE[k].color+'" title="'+STAGE[k].label+': '+s[k]+'"></span>' : '';
    }).join('');
    var saved = localStorage.getItem('rev_open_'+tab()+'_'+c.id);
    var open = saved!=null ? saved==='1' : false;
    var chev = '<span class="revchev" id="revchev-'+c.id+'">'+(open?'▾':'▸')+'</span>';
    return '<div class="revcard">'
      + '<div class="revhead" id="revhead-'+c.id+'" role="button" tabindex="0"'
      +   ' aria-expanded="'+(open?'true':'false')+'" aria-controls="revbody-'+c.id+'"'
      +   ' onclick="toggleRevCard(\''+c.id+'\')"'
      +   ' onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();toggleRevCard(\''+c.id+'\')}">'
      +   chev
      +   '<span class="revtitle">'+esc(c.title)+'</span>'
      +   '<span class="revbadge">'+n+' à faire</span>'
      + '</div>'
      + '<div class="stagebar revbar">'+bar+'</div>'
      + '<div class="revsub">Voix <b>'+t+'/'+t+'</b> · Vidéo <b>'+s.done+'/'+t+'</b></div>'
      + '<div class="revbody'+(open?'':' collapsed')+'" id="revbody-'+c.id+'">'+reviewerRowsGrouped(tasks)+'</div>'
      + '</div>';
  }).join('');
  document.getElementById('view').innerHTML = html;
}

// ───────────────────────── Onglet Production (ex « Gestion ») ─────────────────────────

function renderProduction(pc){
  var lessons = DATA.lessons;
  var m = byStage(lessons);
  var counts = {}; STAGE_ORDER.forEach(function(s){counts[s]=m[s].length});

  var doneN = counts.done, tot = lessons.length;
  var pctv = tot ? Math.round(doneN/tot*100) : 0;
  var html = '<div class="sec"><h2>📈 Vue d\'ensemble</h2><div class="hint">'
    + DATA.courses.length + ' formations · ' + tot + ' leçons · ' + doneN + ' prêtes (' + pctv + '%)</div></div>';

  html += sectionList('video_production', m.video_production);
  html += sectionList('video_redo', m.video_redo);

  // Corrections EN ÉCHEC (status=error), dédupées par lesson_key + note.
  if (DATA.failed && DATA.failed.length){
    var failMap = {};
    DATA.failed.forEach(function(c){
      var k = c.lesson_key + '|' + c.correction_note;
      if (!failMap[k]) failMap[k] = {c:c, n:0, att:0};
      failMap[k].n++; failMap[k].att = Math.max(failMap[k].att, c.attempts||0);
    });
    var failRows = Object.keys(failMap).map(function(k){
      var f = failMap[k], c = f.c;
      var why = f.att + ' tentative'+(f.att>1?'s':'') + (f.n>1 ? ' · '+f.n+' re-soumissions' : '');
      return '<a class="qrow" style="--c:#E74C3C" href="review.html?key='+encodeURIComponent(c.lesson_key)+'">'
        + '<span class="qname">'+esc(c.correction_note)+'</span>'
        + '<span class="qctx">'+esc(CT[(c.lesson_key||'').split('/')[0]]||c.lesson_key)+'</span>'
        + '<span class="qwhy">'+esc(why)+'</span>'
        + '<span class="qarrow">→</span></a>';
    }).join('');
    html += '<div class="sec"><h2>⚠ Corrections en échec <span class="count">'+Object.keys(failMap).length+'</span></h2>'
          + '<div class="hint">Le système a abandonné après plusieurs essais. Souvent un glitch audio à refaire via « 🔁 Se répète » (pas un changement de texte).</div>'+failRows+'</div>';
  }

  // Corrections à trancher (needs_review) — les plus vieilles d'abord + pastille d'attente.
  if (DATA.needsReview.length){
    var ARROW_NR = /(?:->|=>|→|➜)/;
    var nrRows = DATA.needsReview.map(function(c){
      var ageJours = Math.floor((Date.now() - new Date(c.created_at).getTime()) / 86400000);
      var ageBadge = '';
      if (ageJours >= 7) ageBadge = '<span style="color:#E74C3C;font-size:10px;font-weight:700;white-space:nowrap">⏳ '+ageJours+' j</span>';
      else if (ageJours >= 2) ageBadge = '<span style="color:#F39C12;font-size:10px;white-space:nowrap">'+ageJours+' j</span>';
      // Bouton « corriger dans la source » : pour un « mot → mot » localisé (sentence_index),
      // un clic convertit la demande en flag de phrase 'partial' — le circuit crayon fait le
      // reste (édition du .md canonique, commit, régénération). C'est le chemin doctrine pour
      // les homographes que le garde-fou dico refuse (cotes→cotés, marche→marché…).
      var srcBtn = (ARROW_NR.test(c.correction_note||'') && c.sentence_index != null && c.id)
        ? '<span class="qwhy" style="cursor:pointer;color:#2ECC71;font-weight:700" '
          + 'onclick="event.preventDefault();event.stopPropagation();convertToSourceEdit(\''+c.id+'\', this)">✏️ corriger dans la source</span>'
        : '';
      return '<a class="qrow" style="--c:#A855F7" href="review.html?key='+encodeURIComponent(c.lesson_key)+'">'
        + '<span class="qname">'+esc(c.correction_note)+'</span>'
        + ageBadge
        + srcBtn
        + '<span class="qctx">'+esc(CT[(c.lesson_key||'').split('/')[0]]||c.lesson_key)+'</span>'
        + '<span class="qarrow">→</span></a>';
    }).join('');
    html += '<div class="sec"><h2>👁️ Corrections à trancher <span class="count">'+DATA.needsReview.length+'</span></h2>'
          + '<div class="hint">Demandes de Héla qui changent le texte. « ✏️ corriger dans la source » convertit en réécriture de phrase (le pipeline édite le .md et régénère tout seul). Les plus vieilles en premier.</div>'+nrRows+'</div>';
  }

  // Réécritures de phrases (crayon) pas encore appliquées — le circuit qui était
  // un trou noir (audit 2026-07-02) devient une file visible avec âge et raison.
  if (DATA.sflags && DATA.sflags.length){
    var sfCount = { active:0, skipped:0, autre:0 };
    var sflagRows = DATA.sflags.filter(function(f){
      return f.auto_status == null || f.auto_status === 'processing' || f.auto_status === 'skipped';
    });
    sflagRows.forEach(function(f){
      if (f.auto_status === 'skipped') sfCount.skipped++; else sfCount.active++;
    });
    if (sflagRows.length){
      var sfHtml = sflagRows.map(function(f){
        var ageJours = Math.floor((Date.now() - new Date(f.created_at).getTime()) / 86400000);
        var ageBadge = '';
        if (ageJours >= 7) ageBadge = '<span style="color:#E74C3C;font-size:10px;font-weight:700;white-space:nowrap">⏳ '+ageJours+' j</span>';
        else if (ageJours >= 2) ageBadge = '<span style="color:#F39C12;font-size:10px;white-space:nowrap">'+ageJours+' j</span>';
        var etat = f.auto_status === 'skipped'
          ? '⚠ '+(f.skip_reason || 'pas appliquée — à renvoyer depuis le crayon')
          : (f.auto_status === 'processing' ? '⚙️ en cours' : '⏳ en file');
        return '<a class="qrow" style="--c:#3498DB" href="review.html?key='+encodeURIComponent(f.lesson_key)+'">'
          + '<span class="qname">phrase #'+esc(String(f.sentence_index==null?'?':f.sentence_index))+' · '+esc(f.flag_type||'')+'</span>'
          + ageBadge
          + '<span class="qctx">'+esc(CT[(f.lesson_key||'').split('/')[0]]||f.lesson_key)+'</span>'
          + '<span class="qwhy">'+esc(etat)+'</span>'
          + '<span class="qarrow">→</span></a>';
      }).join('');
      html += '<div class="sec"><h2>✏️ Phrases à réécrire <span class="count">'+sflagRows.length+'</span></h2>'
            + '<div class="hint">'+sfCount.active+' en traitement automatique · '+sfCount.skipped+' non appliquées (raison affichée — ouvrir la leçon et « Renvoyer » depuis le crayon).</div>'
            + sfHtml + '</div>';
    }
  }

  // Textes maîtres à vérifier (md_sync_failed).
  if (DATA.syncFailed && DATA.syncFailed.length){
    var sfRows = DATA.syncFailed.map(function(c){
      return '<a class="qrow" style="--c:#E67E22" href="review.html?key='+encodeURIComponent(c.lesson_key)+'">'
        + '<span class="qname">'+esc(c.correction_note)+'</span>'
        + '<span class="qctx">'+esc(CT[(c.lesson_key||'').split('/')[0]]||c.lesson_key)+'</span>'
        + '<span class="qwhy">audio OK · texte à vérifier</span>'
        + '<span class="qarrow">→</span></a>';
    }).join('');
    html += '<div class="sec"><h2>📝 Textes maîtres à vérifier <span class="count">'+DATA.syncFailed.length+'</span></h2>'
          + '<div class="hint">Audio corrigé, mais le texte source (.md) n\'a pas pu être édité automatiquement — à corriger à la main dans Obsidian.</div>'+sfRows+'</div>';
  }

  // Rollup par formation.
  html += '<div class="sec"><h2>🗂️ Par formation</h2></div>';
  var ordered = DATA.courses.slice().sort(function(a,b){
    return (pc[b.id].voice_review+pc[b.id].voice_recheck+pc[b.id].video_redo+pc[b.id].video_production)
         - (pc[a.id].voice_review+pc[a.id].voice_recheck+pc[a.id].video_redo+pc[a.id].video_production);
  });
  html += ordered.map(function(c){
    var s = pc[c.id];
    var t = STAGE_ORDER.reduce(function(a,k){return a+s[k]},0);
    if (!t) return '';
    var bar = STAGE_ORDER.map(function(k){
      var p = t? s[k]/t*100 : 0;
      return p>0 ? '<span style="width:'+p+'%;background:'+STAGE[k].color+'" title="'+STAGE[k].label+': '+s[k]+'"></span>' : '';
    }).join('');
    var ph = XGCockpit.coursePhase(s), phase = ph.label, pcls = ph.cls;
    var bits = [];
    bits.push('Voix <b>'+t+'/'+t+'</b>');
    bits.push('Vidéo <b>'+s.done+'/'+t+'</b>');
    if (s.video_redo) bits.push('<span style="color:#E67E22"><b>'+s.video_redo+'</b> à refaire</span>');
    return '<a class="course" href="course.html?course='+encodeURIComponent(c.id)+'">'
      + '<div class="title"><span>'+esc(c.title)+'</span><span class="phase '+pcls+'">'+phase+'</span></div>'
      + '<div class="stagebar">'+bar+'</div>'
      + '<div class="crow">'+bits.join('')+'</div></a>';
  }).join('');

  document.getElementById('view').innerHTML = html;
}

// ───────────────────────── Onglet Formations finies ─────────────────────────

function renderFinies(pc){
  var fin = finishedCourses(pc).sort(function(a,b){ return (a.sort_order||0)-(b.sort_order||0); });
  if (!fin.length){ document.getElementById('view').innerHTML = '<div class="allgood">Aucune formation 100% terminée pour l\'instant.</div>'; return; }
  var html = '<div class="sec"><div class="hint">'+fin.length+' formation'+(fin.length>1?'s':'')+' dont toutes les leçons sont approuvées (voix + vidéo).</div></div>';
  html += fin.map(function(c){
    var s = pc[c.id];
    var t = STAGE_ORDER.reduce(function(a,k){return a+s[k]},0);
    return '<a class="course" href="course.html?course='+encodeURIComponent(c.id)+'">'
      + '<div class="title"><span>'+esc(c.title)+'</span><span class="phase ready">✅ Terminée</span></div>'
      + '<div class="crow"><span><b>'+t+'</b> leçon'+(t>1?'s':'')+' prêtes</span><span>→ détail</span></div></a>';
  }).join('');
  document.getElementById('view').innerHTML = html;
}

// ───────────────────────── Onglet Import GHL ─────────────────────────

function lmsMap(){ var m={}; DATA.lms.forEach(function(r){ m[r.course_id]=r; }); return m; }

function gStatusOf(rec){ return XGCockpit.gStatusOf(rec); }

function renderGhl(pc){
  var fin = finishedCourses(pc).sort(function(a,b){ return (a.sort_order||0)-(b.sort_order||0); });
  if (!fin.length){ document.getElementById('view').innerHTML = '<div class="allgood">Aucune formation prête à importer pour l\'instant. Termine d\'abord la révision audio + vidéo.</div>'; return; }
  var lm = lmsMap();
  var folderOf = function(c){ var r=lm[c.id]; return (r && r.folder) ? r.folder : ''; };

  // Liste des dossiers existants -> autocomplétion (pas besoin de les pré-créer).
  var allFolders = [];
  fin.forEach(function(c){ var f=folderOf(c); if (f && allFolders.indexOf(f)===-1) allFolders.push(f); });
  allFolders.sort(function(a,b){ return a.localeCompare(b,'fr'); });
  var datalist = '<datalist id="ghl-folders">' + allFolders.map(function(f){ return '<option value="'+esc(f)+'">'; }).join('') + '</datalist>';

  // Grouper par dossier : dossiers alpha d'abord, « Sans dossier » en dernier.
  var groups = {};
  fin.forEach(function(c){ (groups[folderOf(c)] = groups[folderOf(c)]||[]).push(c); });
  var folderKeys = Object.keys(groups).filter(function(f){return f;}).sort(function(a,b){ return a.localeCompare(b,'fr'); });
  if (groups['']) folderKeys.push('');

  function cardHtml(c){
    var rec = lm[c.id], st = gStatusOf(rec);
    var meta = '';
    if (rec){
      if (rec.imported_at) meta = 'Importé le '+new Date(rec.imported_at).toLocaleDateString('fr-CA')+(rec.updated_by?' par '+esc(rec.updated_by):'');
      else if (rec.exported_at) meta = 'Exporté le '+new Date(rec.exported_at).toLocaleDateString('fr-CA')+' — à uploader dans GHL';
    }
    var curFolder = (rec && rec.folder) ? rec.folder : '';
    return '<div class="ghlcard" id="ghlcard-'+c.id+'">'
      + '<div class="ghlhead"><span class="ghltitle">'+esc(c.title)+'</span><span class="gstat '+st.key+'">'+st.label+'</span></div>'
      + (meta?'<div class="ghlmeta">'+meta+'</div>':'')
      + '<div class="ghlbtns">'
      +   '<button class="ghlbtn primary" onclick="ghlExport(\''+c.id+'\')">⬇ Exporter le JSON GHL</button>'
      +   '<button class="ghlbtn" onclick="ghlMark(\''+c.id+'\',\'imported\')">✅ Marquer importé</button>'
      +   '<button class="ghlbtn" onclick="ghlMark(\''+c.id+'\',\'live\')">🌐 Marquer en ligne</button>'
      + '</div>'
      + '<div class="ghlmeta" style="margin-top:8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">'
      +   '<span>📁 Dossier :</span>'
      +   '<input class="ghlfolder" list="ghl-folders" value="'+esc(curFolder)+'" placeholder="aucun"'
      +     ' onchange="setGhlFolder(\''+c.id+'\', this.value)"'
      +     ' style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);color:#F0F0F0;border-radius:6px;padding:4px 8px;font-family:inherit;font-size:12px;max-width:220px">'
      + '</div>'
      + '<div class="ghlmeta" id="ghlmsg-'+c.id+'" style="margin-top:8px"></div>'
      + '</div>';
  }

  var html = datalist + '<div class="sec"><div class="hint">Formations 100% terminées, rangées par dossier. Exporte le JSON, uploade-le dans GoHighLevel Memberships, puis marque-la comme importée. Tape un dossier sur une formation pour la regrouper (l\'autocomplétion propose les dossiers existants).</div></div>';
  folderKeys.forEach(function(f){
    var label = f ? '📁 '+esc(f) : '📂 Sans dossier';
    html += '<div class="ghlfolderhead" style="margin:18px 0 9px;font-size:13px;font-weight:700;color:#CBD5E1;border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:5px">'+label+' <span style="color:#7681a0;font-weight:500">('+groups[f].length+')</span></div>';
    html += groups[f].map(cardHtml).join('');
  });
  document.getElementById('view').innerHTML = html;
}

function ghlMsg(courseId, txt){ var e = document.getElementById('ghlmsg-'+courseId); if (e) e.textContent = txt; }

// Upsert d'une ligne course_lms_status (merge sur course_id+target).
function upsertCourseLms(courseId, patch){
  var body = Object.assign({ course_id: courseId, target: 'ghl', updated_by: (localStorage.getItem('rn')||'Anonyme').trim(), updated_at: new Date().toISOString() }, patch);
  return fetch(API + '/course_lms_status?on_conflict=course_id,target', {
    method: 'POST',
    headers: Object.assign({}, H, { 'Content-Type':'application/json', 'Prefer':'resolution=merge-duplicates,return=representation' }),
    body: JSON.stringify(body)
  }).then(function(r){ if(!r.ok) return r.text().then(function(t){throw new Error('HTTP '+r.status+' '+t.slice(0,80))}); return r.json(); });
}

// Exporter le JSON GHL d'un cours (réutilise GhlPayload) + marquer "exported".
function ghlExport(courseId){
  ghlMsg(courseId, 'Génération du JSON…');
  window.GhlPayload.buildForCourse(courseId).then(function(payload){
    window.GhlPayload.downloadAsFile(payload, courseId+'-ghl-import.json');
    var now = new Date().toISOString();
    return upsertCourseLms(courseId, { status:'exported', exported_at: now }).then(function(rows){
      var rec = (rows&&rows[0]) || {course_id:courseId, status:'exported', exported_at:now};
      // MAJ locale + re-render de la carte.
      DATA.lms = DATA.lms.filter(function(x){return x.course_id!==courseId}); DATA.lms.push(rec);
      render();
      ghlMsg(courseId, 'JSON téléchargé. Uploade-le dans GHL puis clique « Marquer importé ».');
    });
  }).catch(function(e){ ghlMsg(courseId, 'Erreur : '+e.message); });
}
window.ghlExport = ghlExport;

// Marquer un cours importé / en ligne.
function ghlMark(courseId, status){
  var patch = { status: status };
  if (status==='imported') patch.imported_at = new Date().toISOString();
  if (status==='live') patch.live_at = new Date().toISOString();
  ghlMsg(courseId, 'Enregistrement…');
  // Marque aussi les leçons comme pushed côté GHL (suivi par leçon existant).
  var also = (status==='imported' && window.GhlPayload && window.GhlPayload.markCoursePushed)
    ? window.GhlPayload.markCoursePushed(courseId, 'ghl').catch(function(){return null}) : Promise.resolve();
  Promise.all([upsertCourseLms(courseId, patch), also]).then(function(res){
    var rec = (res[0]&&res[0][0]) || Object.assign({course_id:courseId}, patch);
    DATA.lms = DATA.lms.filter(function(x){return x.course_id!==courseId}); DATA.lms.push(rec);
    render();
  }).catch(function(e){ ghlMsg(courseId, 'Erreur : '+e.message); });
}
window.ghlMark = ghlMark;

// Assigner / changer le dossier d'une formation (course_lms_status.folder). Saisie libre, vide = aucun.
function setGhlFolder(courseId, value){
  var folder = (value||'').trim() || null;
  ghlMsg(courseId, 'Enregistrement du dossier…');
  upsertCourseLms(courseId, { folder: folder }).then(function(rows){
    var rec = (rows&&rows[0]) || Object.assign({course_id:courseId, target:'ghl', folder:folder});
    DATA.lms = DATA.lms.filter(function(x){return x.course_id!==courseId}); DATA.lms.push(rec);
    render();
  }).catch(function(e){ ghlMsg(courseId, 'Erreur dossier : '+e.message); });
}
window.setGhlFolder = setGhlFolder;

// ── Conversion « à trancher » -> édition de la source (audit 2026-07-02) ──
// Chemin doctrine pour les homographes (cotes→cotés, marche→marché…) : le
// garde-fou refuse la règle dico (elle casserait d'autres phrases), la bonne
// correction est d'éditer le .md SOURCE. Un clic crée un sentence_flag
// 'partial' que le worker crayon applique (édition + commit + régén), puis la
// correction est fermée en 'done' applied_mode=source-edit.
function convertToSourceEdit(id, el){
  var c = (DATA && DATA.needsReview || []).filter(function(x){ return String(x.id) === String(id); })[0];
  if (!c) return;
  var parts = String(c.correction_note||'').split(/(?:->|=>|→|➜)/);
  if (parts.length < 2) return;
  var nettoie = function(s){ return String(s||'').trim().replace(/^[\s'"«»(]+/,'').replace(/[\s'"«»).,;:!?…]+$/,''); };
  var from = nettoie(parts[0]);
  var to = nettoie(parts[1]);
  if (!from || !to || from === to) { if (el) el.textContent = '⚠ note illisible'; return; }
  if (el) { el.textContent = '⏳…'; el.style.pointerEvents = 'none'; }
  var wh = Object.assign({}, window.XG.H, {'Content-Type':'application/json','Prefer':'return=minimal'});
  fetch(window.XG.API + '/sentence_flags', {
    method: 'POST',
    headers: wh,
    body: JSON.stringify({
      lesson_key: c.lesson_key,
      sentence_index: c.sentence_index,
      flag_type: 'partial',
      original_text: c.correction_note, // colonne NOT NULL — trace lisible de l'origine
      partial_original: from,
      partial_replacement: to,
      note: '[cockpit] converti depuis la correction ' + c.id + ' (' + (c.requested_by||'?') + ')',
      reviewer_name: localStorage.getItem('rn') || 'Nicolas',
    }),
  }).then(function(r){
    if (!r.ok) throw new Error('HTTP '+r.status);
    return fetch(window.XG.API + '/correction_requests?id=eq.'+encodeURIComponent(c.id), {
      method: 'PATCH',
      headers: wh,
      body: JSON.stringify({
        status: 'done',
        applied_mode: 'source-edit',
        reason: 'convertie en édition de la source (crayon) depuis le cockpit',
        completed_at: new Date().toISOString(),
      }),
    });
  }).then(function(r){
    if (r && !r.ok) throw new Error('PATCH HTTP '+r.status);
    if (el) { el.textContent = '✓ envoyé au crayon'; }
  }).catch(function(e){
    if (el) { el.textContent = '⚠ '+e.message; el.style.pointerEvents = ''; }
  });
}

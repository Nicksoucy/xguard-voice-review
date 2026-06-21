/**
 * lib/cockpit-logic.js — Logique metier PURE du cockpit (calculs, agregations, mapping de statuts).
 *
 * Extrait de cockpit.js pour etre testable hors navigateur. Aucune dependance au DOM ni aux
 * globals : tout passe en parametre. Export double :
 *   - navigateur : window.XGCockpit (charge via <script src="lib/cockpit-logic.js">)
 *   - Node/vitest : require('lib/cockpit-logic.js')
 * Garder ce fichier SANS dependance externe (chargeable en 1er, comme app-config.js).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.XGCockpit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // Ordre canonique des etapes du pipeline (cle = pipeline_stage de lesson_status_full).
  var STAGE_ORDER = [
    'voice_review',
    'voice_recheck',
    'video_production',
    'video_redo',
    'video_review',
    'done',
  ];

  // Somme des lecons reellement produites d'un cours (toutes etapes valides, hors conteneurs vides).
  function sumStages(s) {
    return STAGE_ORDER.reduce(function (a, k) {
      return a + (s[k] || 0);
    }, 0);
  }

  // Compte les lecons par etape, pour chaque cours. Une lecon dont le pipeline_stage n'est pas
  // une etape connue (conteneur vide sans voix) tombe dans not_produced.
  function perCourseCounts(courses, lessons) {
    var pc = {};
    courses.forEach(function (c) {
      pc[c.id] = {};
      STAGE_ORDER.forEach(function (s) {
        pc[c.id][s] = 0;
      });
      pc[c.id].not_produced = 0;
    });
    lessons.forEach(function (l) {
      if (pc[l.course_id] && l.pipeline_stage in pc[l.course_id])
        pc[l.course_id][l.pipeline_stage]++;
      else if (pc[l.course_id]) pc[l.course_id].not_produced++;
    });
    return pc;
  }

  // Une formation est "finie" si elle a >=1 lecon produite et que TOUTES ses lecons produites sont
  // a done. Les conteneurs vides (not_produced) sont ignores — sinon une formation comme MET
  // (125 vraies lecons finies + 28 conteneurs vides) serait exclue a tort.
  function finishedCourses(courses, pc) {
    return courses.filter(function (c) {
      var s = pc[c.id];
      if (!s) return false;
      var total = sumStages(s);
      return total > 0 && s.done === total;
    });
  }

  // Compteurs par onglet du cockpit (badges). lms = lignes course_lms_status (target ghl).
  function tabCounts(courses, lessons, lms, pc, audioStages, videoStages) {
    var c = { audio: 0, video: 0, prod: 0, done: 0, ghl: 0 };
    lessons.forEach(function (l) {
      if (l.pipeline_stage in audioStages) c.audio++;
      else if (l.pipeline_stage in videoStages) c.video++;
      else if (l.pipeline_stage === 'video_production' || l.pipeline_stage === 'video_redo')
        c.prod++;
    });
    var fin = finishedCourses(courses, pc);
    c.done = fin.length;
    // GHL : formations finies pas encore importees (action restante).
    var lmsByCourse = {};
    (lms || []).forEach(function (r) {
      lmsByCourse[r.course_id] = r;
    });
    c.ghl = fin.filter(function (co) {
      var r = lmsByCourse[co.id];
      return !r || (r.status !== 'imported' && r.status !== 'live');
    }).length;
    return c;
  }

  // Regroupe et trie les lecons par etape (pour les listes de la vue Production).
  function byStage(lessons) {
    var m = {};
    STAGE_ORDER.forEach(function (s) {
      m[s] = [];
    });
    lessons.forEach(function (l) {
      if (m[l.pipeline_stage]) m[l.pipeline_stage].push(l);
    });
    Object.keys(m).forEach(function (s) {
      m[s].sort(function (a, b) {
        return (
          (a.course_id + '').localeCompare(b.course_id) || (a.sort_order || 0) - (b.sort_order || 0)
        );
      });
    });
    return m;
  }

  // Mapping du statut d'import GHL (course_lms_status.status) vers {key,label} d'affichage.
  function gStatusOf(rec) {
    if (!rec) return { key: 'pret', label: 'PRÊT' };
    if (rec.status === 'live') return { key: 'live', label: 'EN LIGNE' };
    if (rec.status === 'imported') return { key: 'imported', label: 'IMPORTÉ' };
    if (rec.status === 'exported') return { key: 'exported', label: 'EXPORTÉ' };
    return { key: 'pret', label: 'PRÊT' };
  }

  // Phase d'une formation d'apres ses compteurs : Pret LMS / Phase video / Phase voix.
  function coursePhase(s) {
    var t = sumStages(s);
    var voiceDone = t - (s.voice_review || 0) - (s.voice_recheck || 0);
    if (t > 0 && s.done === t) return { cls: 'ready', label: '✅ Prêt LMS' };
    if (voiceDone === t) return { cls: 'video', label: '🎬 Phase vidéo' };
    return { cls: 'voice', label: '🎙️ Phase voix' };
  }

  // Etat de sante de la boucle de correction (Nitro). nowMs = Date.now() injecte (testable).
  // pendingNow = nb de corrections actuellement 'pending' (fetch frais cote cockpit) — sert a ne
  // PAS crier au loup quand le Mac dort mais qu'il n'y a rien a traiter (fausse alerte).
  // Retourne un niveau :
  //   'error' (rouge)  : le worker a signale une erreur — toujours alerter, meme battement recent.
  //   'alert' (rouge)  : >15 min sans battement ET des corrections en attente (travail coince).
  //   'idle'  (gris)   : >15 min sans battement mais rien en attente (Mac endormi, file vide).
  //   sinon show=false : battement recent.
  function healthState(health, nowMs, pendingNow) {
    if (!health || !health.last_heartbeat) return { show: false };
    var ageMin = (nowMs - new Date(health.last_heartbeat).getTime()) / 60000;
    if (health.status === 'error')
      return { show: true, level: 'error', error: true, ageMin: ageMin, version: health.version };
    if (ageMin <= 15) return { show: false, ageMin: ageMin };
    // Travail reel en attente = max du fetch frais et du compteur du dernier run du worker.
    var hbPending = (health.next_jobs && health.next_jobs.pending) || 0;
    var pending = Math.max(pendingNow || 0, hbPending);
    if (pending > 0)
      return { show: true, level: 'alert', ageMin: ageMin, pending: pending, version: health.version };
    return { show: true, level: 'idle', ageMin: ageMin, pending: 0, version: health.version };
  }

  // Nom affichable d'une lecon, robuste si lesson_key est null/absent (evite un crash .split
  // qui casserait tout le rendu du cockpit sur une donnee Supabase inattendue).
  function lessonName(l) {
    if (l.short_title) return l.short_title;
    if (l.title) return l.title;
    if (l.lesson_key) return l.lesson_key.split('/').pop();
    return '?';
  }

  return {
    STAGE_ORDER: STAGE_ORDER,
    lessonName: lessonName,
    sumStages: sumStages,
    perCourseCounts: perCourseCounts,
    finishedCourses: finishedCourses,
    tabCounts: tabCounts,
    byStage: byStage,
    gStatusOf: gStatusOf,
    coursePhase: coursePhase,
    healthState: healthState,
  };
});

/**
 * lib/review-logic.js — Logique PURE de la revision voix (flags, contexte, timestamps, statuts).
 *
 * Extrait de review/flags.js, review/loader.js, review/corrections.js. Les globals du navigateur
 * (W = mots, flags = Map, regenIndices) sont passes en parametres → testable hors navigateur.
 * Export double navigateur (window.XGReview) / Node (require).
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else root.XGReview = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // ── Predicats de flag ────────────────────────────────────────────
  // Resolu = la phrase a ete regeneree depuis la pose du flag (et pas re-flaggee a la main).
  function isResolved(flag, regenIndices) {
    if (!regenIndices) return false;
    if (flag.reflagged) return false;
    if (
      flag.sentenceIndex === null ||
      flag.sentenceIndex === undefined ||
      flag.sentenceIndex === '?'
    )
      return false;
    return regenIndices.indexOf(flag.sentenceIndex) !== -1;
  }
  function isApproved(flag) {
    return !!flag.approved_after_regen;
  }
  function isAutoResolved(flag) {
    return !!flag.auto_resolved;
  }
  function isHidden(flag) {
    return isApproved(flag) || isAutoResolved(flag);
  }

  // ── Contexte d'un mot flagge (borne a la phrase) ─────────────────
  function getCtx(W, i) {
    var MIN_BEFORE = 6,
      MIN_AFTER = 6;
    var MAX_BEFORE = 10,
      MAX_AFTER = 10;
    if (!W[i]) return '';
    var si = W[i].sentenceIndex;
    var sentStart = i;
    while (sentStart > 0 && W[sentStart - 1].sentenceIndex === si) sentStart--;
    var sentEnd = i;
    while (sentEnd < W.length - 1 && W[sentEnd + 1].sentenceIndex === si) sentEnd++;
    var s = Math.max(sentStart, i - MAX_BEFORE);
    var e = Math.min(sentEnd, i + MAX_AFTER);
    if (sentEnd - sentStart <= MIN_BEFORE + MIN_AFTER) {
      s = sentStart;
      e = sentEnd;
    }
    var prefix = s > sentStart ? '... ' : '';
    var suffix = e < sentEnd ? ' ...' : '';
    var r = [];
    for (var k = s; k <= e; k++) r.push(k === i ? '**' + W[k].word + '**' : W[k].word);
    return prefix + r.join(' ') + suffix;
  }

  // ── Contexte d'un GROUPE de mots (Ctrl+click) ────────────────────
  function getGroupCtx(W, groupIndices) {
    if (!groupIndices || groupIndices.length === 0) return '';
    var sortedIdx = groupIndices.slice().sort(function (a, b) {
      return a - b;
    });
    var first = sortedIdx[0];
    var last = sortedIdx[sortedIdx.length - 1];
    if (!W[first]) return '';
    var si = W[first].sentenceIndex;
    var sentStart = first;
    while (sentStart > 0 && W[sentStart - 1].sentenceIndex === si) sentStart--;
    var sentEnd = last;
    while (sentEnd < W.length - 1 && W[sentEnd + 1].sentenceIndex === si) sentEnd++;

    var groupSet = new Set(sortedIdx);
    var subGroups = [];
    var cur = [sortedIdx[0]];
    for (var i = 1; i < sortedIdx.length; i++) {
      if (sortedIdx[i] === sortedIdx[i - 1] + 1) cur.push(sortedIdx[i]);
      else {
        subGroups.push(cur);
        cur = [sortedIdx[i]];
      }
    }
    subGroups.push(cur);

    var WINDOW = 5;
    var parts = [];
    var lastEnd = -1;
    for (var sg = 0; sg < subGroups.length; sg++) {
      var sub = subGroups[sg];
      var subFirst = sub[0];
      var subLast = sub[sub.length - 1];
      var winStart = Math.max(sentStart, subFirst - WINDOW);
      var winEnd = Math.min(sentEnd, subLast + WINDOW);
      var localPrefix = '';
      if (lastEnd >= 0 && winStart <= lastEnd + 1) {
        winStart = lastEnd + 1;
      } else if (sg === 0 && winStart > sentStart) {
        localPrefix = '... ';
      } else if (sg > 0) {
        localPrefix = ' ... ';
      }
      var r = [];
      for (var k = winStart; k <= winEnd; k++) {
        if (groupSet.has(k)) {
          var openBold = !groupSet.has(k - 1) || k === winStart;
          var closeBold = !groupSet.has(k + 1) || k === winEnd;
          var token = W[k].word;
          if (openBold) token = '**' + token;
          if (closeBold) token = token + '**';
          r.push(token);
        } else {
          r.push(W[k].word);
        }
      }
      parts.push(localPrefix + r.join(' '));
      lastEnd = winEnd;
    }
    var suffix = lastEnd < sentEnd ? ' ...' : '';
    return parts.join('') + suffix;
  }

  // ── Groupage de flags ────────────────────────────────────────────
  // flags = Map(index -> flag). Retourne l'index leader du groupe contenant ii, ou null.
  function findGroupLeader(flags, ii) {
    if (flags.has(ii)) return ii;
    var leaderIdx = null;
    flags.forEach(function (f, leaderIi) {
      if (Array.isArray(f.groupIndices) && f.groupIndices.indexOf(ii) !== -1) leaderIdx = leaderIi;
    });
    return leaderIdx;
  }

  // Flag actif le plus proche de currentIdx, dans la MEME phrase. null sinon.
  function findClosestFlag(W, flags, currentIdx) {
    if (currentIdx == null || !W[currentIdx]) return null;
    var currentSi = W[currentIdx].sentenceIndex;
    var best = null;
    var bestDistance = Infinity;
    flags.forEach(function (f, leaderIi) {
      if (isHidden(f)) return;
      var memberIndices = Array.isArray(f.groupIndices) ? f.groupIndices : [leaderIi];
      var minDist = Infinity;
      var sameSentence = false;
      for (var i = 0; i < memberIndices.length; i++) {
        var mi = memberIndices[i];
        if (W[mi] && W[mi].sentenceIndex === currentSi) sameSentence = true;
        var d = Math.abs(mi - currentIdx);
        if (d < minDist) minDist = d;
      }
      if (sameSentence && minDist < bestDistance) {
        bestDistance = minDist;
        best = leaderIi;
      }
    });
    return best;
  }

  // ── Statut d'une demande de correction (texte + classe CSS) ──────
  function correctionStatusLabel(s) {
    if (s.status === 'pending') return { t: '✓ Envoyée — en traitement (Nitro)', c: 'pending' };
    if (s.status === 'processing') return { t: '⚙️ En cours…', c: 'processing' };
    if (s.status === 'needs_review') return { t: '\u{1f441}️ À réviser (Nicolas)', c: 'review' };
    if (s.status === 'error') return { t: '⚠ Erreur', c: 'error' };
    if (s.status === 'done') {
      var wt = '';
      if (s.completed_at) {
        var w = new Date(s.completed_at);
        var p = function (n) {
          return String(n).padStart(2, '0');
        };
        wt =
          ' le ' +
          p(w.getDate()) +
          '/' +
          p(w.getMonth() + 1) +
          ' à ' +
          p(w.getHours()) +
          'h' +
          p(w.getMinutes());
      }
      return { t: '✅ Corrigé' + wt, c: 'done' };
    }
    return { t: '', c: '' };
  }

  // ── Construction d'une demande de correction (intention explicite) ─
  // À partir de la catégorie du flag (UI), du mot, du remplacement tapé et de la note,
  // décide l'INTENTION envoyée à Nitro + le correction_note. Pur/testable.
  //   category 'typo'          -> intent 'word'         (mauvais mot : remplacement OBLIGATOIRE)
  //   category 'pronunciation' -> intent 'pronunciation'(mot bien écrit, mal dit : indice OU note)
  //   category 'rewrite'       -> redirect 'sentence'   (toute la phrase via le modal)
  var ARROW_RE = /(?:->|=>|→|➜)/;
  function buildCorrection(opts) {
    var cat = (opts && opts.category) || 'pronunciation';
    var word = ((opts && opts.word) || '').trim();
    var value = ((opts && opts.value) || '').trim();
    var note = ((opts && opts.note) || '').trim();
    var arrowed = function (v) {
      return ARROW_RE.test(v) ? v : word + ' → ' + v;
    };
    if (cat === 'rewrite') return { ok: false, redirect: 'sentence' };
    if (cat === 'typo') {
      if (!value) return { ok: false, error: 'Tape le bon mot d’abord (ex : manette).' };
      return { ok: true, intent: 'word', correctionNote: arrowed(value), reviewerNote: note || null };
    }
    // pronunciation : le mot est bien écrit, c'est la voix qui le dit mal.
    if (!value && !note)
      return { ok: false, error: 'Dis comment ça doit sonner (indice ou note), ou 🔁 si ça bégaie.' };
    return {
      ok: true,
      intent: 'pronunciation',
      correctionNote: value ? arrowed(value) : '[prononciation] ' + word,
      reviewerNote: note || null,
    };
  }

  // ── Timestamps ───────────────────────────────────────────────────
  // Selectionne le meilleur jeu de timestamps parmi des candidats (ordre = priorite).
  // Valide = contient sentenceIndex 0. Indices 0-1 = preview/, 2-3 = chemin final.
  // Retourne { words: tableau|null, source: 'preview'|'final' }.
  function pickBestTimestamps(candidates) {
    var best = null,
      bestIdx = -1;
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (!Array.isArray(c) || !c.length) continue;
      if (
        !c.some(function (w) {
          return w.sentenceIndex === 0;
        })
      )
        continue;
      best = c;
      bestIdx = i;
      break;
    }
    var source = bestIdx >= 0 && bestIdx <= 1 ? 'preview' : 'final';
    if (!best) {
      candidates.forEach(function (c) {
        if (!Array.isArray(c) || !c.length) return;
        if (!best || c.length > best.length) best = c;
      });
    }
    return { words: best, source: source };
  }

  // Plages temporelles {start,end} par sentenceIndex, calculees depuis les mots W.
  function computeSentenceRanges(W) {
    var ranges = {};
    for (var i = 0; i < W.length; i++) {
      var w = W[i];
      var si = w.sentenceIndex;
      if (si === null || si === undefined) continue;
      if (!ranges[si]) {
        ranges[si] = { start: w.start, end: w.end != null ? w.end : w.start };
      } else {
        if (w.start < ranges[si].start) ranges[si].start = w.start;
        var we = w.end != null ? w.end : w.start;
        if (we > ranges[si].end) ranges[si].end = we;
      }
    }
    return ranges;
  }

  // ── Barre d'info video (review-video) ────────────────────────────
  // Construit le HTML de la barre d'info en ECHAPPANT les valeurs venant de Supabase
  // (produced_by, produced_at) — sinon une donnee piegee s'injecterait dans innerHTML (XSS).
  // esc/fmtDate/fmtTime sont injectes (la fonction reste pure et testable).
  function buildInfoBar(VM, esc, fmtDate, fmtTime) {
    var parts = [];
    var v = VM.version || 1;
    parts.push(
      '<strong style="' +
        (v > 1 ? 'color:#F39C12;font-size:14px' : 'font-size:14px') +
        '">Version ' +
        esc(v) +
        '</strong>',
    );
    if (VM.produced_at)
      parts.push('Produite : <strong>' + esc(fmtDate(VM.produced_at)) + '</strong>');
    if (VM.duration_seconds)
      parts.push('Duree : <strong>' + esc(fmtTime(VM.duration_seconds)) + '</strong>');
    if (VM.produced_by) parts.push('Source : <strong>' + esc(VM.produced_by) + '</strong>');
    parts.push('Voix : <strong style="color:#27AE60">✓ approuvee</strong>');
    return parts.join('<span class="sep">·</span>');
  }

  return {
    buildInfoBar: buildInfoBar,
    buildCorrection: buildCorrection,
    isResolved: isResolved,
    isApproved: isApproved,
    isAutoResolved: isAutoResolved,
    isHidden: isHidden,
    getCtx: getCtx,
    getGroupCtx: getGroupCtx,
    findGroupLeader: findGroupLeader,
    findClosestFlag: findClosestFlag,
    correctionStatusLabel: correctionStatusLabel,
    pickBestTimestamps: pickBestTimestamps,
    computeSentenceRanges: computeSentenceRanges,
  };
});

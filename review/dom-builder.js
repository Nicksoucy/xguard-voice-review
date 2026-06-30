function refreshFlagClasses(){
  // Reset all
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (!el || !el.classList) continue;
    el.classList.remove('flagged');
    el.classList.remove('resolved');
    el.classList.remove('approved');
    el.classList.remove('grouped');
  }
  // Re-applique en gerant les groupes
  flags.forEach(function(f, leaderIdx){
    var isGroup = Array.isArray(f.groupIndices) && f.groupIndices.length > 1;
    var memberIndices = isGroup ? f.groupIndices : [leaderIdx];
    memberIndices.forEach(function(memberIdx){
      var ele = els[memberIdx];
      if (!ele || !ele.classList) return;
      // Meme cascade qu'au chargement : un flag regle ne marque plus le mot.
      if (f.reflagged) ele.classList.add('flagged','reflagged');
      else if (isApproved(f) || isAutoResolved(f)) { /* regle : aucune marque */ }
      else if (isResolved(f)) ele.classList.add('resolved');
      else ele.classList.add('flagged');
      if (isGroup) ele.classList.add('grouped');
    });
  });
}

function buildWords(){
  var c=document.getElementById('wc');c.innerHTML='';els=[];
  var ls=-1;
  var regenSet = (filterModeActive && regenIndices) ? new Set(regenIndices) : null;
  // Set des phrases regenerees pour le SURLIGNAGE VERT (independant du mode filtre).
  // Permet de voir d'un coup d'oeil quelles phrases ont ete corrigees suite aux flags.
  // EXCLUE les phrases dont TOUS les flags ont ete approuves (deja confirmees OK).
  // Strategie : pour chaque phrase regen, si au moins UN flag actif (non approuve) existe
  // OU si aucun flag n'existe (flag genere automatiquement par dict mais jamais re-flagge),
  // on garde le vert. Sinon (tous flags approuves), on cache.
  var regenHighlightSet = null;
  if (regenIndices && regenIndices.length) {
    regenHighlightSet = new Set(regenIndices);
    // Compter les phrases avec au moins 1 flag non approuve
    var sentencesWithUnapprovedFlag = new Set();
    var sentencesWithAnyFlag = new Set();
    flags.forEach(function(f){
      if (f.sentenceIndex != null && f.sentenceIndex !== '?') {
        sentencesWithAnyFlag.add(f.sentenceIndex);
        if (!isApproved(f)) {
          sentencesWithUnapprovedFlag.add(f.sentenceIndex);
        }
      }
    });
    // Pour chaque phrase regen : retirer du highlight si elle a des flags ET tous approuves
    regenIndices.forEach(function(si){
      if (sentencesWithAnyFlag.has(si) && !sentencesWithUnapprovedFlag.has(si)) {
        regenHighlightSet.delete(si);
      }
    });
  }
  var lastSiWasHidden = false;
  var hiddenCount = 0;

  for(var i=0;i<W.length;i++){
    var w=W[i];
    var si=w.sentenceIndex!=null?w.sentenceIndex:-1;

    // Mode filtre : sauter les phrases non regenerees
    if (regenSet && si >= 0 && !regenSet.has(si)) {
      // Toujours pousser un placeholder pour que els[i] reste aligne avec W[i]
      // (le sync audio utilise els[i] pour highlighter les mots).
      var hidden = document.createElement('span');
      hidden.style.display = 'none';
      els.push(hidden);
      if (!lastSiWasHidden) {
        // Afficher un petit separateur "..." cliquable pour rappeler qu'il y a du contenu cache
        var gap = document.createElement('span');
        gap.className = 'sentence-gap';
        gap.textContent = '· · ·';
        gap.title = 'Phrases non regenerees masquees. Cliquer pour tout afficher.';
        gap.onclick = function(){ toggleFilterMode(); };
        c.appendChild(gap);
      }
      lastSiWasHidden = true;
      hiddenCount++;
      continue;
    }
    lastSiWasHidden = false;

    if(si!==ls&&si>=0){
      var m=document.createElement('span');m.className='sm';m.textContent='['+si+']';c.appendChild(m);
      // Bouton flag phrase : cliquable pour ouvrir le modal "Flag phrase"
      var flagBtn=document.createElement('span');
      flagBtn.className='sm-flag';
      flagBtn.textContent='✏️'; // crayon = corriger le texte de la phrase
      flagBtn.title='✏️ Corriger le texte de cette phrase (reformuler, regénérer, remplacer…)';
      (function(sentenceIdx){
        flagBtn.onclick=function(e){e.stopPropagation();openSentenceModal(sentenceIdx)};
      })(si);
      c.appendChild(flagBtn);
      ls=si;
    }
    var s=document.createElement('span');s.className='w';s.textContent=w.word;
    // Surlignage vert si la phrase a ete regeneree (visible meme hors mode filtre).
    if (regenHighlightSet && si >= 0 && regenHighlightSet.has(si)) {
      s.classList.add('regenerated');
    }
    // Re-appliquer le statut flagged/resolved/approved si cette phrase avait deja un flag.
    // Cherche d'abord si i est leader, sinon si i est dans le groupIndices d'un flag.
    var fgFound = null, isGroupMember = false;
    if (flags.has(i)) {
      fgFound = flags.get(i);
      isGroupMember = Array.isArray(fgFound.groupIndices) && fgFound.groupIndices.length > 1;
    } else {
      flags.forEach(function(f){
        if (Array.isArray(f.groupIndices) && f.groupIndices.indexOf(i) !== -1) {
          fgFound = f;
          isGroupMember = true;
        }
      });
    }
    if (fgFound) {
      // Cascade harmonisee (audit 2026-06-10) : reflagged prioritaire, les
      // flags regles ne marquent plus le mot.
      if (fgFound.reflagged) s.classList.add('flagged','reflagged');
      else if (isApproved(fgFound) || isAutoResolved(fgFound)) { /* regle : aucune marque */ }
      else if (isResolved(fgFound)) s.classList.add('resolved');
      else s.classList.add('flagged');
      if (isGroupMember) s.classList.add('grouped');
    }
    (function(ii,sp){
      sp.onclick=function(e){
        if (roGuard()) return;   // lecture seule : ne pas modifier les flags d'un autre reviseur
        // ── CTRL+CLICK : grouper avec un flag existant ───────────────
        // Ctrl+click sur un mot ajoute ce mot au DERNIER flag actif (rouge)
        // pour creer un flag groupe (ex: "cent vingt metres" = 1 seul flag).
        // Le mot est marque flagged + classe 'grouped' pour indication visuelle.
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          // Si le mot est deja flagged, le retirer du groupe
          if (sp.classList.contains('flagged')) {
            // Trouver le flag-leader (celui qui contient ii dans groupIndices)
            var leaderIdx = findGroupLeader(ii);
            if (leaderIdx !== null) {
              var lf = flags.get(leaderIdx);
              if (lf && Array.isArray(lf.groupIndices)) {
                lf.groupIndices = lf.groupIndices.filter(function(g){ return g !== ii; });
                // Si plus rien dans le groupe (mot etait seul), supprimer le flag
                if (lf.groupIndices.length === 0) {
                  flags.delete(leaderIdx);
                } else {
                  // Reconstruire le mot concatene
                  lf.word = lf.groupIndices.map(function(g){ return W[g] ? W[g].word : ''; }).filter(Boolean).join(' ');
                  flags.set(leaderIdx, lf);
                }
                sp.classList.remove('flagged');
                sp.classList.remove('grouped');
              }
            } else {
              // Flag isole, retire normalement
              flags.delete(ii);
              sp.classList.remove('flagged');
            }
          } else {
            // Chercher le flag le plus proche dans la MEME phrase (priorite a la proximite)
            // Cela permet de grouper avec un flag deja resolu (vert) — utile quand on
            // veut signaler que plusieurs mots sonnent encore mal apres regen.
            var leader = findClosestFlag(ii);
            if (leader !== null) {
              var lf2 = flags.get(leader);
              // Si le flag est resolu (vert), Ctrl+click signifie "ce mot ET le flag existant sont
              // encore mal" -> promotion en reflagged pour qu'il repasse rouge.
              if (isResolved(lf2)) {
                lf2.reflagged = true;
              }
              // Promouvoir en groupe si pas deja
              if (!Array.isArray(lf2.groupIndices)) {
                lf2.groupIndices = [leader];
              }
              if (lf2.groupIndices.indexOf(ii) === -1) {
                lf2.groupIndices.push(ii);
                lf2.groupIndices.sort(function(a,b){ return a-b; });
                // Reconstruire le mot concatene en ordre lexical
                lf2.word = lf2.groupIndices.map(function(g){ return W[g] ? W[g].word : ''; }).filter(Boolean).join(' ');
                // Mettre a jour le contexte autour du LEADER
                lf2.context = getGroupCtx(lf2.groupIndices);
                flags.set(leader, lf2);
              }
              // Mettre a jour les classes de TOUS les membres du groupe (le leader peut etre
              // passe de resolved a flagged via reflagged ci-dessus)
              lf2.groupIndices.forEach(function(g){
                if (els[g]) {
                  els[g].classList.remove('resolved','approved');
                  els[g].classList.add('flagged');
                  els[g].classList.add('grouped');
                  if (lf2.reflagged) els[g].classList.add('reflagged');
                }
              });
            } else {
              // Pas de flag actif, creer un nouveau (mode normal)
              var nf2 = {index:ii,word:W[ii].word,context:getCtx(ii),time:fmt(W[ii].start),sentenceIndex:gsi(ii),note:''};
              flags.set(ii, nf2);
              sp.classList.add('flagged');
            }
          }
          renderFlags();
          scheduleAutoSave();
          return;
        }
        // ── CLICK NORMAL ───────────────────────────────────────────────
        // Cas 0 : mot "approved" (vert masque). Clic = annule l'approbation, repasse en resolved (vert visible)
        if(sp.classList.contains('approved')){
          sp.classList.remove('approved');
          sp.classList.add('resolved');
          var ex0 = flags.get(ii);
          if (ex0) { delete ex0.approved_after_regen; flags.set(ii, ex0); }
        }
        // Cas 1 : mot "resolved" (vert). Clic = "ce mot est encore pas bon" -> repasse violet (reflagged)
        else if(sp.classList.contains('resolved')){
          lessonApproved = false; // re-flag d'une phrase corrigee -> dés-approuve la lecon
          sp.classList.remove('resolved');
          sp.classList.add('flagged','reflagged');
          var existing = flags.get(ii) || {index:ii,word:W[ii].word,context:getCtx(ii),time:fmt(W[ii].start),sentenceIndex:gsi(ii),note:''};
          existing.reflagged = true; // marqueur : reste violet meme si la phrase est dans regenIndices
          delete existing.approved_after_regen; delete existing.approved_at; delete existing.auto_resolved;
          flags.set(ii, existing);
        }
        // Cas 2 : mot "flagged" (rouge). Clic = retirer le flag (et tout le groupe si applicable)
        else if(sp.classList.contains('flagged')){
          var groupLeader = findGroupLeader(ii);
          if (groupLeader !== null && groupLeader !== ii) {
            // Le mot fait partie d'un groupe dont il n'est pas leader : retirer du groupe
            var lf3 = flags.get(groupLeader);
            if (lf3 && Array.isArray(lf3.groupIndices)) {
              lf3.groupIndices = lf3.groupIndices.filter(function(g){ return g !== ii; });
              if (lf3.groupIndices.length === 0) {
                flags.delete(groupLeader);
                if (els[groupLeader]) els[groupLeader].classList.remove('flagged','grouped');
              } else {
                lf3.word = lf3.groupIndices.map(function(g){ return W[g] ? W[g].word : ''; }).filter(Boolean).join(' ');
                flags.set(groupLeader, lf3);
              }
            }
          } else {
            // Flag isole OU leader d'un groupe : retirer tout
            var lf4 = flags.get(ii);
            if (lf4 && Array.isArray(lf4.groupIndices)) {
              // Nettoyer les classes de tous les mots du groupe
              lf4.groupIndices.forEach(function(g){
                if (els[g]) els[g].classList.remove('flagged','grouped');
              });
            }
            flags.delete(ii);
          }
          sp.classList.remove('flagged');
          sp.classList.remove('grouped');
        }
        // Cas 3 : mot normal. Clic = ajoute un flag (rouge, sauf si phrase deja regeneree -> vert)
        else {
          lessonApproved = false; // nouveau probleme flagge -> dés-approuve la lecon
          var nf = {index:ii,word:W[ii].word,context:getCtx(ii),time:fmt(W[ii].start),sentenceIndex:gsi(ii),note:''};
          flags.set(ii, nf);
          if (isResolved(nf)) sp.classList.add('resolved');
          else sp.classList.add('flagged');
        }
        renderFlags();
        scheduleAutoSave();
      };
      sp.ondblclick=function(){if(!au)return;au.currentTime=Math.max(0,W[ii].start-0.15);if(au.paused)au.play()};
    })(i,s);
    c.appendChild(s);c.appendChild(document.createTextNode(' '));els.push(s);
  }
}

// Toggle le mode filtre (affiche seulement les phrases regenerees ou toutes)
function toggleFilterMode(){
  if (!regenIndices) return; // Rien a filtrer
  filterModeActive = !filterModeActive;
  var btn = document.getElementById('filterBtn');
  btn.classList.toggle('on', filterModeActive);
  buildWords();
  // Si l'audio joue dans une phrase non-a-revoir, sauter immediatement
  if (filterModeActive && au && !au.paused) maybeSkipUnregen();
}

function flagStutter(){
  if (!au) return;
  if (roGuard()) return;   // lecture seule : ne pas ajouter de glitch a la review d'un autre reviseur
  var t=au.currentTime;var i=0;for(var j=0;j<W.length;j++){if(W[j].start<=t)i=j}
  glitches.unshift({time:fmt(t),timeSec:t,context:getCtx(i),sentenceIndex:gsi(i),note:''});
  var b=document.getElementById('stb');b.classList.add('flash');b.textContent='\u2713';
  setTimeout(function(){b.classList.remove('flash');b.textContent='\u26a1 Stutter'},700);
  renderGlitches();
  scheduleAutoSave();
}

function hl(ctx){return (ctx||'').replace(/\*\*(.+?)\*\*/g,'<b style="color:#E74C3C">$1</b>')}

// Tokens nus du contexte (les mots de W joints par espaces, marqueurs ** retires).
function ctxTokens(ctx){ return (ctx||'').replace(/\*\*/g,'').split(' '); }

// Normalise un token pour comparaison : retire les accents et met en minuscules. Necessaire
// parce qu'une correction d'orthographe CHANGE souvent l'accent (le mot flagge "observee" est
// devenu "observée" dans le texte corrige). Sans ca, on ne retrouverait plus le mot.
function normTok(s){
  var map = {'à':'a','â':'a','ä':'a','é':'e','è':'e','ê':'e','ë':'e','î':'i','ï':'i','ô':'o','ö':'o','û':'u','ù':'u','ü':'u','ç':'c'};
  return (s||'').toLowerCase().replace(/[àâäéèêëîïôöûùüç]/g, function(c){ return map[c]; });
}

// Surligne le mot FLAGGE dans son contexte par correspondance de TEXTE (insensible aux accents),
// pas par index. Pourquoi : le contexte est sauvegarde avec des marqueurs **...** calcules a
// partir de l'index du mot dans les timestamps. Apres une regeneration, le nombre de mots d'une
// phrase change (surtout les "phrase a reecrire"), l'index ne pointe plus sur le meme mot et le
// gras tombe a cote. Bug Hela 2026-06-08 : elle flag "observee" mais "avec" est surligne en rouge.
// On recible directement le vrai mot flagge (d.word) dans le texte du contexte.
function hlFlag(ctx, word){
  var w = normTok((word||'').trim());
  if (!w) return hl(ctx);
  var toks = ctxTokens(ctx);
  var done = false;
  for (var i=0;i<toks.length;i++){
    if (!done && normTok(toks[i]) === w){ toks[i] = '**'+toks[i]+'**'; done = true; }
  }
  return hl(done ? toks.join(' ') : ctx);  // si introuvable (ex: flag groupe), fallback marqueurs
}

// Le contexte contient-il le mot flagge comme token (insensible aux accents) ? (garde au chargement)
function ctxHasWord(ctx, word){
  var w = normTok((word||'').trim());
  if (!w) return false;
  var toks = ctxTokens(ctx);
  for (var i=0;i<toks.length;i++){ if (normTok(toks[i]) === w) return true; }
  return false;
}

// Mots en gras (**...**) d'un contexte, joints par espace (pour valider un re-calcul de groupe).
function boldWords(ctx){
  var m = (ctx||'').match(/\*\*(.+?)\*\*/g) || [];
  return m.map(function(s){ return s.replace(/\*\*/g,''); }).join(' ').trim();
}

function renderGlitches(){
  var l=document.getElementById('gl');
  // Cacher les glitches auto_resolved (deja regenereses et marques cote serveur)
  // sauf si showApproved est actif (toggle "Afficher approuves")
  var visible = glitches.filter(function(g){ return showApproved || !g.auto_resolved; });
  var resolvedCount = glitches.filter(function(g){ return g.auto_resolved; }).length;
  if(!visible.length){
    if (resolvedCount > 0) {
      l.innerHTML='<div class="empty">'+resolvedCount+' stutter'+(resolvedCount>1?'s':'')+' auto-resolu'+(resolvedCount>1?'s':'')+' (apres regen). <a href="#" onclick="toggleShowApproved();return false" style="color:#888;text-decoration:underline">Afficher</a></div>';
    } else {
      l.innerHTML='<div class="empty">Appuie \u26a1 Stutter pendant l\'ecoute (raccourci: S)</div>';
    }
    return;
  }
  l.innerHTML='';
  for(var gi=0;gi<glitches.length;gi++){
    var g = glitches[gi];
    if (!showApproved && g.auto_resolved) continue;
    (function(g,ii){
      var d=document.createElement('div');
      d.className='ri g' + (g.auto_resolved ? ' ok' : '');
      if (g.auto_resolved) d.style.opacity = '0.55';
      d.innerHTML='<span class="rt" onclick="jmp('+g.timeSec+')">'+g.time+'</span><span class="rs">#'+g.sentenceIndex+'</span><span class="rc">'+hl(g.context)+'</span><input placeholder="Note" value="'+(g.note||'').replace(/"/g,'&quot;')+'" oninput="if(window.viewingOtherReview)return;glitches['+ii+'].note=this.value;scheduleAutoSave()"><button class="rm" onclick="if(window.viewingOtherReview)return;glitches.splice('+ii+',1);renderGlitches();scheduleAutoSave()">\u2715</button>';
      l.appendChild(d);
    })(g,gi);
  }
}

function renderFlags(){
  var l=document.getElementById('fl');
  // Mettre a jour le compteur "X a revoir" du bouton filtre en temps reel
  updateFilterBtnCount();
  // Compter les categories
  var greenCount = 0, approvedCount = 0;
  flags.forEach(function(f){
    if (isApproved(f)) approvedCount++;
    else if (isResolved(f)) greenCount++;
  });
  // Afficher/cacher le bouton batch "Approuver les verts"
  var btnApprove = document.getElementById('btnApproveGreens');
  if (btnApprove) {
    if (greenCount > 0) {
      btnApprove.textContent = '\u2713 Approuver les ' + greenCount + ' corrige' + (greenCount>1?'s':'');
      btnApprove.style.display = 'inline-block';
    } else {
      btnApprove.style.display = 'none';
    }
  }
  // Mettre a jour le toggle "Afficher approuves"
  var tog = document.getElementById('toggleApproved');
  if (tog) {
    if (approvedCount > 0) {
      tog.textContent = showApproved
        ? 'Cacher les ' + approvedCount + ' approuve' + (approvedCount>1?'s':'')
        : 'Afficher les ' + approvedCount + ' approuve' + (approvedCount>1?'s':'');
      tog.style.display = 'inline-block';
    } else {
      tog.style.display = 'none';
    }
  }
  // Empty state
  var totalVisible = 0;
  flags.forEach(function(f){ if (showApproved || !isHidden(f)) totalVisible++; });
  if(!totalVisible){l.innerHTML='<div class="empty">'+(flags.size?'Tous les flags ont ete approuves apres regen':'Clique sur les mots qui sonnent mal<br><span style="font-size:10px;opacity:0.7">Astuce : Ctrl+clic pour grouper plusieurs mots (ex: "cent vingt metres" en 1 flag)</span>')+'</div>';return}
  l.innerHTML='';var sorted=Array.from(flags.entries()).sort(function(a,b){return a[0]-b[0]});
  for(var k=0;k<sorted.length;k++){(function(ii,d){
    // Masquer les flags approuves OU auto_resolved sauf si showApproved
    if (isHidden(d) && !showApproved) return;
    var resolved = isResolved(d);
    var approved = isApproved(d);
    var autoResolved = isAutoResolved(d);
    var reflagged = !!d.reflagged;
    var el=document.createElement('div');
    el.className='ri ' + (reflagged ? 'reflag' : (approved || autoResolved ? 'ok' : (resolved ? 'ok' : 'f')));
    if ((approved || autoResolved) && !reflagged) el.style.opacity = '0.55';
    // Selecteur de categorie : permet a Nicolas de distinguer
    // - pronunciation : ElevenLabs prononce mal un mot correctement ecrit -> enrichir le dict
    // - typo : le scriptwriter a ecrit un mot qui n'existe pas -> corriger le .md, NE PAS enrichir dict
    // - rewrite : la phrase entiere est mal tournee -> phrase_patterns Supabase
    var currentCat = d.category || 'pronunciation';
    var catSelect = '<select class="rcat" onchange="if(window.viewingOtherReview)return;flags.get('+ii+').category=this.value;updateRfixPlaceholder('+ii+',this.value);scheduleAutoSave()" title="Categorie du flag">'
      + '<option value="pronunciation" title="Mot bien écrit mais mal prononcé — enrichir le dictionnaire"' + (currentCat==='pronunciation'?' selected':'') + '>prononciation</option>'
      + '<option value="typo" title="Mot mal écrit dans le script — corriger le texte source"' + (currentCat==='typo'?' selected':'') + '>faute de frappe</option>'
      + '<option value="rewrite" title="Toute la phrase est mal tournée — utilise plutôt le crayon de la phrase"' + (currentCat==='rewrite'?' selected':'') + '>phrase a reecrire</option>'
      + '</select>';
    // Si flag groupe, marquer visuellement avec un badge "groupe (N mots)"
    var isGroup = Array.isArray(d.groupIndices) && d.groupIndices.length > 1;
    var groupBadge = isGroup ? '<span class="rg" title="Flag groupe de '+d.groupIndices.length+' mots">\u{1F517} '+d.groupIndices.length+'</span>' : '';
    // Bouton X : nettoie les classes du leader ET de tous les membres du groupe
    var groupIndicesStr = isGroup ? '['+d.groupIndices.join(',')+']' : '['+ii+']';
    // Bouton reflag : visible sur les flags corriges (vert/approuve). Permet a l'employeur
    // de dire "cette correction n'est toujours pas bonne" -> le flag repasse en violet.
    var reflagBtn = '';
    if (reflagged) {
      reflagBtn = '<button class="rreflag on" title="Annuler le reflag (revenir a corrige)" onclick="undoReflag('+ii+')">\u21a9 reflag actif</button>';
    } else {
      // Bouton toujours disponible : sur un flag corrige/approuve = "cette correction
      // n'est toujours pas bonne"; sur un flag encore actif = "marquer prioritaire pour
      // la prochaine regen". Demande Nicolas 2026-05-21 (bouton invisible sur flags actifs).
      var reflagTitle = (resolved || approved || autoResolved)
        ? "Cette correction n'est toujours pas bonne"
        : "Marquer ce flag comme toujours mal prononce (priorite regen)";
      reflagBtn = '<button class="rreflag" title="'+reflagTitle+'" onclick="markReflag('+ii+')">\u26a0 Mal corrige</button>';
    }
    // Champ "Demander une correction automatique" (boucle Hela -> Nitro -> statut in-app).
    // Hela tape la correction voulue ; si pas de fleche, on prefixe avec le mot flagge.
    // Lien direct vers la reformulation de TOUTE la phrase (pour qui part d'un mot mais veut
    // changer la phrase entiere) -> ouvre le modal de la phrase correspondante.
    var phraseLink = (d.sentenceIndex != null)
      ? '<button class="rfixbtn rphrase" title="Changer TOUTE la phrase (reformuler le texte source)" onclick="openSentenceModal('+d.sentenceIndex+')">✏️ corriger la phrase</button>'
      : '';
    // Bouton « écouter la phrase corrigée » : joue depuis le début de la phrase du flag (toujours
    // dispo). Bouton « approuver » : visible quand la correction est appliquee (vert) et pas encore
    // approuvee — valide CETTE phrase (modele Nicolas : ecouter -> approuver dans le bloc).
    var listenBtn = (d.sentenceIndex != null)
      ? '<button class="rfixbtn rlisten" title="Écouter la phrase corrigée" onclick="listenSentence('+d.sentenceIndex+')">🔊 Écouter la phrase</button>'
      : '';
    var approveBtn = (!approved && !autoResolved)
      ? '<button class="rfixbtn rapprove" style="background:#1E8449;border-color:#1E8449;color:#fff" title="Écoute la phrase, puis approuve si elle est bonne" onclick="approveOneFlag('+ii+')">✅ Approuver</button>'
      : '';
    var rfixBlock = '<span class="rfixwrap"><input class="rfix" id="rfix'+ii+'" placeholder="'+rfixPlaceholder(currentCat)+'"><button class="rfixbtn" title="Tu as le bon texte : envoyer la correction (régénération auto)" onclick="submitCorrectionRequest('+ii+')">Corriger</button><button class="rfixbtn rpt" title="La voix répète ou bégaie ce mot — refaire ce bout (sans changer le texte)" onclick="submitRepeat('+ii+')">🔁 Re-générer</button><button class="rfixbtn" title="Atelier du son — tester la prononciation de ce mot" onclick="openAtelier('+ii+')">🎵 Atelier</button>'+phraseLink+listenBtn+approveBtn+'<span class="rfixstatus" id="rfixstatus'+ii+'"></span></span>';
    // Badge clair pour les flags REGLES (visibles seulement via le toggle
    // "afficher les corriges") : Hela sait quoi en penser sans deviner.
    var regleBadge = '';
    if ((approved || autoResolved) && !reflagged) {
      regleBadge = '<span style="color:#27AE60;font-size:10px;white-space:nowrap" title="'
        + (autoResolved ? 'Le mot a ete corrige automatiquement (il a disparu ou ete remplace dans le texte)' : 'Tu as approuve cette correction apres re-ecoute')
        + '">\u2713 ' + (autoResolved ? 'corrige automatiquement' : 'corrige et approuve') + '</span>';
    }
    el.innerHTML='<span class="rt" onclick="jmp('+(W[ii]?W[ii].start:0)+')">'+d.time+'</span><span class="rs">#'+(d.sentenceIndex!=null?d.sentenceIndex:'?')+'</span><span class="rw">'+d.word+'</span>'+regleBadge+groupBadge+catSelect+'<span class="rc">'+hlFlag(d.context, d.word)+'</span><input placeholder="Note" value="'+(d.note||'').replace(/"/g,'&quot;')+'" oninput="if(window.viewingOtherReview)return;flags.get('+ii+').note=this.value;scheduleAutoSave()">'+reflagBtn+rfixBlock+'<button class="rm" onclick="if(window.viewingOtherReview)return;flags.delete('+ii+');'+groupIndicesStr+'.forEach(function(g){if(els[g]){els[g].classList.remove(\'flagged\',\'resolved\',\'approved\',\'grouped\',\'reflagged\')}});renderFlags();scheduleAutoSave()">\u2715</button>';
    l.appendChild(el)})(sorted[k][0],sorted[k][1])}
  // Re-applique les statuts de correction connus (renderFlags efface le DOM a chaque appel).
  applyCorrectionStatuses();
  if (!window._corrInit) { window._corrInit = true; pollCorrectionStatus(); }
}

// Placeholder du champ de correction selon la categorie : prononciation -> le SON (ex "grann"),
// faute de frappe -> le bon MOT. Evite que Hela retape le mot pour la prononciation, ce qui
// donnait "grand -> grand" inutile (bug 2026-06-23). updateRfixPlaceholder rafraichit a la volee
// quand elle change la categorie dans le menu deroulant.
function rfixPlaceholder(cat){
  return cat === 'pronunciation'
    ? 'Ecris le SON voulu (ex : grann) — pas le mot tel quel'
    : 'Le bon mot (ex : changeons) — la fleche est ajoutee auto';
}
function updateRfixPlaceholder(ii, cat){
  var rf = document.getElementById('rfix'+ii);
  if (rf) rf.placeholder = rfixPlaceholder(cat);
}

// ============================================================
// DEMANDE DE CORRECTION AUTOMATIQUE (boucle Hela -> Nitro -> statut in-app)
// ============================================================
// Hela tape la correction voulue dans le champ d'un flag et clique "Corriger".
// -> INSERT dans correction_requests (status=pending). Le processor sur Nitro
//    (Task Scheduler /5min) trie, regenere si sur, et passe le statut a done /
//    needs_review. Le poller ci-dessous rafraichit le badge dans l'app.

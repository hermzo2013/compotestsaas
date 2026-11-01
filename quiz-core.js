/* =====================================================================
   RÉVISIO — ÉTAPE 2 : fonctions PURES (aucun accès DOM, Supabase ni timer)
   - Fonctionne dans le navigateur (window.QuizCore) ET dans Node (module.exports)
   - Aucune fonction ne modifie ses arguments : elles renvoient de nouvelles valeurs
   Convention : un "choix" est identifié par son INDEX dans question.options
   (c'est déjà le cas de `correct` dans ton format actuel).
   ===================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QuizCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------
  // Types
  // ---------------------------------------------------------------
  const TYPES = Object.freeze({
    QCD: 'QCD',                    // choix dichotomique : Vrai/Faux ou A/B (2 options, 1 réponse, radio)
    QCM_UNIQUE: 'QCM_UNIQUE',      // 1 réponse (radio)
    QCM_MULTIPLE: 'QCM_MULTIPLE'   // plusieurs réponses (checkbox)
  });

  const BADGES = Object.freeze({
    QCD:          { label: 'QCD',          cssClass: 'badge-qcd' },
    QCM_UNIQUE:   { label: 'QCM UNIQUE',   cssClass: 'badge-qcm-unique' },
    QCM_MULTIPLE: { label: 'QCM MULTIPLE', cssClass: 'badge-qcm-multiple' },
    SHORT:        { label: 'RÉPONSE COURTE', cssClass: 'badge-short' }
  });

  const isInt = (n) => typeof n === 'number' && Number.isInteger(n);

  // ---------------------------------------------------------------
  // Normalisation : ancien format -> nouveau format (sans migration de données)
  //   tf         -> QCD (Vrai/Faux), max_select 1, correct [i]
  //   mcq        -> QCD si exactement 2 options (A/B), sinon QCM_UNIQUE ; max_select 1, correct [i]
  //   mcq_multi  -> QCM_MULTIPLE, max_select = nb d'options (pas de limite avant), correct [..]
  //   short      -> inchangé (non géré par toggleReponse)
  // Un nouveau format est complété (max_select / correct) mais jamais écrasé.
  // ---------------------------------------------------------------
  function normalizeQuestion(q) {
    if (!q || typeof q !== 'object') return q;
    const options = Array.isArray(q.options) ? q.options : [];
    const asArray = (c) => Array.isArray(c) ? c.slice() : (isInt(c) ? [c] : []);

    switch (q.type) {
      case 'tf':
        return { ...q, type: TYPES.QCD, max_select: 1, correct: asArray(q.correct), _legacyType: q.type };
      case 'mcq':
        return { ...q, type: options.length === 2 ? TYPES.QCD : TYPES.QCM_UNIQUE, max_select: 1, correct: asArray(q.correct), _legacyType: q.type };
      case 'mcq_multi': {
        // la limite fournie par le sujet ("3 réponses maximum") est conservée si elle est cohérente
        const ms = (isInt(q.max_select) && q.max_select >= 2 && q.max_select <= options.length) ? q.max_select : Math.max(2, options.length);
        return { ...q, type: TYPES.QCM_MULTIPLE, max_select: ms, correct: asArray(q.correct), _legacyType: q.type };
      }
      case TYPES.QCM_UNIQUE:
        return { ...q, max_select: 1, correct: asArray(q.correct) };
      case TYPES.QCD:
        return { ...q, max_select: 1, correct: asArray(q.correct) };
      case TYPES.QCM_MULTIPLE:
        return { ...q, max_select: isInt(q.max_select) ? q.max_select : Math.max(2, options.length), correct: asArray(q.correct) };
      default:
        return { ...q }; // 'short' ou inconnu
    }
  }

  function isChoiceQuestion(q) {
    return !!q && (q.type === TYPES.QCD || q.type === TYPES.QCM_UNIQUE || q.type === TYPES.QCM_MULTIPLE);
  }

  /** 'radio' si max_select === 1, sinon 'checkbox' */
  function getSelectionMode(question) {
    return question && question.max_select === 1 ? 'radio' : 'checkbox';
  }

  // ---------------------------------------------------------------
  // toggleReponse(reponses, question, idChoix)
  //   reponses : tableau des index déjà cochés POUR CETTE QUESTION
  //   Renvoie un NOUVEAU tableau (trié, sans doublon). Ne modifie jamais `reponses`.
  //   - max_select === 1 : radio. Cliquer le choix déjà coché le décoche.
  //                        Cliquer un autre choix remplace la sélection.
  //   - max_select  > 1  : checkbox. Ajoute / retire. Si la limite est atteinte,
  //                        l'ajout est IGNORÉ (le tableau est renvoyé tel quel) :
  //                        utilise isSelectionFull() pour afficher "maximum atteint".
  //   - idChoix invalide (hors options, non entier) : aucun changement.
  // ---------------------------------------------------------------
  function toggleReponse(reponses, question, idChoix) {
    const current = Array.isArray(reponses) ? [...new Set(reponses.filter(isInt))] : [];
    const sortedCopy = (arr) => arr.slice().sort((a, b) => a - b);

    if (!question || !isInt(idChoix)) return sortedCopy(current);
    const n = Array.isArray(question.options) ? question.options.length : 0;
    if (idChoix < 0 || idChoix >= n) return sortedCopy(current);

    const max = isInt(question.max_select) && question.max_select >= 1 ? question.max_select : 1;
    const already = current.includes(idChoix);

    if (max === 1) {
      return already ? [] : [idChoix];
    }
    if (already) return sortedCopy(current.filter(x => x !== idChoix));
    if (current.length >= max) return sortedCopy(current);   // limite atteinte : ignoré
    return sortedCopy([...current, idChoix]);
  }

  function isSelectionFull(reponses, question) {
    const max = question && isInt(question.max_select) ? question.max_select : 1;
    return max > 1 && Array.isArray(reponses) && reponses.length >= max;
  }

  /** Un choix peut-il être (dé)coché ? Utile pour griser les cases quand le maximum est atteint. */
  function isChoiceDisabled(reponses, question, idChoix) {
    return !(reponses || []).includes(idChoix) && isSelectionFull(reponses, question);
  }

  // ---------------------------------------------------------------
  // Correction : égalité exacte d'ensembles (comme ton QCM multi actuel)
  // ---------------------------------------------------------------
  function isReponseCorrecte(question, reponses) {
    if (!isChoiceQuestion(question) || !Array.isArray(question.correct)) return false;
    const a = [...new Set(reponses || [])].sort((x, y) => x - y);
    const b = [...new Set(question.correct)].sort((x, y) => x - y);
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }

  // ---------------------------------------------------------------
  // Validation côté client (miroir de quiz_question_is_valid en SQL)
  // Renvoie { valid: boolean, errors: string[] }
  // ---------------------------------------------------------------
  function validateQuestion(q) {
    const errors = [];
    if (!isChoiceQuestion(q)) return { valid: false, errors: ['Type inconnu ou non géré.'] };
    if (typeof q.text !== 'string' || !q.text.trim()) errors.push('Le texte est vide.');
    const opts = Array.isArray(q.options) ? q.options : [];
    if (opts.length < 2 || opts.length > 10) errors.push('Il faut entre 2 et 10 options.');
    if (q.type === TYPES.QCD && opts.length !== 2) errors.push('QCD exige exactement 2 options (Vrai/Faux ou A/B).');
    if (opts.some(o => typeof o !== 'string' || !o.trim())) errors.push('Une option est vide.');
    const ms = q.max_select;
    if (!isInt(ms)) errors.push('max_select doit être un entier.');
    else {
      if (q.type === TYPES.QCM_UNIQUE && ms !== 1) errors.push('QCM_UNIQUE exige max_select = 1.');
      if (q.type === TYPES.QCD && ms !== 1) errors.push('QCD exige max_select = 1.');
      if (q.type === TYPES.QCM_MULTIPLE && (ms < 2 || ms > opts.length)) errors.push('QCM_MULTIPLE exige 2 <= max_select <= nombre d\'options.');
    }
    const c = q.correct;
    if (!Array.isArray(c) || c.length < 1) errors.push('Au moins une bonne réponse est requise.');
    else {
      if (c.some(x => !isInt(x) || x < 0 || x >= opts.length)) errors.push('Une bonne réponse pointe hors des options.');
      if (new Set(c).size !== c.length) errors.push('Bonnes réponses en double.');
      if (isInt(ms) && c.length > ms) errors.push('Plus de bonnes réponses que max_select.');
    }
    return { valid: errors.length === 0, errors };
  }

  // ---------------------------------------------------------------
  // Formatage
  // ---------------------------------------------------------------
  /** 75 -> "01:15" ; 3725 -> "1:02:05" ; valeurs négatives/invalides -> "00:00" */
  function formatTime(totalSeconds) {
    const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
  }

  /** Badge à afficher pour une question (accepte aussi l'ancien format). */
  function getTypeBadge(question) {
    const q = normalizeQuestion(question);
    if (q && q.type === 'short') return BADGES.SHORT;
    return (q && BADGES[q.type]) || BADGES.QCM_UNIQUE;
  }

  /** Consigne affichée sous la question. */
  function formatSelectionHint(question) {
    const ms = question && question.max_select;
    const n = question && Array.isArray(question.options) ? question.options.length : 0;
    if (ms === 1) return 'Une seule réponse';
    if (isInt(ms) && ms > 1) return (n > 0 && ms >= n) ? 'Plusieurs réponses possibles' : `Jusqu'à ${ms} réponses`;
    return '';
  }

  // ---------------------------------------------------------------
  // Chronos & blocs (mode QPQ)
  // ---------------------------------------------------------------
  /** Durée d'un bloc = nb de questions x secondes par question. */
  function computeBlockTimeSeconds(nbQuestions, secondsPerQuestion) {
    const n = Math.max(0, Math.floor(Number(nbQuestions) || 0));
    const spq = Math.max(0, Math.floor(Number(secondsPerQuestion) || 0));
    return n * spq;
  }

  /**
   * Regroupe les questions d'un quiz en blocs ordonnés.
   *  - QPQ    : suit quiz.blocks ; chaque question est rattachée via block_id,
   *             en conservant son ordre d'origine ; globalIndex = position dans quiz.questions.
   *  - NORMAL : un seul bloc "Questions" contenant tout.
   * Les questions sans block_id valide en mode QPQ sont ignorées du regroupement
   * (la contrainte SQL les empêche, mais on reste défensif).
   * Renvoie : [{ id, title, case_block, questions:[{...q, globalIndex}], timeSeconds }]
   */
  function groupQuestionsIntoBlocks(quiz) {
    const questions = (quiz && Array.isArray(quiz.questions)) ? quiz.questions : [];
    const spq = quiz && quiz.seconds_per_question;
    const mode = quiz && quiz.display_mode === 'QPQ' ? 'QPQ' : 'NORMAL';

    if (mode === 'NORMAL' || !Array.isArray(quiz.blocks) || quiz.blocks.length === 0) {
      const qs = questions.map((q, i) => ({ ...q, globalIndex: i }));
      return [{ id: 'all', title: 'Questions', case_block: null, questions: qs, timeSeconds: computeBlockTimeSeconds(qs.length, spq) }];
    }
    return quiz.blocks.map(b => {
      const qs = [];
      questions.forEach((q, i) => { if (String(q.block_id) === String(b.id)) qs.push({ ...q, globalIndex: i }); });
      return {
        id: String(b.id),
        title: b.title || 'Bloc',
        case_block: b.case_block || null,
        questions: qs,
        timeSeconds: computeBlockTimeSeconds(qs.length, spq)
      };
    }).filter(b => b.questions.length > 0);
  }

  function computeTotalTimeSeconds(blocks) {
    return (blocks || []).reduce((sum, b) => sum + (b.timeSeconds || 0), 0);
  }

  return {
    TYPES, BADGES,
    normalizeQuestion, isChoiceQuestion, getSelectionMode,
    toggleReponse, isSelectionFull, isChoiceDisabled, isReponseCorrecte,
    validateQuestion,
    formatTime, getTypeBadge, formatSelectionHint,
    computeBlockTimeSeconds, groupQuestionsIntoBlocks, computeTotalTimeSeconds
  };
});

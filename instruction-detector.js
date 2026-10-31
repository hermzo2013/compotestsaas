/* =====================================================================
   RÉVISIO — ÉTAPE 3a : détection des CONSIGNES écrites dans les sujets importés
   (module ES, à placer à côté de server.js ; aucune dépendance)

   Ce que le module lit dans le texte d'un sujet :
     - le type de réponse attendu : unique (1), double (QCD, 2), multiple (n max)
     - les blocs "étude de cas" et leur énoncé, avec les questions qui s'y rapportent
     - le mode question-par-question (QPQ) : "pas de retour en arrière", "dossier progressif"...
     - le temps par question / par bloc

   Principes de sécurité :
     - Rien n'est inventé : sans consigne reconnue, la question reste exactement comme avant.
     - Les marques de correction du sujet (✓, grille de réponses) gagnent toujours sur la consigne
       (un avertissement est émis en cas de contradiction).
     - Si la détection fait perdre des questions par rapport à l'extraction d'origine,
       on revient à l'extraction d'origine.
   ===================================================================== */

// ---------------------------------------------------------------
// Normalisation (conserve la longueur : utile pour travailler sur des index)
// ---------------------------------------------------------------
export function norm(s) {
  return String(s ?? '')
    .normalize('NFC')
    .replace(/[\u00C0-\u017F]/g, ch => (ch.normalize('NFD')[0] || ch))
    .replace(/œ/gi, 'o')
    .replace(/[\u00A0\u202F\u2009]/g, ' ')
    .replace(/[’‘`´]/g, "'")
    .replace(/[–—‑−]/g, '-')
    .toLowerCase();
}

const WORD_NUM = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10 };
const toNum = (tok) => (/^\d+$/.test(tok) ? parseInt(tok, 10) : WORD_NUM[tok]);
const isInt = (n) => typeof n === 'number' && Number.isInteger(n);

// ---------------------------------------------------------------
// Briques de regex
// ---------------------------------------------------------------
const NOUN0 = String.raw`(?:reponses?|propositions?|assertions?|affirmations?|items?|choix|options?|cases?|possibilites?)`;
const NOUN = String.raw`(?:bonnes?\s+)?${NOUN0}`;
const NUM = String.raw`(\d{1,2}|une?|deux|trois|quatre|cinq|six|sept|huit|neuf|dix)`;
const ADJ = String.raw`(?:exactes?|justes?|vraies?|correctes?|valides?)`;
const NOT_PREV = String.raw`(?<!\b(?:les|ces|des|ses|parmi|aux)\s)`;
const VERBS = String.raw`(?:choisi(?:r|ssez|s)|cochez|cocher|selectionn(?:ez|er)|entourez|entourer|donnez|indiquez|identifiez|retenez|retenir|soulignez|designez|encadrez|reperez|trouvez|repondez\s+par)`;

// --- Nombre de réponses explicite -> max_select ---
const COUNT_RES = [
  // "au maximum 3 réponses", "jusqu'à 2 propositions", "pas plus de 3 réponses"
  new RegExp(String.raw`\b(?:au\s+maximum|au\s+plus|maximum|max\.?|jusqu'?a|pas\s+plus\s+de|limite[es]?\s+a|a\s+concurrence\s+de)\s*:?\s*(?:de\s+|d')?${NUM}\s+${NOUN}`),
  // "3 réponses maximum", "deux propositions exactes au plus"
  new RegExp(String.raw`${NOT_PREV}\b${NUM}\s+${NOUN}(?:\s+${ADJ})?\s*(?:maximum|max\b|au\s+maximum|au\s+plus)`),
  // "cochez 2 réponses", "choisissez les trois bonnes réponses"
  new RegExp(String.raw`\b${VERBS}\s+(?:exactement\s+|seulement\s+|uniquement\s+|au\s+maximum\s+|au\s+plus\s+)?(?:les\s+|la\s+|l')?${NUM}\s+${NOUN}`),
  // "2 bonnes réponses", "deux réponses exactes", "une seule réponse", "une seule bonne réponse"
  new RegExp(String.raw`${NOT_PREV}\b${NUM}\s+(?:(?:bonnes?|seules?)\s+(?:et\s+unique\s+)?(?:bonnes?\s+)?${NOUN0}|${NOUN0}\s+${ADJ})`),
  // "(max 3)", "maximum : 2"
  new RegExp(String.raw`\b(?:maximum|max\.?)\s*:?\s*(\d{1,2})\b(?!\s*(?:ans|mg|g|kg|ml|cl|l|%|h|min|cm|mm|jours?|mois))`),
  // "(3 max)"
  new RegExp(String.raw`\b(\d{1,2})\s*(?:max\b|maximum\b)`),
  // "deux choix"
  new RegExp(String.raw`\b(deux|2)\s+choix\b`),
];
const RANGE_COUNT_RE = new RegExp(String.raw`\bde\s+(\d{1,2})\s+a\s+(\d{1,2})\s+${NOUN}`);

// --- Réponse unique ---
const UNIQUE_RES = [
  /\b(?:qcu|qru|qcmu|qcs)\b/,
  /\bqcm\s*(?:a\s+|de\s+)?(?:reponse|choix)\s+unique\b/,
  /\bqcm\s+(?:unique|simple)\b/,
  /\bqcm\s+a\s+(?:une\s+)?seule\s+reponse\b/,
  /\b(?:reponse|choix)\s+unique\b/,
  /\bunique\s+(?:reponse|choix|bonne\s+reponse)\b/,
  /\bquestions?\s+a\s+(?:reponse|choix)\s+unique\b/,
  /\bsingle[\s-]?(?:choice|answer)\b|\bone\s+answer\b|\bone\s+correct\b/,
  new RegExp(String.raw`\b(?:une|1)\s+seule\s+(?:et\s+unique\s+)?(?:bonne\s+)?${NOUN0}\b`),
  new RegExp(String.raw`\bun\s+seul\s+(?:et\s+unique\s+)?(?:choix|item|cas)\b`),
  new RegExp(String.raw`\bseule\s+(?:bonne\s+)?${NOUN0}\s+${ADJ}\b`),
  /\bune\s+et\s+une\s+seule\b/,
  /\bune\s+unique\s+(?:bonne\s+)?(?:reponse|proposition|assertion|affirmation)\b/,
  /\buniquement\s+une\s+(?:bonne\s+)?(?:reponse|proposition|assertion)\b/,
  /\bqu'une\s+(?:seule\s+)?(?:bonne\s+)?(?:reponse|proposition|assertion|affirmation)\b/,
  new RegExp(String.raw`\b${VERBS}\s+(?:uniquement\s+|seulement\s+)?(?:la|une|l')\s*(?:seule\s+)?(?:bonne\s+)?(?:reponse|proposition|assertion|affirmation|option|item)\b`),
  new RegExp(String.raw`\bla\s+(?:seule\s+)?(?:bonne\s+)?(?:reponse|proposition|assertion|affirmation)\s+${ADJ}\b`),
  /\bune\s+reponse\s+par\s+question\b/,
  /\b(?:zero|aucune?)\s+ou\s+une\s+seule\b/,
  // ---- formulations supplémentaires ----
  /\bchoix\s+simple\b|\bqcm\s+simple\b|\bqcm\s+a\s+une\s+(?:seule\s+)?bonne\s+reponse\b/,
  /\b(?:1|un|une)\s+(?:seul\s+)?(?:choix\s+)?parmi\s+(?:les\s+)?(?:\d+|deux|trois|quatre|cinq|six)\b/,
  /\bune\s+(?:seule\s+)?(?:reponse|proposition|assertion|affirmation|option)\s+parmi\b/,
  /\b(?:cochez|cocher|entourez|entourer|selectionnez|selectionner)\s+(?:une\s+seule|une|1)\s+(?:seule\s+)?(?:case|reponse|proposition|lettre)\b/,
  /\bun\s+seul\s+choix\b|\bchoisir\s+une\s+seule\b/,
  /\b(?:choose|select|pick)\s+(?:only\s+)?(?:one|1)\b|\bone\s+best\s+answer\b|\bsingle\s+best\b/,
  /\bla\s+reponse\s+(?:exacte|juste|correcte)\s+est\s+unique\b/,
  /\bune\s+seule\s+des\s+(?:propositions|reponses|affirmations|assertions)\b/,
  /\b(?:reponse|proposition|assertion)\s+(?:exacte|juste|correcte)\s+unique\b/,
];

// --- Réponses multiples ---
const MULTI_RES = [
  /\b(?:qrm|qcmm|qcm\s*m)\b/,
  /\bqcm\s+multiples?\b/,
  /\bqcm\s+(?:a\s+)?(?:reponses?|propositions?)\s+multiples?\b/,
  /\b(?:reponses?|propositions?|selection)\s+multiples?\b/,
  /\bmulti[\s-]?(?:reponses?|selection)\b|\bmultiple[\s-]?(?:answers?|select)\b|\bselect\s+all\b|\ball\s+that\s+apply\b|\bchoose\s+all\b/,
  /\bqcm\s+a\s+reponses?\s+variables?\b|\breponses?\s+variables?\b|\bmultiple\s+choice\s+answers\b/,
  /\b(?:au\s+moins\s+une|une\s+ou\s+plusieurs)\s+(?:bonnes?\s+)?(?:reponses?|propositions?|cases?)\b/,
  /\bplusieurs\s+cases?\b|\btoutes?\s+les\s+cases?\b/,
  /\bcochez\s+(?:toutes\s+)?(?:les\s+)?cases?\s+(?:correspondantes?|exactes?|justes?)\b/,
  // formulations d'énoncé : "Cocher le (les) facteur(s)...", "Choisir la (les) bonne (s) réponse (s)"
  /\b(?:le|la)\s*\(\s*les\s*\)/,
  /[a-z\u00e0-\u00ff]\s*\(\s*s\s*\)/,
  new RegExp(String.raw`\bplusieurs\s+(?:bonnes?\s+)?${NOUN0}\b`),
  /\bplusieurs\s+(?:possibilites|solutions|reponses)\b/,
  /\b(?:un|une)\s+ou\s+plusieurs\b/,
  /\b(?:la|le)\s+ou\s+les\b/,
  /\b(?:zero|aucune?)\s*,?\s*(?:une?\s+)?ou\s+plusieurs\b/,
  new RegExp(String.raw`\b${VERBS}\s+(?:toutes\s+)?les\s+(?:bonnes?\s+)?(?:reponses?|propositions?|assertions?|affirmations?|items?|options?)\b`),
  new RegExp(String.raw`\btoutes?\s+les\s+(?:bonnes?\s+)?(?:reponses?|propositions?|assertions?|affirmations?|items?)\b`),
  /\btous\s+les\s+(?:items?|choix)\s+(?:exacts?|justes?|vrais?|corrects?)\b/,
  /\b(?:reponse|proposition|assertion|affirmation|item|bonne|exacte|juste)\(s\)/,
  /\bquelle\(s\)|\bquel\(s\)|\blesquel(?:le)?s\b/,
];

// --- QCD : question à choix dichotomique = Vrai/Faux ou A/B (2 options, 1 seule réponse) ---
const DOUBLE_RES = [
  /\bqcd\b/,
  /\bq\.c\.d\b/,
  /\b(?:question\s+a\s+)?choix\s+(?:double|dichotomique|binaire)\b/,
  /\bdouble\s+(?:choix|qcm)\b|\bqcm\s+double\b/,
  /\bdichotomiques?\b|\bbinaires?\b/,
  /\bvrai\s*(?:ou|\/|-|,)\s*faux\b/,
  /\bv\s*\/\s*f\b/,
  /\boui\s*(?:ou|\/|-)\s*non\b/,
  /\b(?:true|t)\s*(?:or|\/)\s*(?:false|f)\b/,
  /\brepon(?:dez|dre)\s+par\s+(?:vrai|v|a)\s+ou\s+(?:faux|f|b)\b/,
  /\ba\s+ou\s+b\b/,
];

// ---------------------------------------------------------------
// detectTypeInstruction : lit une phrase de consigne
//  -> { declared_type, max_select } | null
//  declared_type : 'QCM_UNIQUE' (1 réponse) | 'QCD' (Vrai/Faux ou A/B : 2 options, 1 réponse) | 'QCM_MULTIPLE' (max_select null = "toutes les options")
// ---------------------------------------------------------------
function detectCount(t) {
  const found = [];
  for (const re of COUNT_RES) {
    const m = t.match(re);
    if (m) {
      const n = toNum(m[1]);
      if (isInt(n) && n >= 1 && n <= 10) found.push(n);
    }
  }
  const r = t.match(RANGE_COUNT_RE);
  if (r) {
    const n = parseInt(r[2], 10);
    if (n >= 1 && n <= 10) found.push(n);
  }
  return found.length ? Math.min(...found) : null;
}

export function detectTypeInstruction(raw) {
  const t = norm(raw);
  if (!t.trim()) return null;
  const unique = UNIQUE_RES.some(r => r.test(t));
  const multi = MULTI_RES.some(r => r.test(t));
  const dbl = DOUBLE_RES.some(r => r.test(t));
  const n = detectCount(t);

  if (dbl && !unique && !multi && n === null) return { declared_type: 'QCD', max_select: 1 };
  if (n !== null) {
    if (n === 1) return multi ? null : { declared_type: 'QCM_UNIQUE', max_select: 1 };
    return { declared_type: 'QCM_MULTIPLE', max_select: n };   // "2 réponses maximum" = QCM multiple limité à 2
  }
  if (multi && unique) return null; // ambigu : on ne devine pas
  if (multi) return { declared_type: 'QCM_MULTIPLE', max_select: null };
  if (unique) return { declared_type: 'QCM_UNIQUE', max_select: 1 };
  return null;
}

// Une ligne "ressemble" à une consigne (et pas à un énoncé clinique / une question)
const INSTR_START = new RegExp(String.raw`^\W*(?:consignes?|instructions?|rappel|attention|important|nb\b|n\.b|remarques?|note\b|a\s+noter|veuillez|merci|lisez|repondez|repondre|cochez|cocher|choisissez|choisir|selectionnez|entourez|encadrez|indiquez|identifiez|types?\s+de\s+questions?|format|modalites?|mode\s+de\s+reponse|pour\s+(?:chaque|toutes?|les|ces|cette|ce|l'?ensemble)|chaque|toutes?\s+les|tous\s+les|les\s+(?:qcm|questions?|reponses?|propositions?)|ces\s+(?:qcm|questions)|cette\s+(?:partie|epreuve|section|serie|question)|ce\s+(?:qcm|sujet|questionnaire|test|quiz|module)|dans\s+(?:cette|ce|chaque|toutes)|il\s+(?:y\s+a|peut|existe|n'y)|une\s+seule|un\s+seul|plusieurs|une\s+ou|un\s+ou|aucune?|au\s+(?:maximum|plus)|maximum|max\b|\d+\s+(?:reponses?|propositions?|bonnes?)|partie|section|exercice|epreuve|serie|module|chapitre|qcm|qcu|qcd|qrm|qru|[ivx]{1,4}\s*[\.\-\):]|questions?\s+\d)`);
const BRACKET_ONLY = /^\W*[\(\[].{2,100}[\)\]]\W*$/;
export function looksLikeInstruction(raw) {
  const t = norm(raw).trim();
  return INSTR_START.test(t) || BRACKET_ONLY.test(t);
}

// ---------------------------------------------------------------
// Blocs (études de cas) et plages de questions
// ---------------------------------------------------------------
const BLOCK_KEYWORDS = String.raw`(?:etudes?\s+de\s+cas|cas\s+(?:clinique|pratique|concret|d'?etude)|cas\s*(?:n\s*[°o]?\s*)?\d+|cas\b(?=\s*[:\-]|\s*$)|dossiers?(?:\s+(?:clinique|progressif|progressifs|patient|medical|n\s*[°o]?\s*\d+|\d+))?|situations?(?:\s+(?:clinique|professionnelle|probleme|n\s*[°o]?\s*\d+|\d+))?|mises?\s+en\s+situation|observations?(?:\s+(?:clinique|medicale|n\s*[°o]?\s*\d+|\d+))?|vignettes?(?:\s+clinique)?|scenarios?|enonce(?:\s+commun)?|texte\s+(?:support|de\s+reference|commun)|document\s+(?:support|\d+)|case\s+(?:study|report)|clinical\s+(?:case|vignette)|probleme\s+(?:clinique|n\s*[°o]?\s*\d+)|ecos?\b|dp\s*\d+|cas\s+complexe|histoire\s+clinique|enonce\s+du\s+cas)`;
const BLOCK_HEADER_RE = new RegExp(String.raw`^[\s\*#>\-•]*(${BLOCK_KEYWORDS})(?:\s*(?:n\s*[°o]\s*)?(\d{1,2}|[ivx]{1,4})\b)?\s*(?:[:\-\.)]\s*|\s*$)(.*)$`);

const RANGE_RE = /(?:questions?|quest\.?|\bq\.?)\s*(?:n\s*[°o]?\s*)?(\d{1,3})\s*(?:a|au|-|et|jusqu'?a(?:\s+la)?|,)\s*(?:la\s+question\s+|questions?\s*|quest\.?\s*|q\.?\s*)?(?:n\s*[°o]?\s*)?(\d{1,3})\b/;
const RANGE_LIST_RE = /(?:questions?|quest\.?)\s*(?:n\s*[°o]?\s*)?(\d{1,3}(?:\s*,\s*\d{1,3})+)\s*(?:et|,)\s*(\d{1,3})\b/;
const CASE_LINK_RE = /(?:rapportent|rapporte|portent|porte\s+sur|concernent|concerne|relatives?|se\s+referent|dependent|a\s+partir\s+d|d'apres|en\s+vous\s+aidant|au\s+vu\s+d|a\s+l'aide\s+d|cas\s+suivant|texte\s+suivant|dossier\s+suivant|situation\s+suivante|observation\s+suivante|enonce\s+suivant|sont\s+liees|basees?\s+sur|referez-vous|repondez\s+aux\s+questions|repondre\s+aux\s+questions|pour\s+les\s+questions|aux\s+questions)/;

function parseRange(t) {
  let m = t.match(RANGE_RE);
  if (m) { const a = +m[1], b = +m[2]; if (b >= a && b - a < 60) return { from: a, to: b }; }
  m = t.match(RANGE_LIST_RE);
  if (m) {
    const nums = m[1].split(/\s*,\s*/).map(Number).concat(+m[2]);
    const a = Math.min(...nums), b = Math.max(...nums);
    if (b - a < 60) return { from: a, to: b };
  }
  return null;
}

// ---------------------------------------------------------------
// QPQ : "question par question", "pas de retour en arrière", "dossier progressif"...
// ---------------------------------------------------------------
const QPQ_RES = [
  [/\bqpq\b|\bq\.p\.q\b/, 'QPQ'],
  [/question\s+par\s+question/, 'question par question'],
  [/une\s+question\s+a\s+la\s+fois|un\s+(?:seul\s+)?(?:cas|dossier|bloc)\s+a\s+la\s+fois/, 'une question / un bloc à la fois'],
  [/(?:pas|aucun|sans|impossible\s+de)\s+(?:de\s+)?(?:possibilite\s+de\s+)?retour(?:\s+en\s+arriere)?/, 'pas de retour en arrière'],
  [/(?:ne\s+(?:pourrez|pouvez|pourra|peut|peuvent)\s+(?:plus\s+|pas\s+)?(?:revenir|retourner|modifier))|(?:vous\s+ne\s+pourrez\s+pas\s+revenir)/, 'retour impossible'],
  [/retour\s+(?:en\s+arriere\s+)?(?:impossible|interdit|non\s+autorise)/, 'retour impossible'],
  [/\bsans\s+retour\b/, 'sans retour'],
  [/une\s+fois\s+(?:la\s+reponse\s+|la\s+question\s+)?(?:validee?|soumise?|envoyee?)[^.]{0,80}(?:ne\s+(?:peut|pourra)|plus)\s+(?:etre\s+)?modifi/, 'réponse non modifiable une fois validée'],
  [/validation\s+definitive|reponses?\s+definitives?/, 'validation définitive'],
  [/dossiers?\s+progressifs?/, 'dossier progressif'],
  [/passage\s+(?:automatique|auto)\s+(?:a\s+la\s+)?(?:question|bloc|dossier|cas)?/, 'passage automatique'],
  [/(?:temps|duree)\s+(?:limite|imparti|accorde|alloue)e?\s+par\s+(?:question|cas|dossier|bloc)/, 'temps limité par question/bloc'],
  [/chaque\s+(?:question|cas|dossier|bloc)\s+est\s+chronometre/, 'question chronométrée'],
];
export function detectQpq(raw) {
  const t = norm(raw);
  const reasons = [];
  for (const [re, label] of QPQ_RES) if (re.test(t) && !reasons.includes(label)) reasons.push(label);
  return { qpq: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------
// Temps : "90 secondes par question", "1 min 30 par question", "10 min par dossier"
// ---------------------------------------------------------------
const UNIT = String.raw`(?:h(?:eures?)?|min(?:utes?)?|mn|secondes?|sec|s)`;
const DUR = String.raw`((?:\d{1,2}\s*h\s*\d{2}(?!\d)(?:\s|,|et)*|\d{1,3}\s*${UNIT}\b(?:\s*\d{1,2}(?!\d|\s*${UNIT}\b))?(?:\s|,|et)*){1,3})`;
const SCOPE_WORD = String.raw`(question|cas|dossier|bloc|etude\s+de\s+cas|situation)`;
const TIMING_RES = [
  new RegExp(String.raw`${DUR}\s*(?:par|/|pour\s+chaque|a\s+chaque|chaque)\s+${SCOPE_WORD}`),
  new RegExp(String.raw`(?:par|chaque|pour\s+chaque)\s+${SCOPE_WORD}\s*(?:dispose\s+de|est\s+(?:limitee?|chronometree?)\s+a|durent?|dure|:|=|-|de)?\s*${DUR}`),
  new RegExp(String.raw`(?:temps|duree)\s+(?:imparti|limite|accorde|alloue)?e?\s*(?:d'?une?\s+|par\s+|pour\s+chaque\s+)${SCOPE_WORD}\s*:?\s*(?:de\s+)?${DUR}`),
];
function durationToSeconds(str) {
  let total = 0, any = false;
  str = str.replace(/(\d{1,2})\s*h\s*(\d{2})(?!\d)/g, (m, h, mi) => { total += (+h) * 3600 + (+mi) * 60; any = true; return ' '; });
  const re = new RegExp(String.raw`(\d{1,3})\s*(${UNIT})\b(?:\s*(\d{1,2})(?!\d|\s*${UNIT}\b))?`, 'g');
  for (const m of str.matchAll(re)) {
    const v = +m[1], u = m[2], extra = m[3] !== undefined ? +m[3] : 0;
    any = true;
    if (/^h/.test(u)) total += v * 3600 + extra * 60;
    else if (/^(min|mn)/.test(u)) total += v * 60 + extra;
    else total += v;
  }
  return any ? total : null;
}
export function detectTiming(raw) {
  const t = norm(raw);
  for (let i = 0; i < TIMING_RES.length; i++) {
    const m = t.match(TIMING_RES[i]);
    if (!m) continue;
    const durStr = i === 0 ? m[1] : (i === 1 ? m[2] : m[2]);
    const scopeWord = i === 0 ? m[2] : m[1];
    const sec = durationToSeconds(durStr || '');
    if (sec && sec > 0) return { seconds: sec, per: /question/.test(scopeWord) ? 'question' : 'block' };
  }
  return null;
}

// ---------------------------------------------------------------
// Durée globale de l'épreuve : "Durée : 1 h 30", "Temps : 1Heure", "Durée de l'épreuve : 2 heures", "Vous disposez de 45 min"
// (cherchée uniquement dans l'en-tête du sujet, avant les questions)
// ---------------------------------------------------------------
const TL_RES = [
  new RegExp(String.raw`(?:duree|temps|delai)(?:\s+(?:de\s+l'?\s*(?:epreuve|examen|evaluation|test|composition|sujet|exercice)|totale?|imparti(?:e)?|accorde(?:e)?|maximale?|global(?:e)?|prevue?|limite))*\s*[:=\-]?\s*${DUR}`),
  new RegExp(String.raw`(?:epreuve|examen|evaluation|test|composition)\s+(?:de|d'une\s+duree\s+de)\s+${DUR}`),
  new RegExp(String.raw`vous\s+(?:disposez|avez)\s+(?:de\s+)?${DUR}`),
  new RegExp(String.raw`dure[ea]?\s+(?:de\s+)?${DUR}`),
];
export function detectTimeLimit(rawText) {
  const lines = String(rawText || '').replace(/\r\n?/g, '\n').split('\n');
  let end = lines.findIndex((l, i) => i > 0 && QSTART_RE.test(l));
  if (end < 0 || end > 60) end = Math.min(lines.length, 60);
  const head = norm(lines.slice(0, end).join(' '));
  for (const re of TL_RES) {
    const g = new RegExp(re.source, 'g');
    for (const m of head.matchAll(g)) {
      const after = head.slice(m.index + m[0].length, m.index + m[0].length + 40);
      if (/^\s*(?:par|\/|pour\s+chaque|a\s+chaque|chaque)\s*(?:question|cas|dossier|bloc)/.test(after)) continue;
      const sec = durationToSeconds(m[1] || '');
      if (sec && sec >= 60 && sec <= 28800) return sec;
    }
  }
  return null;
}

// ---------------------------------------------------------------
// Barème : "une réponse juste = +1 ; une réponse fausse = -1, sans réponse = 0", "chaque bonne réponse vaut 1 point",
//          "une réponse fausse retire 0,5 point", "pas de points négatifs"
// -> { correct?, wrong?, blank? }  (wrong est toujours <= 0)
// ---------------------------------------------------------------
export function detectScoring(rawText) {
  const t = norm(rawText);
  const out = {};
  const num = (x) => parseFloat(String(x).replace(',', '.').replace(/\s/g, ''));
  let m;
  if ((m = t.match(/reponses?\s+(?:juste|exacte|correcte|vraie|bonne)s?\s*(?:=|:|vaut|donne|rapporte|\()\s*([+-]?\s*\d+(?:[.,]\d+)?)/))) out.correct = Math.abs(num(m[1]));
  else if ((m = t.match(/(?:chaque\s+)?bonne\s+reponse\s+(?:vaut|=|donne|rapporte|:)\s*([+-]?\d+(?:[.,]\d+)?)\s*(?:point|pt)/))) out.correct = Math.abs(num(m[1]));
  if ((m = t.match(/(?:reponses?\s+(?:fausse|inexacte|incorrecte|erronee|mauvaise)s?|(?:mauvaise|fausse|incorrecte|erronee)s?\s+reponses?)\s*(?:=|:|vaut|donne|\()\s*([+-]?\s*\d+(?:[.,]\d+)?)/))) out.wrong = -Math.abs(num(m[1]));
  else if ((m = t.match(/(?:reponses?\s+(?:fausse|inexacte|incorrecte|erronee|mauvaise)s?|(?:mauvaise|fausse)s?\s+reponses?|erreur)\s+(?:retire|enleve|fait\s+perdre|penalise\s+de|entraine\s+(?:une\s+)?(?:perte|penalite)\s+de)\s*([+-]?\d+(?:[.,]\d+)?)/))) out.wrong = -Math.abs(num(m[1]));
  else if ((m = t.match(/penalite\s+(?:de\s+)?([+-]?\d+(?:[.,]\d+)?)/))) out.wrong = -Math.abs(num(m[1]));
  else if (/(?:pas|sans|aucun(?:e)?)\s+(?:de\s+)?(?:points?\s+negatifs?|penalites?)/.test(t)) out.wrong = 0;
  if ((m = t.match(/(?:sans\s+reponse|question\s+non\s+repondue|pas\s+de\s+reponse|abstention|reponse\s+absente)\s*(?:=|:|vaut|donne)\s*([+-]?\d+(?:[.,]\d+)?)/))) out.blank = num(m[1]);
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------
// Réécriture des intitulés de question non reconnus par l'extracteur d'origine
//   "QCD 3 :", "QCM n°4)", "Question 5 -", "Q7 (QCU) :", "QUESTION N°2" (seule sur sa ligne)
//   -> "Q3. ..."  (+ consigne portée par l'intitulé)
// "Q1 A" / "Q2 VRAI" (grille de réponses) ne sont JAMAIS réécrits.
// ---------------------------------------------------------------
const LABEL_RE = /^(\s*(?:[*\u2022]\s*)?)(QCD|QCU|QCM|QRU|QRM|QROC|QCMU|QCMM|QCS|QUESTION|QUEST\.?|Q)\s*(?:n\s*[°º]\s*|n[°º]\s*|no\.?\s*|numero\s*)?(\d{1,3})\s*(?:[\(\[]([^)\]\n]{1,60})[\)\]])?\s*([:.)\/\-–—])?\s*(.*)$/i;
function rewriteQuestionLabel(line) {
  const m = line.match(LABEL_RE);
  if (!m) return null;
  const [, lead, label, num, group, sep, rest] = m;
  const L = label.toUpperCase().replace(/\.$/, '');
  const isTypeLabel = /^(QCD|QCU|QCM|QRU|QRM|QROC|QCMU|QCMM|QCS)$/.test(L);
  const hasRest = rest.trim().length > 0;
  if (!sep && !group && hasRest) return null;           // "Q1 A", "Q2 VRAI" : grille de réponses
  if (!sep && !group && !isTypeLabel && L !== 'QUESTION' && L !== 'QUEST') return null;
  if (L === 'Q' && !group) return null;                 // "Q3. texte" est déjà géré par l'extracteur
  if (L === 'Q' && group && !hasRest && !sep) { /* "Q3 (QCD)" seul : on réécrit */ }
  let instr = null;
  const typeFromLabel = { QCD: { declared_type: 'QCD', max_select: 2 }, QCU: { declared_type: 'QCM_UNIQUE', max_select: 1 }, QRU: { declared_type: 'QCM_UNIQUE', max_select: 1 }, QCMU: { declared_type: 'QCM_UNIQUE', max_select: 1 }, QCS: { declared_type: 'QCM_UNIQUE', max_select: 1 }, QRM: { declared_type: 'QCM_MULTIPLE', max_select: null }, QCMM: { declared_type: 'QCM_MULTIPLE', max_select: null } };
  if (typeFromLabel[L]) instr = typeFromLabel[L];
  if (group) {
    const d = detectTypeInstruction(group);
    if (d) instr = d;
  }
  return { line: `${lead}Q${num}. ${rest}`, instr };
}

// ---------------------------------------------------------------
// Consigne portée par la question elle-même : "(2 réponses maximum)", "[QCD]", "Cochez 2 réponses."
// -> { instr, text } (text sans la consigne)
// ---------------------------------------------------------------
export function extractInlineInstruction(stem) {
  let text = String(stem ?? '');
  let instr = null;
  text = text.replace(/\s*[\(\[]([^()\[\]]{2,100})[\)\]]/g, (m, g) => {
    if (instr) return m;
    const d = detectTypeInstruction(g);
    if (d) { instr = d; return ''; }
    return m;
  });
  if (!instr) {
    const m = text.match(/^([\s\S]*?[\.\?\!:])\s+([^\.\?\!:]{6,110}[\.\!]?)\s*$/);
    if (m && looksLikeInstruction(m[2])) {
      const d = detectTypeInstruction(m[2]);
      if (d) { instr = d; text = m[1]; }
    }
  }
  // consigne en tête d'énoncé : "Cochez 2 réponses : signes de grossesse"
  if (!instr) {
    const m = text.match(/^([^:]{4,90}):\s+([\s\S]+)$/);
    if (m) {
      const d = detectTypeInstruction(m[1]);
      const leading = looksLikeInstruction(m[1]);
      if (d && (leading || new RegExp(VERBS).test(norm(m[1])))) {
        instr = d;
        if (leading && m[2].trim().length > 5) text = m[2];
      }
    }
  }
  return { instr, text: text.replace(/\s{2,}/g, ' ').trim() };
}

// ---------------------------------------------------------------
// Application d'une consigne à une question (format historique conservé)
// Ajoute : max_select, declared_type. Convertit mcq <-> mcq_multi uniquement si nécessaire.
// ---------------------------------------------------------------
function applyInstruction(q, instr, warnings) {
  if (!q || q.type === 'short') return false;
  // Vrai/Faux = QCD par définition (2 options, 1 réponse)
  if (q.type === 'tf') { q.max_select = 1; q.declared_type = 'QCD'; return true; }
  if (!instr) return false;
  const nOpts = Array.isArray(q.options) ? q.options.length : 0;
  if (nOpts < 2) return false;
  const correctArr = Array.isArray(q.correct) ? q.correct : (isInt(q.correct) ? [q.correct] : []);
  const c = correctArr.length;

  let max, declared;
  if (instr.declared_type === 'QCD') {
    if (nOpts !== 2) return false;               // une consigne QCD ne s'applique qu'aux questions à 2 options (V/F ou A/B)
    max = 1; declared = 'QCD';
  } else if (instr.declared_type === 'QCM_UNIQUE') {
    max = 1; declared = 'QCM_UNIQUE';
  } else {
    max = isInt(instr.max_select) ? instr.max_select : Math.max(2, nOpts);
    max = Math.min(Math.max(2, max), nOpts);
    declared = 'QCM_MULTIPLE';
  }
  if (c > max) {
    warnings.push(`Q${q.number ?? '?'} : ${c} bonnes réponses marquées dans le sujet mais la consigne en autorise ${max} — la consigne a été élargie.`);
    max = c;
    declared = c === 1 ? 'QCM_UNIQUE' : 'QCM_MULTIPLE';
  }
  q.max_select = max;
  q.declared_type = declared;

  if (max > 1 && q.type === 'mcq') { q.type = 'mcq_multi'; q.correct = isInt(q.correct) ? [q.correct] : correctArr; }
  else if (max === 1 && q.type === 'mcq_multi' && c <= 1) { q.type = 'mcq'; q.correct = c ? correctArr[0] : 0; }
  return true;
}

// Une question à 2 options sans consigne (A/B) est aussi un QCD
function tagDichotomous(q) {
  if (!q || q.declared_type || q.type === 'short') return;
  if (q.type === 'tf' || (q.type === 'mcq' && Array.isArray(q.options) && q.options.length === 2)) {
    q.max_select = 1; q.declared_type = 'QCD';
  }
}

// ---------------------------------------------------------------
// Scan du document : consignes, blocs, plages
// ---------------------------------------------------------------
const QSTART_RE = /^\s*(?:\*\s*)?(?:Q\s*)?(\d{1,3})\s*[\/\.\)\-\:]\s+/i;
const OPTION_RE = /^\s*(?:[-•*]\s+|[a-eA-E]\s*[\)\.\:\-]\s+|✓)/;
const SECTION_KEYWORDS = /(?:vrai\s*(?:ou|\/|-|,)\s*faux|\bv\s*\/\s*f\b|questions?\s+(?:a\s+)?(?:choix|reponses?)|\bq(?:cu|cm|cd|rm|ru|roc|cmu|cmm)\b|etudes?\s+de\s+cas|cas\s+clinique|dossier|partie|exercice|section|epreuve)/;
/** Titre de partie/section : "Partie 2 — QCM…", "A- Vrai ou faux", "II. Le Diabète", "QCM à réponse unique" */
export function isSectionHeader(raw) {
  const line = String(raw ?? '').trim();
  if (!line || line.length > 110 || /\?\s*$/.test(line)) return false;
  const t = norm(line);
  if (/^\W*(?:partie|section|exercice|serie|epreuve|chapitre|bloc|rubrique|volet)\s*(?:n\s*[°o]\s*)?(?:\d+|[ivxlc]+|[a-h])\b/.test(t)) return true;
  if (/^\W*[ivx]{1,4}\s*[\.\-:\)]\s+\S/.test(t)) return true;
  if (/^\W*[a-h]\s*[\.\-:\)]\s+\S/.test(t) && SECTION_KEYWORDS.test(t) && !/[;,]$/.test(t)) return true;
  if (/^\W*(?:qcm|qcu|qcd|qrm|qru|qroc|vrai\s*(?:ou|\/)\s*faux)\b/.test(t) && t.length <= 80 && !/\b(?:parmi|quel|quelle|quels|quelles|lequel|laquelle)\b/.test(t)) return true;
  return false;
}

function analyze(rawText) {
  const text = String(rawText || '').replace(/\r\n?/g, '\n');
  const orig = text.split('\n');
  const labelInstr = new Map();
  const work = orig.map((line, i) => {
    const r = rewriteQuestionLabel(line);
    if (!r) return line;
    if (r.instr) labelInstr.set(i, r.instr);
    return r.line;
  });
  const nw = work.map(norm);
  const isQ = (i) => QSTART_RE.test(work[i]);
  const isOpt = (i) => OPTION_RE.test(work[i]);
  const qNum = (i) => { const m = work[i].match(QSTART_RE); return m ? parseInt(m[1], 10) : null; };

  // ---- blocs ----
  const blocks = [];
  const removed = new Set();
  let cur = null;
  for (let i = 0; i < work.length; i++) {
    const blank = work[i].trim() === '';
    if (isQ(i)) {
      if (cur) { cur.firstQLine = i; cur.firstNumber = qNum(i); cur = null; }
      continue;
    }
    if (!cur) {
      if (blank || isOpt(i) || work[i].length > 400) continue;
      let hdr = null;
      const hm = nw[i].match(BLOCK_HEADER_RE);
      if (hm && (nw[i].length <= 140 || (hm[3] || '').length > 0)) {
        const restLen = (hm[3] || '').length;
        const rest = work[i].slice(work[i].length - restLen).trim();
        const label = work[i].slice(0, work[i].length - restLen).replace(/[\s:\-\.)]+$/, '').replace(/^[\s\*#>\-•]+/, '').trim();
        // "Étude de cas 1 : Douleur thoracique" -> sous-titre ; "Cas clinique : Mme X, 54 ans, ..." -> début de l'énoncé
        const isSubtitle = rest.length > 0 && rest.length <= 60 && !/[.!?]$/.test(rest);
        hdr = isSubtitle ? { title: `${label} : ${rest}`, inline: '' } : { title: label, inline: rest };
      } else if (parseRange(nw[i]) && CASE_LINK_RE.test(nw[i]) && !detectTypeInstruction(work[i])) {
        const r = parseRange(nw[i]);
        hdr = { title: `Questions ${r.from} à ${r.to}`, inline: '', range: r };
      }
      if (hdr) {
        cur = { id: `b${blocks.length + 1}`, title: hdr.title.slice(0, 160), startLine: i, caseLines: hdr.inline ? [hdr.inline] : [], range: hdr.range || null, firstQLine: null, firstNumber: null, endLine: i };
        blocks.push(cur);
        removed.add(i);
      }
    } else {
      removed.add(i);
      cur.endLine = i;
      if (blank) { cur.caseLines.push(''); continue; }
      const r = parseRange(nw[i]);
      if (r && (CASE_LINK_RE.test(nw[i]) || nw[i].length < 80)) { cur.range = r; continue; }
      cur.caseLines.push(work[i].trim());
    }
  }
  // blocs sans question derrière : on rend leurs lignes au texte normal
  const validBlocks = [];
  for (const b of blocks) {
    if (b.firstQLine === null) {
      for (let i = b.startLine; i <= b.endLine; i++) removed.delete(i);
    } else validBlocks.push(b);
  }
  validBlocks.forEach((b, k) => { b.id = `b${k + 1}`; b.case_block = b.caseLines.join('\n').replace(/\n{3,}/g, '\n\n').trim() || null; });

  // ---- consignes (portée positionnelle + plages) ----
  const firstQ = work.findIndex((_, i) => isQ(i) && !removed.has(i));
  const rangeScopes = [];
  const qMeta = []; // { line, number, scope, label }
  // Deux niveaux : consigne GLOBALE (avant le premier titre de partie) et consigne de SECTION (remise à zéro à chaque titre).
  let globalScope = null, sectionScope = null, seenSection = false;
  const distinct = new Map();
  const merge = (cur, nxt) => (cur && cur.declared_type === 'QCD' && nxt.declared_type === 'QCM_UNIQUE') ? cur : nxt; // "Vrai ou faux" + "cochez la bonne réponse" = QCD
  for (let i = 0; i < work.length; i++) {
    if (removed.has(i)) continue;
    const blank = work[i].trim() === '';
    if (blank) continue;
    if (isQ(i)) {
      qMeta.push({ line: i, number: qNum(i), scope: sectionScope || globalScope, label: labelInstr.get(i) || null });
      continue;
    }
    const isHdr = isSectionHeader(work[i]);
    if (isHdr) { seenSection = true; sectionScope = null; }
    if (!isHdr && isOpt(i)) continue;
    const inPreamble = firstQ === -1 || i < firstQ;
    const candidate = isHdr || inPreamble || looksLikeInstruction(work[i]);
    if (!candidate) continue;
    let joined = work[i];
    for (let k = 1; k <= 2 && i + k < work.length; k++) {
      const prev = work[i + k - 1].trim();
      const next = work[i + k].trim();
      if (removed.has(i + k) || isQ(i + k) || isOpt(i + k) || next === '') break;
      if (/[.!?;:)\]]$/.test(prev)) break;      // la phrase précédente est terminée
      if (!/^[a-zà-ÿ]/.test(next)) break;        // la ligne suivante ne continue pas la phrase (majuscule, chiffre...)
      joined += ' ' + next;
    }
    const instr = detectTypeInstruction(joined) || detectTypeInstruction(work[i]);
    if (!instr) continue;
    const r = parseRange(norm(joined));
    if (r && !CASE_LINK_RE.test(norm(joined).replace(/questions?\s+\d.*$/, ''))) rangeScopes.push({ ...r, instr });
    else if (r && /\bquestions?\s+\d/.test(norm(work[i]).slice(0, 14))) rangeScopes.push({ ...r, instr });
    else {
      if (seenSection) sectionScope = sectionScope ? merge(sectionScope, instr) : instr;
      else globalScope = globalScope ? merge(globalScope, instr) : instr;
      distinct.set(`${instr.declared_type}|${instr.max_select}`, instr);
    }
  }

  return { work, removed, validBlocks, qMeta, rangeScopes, distinct, isQ, qNum };
}

/** Consigne unique valable pour tout le document (sinon null) — utilisé pour le résultat de l'IA */
export function detectGlobalInstruction(rawText) {
  const a = analyze(rawText);
  if (a.rangeScopes.length) return null;
  const all = [...a.distinct.values()];
  return all.length === 1 ? all[0] : null;
}

// ---------------------------------------------------------------
// Pipeline principal
//   parseQuizText : la fonction d'extraction EXISTANTE de server.js (injectée)
// ---------------------------------------------------------------
export function detectAndParse(rawText, parseQuizText) {
  const text = String(rawText || '').replace(/\r\n?/g, '\n');
  const warnings = [];
  const plain = parseQuizText(text);

  let a;
  try { a = analyze(text); } catch (e) { return { questions: plain, blocks: [], display_mode: 'NORMAL', qpq_hint: false, qpq_reasons: [], warnings: ['Détection des consignes ignorée : ' + e.message], stats: { typed: 0, blocks: 0 } }; }

  const { work, removed, validBlocks, qMeta, rangeScopes } = a;

  // numérotation répétée entre blocs ? -> extraction bloc par bloc
  const nums = qMeta.map(m => m.number);
  const hasDupes = new Set(nums).size !== nums.length;
  const segmented = validBlocks.length >= 2 && hasDupes;

  const segments = [];
  const linesOf = (from, to) => { const out = []; for (let i = from; i < to; i++) if (!removed.has(i)) out.push(work[i]); return out.join('\n'); };
  if (segmented) {
    const bounds = validBlocks.map(b => b.startLine);
    segments.push({ block: null, text: linesOf(0, bounds[0]) });
    validBlocks.forEach((b, k) => segments.push({ block: b, text: linesOf(b.endLine + 1, k + 1 < bounds.length ? bounds[k + 1] : work.length) }));
    if (/Q\d{1,3}\s+(?:VRAI|FAUX|[A-Ea-e](?:[\s\.\,][A-Ea-e])*)/i.test(text)) warnings.push('Une grille de réponses globale a été détectée alors que la numérotation recommence à chaque bloc : elle n\'a pas pu être appliquée aux blocs.');
  } else {
    segments.push({ block: null, text: linesOf(0, work.length) });
  }

  const questions = [];
  let typed = 0;
  for (const seg of segments) {
    if (!seg.text.trim()) continue;
    const parsed = parseQuizText(seg.text);
    // métadonnées par numéro (première occurrence), limitées au segment
    const metaByNumber = new Map();
    const segFrom = seg.block ? seg.block.endLine + 1 : 0;
    const segTo = segmented ? (validBlocks[validBlocks.indexOf(seg.block) + 1]?.startLine ?? work.length) : work.length;
    for (const m of qMeta) if (m.line >= segFrom && m.line < segTo && !metaByNumber.has(m.number)) metaByNumber.set(m.number, m);

    for (const q of parsed) {
      const meta = metaByNumber.get(q.number);
      // 1) consigne dans l'énoncé
      const inline = extractInlineInstruction(q.text);
      if (inline.instr && inline.text.length > 5) q.text = inline.text;
      // 2) plage "Questions 1 à 10 : ..."
      const rs = rangeScopes.find(r => q.number >= r.from && q.number <= r.to);
      // indice porté par l'énoncé lui-même : "Cocher le (les) facteur(s)...", "laquelle...", "Cochez la bonne réponse"
      const stemHint = inline.instr ? null : detectTypeInstruction(q.text);
      const instr = (inline.instr) || (meta && meta.label) || stemHint || (rs && rs.instr) || (meta && meta.scope) || null;
      if (applyInstruction(q, instr, warnings)) typed++;
      tagDichotomous(q);

      // bloc
      let block = seg.block;
      if (!segmented && validBlocks.length) {
        block = validBlocks.find(b => b.range && q.number >= b.range.from && q.number <= b.range.to) || null;
        if (!block) {
          for (let k = validBlocks.length - 1; k >= 0; k--) {
            if (validBlocks[k].firstNumber !== null && q.number >= validBlocks[k].firstNumber && !validBlocks[k].range) { block = validBlocks[k]; break; }
          }
        }
      }
      if (block) q.block_id = block.id;
      questions.push(q);
    }
  }

  // filet de sécurité : ne jamais faire perdre de questions par rapport à l'extraction d'origine
  if (questions.length < plain.length) {
    return { questions: plain, blocks: [], display_mode: 'NORMAL', qpq_hint: false, qpq_reasons: [], warnings: ['La détection des consignes aurait réduit le nombre de questions : extraction standard conservée.'], stats: { typed: 0, blocks: 0 } };
  }

  // blocs réellement utilisés
  const used = new Set(questions.map(q => q.block_id).filter(Boolean));
  const blocksOut = validBlocks.filter(b => used.has(b.id)).map(b => ({ id: b.id, title: b.title, case_block: b.case_block }));

  // QPQ
  const qpq = detectQpq(text);
  const allInBlocks = questions.length > 0 && questions.every(q => q.block_id);
  let display_mode = 'NORMAL';
  if (qpq.qpq) {
    if (blocksOut.length && allInBlocks) display_mode = 'QPQ';
    else if (!blocksOut.length) warnings.push('Mode question par question détecté dans le sujet, mais aucune étude de cas reconnue : mode NORMAL conservé.');
    else warnings.push('Mode question par question détecté, mais certaines questions n\'appartiennent à aucun bloc : mode NORMAL conservé.');
  }

  // temps
  let seconds_per_question;
  const tm = detectTiming(text);
  if (tm) {
    let s = tm.seconds;
    if (tm.per === 'block' && blocksOut.length) s = Math.round(tm.seconds / Math.max(1, questions.length / blocksOut.length));
    if (s >= 10 && s <= 900) seconds_per_question = s;
  }

  const result = { questions, blocks: blocksOut, display_mode, qpq_hint: qpq.qpq, qpq_reasons: qpq.reasons, warnings, stats: { typed, blocks: blocksOut.length } };
  if (seconds_per_question) result.seconds_per_question = seconds_per_question;
  const tl = detectTimeLimit(text); if (tl) result.time_limit_seconds = tl;
  const sc = detectScoring(text); if (sc) result.scoring = sc;
  const unknown = questions.filter(q => q.answer_known === false).length;
  if (unknown) warnings.push(`${unknown} question(s) sans bonne réponse détectée dans le sujet : à vérifier avec ✏️ Éditer.`);
  return result;
}

// ---------------------------------------------------------------
// Résultat de l'IA : validation + complément par détection déterministe
// ---------------------------------------------------------------
export function finalizeAiResult(parsed, sourceText) {
  if (!parsed || !Array.isArray(parsed.questions)) return parsed;
  const warnings = [];
  const qs = parsed.questions;

  // blocs fournis par l'IA
  let blocks = Array.isArray(parsed.blocks)
    ? parsed.blocks.filter(b => b && b.id !== undefined && b.id !== null && b.title).map(b => ({ id: String(b.id), title: String(b.title).slice(0, 160), case_block: b.case_block ? String(b.case_block) : null }))
    : [];
  const ids = new Set(blocks.map(b => b.id));
  for (const q of qs) {
    if (q.block_id !== undefined && q.block_id !== null) {
      q.block_id = String(q.block_id);
      if (!ids.has(q.block_id)) delete q.block_id;
    }
  }
  const used = new Set(qs.map(q => q.block_id).filter(Boolean));
  blocks = blocks.filter(b => used.has(b.id));

  // consignes
  const globalInstr = detectGlobalInstruction(sourceText);
  for (const q of qs) {
    const n = Array.isArray(q.options) ? q.options.length : 0;
    let instr = null;
    if (isInt(q.max_select) && q.max_select >= 1 && n >= 2) {
      instr = q.max_select === 1 ? { declared_type: 'QCM_UNIQUE', max_select: 1 } : (q.max_select === 2 ? { declared_type: 'QCD', max_select: 2 } : { declared_type: 'QCM_MULTIPLE', max_select: q.max_select });
    } else if (globalInstr) instr = globalInstr;
    delete q.max_select; delete q.declared_type;
    if (instr) applyInstruction(q, instr, warnings);
  }

  const qpq = detectQpq(sourceText);
  const allInBlocks = qs.length > 0 && qs.every(q => q.block_id);
  parsed.blocks = blocks;
  parsed.display_mode = (qpq.qpq && blocks.length && allInBlocks) ? 'QPQ' : 'NORMAL';
  parsed.qpq_hint = qpq.qpq;
  parsed.qpq_reasons = qpq.reasons;
  const tm = detectTiming(sourceText);
  if (tm) {
    let s = tm.seconds;
    if (tm.per === 'block' && blocks.length) s = Math.round(tm.seconds / Math.max(1, qs.length / blocks.length));
    if (s >= 10 && s <= 900) parsed.seconds_per_question = s;
  }
  for (const q of qs) tagDichotomous(q);
  const tl = detectTimeLimit(sourceText); if (tl) parsed.time_limit_seconds = tl;
  const sc = detectScoring(sourceText); if (sc) parsed.scoring = sc;
  parsed.warnings = warnings;
  return parsed;
}

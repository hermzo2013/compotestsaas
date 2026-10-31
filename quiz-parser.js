/* =====================================================================
   RÉVISIO — Extracteur v2 (remplace parseQuizText de server.js)
   Même format de sortie que l'ancien : { number, text, options, correct, type }
   (+ answer_known:false quand le sujet ne donne aucune bonne réponse, + explanation si présente)

   Formats de sujets pris en charge (testés sur 3 sujets réels) :
     - Vrai/Faux  : "1- énoncé" puis "A : vrai  B : faux", ou "✓ Réponse correcte : VRAI", ou ": Vrai" en fin de ligne
     - QCM        : options "A.", "A)", "A-", "A :", "(A)", "[A]", "- option", "• option", "☐ option", "[x] option"
     - Réponses   : ✓ devant/derrière l'option, "Réponse : B", "Réponses : A, C", grille de corrigé
                    ("Q1 B", "1 B 11 B 21 A…", "1-B", "1. Vrai"), texte en gras **...**
     - Mise en page : en-têtes/pieds de page répétés, titres de parties, énoncés sur plusieurs lignes,
                    options collées ("?A :"), options sur une même ligne, lettres en double
   ===================================================================== */
import { norm, detectTypeInstruction, isSectionHeader } from './instruction-detector.js';

const CHECK = '✓✔☑✅🗸';
const CHECK_RE = new RegExp(`[${CHECK}]`, 'g');
const HAS_CHECK_RE = new RegExp(`[${CHECK}]`);
const LETTERS = 'ABCDEFGH';

// ---------------------------------------------------------------
// 1. Nettoyage du texte
// ---------------------------------------------------------------
function normalizeText(raw) {
  return String(raw ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[\u00A0\u202F\u2009\u2007]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/[’‘`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/([✓✔☑✅🗸])(?:\s*[✓✔☑✅🗸])+/g, '$1');
}

const PAGE_RE = /^\s*(?:page|p\.)\s*\d+\s*(?:\/|sur|of)?\s*\d*\s*$|^\s*\d+\s*\/\s*\d+\s*$|^\s*-\s*\d+\s*-\s*$/i;

/** Retire en-têtes / pieds de page : lignes répétées d'une page à l'autre (même collées au texte voisin) */
function stripPageNoise(lines) {
  const key = (l) => l.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  const counts = new Map();
  for (const l of lines) { const k = key(l); if (k.length >= 6) counts.set(k, (counts.get(k) || 0) + 1); }
  const phrases = [];
  for (const [k, c] of counts) {
    if (c < 3 || k.length > 120) continue;
    if (/^(?:[a-h]\s*[\.\)\:\-–—]|[#]+\s*[\.\)\-:–—]|[-•*▪○●])/.test(k)) continue;   // lignes d'options / de questions
    if (HAS_CHECK_RE.test(k) || /[?;:.,]$/.test(k)) continue;                           // vraies lignes de contenu
    if (/^(?:vrai|faux|oui|non|v|f)\b/.test(k) || /\bvrai\b.*\bfaux\b/.test(k)) continue;
    phrases.push(k);
  }
  const regs = phrases
    .filter(k => k.length >= 10)
    .map(k => new RegExp(k.split('#').map(x => x.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*')).join('\\s*\\d+\\s*'), 'i'));
  const out = [];
  for (const l of lines) {
    if (PAGE_RE.test(l)) continue;
    let t = l;
    if (phrases.includes(key(l))) continue;
    for (const re of regs) t = t.replace(re, ' ');
    t = t.replace(/\s*(?:page|p\.)\s*\d+\s*(?:\/\s*\d+)?\s*$/i, '').trim();
    if (t) out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------
// 2. Grille / corrigé
// ---------------------------------------------------------------
const PAIR_RE = /(?:^|[\s,;(])q?\s*(\d{1,3})\s*[\-\.\):=]?\s*(vrai|faux|true|false|[A-E](?:\s*(?:[,;\/+&]|et|-)\s*[A-E])*|[A-E]{1,5}|[VF])(?=$|[\s,;.)])/gi;
const KEY_HEAD_RE = /^\W*(?:corrige|corriges|correction|corrections|grille|cle\s+de|solutions?|reponses?\b|bareme\s+de\s+correction|answers?|answer\s+key)/;

function parseAnswerValue(v, nOptions) {
  const t = String(v).trim().toLowerCase();
  if (/^(vrai|true|v)$/.test(t)) return { tf: 0 };
  if (/^(faux|false|f)$/.test(t)) return { tf: 1 };
  const letters = t.replace(/\bet\b|\bou\b/g, ' ').match(/[a-h]/g);
  if (!letters) return null;
  const idx = [...new Set(letters.map(x => x.charCodeAt(0) - 97))].sort((a, b) => a - b);
  if (nOptions && idx.some(i => i >= nOptions)) return null;
  return { letters: idx };
}

function pairsInLine(line) {
  const out = [];
  PAIR_RE.lastIndex = 0;
  let m;
  while ((m = PAIR_RE.exec(line)) !== null) out.push({ num: parseInt(m[1], 10), value: m[2] });
  return out;
}
/** une ligne ne contenant QUE des paires "numéro réponse" (ex. "1 B 11 B 21 A", "Q2 B,C") */
function isKeyLine(line) {
  const l = line.trim();
  if (!l) return false;
  const pairs = pairsInLine(l);
  if (!pairs.length) return false;
  const rest = l.replace(PAIR_RE, ' ').replace(/[\s,;.|:\-–—()]/g, '').replace(/n°|rep\.?|réponses?|reponses?/gi, '');
  return rest.length === 0;
}

// ---------------------------------------------------------------
// 3. Détection des débuts de question
// ---------------------------------------------------------------
const QLABEL = '(?:question|quest\\.?|q|qcd|qcu|qcm|qru|qrm|qroc|qcmu|qcmm|qcs|n\\s*[°º]|no\\.?)';
const QSTART_RES = [
  // "1- texte", "1. texte", "1) texte", "Q1 : texte", "QCM 3 - texte", "Question n°4 (QCU) : texte", "N°5 texte"
  new RegExp(`^\\s*(?:[*•▪]\\s*)?(?:(${QLABEL})\\s*(?:n\\s*[°º]\\s*|no\\.?\\s*)?)?(\\d{1,3})\\s*(?:[°º]\\s*)?(?:\\(([^)\\n]{1,60})\\)\\s*)?([\\.\\)\\-–—:\\/])?\\s*(.*)$`, 'i'),
  // "(3) texte"
  /^\s*\(\s*(\d{1,3})\s*\)\s*(.+)$/,
];

function matchQStart(line) {
  let m = line.match(QSTART_RES[0]);
  if (m) {
    const label = (m[1] || '').toLowerCase().replace(/\.$/, '');
    const num = parseInt(m[2], 10);
    const group = m[3] || '';
    const sep = m[4] || '';
    const rest = (m[5] || '').trim();
    if (num >= 1 && num <= 400) {
      const startsOk = rest === '' || /^[A-Za-zÀ-ÿ"«'(\[*¿]/.test(rest);
      const isTypeLabel = /^(qcd|qcu|qcm|qru|qrm|qroc|qcmu|qcmm|qcs)$/.test(label);
      const isQuestionWord = /^(question|quest)$/.test(label);
      if (sep && startsOk) return { num, rest, group, label };
      if (!sep && (isQuestionWord || isTypeLabel) && (rest === '' || startsOk) && !(label === 'q')) return { num, rest, group, label };
      if (!sep && label === 'q' && rest === '' && !group) return { num, rest, group, label };
      if (!sep && group && label && rest === '') return { num, rest, group, label };
    }
  }
  m = line.match(QSTART_RES[1]);
  if (m && /^[A-Za-zÀ-ÿ"«'(\[*]/.test(m[2].trim())) return { num: parseInt(m[1], 10), rest: m[2].trim(), group: '', label: '' };
  return null;
}

/** Garde la suite croissante de numéros (évite de confondre "2)" d'une option ou "1.5 kg" avec une question) */
function selectQuestionStarts(cands, boundaryBefore) {
  const accepted = [];
  let expected = null;
  const hasSoon = (idx, n) => cands.slice(idx + 1, idx + 40).some(c => c.num === n);
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    if (expected === null) {
      if (c.num <= 10 && (hasSoon(i, c.num + 1) || cands.length === 1)) { accepted.push(c); expected = c.num + 1; }
      continue;
    }
    if (c.num === expected) { accepted.push(c); expected++; continue; }
    if (c.num > expected && c.num <= expected + 3 && hasSoon(i, c.num + 1)) { accepted.push(c); expected = c.num + 1; continue; }
    if (c.num === 1 && boundaryBefore(accepted[accepted.length - 1].line, c.line)) { accepted.push(c); expected = 2; }
  }
  return accepted;
}

// ---------------------------------------------------------------
// 4. Lignes de réponse / d'explication / Vrai-Faux
// ---------------------------------------------------------------
const ANSWER_LINE_RE = new RegExp(`^\\s*(?:[${CHECK}]\\s*)?(?:(?:la\\s+|les\\s+)?(?:bonnes?\\s+)?(?:reponses?|rep\\.?|r|corrige|correction|solution|cle|answers?|ans|correct\\s+answers?)\\s*(?:correcte|juste|exacte|attendue|vraie)?s?\\s*(?:est|sont)?\\s*[:=\\-–]\\s*|(?:=>|->|→)\\s*)(.+)$`, 'i');
const EXPLAIN_RE = /^\s*(?:explication|justification|commentaire|explanation|rationale|rappel|pour\s+aller\s+plus\s+loin)\s*[:\-–]\s*(.*)$/i;

function matchAnswerLine(line) {
  line = line.replace(/^\s*[\(\[]\s*(.*?)\s*[\)\]]\s*$/, (m, inner) => /^(?:r[eé]p|bonne|correct|solution|answer|ans|corrig)/i.test(inner) ? inner : m);   // "(Réponse : C)"
  const t = norm(line);                       // norm() conserve la longueur : les indices valent aussi pour la ligne d'origine
  const m = t.match(ANSWER_LINE_RE);
  if (!m) return null;
  const val = line.slice(t.length - m[1].length).trim();
  return val || null;
}

function matchVfLine(line) {
  let t = norm(line).replace(new RegExp(`[${CHECK}]`, 'g'), ' ✓ ').replace(/[☐□☒]/g, ' ');
  t = t.replace(/\b[ab]\s*[:.)\-]/g, ' ').replace(/[\/,;\-]|\bou\b/g, ' ').replace(/✓(\s*✓)+/g, '✓').replace(/\s+/g, ' ').trim();
  // [mot isolé] [✓] vrai [✓] faux [✓]   —   un ✓ désigne le mot qui le SUIT ; en fin de ligne, le mot qui le précède
  const m = t.match(/^(?:(vrai|faux)\s+)?(✓\s*)?(vrai|v)\s*(✓\s*)?(faux|f)\s*(✓)?$/);
  if (!m) return null;
  let answer = null;
  if (m[2]) answer = 0;
  else if (m[4] || m[6]) answer = 1;
  else if (m[1]) answer = m[1] === 'vrai' ? 0 : 1;
  return { answer };
}

// ---------------------------------------------------------------
// 5. Options
// ---------------------------------------------------------------
function findLetterMarkers(content) {
  const found = [];
  const std = /(?<![A-Za-z0-9\u00C0-\u017F])([A-Ha-h])\s*([\.\)\:\-–—])(?=[\s*])|(?<![A-Za-z0-9\u00C0-\u017F])[\(\[]([A-Ha-h])[\)\]](?=\s)/g;
  let m;
  while ((m = std.exec(content)) !== null) {
    const letter = (m[1] || m[3]);
    found.push({ index: m.index, end: m.index + m[0].length, letter, check: content[m.index - 1] === '\u0001' });
  }
  const glued = /(?<=[a-z\u00E0-\u00FF?!.;,])([A-H])\s*([:\)])(?=\s)/g;
  while ((m = glued.exec(content)) !== null) {
    found.push({ index: m.index, end: m.index + m[0].length, letter: m[1], check: false, glued: true });
  }
  found.sort((a, b) => a.index - b.index);
  // suite A, B, C... (une lettre en double est tolérée : "A, B, B, C")
  const seq = [];
  for (const f of found) {
    const L = LETTERS.indexOf(f.letter.toUpperCase());
    if (L < 0) continue;
    if (!seq.length) { if (L === 0) seq.push({ ...f, L }); continue; }
    const last = seq[seq.length - 1];
    if (f.index < last.end) continue;
    if (L === last.L + 1 || L === last.L) seq.push({ ...f, L });
  }
  const letters = new Set(seq.map(s => s.L));
  return (seq.length >= 2 && letters.has(0) && letters.has(1)) ? seq : [];
}

const BULLET_RE = /^\s*(?:[-–—•▪○●◦□☐☑✓✔*]\s+|\[\s*[xX✓ ]?\s*\]\s*|\(\s*[xX✓ ]?\s*\)\s+)/;

function cleanOptionText(t) {
  return t.replace(/\u0001/g, ' ').replace(CHECK_RE, ' ').replace(/\*\*/g, ' ').replace(/\s+/g, ' ').replace(/^[\s*\-–—•:]+/, '').replace(/[;,\s]+$/, '').replace(/\.+$/, '').replace(/:\s*Non$/i, '').trim();
}

/** -> { stem, options:[{text, correct}], style } */
function extractOptions(content) {
  const marked = content.replace(new RegExp(`[${CHECK}][ \\t]*(?=[A-Ha-h]\\s*[\\.\\)\\:\\-–—]\\s|[\\(\\[][A-Ha-h][\\)\\]]\\s)`, 'g'), '\u0001');
  // a) options lettrées
  const seq = findLetterMarkers(marked);
  if (seq.length >= 2) {
    const stem = marked.slice(0, seq[0].index);
    const options = seq.map((s, i) => {
      const end = i + 1 < seq.length ? seq[i + 1].index : marked.length;
      const raw = marked.slice(s.end, end);
      const bold = marked.slice(Math.max(0, s.index - 2), s.index) === '**' || /\*\*/.test(raw.replace(/\*\*\s*$/, ''));
      const correct = s.check || HAS_CHECK_RE.test(raw) || /\((?:bonne\s+r[ée]ponse|correct[e]?|juste|exacte)\)\s*$/i.test(raw);
      return { text: cleanOptionText(raw.replace(/\((?:bonne\s+r[ée]ponse|correct[e]?|juste|exacte)\)\s*$/i, '')), correct, bold };
    }).filter(o => o.text);
    const nBold = options.filter(o => o.bold).length;
    if (nBold > 0 && nBold < options.length) options.forEach(o => { if (o.bold) o.correct = true; });
    if (options.length >= 2) return { stem, options, style: 'letter' };
  }
  // b) puces / cases à cocher en début de ligne
  const lines = marked.split('\n');
  const bulletIdx = lines.map((l, i) => BULLET_RE.test(l) ? i : -1).filter(i => i >= 0);
  if (bulletIdx.length >= 2) {
    const first = bulletIdx[0];
    const stem = lines.slice(0, first).join('\n');
    const options = [];
    for (let i = first; i < lines.length; i++) {
      const l = lines[i];
      if (BULLET_RE.test(l)) {
        const checked = HAS_CHECK_RE.test(l) || /^\s*(?:\[\s*[xX]\s*\]|\(\s*[xX]\s*\)|☑)/.test(l);
        options.push({ text: l.replace(BULLET_RE, ''), correct: checked });
      } else if (options.length) options[options.length - 1].text += ' ' + l;
    }
    const cleaned = options.map(o => ({ text: cleanOptionText(o.text), correct: o.correct || HAS_CHECK_RE.test(o.text) })).filter(o => o.text);
    if (cleaned.length >= 2) return { stem, options: cleaned, style: 'bullet' };
  }
  // c) ancien format en ligne : "énoncé - a - b - c"
  const dashParts = marked.split(/(?:\n|\s)[-–]\s+/);
  if (dashParts.length >= 4) {
    const options = dashParts.slice(1).map(p => ({ text: cleanOptionText(p), correct: HAS_CHECK_RE.test(p) })).filter(o => o.text);
    if (options.length >= 3) return { stem: dashParts[0], options, style: 'inline-dash' };
  }
  return { stem: marked, options: [], style: 'none' };
}

// ---------------------------------------------------------------
// 6. Construction d'une question
// ---------------------------------------------------------------
function cleanStem(t) {
  return t.replace(/\u0001/g, ' ').replace(CHECK_RE, ' ').replace(/\*\*?/g, '').replace(/\s+/g, ' ').trim();
}

function buildQuestion(number, firstText, bodyLines) {
  let answerVal = null, explanation = '';
  const contentLines = [];
  if (firstText) contentLines.push(firstText);
  let inExplanation = false;
  for (const l of bodyLines) {
    const em = l.match(EXPLAIN_RE);
    if (em) { explanation = em[1].trim(); inExplanation = true; continue; }
    const av = matchAnswerLine(l);
    if (av !== null) { answerVal = av; inExplanation = false; continue; }
    if (inExplanation && !BULLET_RE.test(l) && !/^\s*[A-Ha-h]\s*[\.\)\:\-]\s/.test(l)) { explanation += ' ' + l.trim(); continue; }
    contentLines.push(l);
  }
  // ligne "A : vrai  B : faux" (avec ou sans mot "Vrai"/"Faux" isolé, ✓ ou case cochée)
  let vf = null;
  for (let i = 0; i < contentLines.length; i++) {
    const r = matchVfLine(contentLines[i]);
    if (r && i >= 1) { vf = r; contentLines.splice(i, 1); break; }
  }

  let content = contentLines.join('\n');
  let options = [], stem = content, correctIdx = [], answerKnown = false, type = 'mcq', legacyMulti = false;

  if (vf) {
    options = ['Vrai', 'Faux'];
    type = 'tf';
    if (vf.answer !== null) { correctIdx = [vf.answer]; answerKnown = true; }
  } else {
    const ex = extractOptions(content);
    stem = ex.stem;
    options = ex.options.map(o => o.text);
    ex.options.forEach((o, i) => { if (o.correct) correctIdx.push(i); });
    if (correctIdx.length) answerKnown = true;

    // options "vrai / faux" -> question Vrai/Faux
    const low = options.map(o => o.toLowerCase().replace(/[.\s]+$/, ''));
    if (options.length === 2 && ((low[0] === 'vrai' && low[1] === 'faux') || (low[0] === 'v' && low[1] === 'f') || (low[0] === 'true' && low[1] === 'false'))) {
      type = 'tf'; options = ['Vrai', 'Faux'];
    }
    // ancien format : "énoncé : Vrai" / "énoncé - Faux" en fin de ligne
    if (!options.length) {
      const tm = stem.replace(/\n/g, ' ').match(/^(.*?)\s*(?:[:\-–]\s*\*?|[\(\[]\s*)(vrai|faux|v|f)\s*\*?[\)\]]?\s*$/i);
      if (tm && tm[1].trim().length > 3) {
        stem = tm[1];
        type = 'tf'; options = ['Vrai', 'Faux'];
        correctIdx = [/^(vrai|v)$/i.test(tm[2]) ? 0 : 1]; answerKnown = true;
      }
    }
  }

  // réponse portée par une ligne "Réponse : ..."
  if (answerVal !== null) {
    const parsed = parseAnswerValue(answerVal, options.length || 0);
    if (parsed && parsed.tf !== undefined) {
      if (!options.length) { options = ['Vrai', 'Faux']; type = 'tf'; }
      if (type === 'tf') { correctIdx = [parsed.tf]; answerKnown = true; }
    } else if (parsed && parsed.letters && options.length) {
      correctIdx = parsed.letters; answerKnown = true;
    } else if (!options.length) {
      // pas d'options : question à réponse courte
      return { number, text: cleanStem(stem), options: [], correct: cleanStem(answerVal), type: 'short', ...(explanation ? { explanation: explanation.trim() } : {}) };
    }
  }

  // sans options ni réponse : énoncé Vrai/Faux dont la réponse est inconnue (comportement historique)
  if (!options.length) { options = ['Vrai', 'Faux']; type = 'tf'; }

  const text = cleanStem(stem);

  // type multiple : plusieurs bonnes réponses, ou indice dans l'énoncé quand la réponse est inconnue
  let correct;
  if (type === 'tf') {
    correct = correctIdx.length ? correctIdx[0] : 0;
  } else if (correctIdx.length > 1) {
    type = 'mcq_multi'; correct = [...new Set(correctIdx)].sort((a, b) => a - b);
  } else {
    const hint = detectTypeInstruction(text);
    if (hint && hint.declared_type === 'QCM_MULTIPLE' && !answerKnown) { type = 'mcq_multi'; correct = [0]; }
    else if (!answerKnown && options.length > 2 && contentLines.some(l => /^\s*[-–—•]\s/.test(l)) && !hint) { type = 'mcq_multi'; correct = [0]; legacyMulti = true; } // ancien comportement (options en tirets sans réponse)
    else { correct = correctIdx.length ? correctIdx[0] : 0; }
  }

  const q = { number, text, options, correct, type };
  if (!answerKnown) q.answer_known = false;
  if (legacyMulti) Object.defineProperty(q, '_legacyMulti', { value: true, enumerable: false, writable: true });
  if (explanation) q.explanation = explanation.trim();
  return q;
}

// ---------------------------------------------------------------
// 7. Point d'entrée
// ---------------------------------------------------------------
/** @returns {{questions:Array, warnings:string[], stats:object}} */
export function parseQuiz(rawText) {
  const warnings = [];
  const text = normalizeText(rawText);
  let lines = text.split('\n').map(l => l.trim()).filter(l => l !== '');
  lines = stripPageNoise(lines);

  // ---- candidats de questions (hors lignes de grille) ----
  const cands = [];
  lines.forEach((l, i) => { const m = matchQStart(l); if (m) cands.push({ line: i, ...m }); });

  const isBoundary = (from, to) => { for (let i = from + 1; i < to; i++) if (isSectionHeader(lines[i])) return true; return false; };
  let accepted = selectQuestionStarts(cands, isBoundary);
  if (!accepted.length) return { questions: [], warnings, stats: { found: 0 } };

  // ---- début du corrigé : titre "Corrigé / Grille / Réponses" (ou lignes de paires) après la dernière question ----
  const lastQ = accepted[accepted.length - 1].line;
  let keyStart = lines.length;
  for (let i = lastQ + 1; i < lines.length; i++) {
    const head = KEY_HEAD_RE.test(norm(lines[i])) && lines[i].length <= 90;
    if (!head && !isKeyLine(lines[i])) continue;
    let pairs = pairsInLine(lines[i]).length;
    for (let k = i + 1; k < Math.min(lines.length, i + 14); k++) if (isKeyLine(lines[k])) pairs += pairsInLine(lines[k]).length;
    if (pairs >= (head ? 1 : 2)) { keyStart = i; break; }   // titre explicite : 1 paire suffit ; sans titre : au moins 2 lignes/paires
  }
  accepted = accepted.filter(a => a.line < keyStart);

  // ---- grille de réponses ----
  const answerKey = {};
  for (let i = keyStart; i < lines.length; i++) {
    for (const p of pairsInLine(lines[i])) {
      if (answerKey[p.num] === undefined) answerKey[p.num] = p.value;
    }
  }

  // ---- blocs de questions ----
  const questions = [];
  for (let k = 0; k < accepted.length; k++) {
    const a = accepted[k];
    const nextStart = k + 1 < accepted.length ? accepted[k + 1].line : keyStart;
    let end = nextStart;
    for (let j = a.line + 1; j < nextStart; j++) { if (isSectionHeader(lines[j]) && !BULLET_RE.test(lines[j])) { end = j; break; } }
    const body = lines.slice(a.line + 1, end);
    const q = buildQuestion(a.num, a.rest, body);
    if (!q) continue;
    if (!q.text || q.text.replace(/[^A-Za-zÀ-ÿ]/g, '').length < 3) continue;
    questions.push(q);
  }

  // ---- application de la grille (ne remplace jamais une réponse déjà marquée dans le sujet) ----
  for (const q of questions) {
    const raw = answerKey[q.number];
    if (raw === undefined) continue;
    if (q.answer_known !== false) continue;
    const parsed = parseAnswerValue(raw, q.options.length);
    if (!parsed) continue;
    if (q.type === 'tf' && parsed.tf !== undefined) { q.correct = parsed.tf; delete q.answer_known; }
    else if (parsed.letters && q.type !== 'short') {
      if (parsed.letters.length > 1) { q.type = 'mcq_multi'; q.correct = parsed.letters; }
      else if (q.type === 'mcq_multi' && q._legacyMulti) { q.type = 'mcq'; q.correct = parsed.letters[0]; }
      else if (q.type === 'mcq_multi') q.correct = parsed.letters;
      else q.correct = parsed.letters[0];
      delete q.answer_known;
    }
  }

  const unknown = questions.filter(q => q.answer_known === false).length;
  if (unknown) warnings.push(`${unknown} question(s) sans bonne réponse détectée.`);
  return { questions, warnings, stats: { found: questions.length, keyLines: Object.keys(answerKey).length, unknown } };
}

/** Même signature que l'ancien parseQuizText de server.js */
export function parseQuizText(rawText) {
  return parseQuiz(rawText).questions;
}

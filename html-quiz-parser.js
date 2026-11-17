/* =====================================================================
   RÉVISIO — Convertisseur « HTML → Quiz »  (html-quiz-parser.js)

   API :  window.HtmlQuizParser.convert(htmlCode [, options])
          → { questions: [...], errors: [...], warnings: [...], format: 'js'|'json'|'html'|null, stats: {...} }

   Chaque question produite suit le modèle stocké par Révisio :
     { type: 'mcq'|'mcq_multi'|'tf'|'short', text, options, correct, explanation }
       - mcq / tf   : correct = index (entier)   → même forme que les quiz déjà en base
       - mcq_multi  : correct = [index, ...]     (+ max_select si expectedCount est fourni)
       - short      : correct = "réponse attendue", options = []

   Formats d'entrée reconnus (détection automatique) :
     1. JS    : const ALL_QUESTIONS = [ ... ]  (au milieu de <script>, CSS, HTML…)
     2. JSON  : [ {"question": "..."} ]  ou  { "questions": [ ... ] }
     3. HTML  : <div class="question"> … <li>option</li> … </div>

   SÉCURITÉ : le code collé n'est JAMAIS exécuté (ni eval, ni new Function, ni <script> injecté).
   Les littéraux JavaScript sont lus par un petit analyseur sans exécution.
   ===================================================================== */
(function (root) {
  'use strict';

  var MAX_BYTES = 500 * 1024;               // taille maximale acceptée (500 Ko)
  var MAX_DEPTH = 40;                       // profondeur max des littéraux imbriqués
  var DEFAULT_EXPLANATION = "Pas d'explication";
  var LETTERS = 'ABCDEFGHIJ';
  var CHECK_CHARS = '✓✔☑✅🗸';
  var CHECK_RE = new RegExp('[' + CHECK_CHARS + ']', 'g');
  var HAS_CHECK_RE = new RegExp('[' + CHECK_CHARS + ']');

  // ---------------------------------------------------------------
  // 1. Nettoyage de texte (balises, entités HTML, accents, apostrophes)
  // ---------------------------------------------------------------
  var NAMED_ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '',
    eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â', auml: 'ä', aacute: 'á',
    ccedil: 'ç', icirc: 'î', iuml: 'ï', iacute: 'í', ocirc: 'ô', ouml: 'ö', oacute: 'ó',
    ugrave: 'ù', ucirc: 'û', uuml: 'ü', uacute: 'ú', yuml: 'ÿ', ntilde: 'ñ', oelig: 'œ', aelig: 'æ',
    Eacute: 'É', Egrave: 'È', Ecirc: 'Ê', Agrave: 'À', Acirc: 'Â', Ccedil: 'Ç', Icirc: 'Î', Ocirc: 'Ô',
    Ugrave: 'Ù', Ucirc: 'Û', OElig: 'Œ',
    laquo: '«', raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„',
    hellip: '…', ndash: '–', mdash: '—', bull: '•', middot: '·', euro: '€', pound: '£', copy: '©',
    deg: '°', plusmn: '±', times: '×', divide: '÷', micro: 'µ', sect: '§', para: '¶',
    le: '≤', ge: '≥', ne: '≠', asymp: '≈', infin: '∞', sum: '∑', radic: '√', minus: '−',
    alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', Delta: 'Δ', mu: 'μ', pi: 'π', sigma: 'σ', Sigma: 'Σ',
    lambda: 'λ', theta: 'θ', rho: 'ρ', chi: 'χ', omega: 'ω', Omega: 'Ω', epsilon: 'ε', tau: 'τ', phi: 'φ',
    larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', rArr: '⇒', hArr: '⇔',
    sup2: '²', sup3: '³', frac12: '½', frac14: '¼', frac34: '¾'
  };

  function decodeEntities(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, function (m, e) {
      if (e.charAt(0) === '#') {
        var code = e.charAt(1).toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        if (!code || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return '';
        try { return String.fromCodePoint(code); } catch (_) { return ''; }
      }
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, e) ? NAMED_ENTITIES[e] : m;
    });
  }

  /** Texte brut propre : sans balises, entités décodées, espaces normalisés. Les accents et guillemets sont conservés tels quels. */
  function cleanText(value) {
    if (value === null || value === undefined) return '';
    var s = String(value);
    s = s.replace(/^\uFEFF/, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
    s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n');
    s = s.replace(/<!--[\s\S]*?-->/g, '').replace(/<\/?[a-zA-Z][^>]*>/g, '');   // une vraie balise commence par une lettre : « a < b » reste intact
    s = decodeEntities(s);
    s = s.replace(/[\u00A0\u202F\u2007\u2009]/g, ' ').replace(/\r\n?/g, '\n');
    s = s.split('\n').map(function (l) { return l.replace(/[ \t]+/g, ' ').trim(); }).join('\n');
    s = s.replace(/\n{3,}/g, '\n\n').trim();
    try { s = s.normalize('NFC'); } catch (_) { /* environnement ancien */ }
    return s;
  }

  /** Clé de comparaison : minuscules, sans accents, sans ponctuation ni espaces. */
  function compareKey(s) {
    var t = String(s === null || s === undefined ? '' : s).toLowerCase();
    try { t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (_) { /* ignore */ }
    return t.replace(/[^a-z0-9]+/g, '');
  }

  // ---------------------------------------------------------------
  // 2. Analyseur de littéraux JavaScript / JSON (SANS exécution)
  //    Accepte : clés sans guillemets, 'simples' "doubles" `gabarits` (sans ${}), commentaires,
  //    virgules finales, true/false/null/undefined, nombres.  Refuse tout le reste (appels, variables…).
  // ---------------------------------------------------------------
  function LiteralParser(src) { this.s = src; this.i = 0; }

  LiteralParser.prototype.fail = function (msg) {
    var line = this.s.slice(0, this.i).split('\n').length;
    throw new Error(msg + ' (ligne ' + line + ')');
  };

  LiteralParser.prototype.ws = function () {
    var s = this.s;
    for (;;) {
      var c = s.charAt(this.i);
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\uFEFF' || c === '\u00A0') { this.i++; continue; }
      if (c === '/' && s.charAt(this.i + 1) === '/') { while (this.i < s.length && s.charAt(this.i) !== '\n') this.i++; continue; }
      if (c === '/' && s.charAt(this.i + 1) === '*') {
        var end = s.indexOf('*/', this.i + 2);
        this.i = end === -1 ? s.length : end + 2; continue;
      }
      break;
    }
  };

  LiteralParser.prototype.parse = function () {
    var v = this.value(0);
    this.ws();
    return v;
  };

  LiteralParser.prototype.value = function (depth) {
    if (depth > MAX_DEPTH) this.fail('Imbrication trop profonde');
    this.ws();
    var c = this.s.charAt(this.i);
    if (c === '{') return this.object(depth);
    if (c === '[') return this.array(depth);
    if (c === '"' || c === "'" || c === '`') return this.string();
    if (c === '-' || c === '+' || c === '.' || (c >= '0' && c <= '9')) return this.number();
    var id = this.identifier();
    if (id === 'true') return true;
    if (id === 'false') return false;
    if (id === 'null' || id === 'undefined') return null;
    if (id === 'NaN') return null;
    if (id) this.fail('Valeur non littérale « ' + id + ' » (variable ou appel de fonction non pris en charge)');
    this.fail('Caractère inattendu « ' + (c || 'fin du texte') + ' »');
  };

  LiteralParser.prototype.identifier = function () {
    var m = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i, this.i + 80));
    if (!m) return '';
    this.i += m[0].length;
    return m[0];
  };

  LiteralParser.prototype.number = function () {
    var m = /^[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(this.s.slice(this.i, this.i + 40));
    if (!m) this.fail('Nombre invalide');
    this.i += m[0].length;
    return Number(m[0]);
  };

  LiteralParser.prototype.string = function () {
    var s = this.s, q = s.charAt(this.i++), out = '';
    for (;;) {
      if (this.i >= s.length) this.fail('Chaîne non terminée');
      var c = s.charAt(this.i++);
      if (c === q) return out;
      if (q === '`' && c === '$' && s.charAt(this.i) === '{') this.fail('Gabarit avec expression ${…} non pris en charge');
      if (c !== '\\') {
        if (c === '\n' && q !== '`') this.fail('Retour à la ligne dans une chaîne');
        out += c; continue;
      }
      var e = s.charAt(this.i++);
      switch (e) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'v': out += '\v'; break;
        case '0': out += '\0'; break;
        case '\r': if (s.charAt(this.i) === '\n') this.i++; break;       // continuation de ligne
        case '\n': break;
        case 'x': {
          var hx = s.substr(this.i, 2);
          if (!/^[0-9a-fA-F]{2}$/.test(hx)) this.fail('Séquence \\x invalide');
          out += String.fromCharCode(parseInt(hx, 16)); this.i += 2; break;
        }
        case 'u': {
          if (s.charAt(this.i) === '{') {
            var close = s.indexOf('}', this.i);
            var cp = parseInt(s.slice(this.i + 1, close), 16);
            if (close === -1 || isNaN(cp) || cp > 0x10FFFF) this.fail('Séquence \\u{…} invalide');
            out += String.fromCodePoint(cp); this.i = close + 1;
          } else {
            var u4 = s.substr(this.i, 4);
            if (!/^[0-9a-fA-F]{4}$/.test(u4)) this.fail('Séquence \\u invalide');
            out += String.fromCharCode(parseInt(u4, 16)); this.i += 4;
          }
          break;
        }
        default: out += e;                                                  // \' \" \\ \/ et autres
      }
    }
  };

  LiteralParser.prototype.array = function (depth) {
    var arr = [];
    this.i++;                                                               // [
    for (;;) {
      this.ws();
      var c = this.s.charAt(this.i);
      if (c === ']') { this.i++; return arr; }
      if (c === ',') { this.i++; continue; }                                // virgules multiples / finales tolérées
      if (this.i >= this.s.length) this.fail('Tableau non fermé');
      arr.push(this.value(depth + 1));
      this.ws();
      var n = this.s.charAt(this.i);
      if (n === ',') this.i++;
      else if (n !== ']') this.fail('« , » ou « ] » attendu');
    }
  };

  LiteralParser.prototype.object = function (depth) {
    var obj = {};
    this.i++;                                                               // {
    for (;;) {
      this.ws();
      var c = this.s.charAt(this.i);
      if (c === '}') { this.i++; return obj; }
      if (c === ',') { this.i++; continue; }
      if (this.i >= this.s.length) this.fail('Objet non fermé');
      var key;
      if (c === '"' || c === "'" || c === '`') key = this.string();
      else if (c >= '0' && c <= '9') key = String(this.number());
      else {
        key = this.identifier();
        if (!key) this.fail('Nom de propriété attendu');
      }
      this.ws();
      if (this.s.charAt(this.i) !== ':') this.fail('« : » attendu après « ' + key + ' »');
      this.i++;
      var v = this.value(depth + 1);
      if (key !== '__proto__' && key !== 'constructor' && key !== 'prototype') obj[key] = v;   // pas de pollution de prototype
      this.ws();
      var n = this.s.charAt(this.i);
      if (n === ',') this.i++;
      else if (n !== '}') this.fail('« , » ou « } » attendu');
    }
  };

  // ---------------------------------------------------------------
  // 3. Repérage d'un tableau dans un texte (sans le exécuter)
  // ---------------------------------------------------------------
  /** Saute chaîne ou commentaire à partir de i ; renvoie le nouvel index (ou i si rien à sauter). */
  function skipNonCode(src, i) {
    var c = src.charAt(i);
    if (c === '"' || c === "'" || c === '`') {
      for (var j = i + 1; j < src.length; j++) {
        var d = src.charAt(j);
        if (d === '\\') { j++; continue; }
        if (d === c) return j + 1;
        if (d === '\n' && c !== '`') return j;                              // chaîne mal formée : on s'arrête à la fin de ligne
      }
      return src.length;
    }
    if (c === '/' && src.charAt(i + 1) === '/') { var e1 = src.indexOf('\n', i); return e1 === -1 ? src.length : e1; }
    if (c === '/' && src.charAt(i + 1) === '*') { var e2 = src.indexOf('*/', i + 2); return e2 === -1 ? src.length : e2 + 2; }
    return i;
  }

  /** Index du crochet/accolade fermant correspondant à celui d'ouverture en `open`, ou -1. */
  function findMatching(src, open) {
    var depth = 0;
    for (var i = open; i < src.length; i++) {
      var skip = skipNonCode(src, i);
      if (skip !== i) { i = skip - 1; continue; }
      var c = src.charAt(i);
      if (c === '[' || c === '{' || c === '(') depth++;
      else if (c === ']' || c === '}' || c === ')') { depth--; if (depth === 0) return i; }
    }
    return -1;
  }

  /** Découpe le contenu d'un tableau (entre [ et ]) en éléments de premier niveau. */
  function splitTopLevel(src, open, close) {
    var parts = [], depth = 0, start = open + 1;
    for (var i = open + 1; i < close; i++) {
      var skip = skipNonCode(src, i);
      if (skip !== i) { i = skip - 1; continue; }
      var c = src.charAt(i);
      if (c === '[' || c === '{' || c === '(') depth++;
      else if (c === ']' || c === '}' || c === ')') depth--;
      else if (c === ',' && depth === 0) { parts.push(src.slice(start, i)); start = i + 1; }
    }
    parts.push(src.slice(start, close));
    return parts.filter(function (p) { return p.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').trim() !== ''; });
  }

  /** Après « = » ou « : », trouve le « [ » du tableau (tolère Object.freeze( / ( ). */
  function arrayStartAfter(src, pos) {
    var i = pos, guard = 0;
    for (;;) {
      var skip = skipNonCode(src, i);
      if (skip !== i) { i = skip; continue; }
      var c = src.charAt(i);
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
      if (c === '[') return i;
      var m = /^(?:Object\.freeze\s*\(|\()/.exec(src.slice(i, i + 20));
      if (m && guard++ < 3) { i += m[0].length; continue; }
      return -1;
    }
  }

  function looksLikeQuestion(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
    var keys = Object.keys(o).map(compareKey);
    var hasText = keys.some(function (k) { return TEXT_KEYS.indexOf(k) !== -1; });
    var hasAnswer = keys.some(function (k) { return OPTION_KEYS.indexOf(k) !== -1 || CORRECT_KEYS.indexOf(k) !== -1; });
    return hasText && hasAnswer;
  }

  /** Lit les éléments d'un tableau, un par un : un élément illisible n'invalide pas les autres. */
  function readArrayAt(src, open, errors) {
    var close = findMatching(src, open);
    if (close === -1) { errors.push('Tableau de questions non fermé (crochet « ] » manquant).'); return []; }
    var parts = splitTopLevel(src, open, close), items = [];
    parts.forEach(function (p, idx) {
      try { items.push({ n: idx + 1, raw: new LiteralParser(p).parse() }); }
      catch (e) { errors.push('Question ' + (idx + 1) + ' : syntaxe illisible — ' + e.message + '. Ignorée.'); }
    });
    return items;
  }

  function extractFromJsSource(src, errors) {
    // 1) ALL_QUESTIONS (const/let/var/window., ou clé d'objet)
    var re = /\bALL_QUESTIONS\b["']?\s*(?::[^=\n]{0,60})?[=:]\s*/g, m;
    while ((m = re.exec(src))) {
      var open = arrayStartAfter(src, m.index + m[0].length);
      if (open !== -1) return { items: readArrayAt(src, open, errors), name: 'ALL_QUESTIONS' };
    }
    // 2) autre tableau nommé « …question… / …quiz… / …qcm… »
    var re2 = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
    while ((m = re2.exec(src))) {
      if (!/quest|quiz|qcm|exam|test/i.test(m[1])) continue;
      var op = arrayStartAfter(src, m.index + m[0].length);
      if (op === -1) continue;
      var tmp = [];
      var items = readArrayAt(src, op, tmp);
      if (items.some(function (it) { return looksLikeQuestion(it.raw); })) { tmp.forEach(function (e) { errors.push(e); }); return { items: items, name: m[1] }; }
    }
    return null;
  }

  function extractFromJson(src, errors) {
    var t = src.trim();
    if (t.charAt(0) === '[') return { items: readArrayAt(t, 0, errors), name: 'JSON' };
    if (t.charAt(0) === '{') {
      var obj;
      try { obj = new LiteralParser(t).parse(); }
      catch (e) { errors.push('JSON illisible : ' + e.message); return { items: [], name: 'JSON' }; }
      var arr = findQuestionsArray(obj, 0);
      if (!arr) { errors.push('Aucun tableau de questions trouvé dans l\'objet JSON (clé « questions » attendue).'); return { items: [], name: 'JSON' }; }
      return { items: arr.map(function (raw, i) { return { n: i + 1, raw: raw }; }), name: 'JSON' };
    }
    return null;
  }

  function findQuestionsArray(obj, depth) {
    if (!obj || typeof obj !== 'object' || depth > 4) return null;
    if (Array.isArray(obj)) return obj.some(looksLikeQuestion) ? obj : null;
    var keys = Object.keys(obj), i;
    for (i = 0; i < keys.length; i++) if (/^(all_?)?questions?$|^quiz$|^items$/i.test(keys[i]) && Array.isArray(obj[keys[i]])) return obj[keys[i]];
    for (i = 0; i < keys.length; i++) { var r = findQuestionsArray(obj[keys[i]], depth + 1); if (r) return r; }
    return null;
  }

  // ---------------------------------------------------------------
  // 4. Normalisation d'une question brute (JS/JSON) → modèle Révisio
  // ---------------------------------------------------------------
  var TEXT_KEYS = ['question', 'text', 'q', 'enonce', 'title', 'statement', 'prompt', 'intitule', 'libelle', 'label'];
  var OPTION_KEYS = ['options', 'choices', 'choix', 'propositions', 'items', 'reponsespossibles', 'possibleanswers'];
  var CORRECT_KEYS = ['correctanswers', 'correctanswer', 'correct', 'answer', 'answers', 'solution', 'solutions',
    'bonnesreponses', 'bonnereponse', 'reponse', 'reponses', 'correctindex', 'correctindices', 'correctindexes', 'correctoptions', 'right', 'rightanswers'];
  var EXPLANATION_KEYS = ['explanation', 'explication', 'explications', 'rationale', 'justification', 'feedback', 'comment', 'commentaire', 'correction'];
  var TYPE_KEYS = ['type', 'kind', 'questiontype', 'qtype', 'format'];
  var COUNT_KEYS = ['expectedcount', 'expectedanswers', 'maxselect', 'maxselection', 'nbreponses', 'nbanswers', 'count', 'numcorrect'];

  function indexKeys(o) {
    var map = {};
    Object.keys(o).forEach(function (k) { var nk = compareKey(k); if (!(nk in map)) map[nk] = o[k]; });
    return map;
  }
  function pick(map, names) {
    for (var i = 0; i < names.length; i++) if (names[i] in map && map[names[i]] !== undefined && map[names[i]] !== null) return map[names[i]];
    return undefined;
  }

  function normalizeType(raw) {
    if (raw === undefined || raw === null) return null;
    var k = compareKey(raw);
    if (!k) return null;
    if (/^(single|simple|unique|mcq|qcm|qcmunique|mcqsingle|singlechoice|radio|choice|choix|choixunique|qcu)$/.test(k)) return 'single';
    if (/^(multiple|multi|mcqmulti|mcqmultiple|qcmmultiple|qcmm|multiplechoice|checkbox|multichoice|choixmultiple|qcmmulti)$/.test(k)) return 'multiple';
    if (/^(tf|truefalse|vraifaux|boolean|bool|qcd|vf)$/.test(k)) return 'tf';
    if (/^(short|shortanswer|text|open|ouverte|reponsecourte|input|free|libre|texte)$/.test(k)) return 'short';
    return undefined;                                                       // type renseigné mais inconnu
  }

  function toOptionList(rawOptions) {
    // renvoie { texts: [...], flagged: [...], keep: [indices d'origine conservés] }
    var texts = [], flagged = [], keep = [];
    (Array.isArray(rawOptions) ? rawOptions : []).forEach(function (o, i) {
      var text, isCorrect = false;
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        var m = indexKeys(o);
        text = pick(m, ['text', 'label', 'value', 'title', 'option', 'content', 'html', 'reponse', 'answer', 'name']);
        var flag = pick(m, ['correct', 'iscorrect', 'right', 'isright', 'valid', 'good', 'bonne']);
        isCorrect = flag === true || flag === 1 || /^(true|1|yes|oui|vrai|correct)$/i.test(String(flag));
      } else text = o;
      text = cleanText(text);
      if (HAS_CHECK_RE.test(text)) { isCorrect = true; text = text.replace(CHECK_RE, '').trim(); }
      if (!text) return;                                                    // option vide : ignorée (les index sont recalculés)
      texts.push(text); keep.push(i); if (isCorrect) flagged.push(texts.length - 1);
    });
    // retire les marqueurs « A. », « B) », « (C) » si TOUTES les options en portent
    var marker = /^\s*(?:\(\s*[A-Ja-j]\s*\)|[A-Ja-j]\s*[.):\-–—])\s+/;
    if (texts.length >= 2 && texts.every(function (t) { return marker.test(t); })) texts = texts.map(function (t) { return t.replace(marker, ''); });
    return { texts: texts, flagged: flagged, keep: keep };
  }

  /**
   * Résout les « bonnes réponses » brutes en index d'options (base 0).
   * Accepte : index numériques, lettres (A, B…), texte de l'option, listes « A, C ».
   * Renvoie { indices, problems }.
   */
  function resolveCorrect(rawCorrect, opts, base) {
    var texts = opts.texts, n = texts.length, indices = [], problems = [];
    var items = [];
    if (rawCorrect === undefined || rawCorrect === null || rawCorrect === '') return { indices: [], problems: [] };
    if (Array.isArray(rawCorrect)) items = rawCorrect.slice();
    else if (typeof rawCorrect === 'string') {
      var asText = compareKey(rawCorrect);
      var exact = texts.findIndex(function (t) { return compareKey(t) === asText; });
      if (exact !== -1) items = [rawCorrect];
      else if (/^\s*[A-Ja-j](?:\s*(?:[,;/&+]|et|and)\s*[A-Ja-j])*\s*$/.test(rawCorrect) || /^\s*\d+(?:\s*[,;/&+]\s*\d+)*\s*$/.test(rawCorrect)) items = rawCorrect.split(/\s*(?:[,;/&+]|\bet\b|\band\b)\s*/);
      else items = [rawCorrect];
    } else items = [rawCorrect];

    items.forEach(function (it) {
      var idx = -1;
      if (typeof it === 'number' && isFinite(it) && Math.floor(it) === it) idx = it - base;
      else if (typeof it === 'boolean' || it === null || it === undefined) { problems.push('valeur « ' + it + ' » inutilisable'); return; }
      else {
        var s = cleanText(typeof it === 'object' ? (it.text || it.label || it.value || '') : it);
        var key = compareKey(s);
        var byText = key ? texts.findIndex(function (t) { return compareKey(t) === key; }) : -1;
        if (byText !== -1) idx = byText;
        else if (/^[A-Ja-j]$/.test(s)) idx = LETTERS.indexOf(s.toUpperCase());
        else if (/^\d+$/.test(s)) idx = parseInt(s, 10) - base;
        else { problems.push('« ' + (s.length > 40 ? s.slice(0, 40) + '…' : s) + ' » ne correspond à aucune option'); return; }
      }
      if (idx < 0 || idx >= n) { problems.push('l\'index ' + (idx + base) + ' est hors des ' + n + ' options'); return; }
      if (indices.indexOf(idx) === -1) indices.push(idx);
    });
    indices.sort(function (a, b) { return a - b; });
    return { indices: indices, problems: problems };
  }

  /** Transforme un objet brut en question Révisio. Renvoie { question } ou { error } (+ warnings). */
  function normalizeQuestion(raw, n, opt) {
    var warnings = [];
    var label = 'Question ' + n;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: label + ' : ce n\'est pas un objet question. Ignorée.' };
    var m = indexKeys(raw);

    var text = cleanText(pick(m, TEXT_KEYS))
      .replace(/^\s*(?:Q(?:uestion)?\s*)?\d{1,3}\s*[.):\-–—]\s+/i, '');     // « 12. », « Q3 - », « Question 4 : »
    if (!text) return { error: label + ' : énoncé vide. Ignorée.' };
    var short = text.length > 50 ? text.slice(0, 50) + '…' : text;
    label = 'Question ' + n + ' (« ' + short + ' »)';

    var explanation = cleanText(pick(m, EXPLANATION_KEYS)) || DEFAULT_EXPLANATION;

    var typeRaw = pick(m, TYPE_KEYS);
    var type = normalizeType(typeRaw);
    if (type === undefined) { warnings.push(label + ' : type « ' + typeRaw + ' » inconnu, déduit automatiquement.'); type = null; }

    var rawCorrect = pick(m, CORRECT_KEYS);
    var rawOptions = pick(m, OPTION_KEYS);

    // ---- Réponse courte -------------------------------------------------
    var noOptions = !Array.isArray(rawOptions) || rawOptions.length === 0;
    if (type === 'short' || (type === null && noOptions && typeof rawCorrect === 'string' && !/^[A-Ja-j]$/.test(rawCorrect.trim()))) {
      var answer = Array.isArray(rawCorrect) ? rawCorrect.map(cleanText).filter(Boolean).join(' / ') : cleanText(rawCorrect);
      if (!answer) return { error: label + ' : aucune réponse attendue (correctAnswers vide). Ignorée.' };
      return { question: { type: 'short', text: text, options: [], correct: answer, explanation: explanation }, warnings: warnings };
    }

    // ---- Vrai / Faux sans options --------------------------------------
    if (type === 'tf' && noOptions) {
      var tfVal = Array.isArray(rawCorrect) ? rawCorrect[0] : rawCorrect;
      var tk = compareKey(tfVal), tfIdx = -1;
      if (tfVal === true || /^(true|vrai|v|oui)$/.test(tk)) tfIdx = 0;
      else if (tfVal === false || /^(false|faux|f|non)$/.test(tk)) tfIdx = 1;
      else if (typeof tfVal === 'number' && (tfVal - opt.indexBase === 0 || tfVal - opt.indexBase === 1)) tfIdx = tfVal - opt.indexBase;
      if (tfIdx === -1) return { error: label + ' : réponse Vrai/Faux introuvable (correctAnswers vide ou illisible). Ignorée.' };
      return { question: { type: 'tf', text: text, options: ['Vrai', 'Faux'], correct: tfIdx, explanation: explanation }, warnings: warnings };
    }

    // ---- Questions à choix ---------------------------------------------
    var list = toOptionList(rawOptions);
    if (list.texts.length < 2) return { error: label + ' : au moins 2 options sont nécessaires. Ignorée.' };
    if (list.texts.length > 10) warnings.push(label + ' : ' + list.texts.length + ' options (l\'éditeur de Révisio en attend 10 au maximum).');
    if (type === 'tf' && list.texts.length !== 2) return { error: label + ' : une question Vrai/Faux doit avoir exactement 2 options. Ignorée.' };

    // les index fournis visent la liste ORIGINALE ; si des options vides ont été retirées, on convertit
    var rc = rawCorrect;
    if (list.keep.length !== (Array.isArray(rawOptions) ? rawOptions.length : 0)) {
      var remap = function (v) { if (typeof v === 'number') { var pos = list.keep.indexOf(v - opt.indexBase); return pos === -1 ? v : pos + opt.indexBase; } return v; };
      rc = Array.isArray(rc) ? rc.map(remap) : remap(rc);
      warnings.push(label + ' : option(s) vide(s) retirée(s), index des réponses recalculés.');
    }
    var res = resolveCorrect(rc, list, opt.indexBase);
    var correct = res.indices;
    if (!correct.length && list.flagged.length && (rc === undefined || rc === null || (Array.isArray(rc) && !rc.length) || rc === '')) correct = list.flagged.slice();   // options marquées correct:true
    if (!correct.length) {
      var why = res.problems.length ? ' (' + res.problems.join(' ; ') + ')' : '';
      return { error: label + ' : aucune bonne réponse exploitable' + why + '. Ignorée.' };
    }
    if (res.problems.length) warnings.push(label + ' : ' + res.problems.join(' ; ') + ' — réponse(s) non retenue(s).');

    // ---- Type final ------------------------------------------------------
    var finalType;
    if (type === 'tf') {
      if (correct.length > 1) return { error: label + ' : plusieurs bonnes réponses pour une question Vrai/Faux. Ignorée.' };
      finalType = 'tf';
    } else if (type === 'multiple') finalType = 'mcq_multi';
    else if (type === 'single') {
      if (correct.length > 1) { finalType = 'mcq_multi'; warnings.push(label + ' : type « single » mais ' + correct.length + ' bonnes réponses → converti en QCM multiple.'); }
      else finalType = 'mcq';
    } else finalType = correct.length > 1 ? 'mcq_multi' : 'mcq';             // pas de type : on devine

    var q = { type: finalType, text: text, options: list.texts, correct: null, explanation: explanation };
    if (finalType === 'mcq_multi') {
      q.correct = correct;
      var expected = pick(m, COUNT_KEYS);
      expected = typeof expected === 'string' && /^\d+$/.test(expected.trim()) ? parseInt(expected, 10) : expected;
      if (typeof expected === 'number' && Math.floor(expected) === expected) {
        if (expected >= correct.length && expected >= 2 && expected <= list.texts.length) q.max_select = expected;
        else warnings.push(label + ' : expectedCount=' + expected + ' incohérent avec ' + correct.length + ' bonne(s) réponse(s) / ' + list.texts.length + ' options — ignoré.');
      }
    } else q.correct = correct[0];                                           // mcq / tf : entier, comme les quiz existants

    return { question: q, warnings: warnings };
  }

  // ---------------------------------------------------------------
  // 5. Format HTML brut : <div class="question"> … <li> … </div>
  // ---------------------------------------------------------------
  var Q_SELECTOR = '.question, [data-question], .quiz-question, .qcm-question, .q-block, .question-block, .question-card';
  var CORRECT_CLASS_RE = /(^|[\s_-])(correct|right|good|valid|bonne|ok|is-correct|correct-answer)($|[\s_-])/i;
  var WRONG_CLASS_RE = /(incorrect|wrong|faux|false|invalid)/i;

  function parseHtmlBlocks(html, errors) {
    var DP = root.DOMParser || (typeof DOMParser !== 'undefined' ? DOMParser : null);
    if (!DP) { errors.push('Analyse du HTML brut indisponible dans cet environnement (DOMParser manquant).'); return []; }
    var doc = new DP().parseFromString(html, 'text/html');
    Array.prototype.forEach.call(doc.querySelectorAll('script, style, noscript, template'), function (el) { el.parentNode && el.parentNode.removeChild(el); });
    var all = Array.prototype.slice.call(doc.querySelectorAll(Q_SELECTOR));
    var blocks = all.filter(function (el) { return !all.some(function (o) { return o !== el && el.contains(o); }); });     // on garde les blocs les plus internes
    var items = [];
    blocks.forEach(function (block, idx) {
      var n = idx + 1;
      var qEl = block.querySelector('.question-text, .q-text, .question-title, .enonce, .stem, [data-question-text]');
      var text;
      if (qEl) text = cleanText(qEl.textContent);
      else {
        var clone = block.cloneNode(true);
        Array.prototype.forEach.call(clone.querySelectorAll('ul, ol, select, .explanation, .explication, .rationale, .feedback, .options, .choices, label, input, button'), function (el) { el.parentNode && el.parentNode.removeChild(el); });
        text = cleanText(clone.textContent);
      }
      var liNodes = Array.prototype.slice.call(block.querySelectorAll('li'));
      if (!liNodes.length) liNodes = Array.prototype.slice.call(block.querySelectorAll('.option, .choice, .answer, .reponse, label'));
      liNodes = liNodes.filter(function (li) { return !li.closest('.explanation, .explication, .rationale, .feedback'); });
      var options = [];
      liNodes.forEach(function (li) {
        var c = li.cloneNode(true);
        Array.prototype.forEach.call(c.querySelectorAll('.explanation, .explication, .rationale, .feedback, input, button'), function (el) { el.parentNode && el.parentNode.removeChild(el); });
        var flagged = false;
        var cls = (li.getAttribute('class') || '') + ' ' + Array.prototype.map.call(li.querySelectorAll('[class]'), function (e) { return e.getAttribute('class'); }).join(' ');
        var dc = li.getAttribute('data-correct') || li.getAttribute('data-is-correct') || li.getAttribute('data-valid') || li.getAttribute('data-right');
        if (dc !== null) flagged = /^(true|1|yes|oui|vrai|correct|)$/i.test(dc.trim()) && dc !== '';
        else if (CORRECT_CLASS_RE.test(cls) && !WRONG_CLASS_RE.test(li.getAttribute('class') || '')) flagged = true;
        var inp = li.querySelector('input[data-correct]');
        if (inp && /^(true|1|yes|oui|correct)$/i.test(inp.getAttribute('data-correct'))) flagged = true;
        options.push({ text: c.textContent, correct: flagged });
      });
      var dtype = block.getAttribute('data-type') || block.getAttribute('data-question-type') || '';
      if (!dtype) { var cm = /\b(single|multiple|multi|tf|true-?false|short)\b/i.exec(block.getAttribute('class') || ''); if (cm) dtype = cm[1]; }
      var expEl = block.querySelector('.explanation, .explication, .rationale, .feedback, [data-explanation]');
      var explanation = block.getAttribute('data-explanation') || (expEl ? (expEl.getAttribute('data-explanation') || expEl.textContent) : '');
      var nodeAnswer = block.getAttribute('data-answer') || block.getAttribute('data-correct') || block.getAttribute('data-correct-answers') || block.getAttribute('data-correctanswers') || block.getAttribute('data-answers');
      var raw = { question: text, options: options, type: dtype || undefined, explanation: explanation };
      if (nodeAnswer) raw.correctAnswers = nodeAnswer;
      var ec = block.getAttribute('data-expected-count') || block.getAttribute('data-expectedcount') || block.getAttribute('data-max-select');
      if (ec) raw.expectedCount = ec;
      items.push({ n: n, raw: raw });
    });
    return items;
  }

  // ---------------------------------------------------------------
  // 6. Point d'entrée
  // ---------------------------------------------------------------
  function byteLength(s) {
    try { return new TextEncoder().encode(s).length; } catch (_) { return s.length; }
  }

  function convert(htmlCode, options) {
    var opt = { indexBase: 0, maxBytes: MAX_BYTES };
    if (options && typeof options === 'object') {
      if (options.indexBase === 1) opt.indexBase = 1;
      if (typeof options.maxBytes === 'number' && options.maxBytes > 0) opt.maxBytes = options.maxBytes;
    }
    var result = { questions: [], errors: [], warnings: [], format: null, stats: { detected: 0, valid: 0, mcq: 0, mcq_multi: 0, tf: 0, short: 0 } };
    try {
      if (typeof htmlCode !== 'string' || !htmlCode.trim()) { result.errors.push('Aucun code à convertir : colle du HTML ou importe un fichier .html.'); return result; }
      if (byteLength(htmlCode) > opt.maxBytes) {
        result.errors.push('Fichier trop volumineux (' + Math.round(byteLength(htmlCode) / 1024) + ' Ko). Maximum : ' + Math.round(opt.maxBytes / 1024) + ' Ko.');
        return result;
      }
      var src = htmlCode.replace(/^\uFEFF/, '');
      var found = null, errs = [];

      var trimmed = src.trim();
      if (trimmed.charAt(0) === '[' || trimmed.charAt(0) === '{') { found = extractFromJson(trimmed, errs); if (found) result.format = 'json'; }

      if (!found) {
        found = extractFromJsSource(src, errs);
        if (found) result.format = 'js';
      }
      if (!found) {                                                         // <script type="application/json"> …
        var jre = /<script\b[^>]*type\s*=\s*["']?application\/(?:ld\+)?json["']?[^>]*>([\s\S]*?)<\/script>/gi, jm;
        while (!found && (jm = jre.exec(src))) {
          var e2 = [];
          var j = extractFromJson(jm[1], e2);
          if (j && j.items.length && j.items.some(function (it) { return looksLikeQuestion(it.raw); })) { found = j; errs = errs.concat(e2); result.format = 'json'; }
        }
      }
      if (!found && /<[a-z][\s\S]*>/i.test(src)) {
        var blocks = parseHtmlBlocks(src, errs);
        if (blocks.length) { found = { items: blocks, name: 'HTML' }; result.format = 'html'; }
      }
      result.errors = result.errors.concat(errs);

      if (!found) {
        result.errors.push('Aucune question détectée. Formats acceptés : « const ALL_QUESTIONS = [ … ] », un tableau JSON [{"question": …}], ou des blocs <div class="question"> avec des <li> pour les options.');
        return result;
      }

      result.stats.detected = found.items.length;
      found.items.forEach(function (it) {
        var r = normalizeQuestion(it.raw, it.n, opt);
        if (r.warnings && r.warnings.length) result.warnings = result.warnings.concat(r.warnings);
        if (r.error) { result.errors.push(r.error); return; }
        result.questions.push(r.question);
        result.stats.valid++;
        result.stats[r.question.type]++;
      });
      if (!result.questions.length && !result.errors.length) result.errors.push('Aucune question valide trouvée.');
    } catch (e) {
      result.errors.push('Erreur inattendue pendant la conversion : ' + (e && e.message ? e.message : e));
    }
    return result;
  }

  var api = { convert: convert, MAX_BYTES: MAX_BYTES, version: '1.0.0', _internal: { LiteralParser: LiteralParser, cleanText: cleanText, normalizeQuestion: normalizeQuestion } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.HtmlQuizParser = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

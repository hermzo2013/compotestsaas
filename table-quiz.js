/* =====================================================================
   RÉVISIO — Questions « tableau à remplir »  (table-quiz.js)

   Fichier léger chargé à la demande (loadModule) quand un quiz contient une question
   { type: 'table', text, tableHtml, answers: [{ inputId, expected, tol }], explanation }.

   Expose :
     window.renderTableQuestion(question, container, options)   ← appelé par le moteur d'examen
     window.TableQuiz = { renderTableQuestion, score, isPerfect, cellResults, compareAnswer,
                          parseNumber, sanitize, sanitizeHtml }

   SÉCURITÉ : tableHtml vient d'un HTML collé par un admin. Il est nettoyé à l'import ET de nouveau
   à l'affichage (liste blanche de balises/attributs) : pas de script, pas de style, pas de gestionnaire
   d'événement, pas de lien, pas d'image, pas de formulaire.
   ===================================================================== */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------
  // 1. Nettoyage HTML (liste blanche)
  // ---------------------------------------------------------------
  var KEEP = {
    table: 1, caption: 1, colgroup: 1, col: 1, thead: 1, tbody: 1, tfoot: 1, tr: 1, th: 1, td: 1,
    p: 1, div: 1, br: 1, b: 1, strong: 1, i: 1, em: 1, u: 1, sub: 1, sup: 1, small: 1, code: 1, span: 1,
    ul: 1, ol: 1, li: 1
  };
  var DROP = {
    script: 1, style: 1, button: 1, svg: 1, math: 1, iframe: 1, object: 1, embed: 1, form: 1, select: 1,
    textarea: 1, link: 1, meta: 1, noscript: 1, template: 1, img: 1, audio: 1, video: 1, canvas: 1,
    head: 1, title: 1, base: 1, applet: 1, frame: 1, frameset: 1, datalist: 1, dialog: 1
  };
  var BLOCK_MAP = { section: 'div', article: 'div', header: 'div', footer: 'div', main: 'div', aside: 'div', figure: 'div', fieldset: 'div', center: 'div', blockquote: 'div', pre: 'div', dl: 'div', dt: 'p', dd: 'p' };
  var SPAN_ATTRS = { td: ['colspan', 'rowspan', 'scope'], th: ['colspan', 'rowspan', 'scope'], col: ['span'], colgroup: ['span'] };
  var MAX_NODES = 30000;
  var MAX_HTML = 200 * 1024;
  var IID_RE = /^[A-Za-z0-9_.-]{1,40}$/;

  function escText(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escAttr(s) { return escText(s).replace(/"/g, '&quot;'); }

  function serialize(node, ctx) {
    if (++ctx.count > MAX_NODES) throw new Error('Tableau trop volumineux.');
    if (node.nodeType === 3) return escText(node.nodeValue);
    if (node.nodeType !== 1) return '';
    var tag = node.tagName.toLowerCase();
    if (DROP[tag]) return '';
    if (node.hasAttribute && node.hasAttribute('hidden')) return '';

    if (tag === 'input') {
      var iid = ctx.inputHandler ? ctx.inputHandler(node) : null;
      if (iid) return '<input type="text" data-iid="' + escAttr(iid) + '" autocomplete="off" autocapitalize="off" spellcheck="false">';
      var type = (node.getAttribute('type') || 'text').toLowerCase();
      if (ctx.keepValue && node.hasAttribute('value') && (type === 'text' || type === 'number' || type === '')) return escText(node.getAttribute('value'));   // case déjà remplie
      return '';
    }

    var inner = '';
    for (var c = node.firstChild; c; c = c.nextSibling) inner += serialize(c, ctx);

    if (/^h[1-6]$/.test(tag)) return '<p><strong>' + inner + '</strong></p>';
    var out = KEEP[tag] ? tag : BLOCK_MAP[tag];
    if (!out) return inner;                                   // balise inconnue (label, a, font…) : on garde le texte seulement
    var attrs = '';
    (SPAN_ATTRS[tag] || []).forEach(function (a) {
      var v = node.getAttribute(a);
      if (v !== null && /^\d{1,2}$/.test(v.trim()) && +v >= 1 && +v <= 50) attrs += ' ' + a + '="' + (+v) + '"';
    });
    if (tag === 'br') return '<br>';
    return '<' + out + attrs + '>' + inner + '</' + out + '>';
  }

  /** Nettoie un nœud DOM (ou ses enfants) → chaîne HTML sûre. options: { inputHandler(el)→iid|null, keepValue, childrenOnly } */
  function sanitize(node, options) {
    options = options || {};
    var ctx = { count: 0, inputHandler: options.inputHandler, keepValue: !!options.keepValue };
    var html = '';
    if (options.childrenOnly === false) html = serialize(node, ctx);
    else for (var c = node.firstChild; c; c = c.nextSibling) html += serialize(c, ctx);
    if (html.length > MAX_HTML) throw new Error('Tableau trop volumineux (' + Math.round(html.length / 1024) + ' Ko).');
    return html;
  }

  function domParser() {
    var DP = root.DOMParser || (typeof DOMParser !== 'undefined' ? DOMParser : null);
    if (!DP) throw new Error('DOMParser indisponible.');
    return new DP();
  }

  /** Nettoie une chaîne HTML stockée (déjà passée par l'import) : ne garde que les <input data-iid>. */
  function sanitizeHtml(html) {
    var doc = domParser().parseFromString('<body>' + String(html || '') + '</body>', 'text/html');
    return sanitize(doc.body, {
      inputHandler: function (el) { var v = el.getAttribute('data-iid'); return v && IID_RE.test(v) ? v : null; }
    });
  }

  // ---------------------------------------------------------------
  // 2. Comparaison des réponses (nombres avec tolérance, sinon texte)
  // ---------------------------------------------------------------
  function compareKey(s) {
    var t = String(s === null || s === undefined ? '' : s).toLowerCase();
    try { t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); } catch (_) { /* ignore */ }
    return t.replace(/[^a-z0-9]+/g, '');
  }

  /** « 1 234,5 », « 0,156 », « 15 % », « 3/4 », « −2 » → nombre, sinon NaN. */
  function parseNumber(value) {
    if (typeof value === 'number') return isFinite(value) ? value : NaN;
    var t = String(value === null || value === undefined ? '' : value).replace(/[\s\u00A0\u202F]/g, '').replace(/[−–—]/g, '-').replace(/%$/, '');
    if (!t) return NaN;
    var frac = /^([+-]?\d+(?:[.,]\d+)?)\/(\d+(?:[.,]\d+)?)$/.exec(t);
    if (frac) { var a = parseFloat(frac[1].replace(',', '.')), b = parseFloat(frac[2].replace(',', '.')); return b ? a / b : NaN; }
    if (t.indexOf(',') !== -1 && t.indexOf('.') !== -1) {            // le dernier séparateur est la virgule décimale
      var last = Math.max(t.lastIndexOf(','), t.lastIndexOf('.'));
      t = t.slice(0, last).replace(/[.,]/g, '') + '.' + t.slice(last + 1);
    } else t = t.replace(',', '.');
    return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(t) ? Number(t) : NaN;
  }

  function normTol(tol) { var n = Number(tol); return isFinite(n) && n > 0 ? n : 0; }

  /** answer = { expected, tol } ; « expected » peut contenir plusieurs valeurs acceptées séparées par « | ». */
  function compareAnswer(answer, value) {
    var v = String(value === null || value === undefined ? '' : value).trim();
    if (!v || !answer) return false;
    var tol = normTol(answer.tol);
    var alts = String(answer.expected === undefined || answer.expected === null ? '' : answer.expected).split('|');
    var vn = parseNumber(v);
    for (var i = 0; i < alts.length; i++) {
      var alt = alts[i].trim();
      if (!alt) continue;
      var en = parseNumber(alt);
      if (!isNaN(en)) {
        if (!isNaN(vn) && Math.abs(vn - en) <= tol + 1e-9 * Math.max(1, Math.abs(en))) return true;
      } else if (compareKey(alt) && compareKey(alt) === compareKey(v)) return true;
    }
    return false;
  }

  /** ua = { inputId: valeur, … } (ou null). Renvoie [{ inputId, ok, value, expected }]. */
  function cellResults(question, ua) {
    var values = ua && typeof ua === 'object' ? ua : {};
    return (Array.isArray(question && question.answers) ? question.answers : []).map(function (a) {
      var value = values[a.inputId];
      return { inputId: a.inputId, ok: compareAnswer(a, value), value: value === undefined ? '' : value, expected: String(a.expected === undefined ? '' : a.expected).split('|')[0].trim() };
    });
  }
  /** Part de cases correctes, entre 0 et 1 (crédit partiel : sert au score final). */
  function score(question, ua) {
    var r = cellResults(question, ua);
    return r.length ? r.filter(function (x) { return x.ok; }).length / r.length : 0;
  }
  function isPerfect(question, ua) { var r = cellResults(question, ua); return r.length > 0 && r.every(function (x) { return x.ok; }); }

  // ---------------------------------------------------------------
  // 3. Rendu dans le moteur d'examen
  // ---------------------------------------------------------------
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

  /**
   * Remplit `container` avec le tableau de la question.
   * options : {
   *   answer   : { inputId: valeur }  réponses déjà saisies (reprise, navigation),
   *   locked   : true → affiche la correction (cases vertes/rouges + score),
   *   mode     : 'training' | 'exam'  (le bouton « Vérifier » n'existe qu'en entraînement),
   *   onChange : fn(values)  à chaque saisie,
   *   onVerify : fn(values)  clic sur « Vérifier le tableau » (le moteur verrouille alors la question)
   * }
   */
  function renderTableQuestion(question, container, options) {
    options = options || {};
    container.textContent = '';
    var values = {};
    if (options.answer && typeof options.answer === 'object') Object.keys(options.answer).forEach(function (k) { values[k] = String(options.answer[k]); });

    var wrap = el('div', 'table-quiz');
    try { wrap.innerHTML = sanitizeHtml(question && question.tableHtml); }
    catch (e) { container.appendChild(el('div', 'notice err', 'Tableau illisible : ' + e.message)); return container; }
    container.appendChild(wrap);

    var inputs = Array.prototype.slice.call(wrap.querySelectorAll('input[data-iid]'));
    var known = {};
    (question.answers || []).forEach(function (a) { known[a.inputId] = a; });
    var results = {};
    cellResults(question, values).forEach(function (r) { results[r.inputId] = r; });

    inputs.forEach(function (inp, idx) {
      var id = inp.getAttribute('data-iid');
      inp.value = values[id] !== undefined ? values[id] : '';
      inp.setAttribute('aria-label', 'Case ' + (idx + 1));
      if (options.locked) {
        inp.disabled = true;
        var r = results[id];
        if (r) {
          inp.classList.add(r.ok ? 'correct' : 'wrong');
          if (!r.ok) { var hint = el('span', 'tq-expected', '→ ' + r.expected); inp.parentNode.insertBefore(hint, inp.nextSibling); }
        }
        return;
      }
      inp.addEventListener('input', function () {
        values[id] = inp.value;
        if (typeof options.onChange === 'function') options.onChange(Object.assign({}, values));
      });
      inp.addEventListener('keydown', function (ev) {           // Entrée → case suivante
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        var next = inputs[idx + 1];
        if (next) next.focus();
      });
    });

    if (options.locked) {
      var list = (question.answers || []).map(function (a) { return results[a.inputId]; }).filter(Boolean);
      var ok = list.filter(function (r) { return r.ok; }).length;
      var perfect = list.length > 0 && ok === list.length;
      var box = el('div', 'exam-result-box' + (perfect ? '' : ' wrong'));
      box.appendChild(el('b', '', (perfect ? '✅ Tableau entièrement correct' : '❌ Tableau incomplet ou incorrect')));
      box.appendChild(el('div', 'tq-score', 'Score : ' + ok + ' / ' + list.length + ' cases correctes'));
      if (question.explanation) {
        var ex = el('div', 'exam-explain'); ex.appendChild(el('b', '', 'Explication : ')); ex.appendChild(document.createTextNode(question.explanation));
        box.appendChild(ex);
      }
      container.appendChild(box);
      return container;
    }

    if (options.mode === 'training' && typeof options.onVerify === 'function') {
      var btn = el('button', 'validate-btn', '✅ Vérifier le tableau');
      btn.type = 'button';
      btn.addEventListener('click', function () {
        var filled = inputs.filter(function (i) { return i.value.trim() !== ''; }).length;
        if (!filled) return alert('Remplis au moins une case avant de vérifier.');
        if (filled < inputs.length && !confirm((inputs.length - filled) + ' case(s) vide(s) seront comptées fausses. Vérifier quand même ?')) return;
        options.onVerify(Object.assign({}, values));
      });
      container.appendChild(btn);
    }
    return container;
  }

  var api = {
    renderTableQuestion: renderTableQuestion, score: score, isPerfect: isPerfect, cellResults: cellResults,
    compareAnswer: compareAnswer, parseNumber: parseNumber, sanitize: sanitize, sanitizeHtml: sanitizeHtml, version: '1.0.0'
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) { root.TableQuiz = api; root.renderTableQuestion = renderTableQuestion; }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

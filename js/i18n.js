/*!
 * WikiMV — internationalisation core (ru / en / pt-BR)
 *
 * - Source language of the code base is Russian: every UI string is passed through WM.t('<russian text>').
 *   For `ru` the text is returned untouched, for `en` / `pt-BR` it is looked up in the dictionaries
 *   registered by js/lang/en.js and js/lang/pt-BR.js (keyed by the Russian source text).
 * - Placeholders: WM.t('Расстояние: {0} м', 12)  ->  "Distance: 12 m".
 * - Static HTML (index.html) is translated once at start-up by WM.i18n.translateDom().
 * - Language choice: localStorage 'wm_lang' = 'auto' | 'en' | 'pt-BR' | 'ru'. 'auto' follows the system language.
 *   Changing the language reloads the page.
 */
(function () {
  'use strict';

  var WM = (window.WM = window.WM || {});
  var SUPPORTED = ['ru', 'en', 'pt-BR'];
  var LS_KEY = 'wm_lang';
  var dicts = {};

  function safeGet() { try { return localStorage.getItem(LS_KEY); } catch (e) { return null; } }
  function safeSet(v) { try { localStorage.setItem(LS_KEY, v); } catch (e) {} }

  // Maps any BCP-47-ish tag to one of the supported languages.
  function mapTag(tag) {
    var t = String(tag || '').toLowerCase();
    if (t.indexOf('pt') === 0) return 'pt-BR';
    if (t.indexOf('ru') === 0) return 'ru';
    if (t.indexOf('en') === 0) return 'en';
    return null;
  }

  function systemLang() {
    var list = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || 'en'];
    for (var i = 0; i < list.length; i++) {
      var m = mapTag(list[i]);
      if (m) return m;
    }
    return 'en';
  }

  var pref = safeGet() || 'auto';
  if (pref !== 'auto' && SUPPORTED.indexOf(pref) < 0) pref = 'auto';
  var lang = pref === 'auto' ? systemLang() : pref;

  var LOCALES = { 'ru': 'ru-RU', 'en': 'en-US', 'pt-BR': 'pt-BR' };
  var i18n = (WM.i18n = {
    SUPPORTED: SUPPORTED,
    pref: pref,
    lang: lang,
    locale: LOCALES[lang],
    // Language codes for the different remote services
    api: {
      wikimapia: { 'ru': 'ru', 'en': 'en', 'pt-BR': 'pt' }[lang],
      inat: { 'ru': 'ru', 'en': 'en', 'pt-BR': 'pt-BR' }[lang],
      wiki: { 'ru': 'ru', 'en': 'en', 'pt-BR': 'pt' }[lang],
      nominatim: { 'ru': 'ru', 'en': 'en', 'pt-BR': 'pt-BR,pt,en' }[lang],
      photon: { 'ru': 'ru', 'en': 'en', 'pt-BR': 'default' }[lang],
      acceptLanguage: {
        'ru': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'en': 'en-US,en;q=0.9',
        'pt-BR': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
      }[lang]
    },

    register: function (l, dict) {
      var d = dicts[l] || (dicts[l] = {});
      for (var k in dict) d[k] = dict[k];
      reverse = null;
    },

    setPref: function (p) {
      if (p !== 'auto' && SUPPORTED.indexOf(p) < 0) return;
      safeSet(p);
      try { location.reload(); } catch (e) {}
    }
  });

  // ---- translate -------------------------------------------------------------------
  function fmt(s, args) {
    if (!args.length) return s;
    return s.replace(/\{(\d+)\}/g, function (m, i) {
      var v = args[Number(i)];
      return v === undefined && !(Number(i) in args) ? m : String(v);
    });
  }

  WM.t = i18n.t = function (key) {
    var args = arguments.length > 1 ? Array.prototype.slice.call(arguments, 1) : [];
    var d = lang === 'ru' ? null : dicts[lang];
    var s = d && Object.prototype.hasOwnProperty.call(d, key) && d[key] !== '' ? d[key] : key;
    return fmt(s, args);
  };

  // Reverse lookup: translated text -> original Russian text. Lets name-based logic keep
  // working on the Russian source text whatever the active language is.
  var reverse = null;
  i18n.src = function (text) {
    if (lang === 'ru' || typeof text !== 'string') return text;
    if (!reverse) {
      reverse = Object.create(null);
      var amb = Object.create(null), d = dicts[lang] || {};
      for (var k in d) {
        var v = d[k];
        if (v in reverse && reverse[v] !== k) amb[v] = 1; else reverse[v] = k;
      }
      for (var a in amb) delete reverse[a];
    }
    return reverse[text] || text;
  };

  // ---- static HTML translation ----------------------------------------------------
  var ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'label', 'data-tooltip', 'data-title', 'data-label', 'data-hint', 'data-text', 'data-caption', 'data-tip'];
  var INLINE = { B: 1, I: 1, EM: 1, STRONG: 1, SPAN: 1, A: 1, CODE: 1, SMALL: 1, KBD: 1, U: 1, SUP: 1, SUB: 1, BR: 1, MARK: 1, ABBR: 1, S: 1 };
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, NOSCRIPT: 1 };
  var CYR = /[Ѐ-ӿ]/;
  var norm = function (s) { return s.replace(/[ \t\r\n]+/g, ' ').trim(); };

  function inlineOnly(el) {
    for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (!INLINE[c.tagName] || !inlineOnly(c)) return false;
    }
    return true;
  }

  // opts.collect(key, kind): collect keys instead of translating (used by the build tooling)
  i18n.translateDom = function (root, opts) {
    root = root || document;
    var collect = opts && opts.collect;
    var d = lang === 'ru' ? null : dicts[lang];
    if (!d && !collect) return;

    function lookup(key) {
      return Object.prototype.hasOwnProperty.call(d, key) && d[key] !== '' ? d[key] : null;
    }

    function visit(el) {
      if (SKIP[el.tagName] && el.tagName !== 'TEXTAREA') return;
      if (el.hasAttribute && el.hasAttribute('data-no-i18n')) return;
      // attributes
      for (var i = 0; i < ATTRS.length; i++) {
        var an = ATTRS[i];
        if (el.hasAttribute(an)) {
          var av = el.getAttribute(an);
          if (CYR.test(av)) {
            var ak = norm(av);
            if (collect) collect(ak, 'attr:' + an);
            else { var at = lookup(ak); if (at !== null) el.setAttribute(an, at); }
          }
        }
      }
      if (el.tagName === 'TEXTAREA') return; // attributes only (placeholder), never the content
      // template content
      if (el.tagName === 'TEMPLATE' && el.content) { walk(el.content); }
      // inline unit (mixed text + inline markup) -> translate the whole innerHTML
      if (el.firstElementChild && CYR.test(el.textContent) && inlineOnly(el)) {
        var hasOwnText = false;
        for (var n0 = el.firstChild; n0; n0 = n0.nextSibling) if (n0.nodeType === 3 && CYR.test(n0.nodeValue)) { hasOwnText = true; break; }
        if (hasOwnText) {
          var uk = norm(el.innerHTML);
          if (collect) { collect(uk, 'unit'); return; }
          var ut = lookup(uk);
          if (ut !== null) { el.innerHTML = ut; return; }
        }
      }
      for (var n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3) {
          if (!CYR.test(n.nodeValue)) continue;
          var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(n.nodeValue);
          var tk = norm(m[2]);
          if (collect) { collect(tk, 'text'); continue; }
          var tt = lookup(tk);
          if (tt !== null) n.nodeValue = m[1] + tt + m[3];
        } else if (n.nodeType === 1) visit(n);
      }
    }
    function walk(node) {
      for (var c = node.firstElementChild; c; c = c.nextElementSibling) visit(c);
    }
    walk(root.documentElement ? root.documentElement : root);
  };

  // ---- language picker in the settings panel ---------------------------------------
  i18n.bindUI = function () {
    var radios = document.querySelectorAll('input[name="app-lang-mode"]');
    for (var i = 0; i < radios.length; i++) {
      (function (r) {
        r.checked = r.value === pref;
        r.addEventListener('change', function () {
          if (r.checked && r.value !== pref) i18n.setPref(r.value);
        });
      })(radios[i]);
    }
  };

  try { document.documentElement.lang = lang; } catch (e) {}
})();

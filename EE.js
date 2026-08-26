(function () {
  'use strict';

  var PLUGIN          = 'voice_catalog_buttons';
  var CACHE_KEY       = 'voice_catalog_buttons_v2';
  var SUCCESS_TTL     = 6 * 60 * 60 * 1000;
  var EMPTY_TTL       = 30 * 60 * 1000;
  var CACHE_LIMIT     = 50;
  var MAX_SOURCES     = 10;
  var MAX_DEPTH       = 2;
  var REQUEST_TIMEOUT = 9000;

  function clean(v) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  }

  function detectQuality(value) {
    var t = '';
    if (value == null) t = '';
    else if (typeof value === 'object') {
      try { t = JSON.stringify(value); } catch (e) { t = String(value); }
    } else {
      t = String(value);
    }
    t = clean(t).toLowerCase();
    var q = /(?:2160p?|\b4k\b)/.test(t) ? 2160
      : /1080p?/.test(t) ? 1080
      : /720p?/.test(t) ? 720
      : /480p?/.test(t) ? 480 : 0;
    return { quality: q, hdr: /\bhdr\b/.test(t) };
  }

  function normalizeVoice(value) {
    var raw = clean(value);
    var isOrig = /\b(?:original|english|eng)\b|оригінал|оригинал|англій|англий/i.test(raw);
    var isUk   = /україн|украин|\bukr?\b|\bua\b/i.test(raw);
    var label  = clean(raw
      .replace(/(?:2160p?|\b4k\b|1080p?|720p?|480p?|\bhdr\b)/ig, '')
      .replace(/^\s*[-–—|,;:/]+|[-–—|,;:/]+\s*$/g, ''));
    return {
      label: isOrig ? 'Original' : (label || 'Без позначення'),
      language: isUk ? 'uk' : (isOrig ? 'en' : 'other')
    };
  }

  function displayLabel(g) {
    var s = g.quality === 2160 ? '4K' : (g.quality ? g.quality + 'p' : '');
    if (s && g.hdr) s += ' HDR';
    return g.label + (s ? ' — ' + s : '');
  }

  function voiceKey(c) {
    return (c.language || 'other') + ':' + clean(c.voice || c.label).toLowerCase();
  }

  function candidateBetter(a, b) {
    if ((b.quality || 0) !== (a.quality || 0)) return (b.quality || 0) - (a.quality || 0);
    if (!!b.hdr !== !!a.hdr) return b.hdr ? 1 : -1;
    return 0;
  }

  function groupItems(list) {
    var map = {};
    (list || []).forEach(function (item) {
      if (!item) return;
      var voice = normalizeVoice(item.voice || item.label || item.text || item.name || item.title);
      var q = detectQuality([item.quality, item.maxquality, item.text, item.label, item.name].join(' '));
      var key = voiceKey(voice);

      if (!map[key]) {
        map[key] = {
          label: voice.label,
          language: voice.language,
          quality: 0,
          hdr: false,
          candidates: []
        };
      }
      var g = map[key];
      g.candidates.push({
        voice: voice.label,
        language: voice.language,
        quality: q.quality,
        hdr: q.hdr,
        url: item.url || item.link || item.file || '',
        balanser: item.balanser || item.source || '',
        selection: item.selection || null,
        root: !!item.root,
        raw: item
      });

      if (q.quality > g.quality) {
        g.quality = q.quality;
        g.hdr = q.hdr;
      } else if (q.quality === g.quality && q.hdr) {
        g.hdr = true;
      }
    });

    var order = { uk: 0, other: 1, en: 2 };
    return Object.keys(map).map(function (k) {
      var g = map[k];
      g.candidates.sort(candidateBetter);
      return g;
    }).sort(function (a, b) {
      var ra = order[a.language] != null ? order[a.language] : 1;
      var rb = order[b.language] != null ? order[b.language] : 1;
      if (ra !== rb) return ra - rb;
      if (b.quality !== a.quality) return b.quality - a.quality;
      if (!!b.hdr !== !!a.hdr) return b.hdr ? 1 : -1;
      return a.label.localeCompare(b.label);
    });
  }

  function getStore() {
    var s = Lampa.Storage.get(CACHE_KEY, { entries: {} });
    if (!s || typeof s !== 'object' || !s.entries) s = { entries: {} };
    return s;
  }

  function cacheGet(id) {
    try {
      var store = getStore();
      var e = store.entries[id];
      if (!e) return null;
      var ttl = e.empty ? EMPTY_TTL : SUCCESS_TTL;
      if (Date.now() - e.savedAt >= ttl) {
        delete store.entries[id];
        Lampa.Storage.set(CACHE_KEY, store);
        return null;
      }
      return JSON.parse(JSON.stringify(e.value));
    } catch (e) { return null; }
  }

  function cacheSet(id, value) {
    try {
      var store = getStore();
      store.entries[id] = {
        savedAt: Date.now(),
        empty: !value || !value.length,
        value: value
      };
      var keys = Object.keys(store.entries).sort(function (a, b) {
        return store.entries[b].savedAt - store.entries[a].savedAt;
      });
      keys.slice(CACHE_LIMIT).forEach(function (k) { delete store.entries[k]; });
      Lampa.Storage.set(CACHE_KEY, store);
    } catch (e) {}
  }

  function cacheClear(id) {
    try {
      var store = getStore();
      if (id) delete store.entries[id];
      else store.entries = {};
      Lampa.Storage.set(CACHE_KEY, store);
    } catch (e) {}
  }

  function request(url, type, timeout) {
    return new Promise(function (resolve, reject) {
      if (!url) {
        reject(new Error('empty_url'));
        return;
      }
      var req = new Lampa.Reguest();
      var t = setTimeout(function () {
        try { req.clear(); } catch (e) {}
        reject(new Error('timeout'));
      }, timeout || REQUEST_TIMEOUT);

      req.quiet().timeout(timeout || REQUEST_TIMEOUT).get(url, function (data) {
        clearTimeout(t);
        try {
          if (type !== 'text' && typeof data === 'string') data = JSON.parse(data);
          resolve(data);
        } catch (e) { reject(e); }
      }, function (err) {
        clearTimeout(t);
        reject(err || new Error('network'));
      });
    });
  }

  function requestJson(url, timeout) {
    return request(url, 'json', timeout);
  }

  function requestText(url, timeout) {
    return request(url, 'text', timeout);
  }

  function extractRecords(html) {
    var records = [];
    if (typeof html !== 'string') return records;

    try {
      var root = document.createElement('div');
      root.innerHTML = html;
      var nodes = root.querySelectorAll('.videos__button[data-json], .videos__item[data-json], [data-json]');
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        try {
          var data = JSON.parse(node.getAttribute('data-json'));
          if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
          if (data.season == null && node.getAttribute('s') != null) data.season = node.getAttribute('s');
          if (data.episode == null && node.getAttribute('e') != null) data.episode = node.getAttribute('e');
          records.push({
            kind: node.classList.contains('videos__button') ? 'button' : 'item',
            text: (node.textContent || '').replace(/\s+/g, ' ').trim(),
            active: node.classList.contains('active') || node.classList.contains('focus') || data.active === true,
            data: data
          });
        } catch (e) {}
      }
    } catch (e) {}

    return records;
  }

  function parseRecordsToItems(records, job) {
    var items = [];
    var activeVoice = job.voiceHint;

    (records || []).forEach(function (rec) {
      if (rec.kind === 'button') {
        var v = normalizeVoice(rec.text);
        if (rec.active) activeVoice = v;
        return;
      }
      var voice = activeVoice || normalizeVoice(rec.text || (rec.data && (rec.data.translate || rec.data.voice)));
      var q = detectQuality([rec.text, rec.data && rec.data.quality, rec.data && rec.data.maxquality].join(' '));
      items.push({
        voice: voice.label,
        language: voice.language,
        quality: q.quality,
        hdr: q.hdr,
        url: (rec.data && (rec.data.url || rec.data.file)) || '',
        balanser: job.balanser,
        selection: rec.data ? {
          index: rec.data.index,
          label: rec.text,
          quality: q.quality,
          hdr: q.hdr
        } : null,
        root: job.depth === 0
      });
    });

    if (!items.length && activeVoice) {
      items.push({
        voice: activeVoice.label,
        language: activeVoice.language,
        quality: 0,
        hdr: false,
        url: job.url,
        balanser: job.balanser,
        root: true
      });
    }
    return items;
  }

  function parseJsonResponse(data, source) {
    var items = [];
    if (!data) return items;

    if (Array.isArray(data)) {
      data.forEach(function (v) {
        if (!v) return;
        items.push({
          voice: v.voice || v.translate || v.name || v.title || v.text,
          quality: v.quality || v.maxquality || v.q,
          url: v.url || v.link || v.file,
          balanser: source.balanser,
          selection: v.selection || null
        });
      });
      return items;
    }

    var list = data.voices || data.playlist || data.online || data.list || data.items || [];
    if (Array.isArray(list)) {
      list.forEach(function (v) {
        items.push({
          voice: v.voice || v.translate || v.name || v.title,
          quality: v.quality || v.maxquality,
          url: v.url || v.link || v.file,
          balanser: source.balanser,
          selection: v.selection || null
        });
      });
    }
    return items;
  }

  function createScanner(options) {
    options = options || {};
    var maxConcurrency = options.maxConcurrency || 3;
    var totalBudgetMs  = options.totalBudgetMs || 22000;

    function scan(params) {
      var sources  = params.sources || [];
      var season   = params.season || 0;
      var buildUrl = params.buildProviderUrl || function (u) { return u; };
      var authUrl  = params.authorizeUrl || function (u) { return u; };
      var cacheId  = params.cacheId;

      var startTime = Date.now();
      var queue = [];
      var active = 0;
      var results = [];
      var finished = false;
      var cancelled = false;

      return new Promise(function (resolve) {
        function done() {
          if (finished) return;
          finished = true;
          var groups = groupItems(results);
          if (cacheId) cacheSet(cacheId, groups);
          resolve(groups);
        }

        function next() {
          if (cancelled || finished) return;
          if (Date.now() - startTime > totalBudgetMs) return done();
          if (!queue.length && active === 0) return done();

          while (active < maxConcurrency && queue.length) {
            var job = queue.shift();
            if (!job) break;
            active++;
            var url = authUrl(buildUrl(job.url));
            requestText(url, REQUEST_TIMEOUT)
              .then(function (html) {
                active--;
                if (cancelled || finished) return;
                var records = extractRecords(html);
                results = results.concat(parseRecordsToItems(records, job));
                if (job.depth < MAX_DEPTH) {
                  records.forEach(function (rec) {
                    if (rec.kind === 'button' && rec.data && rec.data.url) {
                      queue.push({
                        url: rec.data.url,
                        balanser: job.balanser,
                        depth: job.depth + 1,
                        voiceHint: normalizeVoice(rec.text)
                      });
                    }
                  });
                }
                next();
              })
              .catch(function () {
                active--;
                next();
              });
          }
        }

        sources.slice(0, MAX_SOURCES).forEach(function (src) {
          var url = src.url;
          if (season > 0 && url.indexOf('season=') < 0) {
            url += (url.indexOf('?') > -1 ? '&' : '?') + 'season=' + season;
          }
          queue.push({ url: url, balanser: src.balanser, depth: 0, voiceHint: null });
        });

        if (!queue.length) return done();
        next();
        scan.cancel = function () {
          cancelled = true;
          done();
        };
      });
    }

    return { scan: scan };
  }

  function showSelect(title, items, onSelect, onBack) {
    var enabled = Lampa.Controller.enabled();
    var ctrl = enabled && enabled.name ? enabled.name : enabled;
    var restored = false;

    function restore() {
      if (restored) return;
      restored = true;
      if (ctrl) Lampa.Controller.toggle(ctrl);
    }

    Lampa.Select.show({
      title: title,
      items: items,
      onBack: function () {
        restore();
        if (typeof onBack === 'function') onBack();
      },
      onSelect: function (item) {
        restore();
        if (item && (item.disabled || item.noenter)) return;
        if (typeof onSelect === 'function') onSelect(item);
      }
    });
  }

  function validateContract(json) {
    if (!json || json.voice_catalog !== true || json.contract !== 1 || !Array.isArray(json.online)) {
      throw new Error('unsupported_contract');
    }
    return json.online.filter(function (s) {
      return s && s.url && s.balanser && String(s.url).toLowerCase().indexOf('/lite/groupdeny') < 0;
    });
  }

  function buildCacheId(movie, season, sources) {
    var id = (movie && (movie.id || movie.tmdb_id || movie.imdb_id || movie.kinopoisk_id)) || 'unknown';
    var src = clean(movie && movie.source).toLowerCase();
    var key = 'vb2:' + (src ? src + ':' : '') + id + ':' + (season || 0);
    var fp = (sources || []).map(function (s) { return s.balanser + '|' + s.url; }).join(';');
    key += ':' + (fp.length > 48 ? fp.slice(0, 48) : fp);
    return key;
  }

  function defaultListUrl(movie) {
    if (!movie) return null;
    var base = Lampa.Storage.get('lampac_address') ||
               Lampa.Storage.get('online_balance_url') ||
               Lampa.Storage.get('cub_address') || '';
    if (!base) return null;
    var mid = movie.kinopoisk_id || movie.kp_id || movie.id || movie.tmdb_id || movie.imdb_id || '';
    return String(base).replace(/\/$/, '') + '/lite/voice?id=' + encodeURIComponent(mid);
  }

  function makeContext(movie, extra) {
    extra = extra || {};
    return {
      movie: movie,
      buildListUrl: extra.buildListUrl || function () {
        return extra.listUrl || defaultListUrl(movie);
      },
      buildProviderUrl: extra.buildProviderUrl || function (u) { return u; },
      buildNativeProviderUrl: extra.buildNativeProviderUrl,
      authorizeUrl: extra.authorizeUrl || function (u) { return u; },
      openNative: extra.openNative || function () {
        Lampa.Activity.push({
          url: '',
          title: (movie && (movie.title || movie.name)) || '',
          component: 'online',
          movie: movie,
          page: 1
        });
      }
    };
  }

  function openCandidate(context, candidate) {
    if (!candidate) return;

    if (typeof context.openNative === 'function') {
      var selection = {
        balanser: candidate.balanser,
        url: candidate.url
      };
      if (typeof context.buildNativeProviderUrl === 'function' && candidate.root !== false) {
        selection.url = context.buildNativeProviderUrl(candidate.url);
      }
      if (candidate.selection) selection.item = candidate.selection;
      context.openNative(selection);
      return;
    }

    if (candidate.url && Lampa.Player) {
      Lampa.Player.play({
        url: candidate.url,
        title: candidate.voice || 'Video'
      });
    }
  }

  function showQualities(context, group, onBack) {
    return new Promise(function (resolve) {
      var seen = {};
      var items = [];

      (group.candidates || []).forEach(function (c) {
        var q = c.quality || 0;
        var key = q + ':' + (c.hdr ? '1' : '0') + ':' + (c.balanser || '') + ':' + (c.url || '');
        if (seen[key]) return;
        seen[key] = true;

        var label = q === 2160 ? '4K' : (q ? q + 'p' : 'Невідома якість');
        if (c.hdr) label += ' HDR';
        if (c.balanser) label += '  ·  ' + c.balanser;

        items.push({
          title: label,
          candidate: c,
          quality: q,
          hdr: !!c.hdr
        });
      });

      items.sort(function (a, b) {
        if (b.quality !== a.quality) return b.quality - a.quality;
        if (!!b.hdr !== !!a.hdr) return b.hdr ? 1 : -1;
        return 0;
      });

      if (!items.length) {
        items.push({ title: 'Немає варіантів', disabled: true, noenter: true });
      }

      showSelect(group.label, items, function (item) {
        if (item.candidate) openCandidate(context, item.candidate);
        resolve('select');
      }, function () {
        resolve('back');
        if (typeof onBack === 'function') onBack();
      });
    });
  }

  function showGroups(context, groups, cacheId, season) {
    return new Promise(function (resolve) {
      function draw() {
        var items = (groups || []).map(function (g) {
          var count = (g.candidates || []).length;
          var title = displayLabel(g);
          if (count > 1) title += '  (' + count + ')';
          return { title: title, group: g };
        });

        if (!items.length) {
          items.push({ title: 'Нічого не знайдено', disabled: true, noenter: true });
          items.push({ title: 'Повторити пошук', retry: true });
        }
        items.push({ title: 'Звичайні балансери', native: true });

        showSelect('Оберіть озвучку', items, function (item) {
          if (item.retry) {
            cacheClear(cacheId);
            runCatalog(context, season).then(resolve);
            return;
          }
          if (item.native) {
            if (typeof context.openNative === 'function') context.openNative();
            resolve();
            return;
          }
          if (item.group) {
            var candidates = item.group.candidates || [];
            if (candidates.length <= 1) {
              if (candidates[0]) openCandidate(context, candidates[0]);
              resolve();
              return;
            }
            showQualities(context, item.group, function () {
              draw();
            }).then(function (result) {
              if (result === 'select') resolve();
            });
            return;
          }
          resolve();
        }, function () {
          resolve();
        });
      }

      draw();
    });
  }

  function showSeasons(context) {
    return new Promise(function (resolve) {
      var count = parseInt(context.movie && context.movie.number_of_seasons, 10) || 0;
      if (count <= 1) {
        resolve(0);
        return;
      }
      var items = [];
      for (var s = 1; s <= count; s++) {
        items.push({ title: 'Сезон ' + s, season: s });
      }
      showSelect('Оберіть сезон', items, function (item) {
        resolve(item.season || 0);
      }, function () {
        resolve(null);
      });
    });
  }

  function collectGroups(context, season) {
    var listUrl = typeof context.buildListUrl === 'function' ? context.buildListUrl() : null;
    if (!listUrl) return Promise.reject(new Error('no_list_url'));

    return requestJson(listUrl, 12000).then(function (json) {
      var sources = validateContract(json);
      if (!sources.length) throw new Error('no_sources');

      var cacheId = buildCacheId(context.movie, season, sources);
      var cached = cacheGet(cacheId);
      if (cached) return { groups: cached, cacheId: cacheId, fromCache: true };

      var jsonTasks = sources.slice(0, MAX_SOURCES).map(function (src) {
        var url = src.url;
        if (typeof context.buildProviderUrl === 'function') url = context.buildProviderUrl(url);
        if (typeof context.authorizeUrl === 'function') url = context.authorizeUrl(url);
        if (season > 0 && url.indexOf('season=') < 0) {
          url += (url.indexOf('?') > -1 ? '&' : '?') + 'season=' + season;
        }
        return requestJson(url, REQUEST_TIMEOUT)
          .then(function (data) { return parseJsonResponse(data, src); })
          .catch(function () { return null; });
      });

      return Promise.all(jsonTasks).then(function (results) {
        var all = [];
        var needScan = false;
        results.forEach(function (r) {
          if (r && r.lengt зроби таке саме тільки для лампи

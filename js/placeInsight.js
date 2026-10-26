/**
 * Wikimapia Viewer — модуль «Информация об этом месте» (placeInsight.js) v3.0
 * Экспресс-разведка местности: проходимость, биотоп, почва, гидрология, грибной потенциал и биоразнообразие.
 */
(function () {
  'use strict';
  const WM = window.WM = window.WM || {};

  let abortController = null;
  const insightCache = new Map();
  const CACHE_TTL_MS = 20 * 60 * 1000; // 20 минут

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
  const sgn = v => (v > 0 ? '+' : '') + v;

  // =========================================================================
  // БЫСТРЫЙ И БЕЗОПАСНЫЙ СБОР ДАННЫХ
  // =========================================================================

  async function fetchLocalBiodiversity(lat, lon, month, signal) {
    const res = {
      fungi: [],
      plants: [],
      birds: [],
      mammals: [],
      threatened: []
    };

    try {
      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), 4500);
      const onAbort = () => ctl.abort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      // Запрашиваем реальные частые виды в радиусе 20 км с разбивкой
      const pCommon = new URLSearchParams({
        lat: lat.toFixed(4),
        lng: lon.toFixed(4),
        radius: '22',
        month: String(month),
        per_page: '45',
        locale: WM.i18n.api.inat,
        fields: '(taxon:(id:!t,name:!t,preferred_common_name:!t,iconic_taxon_name:!t,threatened:!t,rank:!t,default_photo:(square_url:!t)),count:!t)'
      });

      // Параллельно запрашиваем редкие/краснокнижные виды района
      const pThreat = new URLSearchParams({
        lat: lat.toFixed(4),
        lng: lon.toFixed(4),
        radius: '30',
        threatened: 'true',
        per_page: '8',
        locale: WM.i18n.api.inat,
        fields: '(taxon:(id:!t,name:!t,preferred_common_name:!t,iconic_taxon_name:!t,threatened:!t,rank:!t,default_photo:(square_url:!t)),count:!t)'
      });

      const [rCommon, rThreat] = await Promise.allSettled([
        fetch(`https://api.inaturalist.org/v2/observations/species_counts?${pCommon.toString()}`, {
          signal: ctl.signal,
          headers: { 'Accept': 'application/json' }
        }).then(r => r.ok ? r.json() : null),
        fetch(`https://api.inaturalist.org/v2/observations/species_counts?${pThreat.toString()}`, {
          signal: ctl.signal,
          headers: { 'Accept': 'application/json' }
        }).then(r => r.ok ? r.json() : null)
      ]);

      clearTimeout(tm);
      if (signal) signal.removeEventListener('abort', onAbort);

      const items = (rCommon.status === 'fulfilled' && rCommon.value?.results) ? rCommon.value.results : [];
      const seenIds = new Set();

      items.forEach(item => {
        const t = item.taxon;
        if (!t || !t.id || seenIds.has(t.id)) return;
        seenIds.add(t.id);

        const card = {
          id: t.id,
          name: t.preferred_common_name || t.name,
          latin: t.name || '',
          iconic: t.iconic_taxon_name || '',
          count: item.count || 1,
          photo: t.default_photo?.square_url || ''
        };

        if (t.iconic_taxon_name === 'Fungi') res.fungi.push(card);
        else if (t.iconic_taxon_name === 'Plantae') res.plants.push(card);
        else if (t.iconic_taxon_name === 'Aves') res.birds.push(card);
        else if (['Mammalia', 'Amphibia', 'Reptilia'].includes(t.iconic_taxon_name)) res.mammals.push(card);
      });

      const threatItems = (rThreat.status === 'fulfilled' && rThreat.value?.results) ? rThreat.value.results : [];
      threatItems.forEach(item => {
        const t = item.taxon;
        if (!t || !t.id) return;
        res.threatened.push({
          id: t.id,
          name: t.preferred_common_name || t.name,
          latin: t.name || '',
          iconic: t.iconic_taxon_name || '',
          count: item.count || 1
        });
      });
    } catch (e) {
      // Игнорируем сетевые ошибки iNat, интерфейс продолжит работать
    }

    return res;
  }

  async function getInsightData(lat, lon, signal) {
    const cacheKey = `${lat.toFixed(3)}_${lon.toFixed(3)}`;
    const now = Date.now();
    const hit = insightCache.get(cacheKey);
    if (hit && (now - hit.time < CACHE_TTL_MS)) {
      return hit.data;
    }

    const month = new Date().getMonth() + 1;

    // 1. Опрашиваем геологические и метео-сервисы
    // Важно: не вызываем дублирующий Overpass!
    const [soilRes, terrainRes, lcRes, agroRes, floodRes, osmWaterRes] = await Promise.allSettled([
      WM.soil && WM.soil.getSoilGrids ? WM.soil.getSoilGrids(lat, lon, signal) : Promise.resolve(null),
      WM.soil && WM.soil.getTerrain ? WM.soil.getTerrain(lat, lon, signal) : Promise.resolve(null),
      WM.soil && WM.soil.getLandCover ? WM.soil.getLandCover(lat, lon, signal) : Promise.resolve(null),
      WM.soil && WM.soil.fetchAgro ? WM.soil.fetchAgro(lat, lon, signal) : Promise.resolve(null),
      WM.water && WM.water.fetchGloFas ? WM.water.fetchGloFas(lat, lon, signal) : Promise.resolve(null),
      WM.water && WM.water.fetchOsm ? WM.water.fetchOsm(lat, lon, signal) : Promise.resolve(null)
    ]);

    const soil = soilRes.status === 'fulfilled' ? soilRes.value : null;
    const terrain = terrainRes.status === 'fulfilled' ? terrainRes.value : null;
    const lc = lcRes.status === 'fulfilled' ? lcRes.value : null;
    const agro = agroRes.status === 'fulfilled' ? agroRes.value : null;
    const flood = floodRes.status === 'fulfilled' ? floodRes.value : null;
    const osmWater = osmWaterRes.status === 'fulfilled' ? osmWaterRes.value : { ok: false, items: [], inside: {}, nearest: {} };

    // Биоразнообразие запрашиваем параллельно
    const bio = await fetchLocalBiodiversity(lat, lon, month, signal);

    // 2. Определение биотопа
    let biotope = null;
    let biotopeConfidence = 0;
    let fungal = null;
    let whereToGoText = '';

    const moist = (soil && agro && WM.soil?.assessMoisture) ? WM.soil.assessMoisture(soil.hydro, agro) : null;

    if (soil && WM.soil?.matchBiotopes) {
      const matches = WM.soil.matchBiotopes(soil, terrain, moist, lat, lon, lc);
      if (matches && matches.length) {
        biotope = matches[0].biotope;
        biotopeConfidence = matches.confidence || matches[0].similarity || 70;
      }
    }

    if (soil && agro && WM.soil?.computeFungalIndex) {
      fungal = WM.soil.computeFungalIndex(soil, agro, terrain, moist, month);
    }

    if (WM.soil?.whereToGo && biotope && fungal) {
      whereToGoText = WM.soil.whereToGo({ moist, agro, terrain, fungal, biotope, soil });
    }

    // 3. УМНЫЙ СИНТЕЗ ПРОХОДИМОСТИ И ГИДРОЛОГИИ
    // Защита от ложного объявления обычного леса «топью»
    const isOsmWetland = !!(osmWater?.inside?.wetland || (osmWater?.nearest?.wetland && osmWater.nearest.wetland.dist <= 40) || lc?.wetland);
    const isOsmWater = !!(osmWater?.inside?.water || (osmWater?.nearest?.water && osmWater.nearest.water.dist === 0) || lc?.water);
    const isForest = !!(lc?.forest || (biotope && ['acid_sand_dry', 'pine_loam_mixed', 'acid_loam_mesic', 'neutral_rich_loam'].includes(biotope.id)));

    let waterAnalysis = null;
    if (WM.water?.analyze) {
      // Подготавливаем wx адаптер из agro данных, чтобы не слать ещё один дублирующий HTTP-запрос погоды
      const wxAdapter = agro ? {
        m0_1: agro.m0,
        m1_3: agro.m0,
        m3_9: agro.m39,
        m9_27: agro.m39,
        m27_81: agro.m39,
        airT: agro.airT,
        rain72: agro.rain3,
        rain7: agro.rain7,
        rain14: agro.rain14,
        fc72: agro.fcRain,
        api: agro.rain7 * 0.7,
        thawing: false,
        frozenTop: agro.soilT0 < -0.5,
        frozenDeep: agro.soilT18 < -0.5
      } : null;

      waterAnalysis = WM.water.analyze({ flood, osm: osmWater, wx: wxAdapter, terrain, soil });
    }

    // КОРРЕКЦИЯ ОШИБКИ «НЕПРОХОДИМАЯ ТОПЬ В ЛЕСУ»:
    let effectiveRisk = waterAnalysis ? waterAnalysis.risk : 20;
    let effectiveVerdict = waterAnalysis ? { ...waterAnalysis.v } : null;

    if (isOsmWater) {
      effectiveRisk = 96;
      effectiveVerdict = {
        title: WM.t('Открытая вода / акватория'),
        color: '#0284c7',
        icon: '🛶',
        walk: WM.t('Пешком невозможно: открытый водоём.'),
        car: WM.t('Проезд невозможен. Только плавсредства.'),
        gear: WM.t('Лодка, спасжилет.')
      };
    } else if (isForest && !isOsmWetland && (!flood || flood.cur < (flood.p75 || 999))) {
      // Если это лес и явного болота нет — риск топкости физически не может быть выше 45!
      effectiveRisk = Math.min(effectiveRisk, moist?.status === 'wet' ? 44 : 26);

      if (effectiveRisk >= 35) {
        effectiveVerdict = {
          title: WM.t('Влажный лесной грунт / лужи'),
          color: '#eab308',
          icon: '🌦️',
          walk: WM.t('Проходимо в треккинговой обуви или легких сапогах.'),
          car: WM.t('Проезд на легковом авто затруднен в колеях; внедорожник — свободно.'),
          gear: WM.t('Треккинговые ботинки или сапоги.')
        };
      } else {
        effectiveVerdict = {
          title: WM.t('Сухой устойчивый лесной грунт'),
          color: '#10b981',
          icon: '🌲',
          walk: WM.t('Свободный уверенный шаг в любой обуви.'),
          car: WM.t('Свободный проезд по грунтовым лесным дорогам.'),
          gear: WM.t('Любая удобная обувь.')
        };
      }
    } else if (!effectiveVerdict) {
      effectiveVerdict = {
        title: WM.t('Умеренная влажность грунта'),
        color: '#10b981',
        icon: '🟢',
        walk: WM.t('Свободный проход.'),
        car: WM.t('Обычный проезд транспорта.'),
        gear: WM.t('Стандартная экипировка.')
      };
    }

    const payload = {
      lat, lon, month,
      soil, terrain, lc, agro, flood,
      biotope, biotopeConfidence,
      fungal, whereToGoText,
      bio,
      effectiveRisk,
      effectiveVerdict,
      isForest, isOsmWetland, isOsmWater
    };

    insightCache.set(cacheKey, { time: now, data: payload });
    return payload;
  }

  // =========================================================================
  // ОТРИСОВКА ИНТЕРФЕЙСА
  // =========================================================================

  function renderInsightModal(data) {
    const content = document.getElementById('place-insight-content');
    if (!content) return;

    const {
      biotope, biotopeConfidence, fungal, effectiveVerdict: v,
      effectiveRisk: risk, terrain, soil, bio, whereToGoText,
      agro, flood, month
    } = data;

    const trafficLightCol = v.color || (risk >= 65 ? '#ef4444' : (risk >= 35 ? '#eab308' : '#10b981'));
    const trafficLightIcon = v.icon || (risk >= 65 ? '🔴' : (risk >= 35 ? '🟡' : '🟢'));

    const seasonNames = ['', WM.t('январе'), WM.t('феврале'), WM.t('марте'), WM.t('апреле'), WM.t('мае'), WM.t('июне'), WM.t('июле'), WM.t('августе'), WM.t('сентябре'), WM.t('октябре'), WM.t('ноябре'), WM.t('декабре')];

    // Генератор кликабельных чипов видов для карты
    const renderTaxaChips = (list, defaultIcon) => {
      if (!list || !list.length) {
        return `<span class="muted" style="font-size:11px; padding:3px 0;">${WM.t('Наблюдений поблизости пока нет.')}</span>`;
      }
      return list.map(item => `
        <button type="button" class="pi-species-chip" data-taxon-id="${item.id}" data-name="${esc(item.name)}" title="${esc(item.latin)}">
          <span class="pi-chip-icon">${defaultIcon}</span>
          <span class="pi-chip-title">${esc(item.name)}</span>
          ${item.count > 1 ? `<span class="pi-chip-count">${item.count}</span>` : ''}
        </button>
      `).join('');
    };

    // Индикаторные виды из биотопа (если в iNat находок мало)
    const getSeasonalBiotopeFungi = () => {
      if (!biotope || !biotope.fungi) return [];
      if (month >= 3 && month <= 5) return biotope.fungi.spring || [];
      if (month >= 6 && month <= 8) return biotope.fungi.summer || [];
      if (month >= 9 && month <= 11) return biotope.fungi.autumn || [];
      return biotope.fungi.winter || [];
    };

    const biotopeFungiList = getSeasonalBiotopeFungi();
    const biotopePlantsList = biotope ? (biotope.plants || []) : [];

    content.innerHTML = `
      <!-- 1. ГЛАВНЫЙ СТАТУС-БАННЕР МЕСТНОСТИ -->
      <div class="pi-hero-card" style="border-left: 4.5px solid ${trafficLightCol};">
        <div class="pi-hero-header">
          <div class="pi-hero-badge-row">
            <span class="pi-badge" style="border-color:${trafficLightCol}; color:${trafficLightCol};">
              ${trafficLightIcon} ${esc(v.title)}
            </span>
            ${biotope ? `<span class="pi-badge" style="border-color:var(--accent); color:var(--accent);">${WM.t('Биотоп: {0}%', biotopeConfidence)}</span>` : ''}
            ${fungal ? `<span class="pi-badge" style="border-color:${fungal.color}; color:${fungal.color};">${WM.t('Грибница: {0}%', fungal.score)}</span>` : ''}
          </div>
          <h3 class="pi-hero-title">${biotope ? esc(biotope.title.split(' / ')[0]) : WM.t('Природный ландшафт')}</h3>
          <div class="pi-hero-subtitle">${biotope ? `${esc(biotope.soilTypeRu)} · ${esc(soil ? soil.hydro.drainage.label : '')}` : WM.t('Характер грунта и растительности')}</div>
        </div>

        <!-- Ключевые статусы доступности -->
        <div class="pi-metrics-row">
          <div class="pi-metric-card" style="border-left-color:${trafficLightCol};">
            <span class="pi-metric-lbl">${WM.t('🚶 Доступность пешком')}</span>
            <b class="pi-metric-val" style="color:${trafficLightCol};">${esc(v.walk)}</b>
            <span class="pi-metric-desc">${WM.t('Снаряжение: {0}', esc(v.gear))}</span>
          </div>

          <div class="pi-metric-card" style="border-left-color:${fungal ? fungal.color : 'var(--accent)'};">
            <span class="pi-metric-lbl">${WM.t('🍄 Грибной потенциал')}</span>
            <b class="pi-metric-val" style="color:${fungal ? fungal.color : 'var(--accent)'};">${fungal ? esc(fungal.phase) : WM.t('Ожидание метеоданных')}</b>
            <span class="pi-metric-desc">${fungal?.window ? esc(fungal.window) : WM.t('Ориентируйтесь на влажность подстилки.')}</span>
          </div>
        </div>
      </div>

      <!-- 2. СОВЕТ ПОХОДНИКУ И ГРИБНИКУ -->
      ${whereToGoText ? `
        <div class="pi-highlight-box">
          <div class="pi-box-title">${WM.t('🧭 Куда лучше сместиться и где искать:')}</div>
          <div class="pi-box-text">${esc(whereToGoText)}</div>
        </div>
      ` : ''}

      <!-- 3. КРАСНАЯ КНИГА / ОХРАНЯЕМЫЕ ВИДЫ (ЕСЛИ ЕСТЬ НАХОДКИ) -->
      ${bio.threatened && bio.threatened.length > 0 ? `
        <div class="pi-threatened-box">
          <div class="pi-box-title" style="color: #ef4444;">${WM.t('⚠️ Редкие и охраняемые виды в этом районе (iNaturalist):')}</div>
          <div class="pi-species-chips-wrap" style="margin-top: 5px;">
            ${bio.threatened.map(t => `
              <button type="button" class="pi-species-chip threatened" data-taxon-id="${t.id}" data-name="${esc(t.name)}">
                <span class="pi-chip-icon">🔴</span>
                <span class="pi-chip-title">${esc(t.name)}</span>
              </button>
            `).join('')}
          </div>
        </div>
      ` : ''}

      <!-- 4. ФЛОРА, ФАУНА И ГРИБЫ ВОКРУГ -->
      <div class="pi-section-card">
        <div class="pi-section-title">${WM.t('🌲 Живая природа вокруг (сезон: {0}):', seasonNames[month])}</div>

        <!-- Грибы -->
        <div class="pi-species-group">
          <div class="pi-species-group-head">
            <span>${WM.t('🍄 Характерные и частые грибы:')}</span>
          </div>
          <div class="pi-species-chips-wrap">
            ${bio.fungi.length > 0
              ? renderTaxaChips(bio.fungi.slice(0, 6), '🍄')
              : (biotopeFungiList.length > 0
                  ? biotopeFungiList.slice(0, 6).map(f => `<span class="pi-species-chip static"><span class="pi-chip-icon">🍄</span><span class="pi-chip-title">${esc(f)}</span></span>`).join('')
                  : `<span class="muted" style="font-size:11px;">${WM.t('Слой грибов в этом месяце не активен.')}</span>`)}
          </div>
        </div>

        <!-- Ягоды и растения -->
        <div class="pi-species-group" style="margin-top: 9px;">
          <div class="pi-species-group-head">
            <span>${WM.t('🌿 Растения, деревья и ягоды:')}</span>
          </div>
          <div class="pi-species-chips-wrap">
            ${bio.plants.length > 0
              ? renderTaxaChips(bio.plants.slice(0, 6), '🌱')
              : (biotopePlantsList.length > 0
                  ? biotopePlantsList.slice(0, 6).map(p => `<span class="pi-species-chip static"><span class="pi-chip-icon">🌱</span><span class="pi-chip-title">${esc(p)}</span></span>`).join('')
                  : `<span class="muted" style="font-size:11px;">${WM.t('Данные о растениях формируются.')}</span>`)}
          </div>
        </div>

        <!-- Птицы и звери -->
        ${(bio.birds.length > 0 || bio.mammals.length > 0) ? `
          <div class="pi-species-group" style="margin-top: 9px;">
            <div class="pi-species-group-head">
              <span>${WM.t('🐾 Птицы и животные окрестностей (iNat):')}</span>
            </div>
            <div class="pi-species-chips-wrap">
              ${renderTaxaChips([...bio.birds.slice(0, 4), ...bio.mammals.slice(0, 4)], '🐾')}
            </div>
          </div>
        ` : ''}
      </div>

      <!-- 5. ГЕОЛОГИЯ, РЕЛЬЕФ И ВОДА -->
      <div class="pi-section-card">
        <div class="pi-section-title">${WM.t('⛰️ Земля, вода и условия под ногами:')}</div>
        <div class="pi-features-grid">
          <div class="pi-feature-item">
            <span class="pi-feature-icon">${terrain ? terrain.icon : '🟢'}</span>
            <div class="pi-feature-text">
              <b>${terrain ? esc(terrain.aspectName) : WM.t('Равнина')}</b>
              <small>${terrain ? WM.t('Уклон {0}°, над низиной {1} м', terrain.slopeDeg, sgn(terrain.hLow)) : WM.t('Без выраженного стока')}</small>
            </div>
          </div>

          <div class="pi-feature-item">
            <span class="pi-feature-icon">🧪</span>
            <div class="pi-feature-text">
              <b>${soil ? `pH ${soil.ph.toFixed(1)} · ${esc(soil.hydro.drainage.label)}` : WM.t('Стандартный дренаж')}</b>
              <small>${soil ? WM.t('Песок {0}%, глина {1}%, Ksat {2} мм/ч', soil.sand, soil.clay, soil.hydro.ks) : WM.t('Почва умеренной плотности')}</small>
            </div>
          </div>

          <div class="pi-feature-item">
            <span class="pi-feature-icon">🚙</span>
            <div class="pi-feature-text">
              <b>${WM.t('Проезд авто:')}</b>
              <small>${esc(v.car)}</small>
            </div>
          </div>

          <div class="pi-feature-item">
            <span class="pi-feature-icon">💧</span>
            <div class="pi-feature-text">
              <b>${WM.t('Режим стока и осадки:')}</b>
              <small>${flood && flood.cur >= 0.5 ? WM.t('Река: {0} м³/с (порог поймы {1})', flood.cur, flood.p75) : (agro ? WM.t('Осадки 7 дн: {0} мм', agro.rain7) : WM.t('Без паводкового риска'))}</small>
            </div>
          </div>
        </div>
      </div>

      <!-- 6. КНОПКИ БЫСТРОГО ПЕРЕХОДА -->
      <div class="nav-actions-grid inat-actions-grid" style="margin-top: 12px;">
        <button type="button" class="action-card-btn" id="btn-pi-to-soil">${WM.t('🧪 Подробно о почве')}</button>
        <button type="button" class="action-card-btn" id="btn-pi-to-water">${WM.t('🌊 Паводок и разлив')}</button>
        <button type="button" class="action-card-btn primary" id="btn-pi-copy-brief" style="grid-column: span 2;">${WM.t('📋 Скопировать сводку')}</button>
      </div>
    `;

    // Слушатели кнопок перехода в детальные модули
    document.getElementById('btn-pi-to-soil')?.addEventListener('click', () => {
      closeInsightModal();
      if (WM.soil?.runDiagnosisForCoords) WM.soil.runDiagnosisForCoords(data.lat, data.lon);
    });

    document.getElementById('btn-pi-to-water')?.addEventListener('click', () => {
      closeInsightModal();
      if (WM.water?.runDiagnosisForCoords) WM.water.runDiagnosisForCoords(data.lat, data.lon);
    });

    // Клик по любому таксону активирует фильтр на карте iNaturalist
    content.querySelectorAll('.pi-species-chip:not(.static)').forEach(chip => {
      chip.addEventListener('click', () => {
        const tid = chip.dataset.taxonId;
        const name = chip.dataset.name;
        closeInsightModal();
        if (WM.inat?.applyFilterToMap) {
          WM.inat.applyFilterToMap(name, { id: parseInt(tid, 10), name });
        }
      });
    });

    // Копирование емкого полевого отчета
    document.getElementById('btn-pi-copy-brief')?.addEventListener('click', () => {
      const text = [
        WM.t('🏕️ Экспресс-сводка местности [{0}, {1}]:', data.lat.toFixed(5), data.lon.toFixed(5)),
        biotope ? WM.t('• Биотоп: {0} (уверенность {1}%)', biotope.title.split(' / ')[0], biotopeConfidence) : '',
        WM.t('• Проходимость: {0} — {1}', v.title, v.walk),
        WM.t('• Транспорт: {0}', v.car),
        fungal ? WM.t('• Грибной потенциал: {0} ({1}%) — {2}', fungal.phase, fungal.score, fungal.window) : '',
        whereToGoText ? WM.t('• Тактика поиска: {0}', whereToGoText) : '',
        terrain ? WM.t('• Рельеф: {0}, уклон {1}°, над низиной {2} м', terrain.aspectName, terrain.slopeDeg, sgn(terrain.hLow)) : '',
        soil ? WM.t('• Почва: pH {0}, песок {1}%, глина {2}%, дренаж: {3}', soil.ph.toFixed(1), soil.sand, soil.clay, soil.hydro.drainage.label) : '',
        bio.threatened.length ? WM.t('• Красная книга рядом: {0}', bio.threatened.map(t => t.name).join(', ')) : ''
      ].filter(Boolean).join('\n');

      navigator.clipboard.writeText(text).then(() => {
        if (WM.ui?.showToast) WM.ui.showToast(WM.t('📋 Полевая сводка скопирована в буфер'));
      });
    });
  }

  // =========================================================================
  // ЗАПУСК И УПРАВЛЕНИЕ МОДАЛЬНЫМ ОКНОМ
  // =========================================================================

  async function runForCoords(lat, lon) {
    const modal = document.getElementById('modal-place-insight');
    const content = document.getElementById('place-insight-content');
    const coordsEl = document.getElementById('place-insight-coords');
    if (!modal || !content) return;

    if (abortController) abortController.abort();
    abortController = new AbortController();
    const signal = abortController.signal;

    if (coordsEl) coordsEl.textContent = `📍 ${lat.toFixed(5)}°, ${lon.toFixed(5)}°`;

    content.innerHTML = `
      <div class="soil-loading-wrap" style="padding: 34px 14px;">
        <div class="lb-spinner" style="width:38px;height:38px;border-width:3px;border-top-color:var(--accent);"></div>
        <div class="soil-loading-text" style="margin-top:14px; font-weight:700;">${WM.t('Экспресс-разведка местности…')}</div>
        <small class="hint-text" style="text-align:center; max-width:320px; line-height:1.4;">
          ${WM.t('Синтез рельефа, типа почвы, водного режима, биоразнообразия и грибного календаря')}
        </small>
      </div>`;

    modal.classList.add('open');
    if (WM.ui?.pushHistoryState) WM.ui.pushHistoryState('placeInsight');

    try {
      const data = await getInsightData(lat, lon, signal);
      if (signal.aborted) return;
      renderInsightModal(data);
    } catch (err) {
      if (signal.aborted) return;
      content.innerHTML = `
        <div class="sheet-empty-state" style="padding:24px 14px;">
          <div class="sheet-empty-icon">⚠️</div>
          <div class="sheet-empty-title">${WM.t('Не удалось получить данные')}</div>
          <div class="sheet-empty-desc">${esc(err.message || WM.t('Проверьте соединение с сетью'))}</div>
          <button type="button" class="btn btn-primary" id="btn-pi-retry" style="margin-top:10px;">${WM.t('↺ Повторить запрос')}</button>
        </div>
      `;
      document.getElementById('btn-pi-retry')?.addEventListener('click', () => runForCoords(lat, lon));
    }
  }

  function open() {
    let lat, lon;
    const pickerMode = WM.picker ? WM.picker.getMode() : 'cross';
    if (pickerMode === 'cross' && WM.map) {
      const c = WM.map.getCenter(); lat = c.lat; lon = c.lng;
    } else if (WM.gpsState && WM.gpsState.lat != null) {
      lat = WM.gpsState.lat; lon = WM.gpsState.lng;
    } else if (WM.map) {
      const c = WM.map.getCenter(); lat = c.lat; lon = c.lng;
    } else {
      lat = 55.75124; lon = 37.61842;
    }
    runForCoords(lat, lon);
  }

  function closeInsightModal(syncHistory = true) {
    if (abortController) { abortController.abort(); abortController = null; }
    const modal = document.getElementById('modal-place-insight');
    if (modal) modal.classList.remove('open');
    if (syncHistory && WM.ui?.clearHistoryState) WM.ui.clearHistoryState('placeInsight');
  }

  function init() {
    const modal = document.getElementById('modal-place-insight');
    if (!modal || modal._inited) return;
    modal._inited = true;

    document.getElementById('place-insight-close-x')?.addEventListener('click', () => closeInsightModal());
    document.getElementById('btn-place-insight-close')?.addEventListener('click', () => closeInsightModal());
    modal.addEventListener('click', (e) => { if (e.target === modal) closeInsightModal(); });
  }

  document.addEventListener('DOMContentLoaded', init);

  WM.placeInsight = {
    init,
    open,
    close: closeInsightModal,
    runForCoords
  };
})();
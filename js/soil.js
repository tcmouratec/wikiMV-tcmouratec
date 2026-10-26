/**
 * Wikimapia Viewer — модуль «Почва и биотоп» (soil.js) v2
 *
 * v3: тип местности определяется по OSM (Overpass) + рельеф + SoilGrids; добавлены биотопы
 *     «Сосняк сфагновый», «Торфяная выработка», «Песчаный карьер», уверенность классификации.
 *
 * Цепочка загрузки данных SoilGrids:
 *  1. WCS через воркер (MapServer GeoTIFF).
 *  2. REST API через воркер (при сбое WCS).
 *  3. Прямой REST API к rest.isric.org без воркера (если оба воркер-запроса не сработали).
 */
(function () {
  'use strict';
  const WM = window.WM = window.WM || {};

  const SOILGRIDS_API = 'https://rest.isric.org/soilgrids/v2.0/properties/query';
  const PROXY = 'https://weather-soil-proxy.sylar1907942.workers.dev/';
  // Вставьте сюда полученный URL из Yandex Cloud Functions:
  const YANDEX_PROXY = 'https://functions.yandexcloud.net/d4e100u26krnn0mkl3ma';
  
  const CACHE_TTL = 30 * 60 * 1000;
  const soilCache = new Map();
  const terrainCache = new Map();
  let abortController = null;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (x, x0, x1, y0, y1) => y0 + (y1 - y0) * clamp((x - x0) / (x1 - x0), 0, 1);
  const r1 = v => Math.round(v * 10) / 10;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
  const sgn = v => (v > 0 ? '+' : '') + v;

  function ensureStyles() {
    if (document.getElementById('gx-shared-style')) return;
    const st = document.createElement('style');
    st.id = 'gx-shared-style';
    st.textContent = `
.gx-bar{height:8px;border-radius:6px;background:var(--bg-primary);border:1px solid var(--border);overflow:hidden}
.gx-bar>i{display:block;height:100%;border-radius:6px;transition:width .5s}
.gx-row{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;margin:5px 0}
.gx-row b{white-space:nowrap}
.gx-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(100px,1fr));gap:6px;margin:8px 0}
.gx-stat{border:1px solid var(--border);border-radius:9px;padding:6px 8px;background:var(--bg-primary)}
.gx-stat small{display:block;color:var(--text-muted);font-size:10.5px;line-height:1.2}
.gx-stat b{font-size:13px;color:var(--text-main)}
.gx-note{font-size:11.5px;line-height:1.45;color:var(--text-muted)}
.gx-insights{margin:10px 0 0;padding:8px 10px;border-radius:9px;border:1px dashed var(--border);background:var(--bg-primary);font-size:12px;line-height:1.5;color:var(--text-main)}
.gx-insights div{margin:3px 0}
.gx-tabs{display:flex;gap:4px;margin:6px 0 8px}
.gx-tab{flex:1;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-main);border-radius:8px;padding:6px 2px;font-size:11.5px;cursor:pointer}
.gx-tab.active{border-color:var(--accent);color:var(--accent);font-weight:700}
.gx-table{width:100%;border-collapse:collapse;font-size:11px;color:var(--text-main)}
.gx-table th,.gx-table td{padding:3px 4px;border-bottom:1px solid var(--border);text-align:right;font-weight:500}
.gx-table th{color:var(--text-muted);font-size:10px}
.gx-table th:first-child,.gx-table td:first-child{text-align:left}
.gx-factor{display:flex;gap:6px;font-size:11.5px;line-height:1.4;margin:3px 0;color:var(--text-main)}
.gx-fpts{font-weight:800;min-width:34px;text-align:right}
.gx-svg{width:100%;height:auto;display:block}
.gx-svg text{fill:var(--text-muted)}
.gx-split{display:flex;gap:10px;align-items:center}
.gx-pill{display:inline-block;font-size:10.5px;font-weight:700;border:1px solid var(--border);border-radius:20px;padding:1px 8px}
.gx-alt{display:flex;align-items:center;gap:8px;font-size:11.5px;margin:4px 0}
.gx-alt .gx-bar{flex:1}
`;
    document.head.appendChild(st);
  }

  const BIOTOPES = [
    {
      id: 'acid_sand_dry', title: WM.t('Сухой кислый бор / Беломошник на песках'),
      soilTypeRu: WM.t('Подзол иллювиально-железистый / Псаммозем песчаный'),
      profile: { ph: 4.6, sand: 75, clay: 6, soc: 60, cn: 24, wet: 0.15, cfvo: 5 },
      description: WM.t('Бедная, лёгкая, быстро дренируемая почва с кислой реакцией и широким C:N. Характерна для сухих сосновых боров, вересковых пустошей и песчаных террас.'),
      trees: [WM.t('Сосна обыкновенная (Pinus sylvestris)'), WM.t('Берёза повислая'), WM.t('Можжевельник')],
      plants: [WM.t('Вереск обыкновенный'), WM.t('Брусника'), WM.t('Толокнянка'), WM.t('Белоус торчащий'), WM.t('Ягель (Cladonia)')],
      fungi: {
        spring: [WM.t('Строчок сосновый (Gyromitra ambigua)'), WM.t('Саркосфера корончатая')],
        summer: [WM.t('Боровик сосновый (Boletus pinophilus)'), WM.t('Маслёнок зернистый'), WM.t('Лисичка настоящая'), WM.t('Сыроежка ломкая')],
        autumn: [WM.t('Белый гриб сосновый'), WM.t('Польский гриб (Imleria badia)'), WM.t('Маслёнок поздний'), WM.t('Зеленушка'), WM.t('Рядовка серая'), WM.t('Моховик жёлто-бурый')],
        winter: [WM.t('Лишайники Cladonia (наземный ягель)'), WM.t('Смолянка сосновая')]
      },
      foragingTip: WM.t('Быстрее всех биотопов прогревается весной и мгновенно откликается на тёплые дожди. Но в жару слой сгорает за 2–3 дня.')
    },
    {
      id: 'pine_loam_mixed', title: WM.t('Сосняк зеленомошно-черничный / Супесчаный смешанный бор'),
      soilTypeRu: WM.t('Дерново-подзолистая супесчаная / Подзол глубокий'),
      profile: { ph: 5.0, sand: 55, clay: 12, soc: 80, cn: 20, wet: 0.4, cfvo: 6 },
      description: WM.t('Средняя по влагообеспеченности почва: достаточно дренажа, чтобы не закисать, и достаточно запаса воды, чтобы слой держался 1–2 недели.'),
      trees: [WM.t('Сосна обыкновенная'), WM.t('Ель'), WM.t('Берёза бородавчатая'), WM.t('Осина')],
      plants: [WM.t('Черника'), WM.t('Брусника'), WM.t('Кукушкин лён'), WM.t('Дикранум'), WM.t('Ортилия однобокая')],
      fungi: {
        spring: [WM.t('Строчок обыкновенный'), WM.t('Шапочка сморчковая')],
        summer: [WM.t('Белый гриб сосновый'), WM.t('Подосиновик'), WM.t('Маслёнок обыкновенный'), WM.t('Лисичка')],
        autumn: [WM.t('Белый гриб'), WM.t('Польский гриб'), WM.t('Маслята'), WM.t('Рыжик сосновый'), WM.t('Груздь настоящий')],
        winter: [WM.t('Зимний опёнок (Flammulina velutipes)')]
      },
      foragingTip: WM.t('Универсальный «грибной» биотоп. Лучшие места — опушки, просеки и склоны с зелёными мхами и черникой.')
    },
    {
      id: 'acid_wet_peat', title: WM.t('Торфяник / Моховое сфагновое верховое болото'),
      soilTypeRu: WM.t('Торфяно-глеевая / Олиготрофная органогенная'),
      profile: { ph: 4.1, sand: 15, clay: 15, soc: 130, cn: 35, wet: 0.95, cfvo: 2 },
      description: WM.t('Сильнокислая переувлажнённая почва с мощным слоем неразложившейся органики. Корням не хватает кислорода, азот связан в недоступных формах.'),
      trees: [WM.t('Берёза пушистая / карликовая'), WM.t('Сосна болотная низкорослая'), WM.t('Ива ушастая')],
      plants: [WM.t('Сфагнум (Sphagnum)'), WM.t('Клюква болотная'), WM.t('Голубика топяная'), WM.t('Багульник болотный'), WM.t('Пушица влагалищная'), WM.t('Росянка')],
      fungi: {
        spring: [WM.t('Мицена болотная'), WM.t('Болетина болотная')],
        summer: [WM.t('Подберёзовик болотный (Leccinum holopus)'), WM.t('Сыроежка болотная'), WM.t('Моховик болотный')],
        autumn: [WM.t('Моховик топяной'), WM.t('Подберёзовик болотный белый'), WM.t('Паутинник болотный'), WM.t('Чага берёзовая (Inonotus obliquus)')],
        winter: [WM.t('Чага берёзовая')]
      },
      foragingTip: WM.t('Главная база ягодников (клюква, голубика). В засуху грибной слой концентрируется по окраинам болот. Идите только по проверенным тропам: зыбун.')
    },
    {
      id: 'alder_fen', title: WM.t('Ольшаник / Низинное травяное болото'),
      soilTypeRu: WM.t('Торфяно-перегнойно-глеевая эутрофная'),
      profile: { ph: 6.0, sand: 20, clay: 22, soc: 120, cn: 17, wet: 0.95, cfvo: 2 },
      description: WM.t('Богатое, но сырое место: проточное грунтовое увлажнение, мягкий торф, высокая биологическая активность. Грибы растут по кочкам.'),
      trees: [WM.t('Ольха чёрная (Alnus glutinosa)'), WM.t('Берёза пушистая'), WM.t('Ива пепельная'), WM.t('Черёмуха')],
      plants: [WM.t('Таволга вязолистная'), WM.t('Осока острая'), WM.t('Кочедыжник женский'), WM.t('Крапива двудомная'), WM.t('Подмаренник болотный')],
      fungi: {
        spring: [WM.t('Дисцина щитовидная'), WM.t('Стробилюрус сочный')],
        summer: [WM.t('Подберёзовик болотный'), WM.t('Сыроежка жёлтая'), WM.t('Подгруздок белый')],
        autumn: [WM.t('Опёнок осенний'), WM.t('Вешенка'), WM.t('Чешуйчатка золотистая')],
        winter: [WM.t('Вешенка обыкновенная'), WM.t('Фламмулина')]
      },
      foragingTip: WM.t('В жару здесь сохраняется влага, но сборы идут по кочкам и валежу. Нужны высокие сапоги.')
    },
    {
      id: 'acid_loam_mesic', title: WM.t('Ельник-зеленомошник / Смешанный суглинистый лес'),
      soilTypeRu: WM.t('Дерново-подзолистая тяжелосуглинистая'),
      profile: { ph: 5.2, sand: 32, clay: 28, soc: 85, cn: 18, wet: 0.5, cfvo: 5 },
      description: WM.t('Умеренно кислая, влагоёмкая и богатая минералами почва. Оптимальна для еловых и берёзово-еловых ассоциаций со стабильным водным режимом.'),
      trees: [WM.t('Ель европейская (Picea abies)'), WM.t('Берёза бородавчатая'), WM.t('Осина')],
      plants: [WM.t('Черника'), WM.t('Кислица обыкновенная'), WM.t('Майник двулистный'), WM.t('Щитовник мужской'), WM.t('Плаун годичный')],
      fungi: {
        spring: [WM.t('Строчок обыкновенный (Gyromitra esculenta)')],
        summer: [WM.t('Белый гриб еловый (Boletus edulis)'), WM.t('Подосиновик красный'), WM.t('Лисичка трубчатая'), WM.t('Сыроежка зелёная')],
        autumn: [WM.t('Белый гриб еловый'), WM.t('Груздь настоящий / чёрный'), WM.t('Рыжик еловый'), WM.t('Опёнок осенний'), WM.t('Волнушка розовая')],
        winter: [WM.t('Зимний опёнок (Flammulina velutipes)'), WM.t('Вешенка оранжевая')]
      },
      foragingTip: WM.t('Классический биотоп еловых белых и груздей. Долго удерживает влагу: даже через 10–12 дней после дождей сохраняется плодоношение.')
    },
    {
      id: 'neutral_rich_loam', title: WM.t('Широколиственная дубрава / Богатый смешанный лес'),
      soilTypeRu: WM.t('Серая лесная / Дерново-карбонатная оподзоленная'),
      profile: { ph: 6.4, sand: 38, clay: 24, soc: 90, cn: 13, wet: 0.45, cfvo: 4 },
      description: WM.t('Оптимальная нейтральная почва с высоким содержанием гумуса, подвижного азота и кальция и сбалансированной микрофлорой.'),
      trees: [WM.t('Дуб черешчатый (Quercus robur)'), WM.t('Липа мелколистная'), WM.t('Клён остролистный'), WM.t('Лещина')],
      plants: [WM.t('Медуница неясная'), WM.t('Сныть обыкновенная'), WM.t('Копытень европейский'), WM.t('Ландыш майский'), WM.t('Вороний глаз')],
      fungi: {
        spring: [WM.t('Сморчок деликатесный / конический'), WM.t('Шапочка сморчковая'), WM.t('Саркосцифа алая')],
        summer: [WM.t('Дубовик оливково-бурый'), WM.t('Белый гриб дубовый (Boletus reticulatus)'), WM.t('Полубелый гриб'), WM.t('Грабовик')],
        autumn: [WM.t('Боровик сетчатый'), WM.t('Дубовик крапчатый'), WM.t('Печёночница обыкновенная'), WM.t('Рядовка фиолетовая'), WM.t('Зонтик пёстрый')],
        winter: [WM.t('Трутовик лакированный (Рейши)'), WM.t('Аурикулярия уховидная')]
      },
      foragingTip: WM.t('Максимальное биоразнообразие микоризы: весной ищите сморчки по оврагам, а в августе–сентябре — мясистые дубовики и сетчатые белые.')
    },
    {
      id: 'alkaline_limestone', title: WM.t('Известняковые склоны / Карбонатный биотоп'),
      soilTypeRu: WM.t('Рендзина / Перегнойно-карбонатная щелочная'),
      profile: { ph: 7.7, sand: 40, clay: 20, soc: 60, cn: 12, wet: 0.3, cfvo: 18 },
      description: WM.t('Щелочная почва с обилием свободного кальция на известняковых или мергелистых плитах.'),
      trees: [WM.t('Ясень обыкновенный'), WM.t('Вяз шершавый'), WM.t('Граб'), WM.t('Дикая яблоня')],
      plants: [WM.t('Венерин башмачок'), WM.t('Мать-и-мачеха'), WM.t('Шалфей мутовчатый'), WM.t('Солнцецвет'), WM.t('Орхидные кальцефилы')],
      fungi: {
        spring: [WM.t('Сморчок степной / высокий (Morchella elata)')],
        summer: [WM.t('Шампиньон полевой'), WM.t('Сатанинский гриб (Rubroboletus satanas)'), WM.t('Сыроежка золотистая')],
        autumn: [WM.t('Рядовка тополевая'), WM.t('Шампиньон лесной'), WM.t('Паутинник триумфальный'), WM.t('Геоглоссум')],
        winter: [WM.t('Трутовик настоящий')]
      },
      foragingTip: WM.t('Кальцефильный биотоп. Осторожно: летом здесь часто встречается ядовитый сатанинский гриб и ложные дубовики.')
    },
    {
      id: 'heavy_clay_wet', title: WM.t('Пойменная глина / Низинный влажный сырой лес'),
      soilTypeRu: WM.t('Аллювиально-луговая тяжелоглинистая / Глеевая'),
      profile: { ph: 6.2, sand: 18, clay: 48, soc: 80, cn: 14, wet: 0.8, cfvo: 2 },
      description: WM.t('Тяжёлая, липкая и холодная глина. Медленно прогревается, склонна к заболачиванию и образованию плотной корки.'),
      trees: [WM.t('Ольха чёрная'), WM.t('Тополь белый'), WM.t('Ива ломкая'), WM.t('Черёмуха')],
      plants: [WM.t('Калужница болотная'), WM.t('Таволга вязолистная (лабазник)'), WM.t('Хвощ топяной'), WM.t('Осока острая'), WM.t('Ирис аировидный')],
      fungi: {
        spring: [WM.t('Стробилюрус сочный'), WM.t('Дисцина щитовидная')],
        summer: [WM.t('Подгруздок белый'), WM.t('Сыроежка жёлтая'), WM.t('Псатирелла водолюбивая')],
        autumn: [WM.t('Опёнок осенний северный'), WM.t('Трутовик чешуйчатый'), WM.t('Чешуйчатка золотистая'), WM.t('Вешенка')],
        winter: [WM.t('Вешенка обыкновенная (Pleurotus ostreatus)'), WM.t('Фламмулина')]
      },
      foragingTip: WM.t('В засушливое лето это спасательный круг грибника — влага удерживается, даже когда верхние боры скрипят от суши.')
    },
    {
      id: 'meadow_chernozem', title: WM.t('Лугостепь / Опушки и поля на гумусных почвах'),
      soilTypeRu: WM.t('Чернозём выщелоченный / Лугово-чернозёмная'),
      profile: { ph: 6.9, sand: 30, clay: 28, soc: 90, cn: 11, wet: 0.35, cfvo: 3 },
      description: WM.t('Плодородная, богатая гумусом нейтральная почва открытых участков: лугов, степных балок, опушек и залежей.'),
      trees: [WM.t('Дуб (на опушках)'), WM.t('Яблоня дикая'), WM.t('Боярышник'), WM.t('Шиповник')],
      plants: [WM.t('Клевер луговой'), WM.t('Шалфей луговой'), WM.t('Тимофеевка'), WM.t('Василёк'), WM.t('Ковыль (степные участки)')],
      fungi: {
        spring: [WM.t('Сморчок степной'), WM.t('Весенний гриб-зонтик')],
        summer: [WM.t('Шампиньон полевой'), WM.t('Опёнок луговой'), WM.t('Дождевик гигантский')],
        autumn: [WM.t('Зонтик пёстрый'), WM.t('Рядовка'), WM.t('Дождевики'), WM.t('Лугового опёнка «ведьмины кольца»')],
        winter: []
      },
      foragingTip: WM.t('Грибы идут «кольцами» на лугах после тёплых дождей. Хороши шампиньоны и зонтики; проверяйте места: рядом с дорогами и полями возможны химикаты.')
    },
    {
      id: 'rocky_slope', title: WM.t('Каменистый склон / Щебнистый бор'),
      soilTypeRu: WM.t('Щебнистая дерново-подзолистая / Литозём'),
      profile: { ph: 5.6, sand: 45, clay: 12, soc: 45, cn: 20, wet: 0.2, cfvo: 40 },
      description: WM.t('Мелкозём с большим количеством камней: быстро дренируется, но в каменистых «карманах» держит влагу и прогревается.'),
      trees: [WM.t('Сосна'), WM.t('Берёза'), WM.t('Рябина'), WM.t('Ель (на тенистых склонах)')],
      plants: [WM.t('Брусника'), WM.t('Овсяница овечья'), WM.t('Чабрец'), WM.t('Костяника'), WM.t('Лишайники')],
      fungi: {
        spring: [WM.t('Строчок обыкновенный')],
        summer: [WM.t('Боровик'), WM.t('Лисичка'), WM.t('Сыроежка')],
        autumn: [WM.t('Белый гриб'), WM.t('Рядовка'), WM.t('Маслёнок')],
        winter: [WM.t('Лишайники')]
      },
      foragingTip: WM.t('Грибы жмутся к нижней части склонов и к карманам мелкозёма. На гребнях слой появляется только после затяжных дождей.')
    },
    {
      id: 'pine_sphagnum', title: WM.t('Сосняк сфагновый / Заболоченный сосновый лес'),
      soilTypeRu: WM.t('Торфяно-подзолисто-глеевая / Торфянисто-глеевая'),
      profile: { ph: 4.5, sand: 40, clay: 15, soc: 110, cn: 28, wet: 0.8, cfvo: 3 },
      description: WM.t('Переходная зона между сухим бором и верховым болотом: сосна растёт на кочках, подстилка — сфагново-кустарничковая, уровень грунтовых вод держится в 20–40 см от поверхности.'),
      trees: [WM.t('Сосна обыкновенная (болотная форма)'), WM.t('Берёза пушистая'), WM.t('Ель (в понижениях)')],
      plants: [WM.t('Сфагнум'), WM.t('Багульник болотный'), WM.t('Голубика'), WM.t('Клюква'), WM.t('Подбел'), WM.t('Пушица'), WM.t('Черника (на кочках)')],
      fungi: {
        spring: [WM.t('Строчок обыкновенный (на сухих гривах)')],
        summer: [WM.t('Подберёзовик болотный'), WM.t('Моховик болотный'), WM.t('Сыроежка болотная')],
        autumn: [WM.t('Моховик зелёный'), WM.t('Маслёнок болотный (Suillus flavidus)'), WM.t('Польский гриб (на гривах)'), WM.t('Паутинник болотный'), WM.t('Горькушка')],
        winter: [WM.t('Чага берёзовая')]
      },
      foragingTip: WM.t('Грибы — на сухих гривах и кочках у основания сосен, ягоды (клюква, голубика) — в мочажинах. Идите по краю, не выходя на открытый сфагновый ковёр.')
    },
    {
      id: 'peat_cutting', title: WM.t('Торфяная выработка / Карты и обводнённые торфяные карьеры'),
      soilTypeRu: WM.t('Торфяная остаточная / Постпирогенная органогенная'),
      profile: { ph: 5.2, sand: 30, clay: 20, soc: 80, cn: 22, wet: 0.7, cfvo: 3 },
      description: WM.t('Бывшие торфоразработки: прямоугольные карты, канавы и валы, местами обводнённые, местами сухие. Верхний слой торфа снят или перемешан, поэтому почва молодая, неоднородная, зарастает берёзой, ивой, иван-чаем и тростником.'),
      trees: [WM.t('Берёза повислая и пушистая (самосев)'), WM.t('Ива козья / пепельная'), WM.t('Сосна (подрост на валах)'), WM.t('Осина')],
      plants: [WM.t('Иван-чай'), WM.t('Пушица'), WM.t('Тростник'), WM.t('Хвощ'), WM.t('Подорожник'), WM.t('Мать-и-мачеха'), WM.t('Сабельник'), WM.t('Ситник')],
      fungi: {
        spring: [WM.t('Строчок (на сухих валах)'), WM.t('Сморчковая шапочка по гарям')],
        summer: [WM.t('Подберёзовик обыкновенный (под молодой берёзой)'), WM.t('Сыроежки'), WM.t('Маслёнок обыкновенный')],
        autumn: [WM.t('Подберёзовики'), WM.t('Подосиновик (под осиной)'), WM.t('Козляк'), WM.t('Моховик'), WM.t('Опёнок осенний (на пнях)')],
        winter: [WM.t('Чага берёзовая')]
      },
      foragingTip: WM.t('Грибы идут по валам и бровкам между картами, под молодой берёзой и осиной. Осторожно: обводнённые карты глубокие, берега торфа обрываются, а выработки склонны к торфяным пожарам.')
    },
    {
      id: 'sand_quarry', title: WM.t('Песчаный карьер / Пионерные заросли на песках'),
      soilTypeRu: WM.t('Псаммозём первичный / Карьерно-отвальный (молодая почва)'),
      profile: { ph: 5.8, sand: 85, clay: 6, soc: 15, cn: 25, wet: 0.1, cfvo: 8 },
      description: WM.t('Вскрытый или недавно рекультивированный песок. Гумусового горизонта почти нет, вода уходит мгновенно. На отвалах — пионерная растительность, молодые сосновые посадки и берёзовый самосев, по днищу карьера обычно есть обводнённые понижения.'),
      trees: [WM.t('Сосна обыкновенная (посадки, самосев)'), WM.t('Берёза повислая'), WM.t('Ива'), WM.t('Осина (по краям)')],
      plants: [WM.t('Овсяница овечья'), WM.t('Тимофеевка степная'), WM.t('Пижма'), WM.t('Мать-и-мачеха'), WM.t('Козлятник'), WM.t('Чабрец'), WM.t('Ястребинка'), WM.t('Лишайники Cladonia')],
      fungi: {
        spring: [WM.t('Строчок (под молодыми соснами)')],
        summer: [WM.t('Маслёнок поздний (под молодой сосной)'), WM.t('Лисичка'), WM.t('Сыроежки')],
        autumn: [WM.t('Маслята'), WM.t('Болетус зернистый'), WM.t('Рядовка серая и жёлто-бурая'), WM.t('Моховик'), WM.t('Зеленушка')],
        winter: []
      },
      foragingTip: WM.t('Грибы — только под посадками сосны старше 8–10 лет, у стенок карьера и вдоль дорог. На голом песке плодоношения нет. Берегитесь осыпающихся откосов и глубоких обводнённых карьеров.')
    }
  ];

  const SEASON_PRIOR = [0, 0.05, 0.05, 0.15, 0.3, 0.45, 0.6, 0.8, 1.0, 1.0, 0.85, 0.3, 0.08];
  const SEASONS = [['spring', WM.t('🌸 Весна')], ['summer', WM.t('☀️ Лето')], ['autumn', WM.t('🍂 Осень')], ['winter', WM.t('❄️ Зима')]];
  const MONTHS_PREP = ['', WM.t('январе'), WM.t('феврале'), WM.t('марте'), WM.t('апреле'), WM.t('мае'), WM.t('июне'), WM.t('июле'), WM.t('августе'), WM.t('сентябре'), WM.t('октябре'), WM.t('ноябре'), WM.t('декабре')];

  function seasonOfMonth(m) {
    if (m >= 3 && m <= 5) return 'spring';
    if (m >= 6 && m <= 8) return 'summer';
    if (m >= 9 && m <= 11) return 'autumn';
    return 'winter';
  }

  // =========================================================================
  // СЕТЬ И ДИАГНОСТИКА
  // =========================================================================
  const debugTraceLog = [];

  function logTrace(item) {
    debugTraceLog.unshift({
      time: new Date().toLocaleTimeString(),
      ...item
    });
    if (debugTraceLog.length > 25) debugTraceLog.pop();
  }

  async function fetchJson(url, timeoutMs, outer, channelName = 'Direct') {
    const ctl = new AbortController();
    const t0 = performance.now();
    let timedOut = false;

    const onAbort = () => ctl.abort();
    if (outer) {
      if (outer.aborted) throw new DOMException('Aborted', 'AbortError');
      outer.addEventListener('abort', onAbort, { once: true });
    }

    const tm = setTimeout(() => {
      timedOut = true;
      ctl.abort();
    }, timeoutMs);

    try {
      const res = await fetch(url, { signal: ctl.signal });
      const elapsed = Math.round(performance.now() - t0);
      const text = await res.text();

      if (!res.ok) {
        logTrace({
          channel: channelName,
          url,
          status: `HTTP ${res.status}`,
          ok: false,
          ms: elapsed,
          error: text.slice(0, 120)
        });
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 80)}`);
      }

      let json = JSON.parse(text);
      if (json && typeof json.contents === 'string') json = JSON.parse(json.contents);

      logTrace({
        channel: channelName,
        url,
        status: '200 OK',
        ok: true,
        ms: elapsed,
        error: null
      });
      return json;
    } catch (err) {
      const elapsed = Math.round(performance.now() - t0);
      const isAbort = err.name === 'AbortError' || err instanceof DOMException;
      const statusText = timedOut
        ? WM.t('⏱️ Таймаут (> {0} сек)', timeoutMs / 1000)
        : (isAbort ? WM.t('⏹️ Отменён') : `❌ ${err.message || WM.t('Ошибка CORS / сети')}`);

      logTrace({
        channel: channelName,
        url,
        status: statusText,
        ok: false,
        ms: elapsed,
        error: err.message
      });
      throw err;
    } finally {
      clearTimeout(tm);
      if (outer) outer.removeEventListener('abort', onAbort);
    }
  }

  async function fetchWithFallback(url, timeoutMs = 6000, signal, reqName = 'Meteo/Elevation') {
    try {
      return await fetchJson(url, timeoutMs, signal, `${reqName} (Direct)`);
    } catch (e) {
      if (signal && signal.aborted) throw e;
    }
    const enc = encodeURIComponent(url);

    // Первым делом пробуем наши надёжные прокси (Cloudflare + Yandex параллельно через Promise.any)
    try {
      const privateProxies = [
        fetchJson(PROXY + '?url=' + enc, timeoutMs, signal, `${reqName} (CF Worker)`)
      ];
      if (YANDEX_PROXY && !YANDEX_PROXY.includes('YOUR_FUNCTION_ID')) {
        privateProxies.push(
          fetchJson(YANDEX_PROXY + '?url=' + enc, timeoutMs, signal, `${reqName} (Yandex Function)`)
        );
      }
      return await Promise.any(privateProxies);
    } catch (e) {
      if (signal && signal.aborted) throw e;
    }

    // Если оба наших сервера недоступны — запасные публичные CORS-прокси
    return await Promise.any([
      fetchJson('https://allorigins.hexlet.app/raw?url=' + enc, timeoutMs, signal, `${reqName} (AllOrigins)`),
      fetchJson('https://api.codetabs.com/v1/proxy?quest=' + enc, timeoutMs, signal, `${reqName} (CodeTabs)`)
    ]);
  }



  function renderDebugAccordion() {
    if (!debugTraceLog.length) return '';
    // Показываем последние 20 записей вместо 8, чтобы не терять быстрые запросы OSM
    const rows = debugTraceLog.slice(0, 20).map(tr => {
      const col = tr.ok ? '#16a34a' : '#ef4444';
      return `
        <div style="padding:5px 0; border-bottom:1px solid var(--border); font-size:11px;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <b>${esc(tr.channel)}</b>
            <span style="color:${col}; font-weight:700;">${WM.t('{0} ({1} мс)', esc(tr.status), tr.ms)}</span>
          </div>
          <div style="margin-top:2px; word-break:break-all; font-family:monospace; font-size:10px;">
            <a href="${esc(tr.url)}" target="_blank" rel="noopener" style="color:var(--accent); text-decoration:underline;">${WM.t('🔗 Открыть URL запроса в новой вкладке ↗')}</a>
          </div>
          ${tr.error ? `<div style="color:#ef4444; font-size:10px; margin-top:2px;">⚠️ ${esc(tr.error)}</div>` : ''}
        </div>`;
    }).join('');

    return `
      <details style="margin-top:12px; border:1px dashed var(--border); border-radius:9px; padding:6px 10px; background:var(--bg-primary);">
        <summary style="cursor:pointer; font-weight:700; font-size:11.5px; color:var(--text-muted); user-select:none;">
          ${WM.t('🐞 Журнал сетевых запросов (Debug Log: последние {0})', Math.min(debugTraceLog.length, 20))}
        </summary>
        <div style="margin-top:8px;">${rows}</div>
      </details>
    `;
  }

  function renderRawDataAccordion(ctx) {
    if (!ctx) return '';
    const safePayload = {
      timestamp: new Date().toISOString(),
      coordinates: { lat: ctx.lat, lon: ctx.lon },
      soilGrids: ctx.soil || null,
      agroMeteo: ctx.agro || null,
      terrainDEM: ctx.terrain || null,
      osmLandCover: ctx.lc || null
    };

    const jsonStr = JSON.stringify(safePayload, null, 2);

    return `
      <details style="margin-top:8px; border:1px dashed var(--border); border-radius:9px; padding:6px 10px; background:var(--bg-primary);">
        <summary style="cursor:pointer; font-weight:700; font-size:11.5px; color:var(--text-muted); user-select:none; display:flex; justify-content:space-between; align-items:center;">
          <span>${WM.t('📦 Исходные сырые данные (Raw JSON: SoilGrids, Метео, Рельеф, OSM)')}</span>
        </summary>
        <div style="margin-top:8px; display:flex; flex-direction:column; gap:6px;">
          <div style="display:flex; justify-content:flex-end;">
            <button type="button" class="btn btn-secondary" id="btn-soil-copy-raw-json" style="font-size:11px; padding:4px 10px;">
              ${WM.t('📋 Скопировать сырой JSON')}
            </button>
          </div>
          <pre id="soil-raw-json-pre" style="max-height:240px; overflow:auto; background:var(--bg-secondary); border:1px solid var(--border); border-radius:6px; padding:8px; font-family:monospace; font-size:10.5px; line-height:1.35; user-select:text; margin:0; white-space:pre-wrap; word-break:break-word;">${esc(jsonStr)}</pre>
        </div>
      </details>
    `;
  }

  // =========================================================================
  // ПОЧВА: ISRIC SoilGrids 2.0 (WCS -> Worker REST -> Direct REST)
  // =========================================================================
  const SG_DEPTHS = ['0-5cm', '5-15cm', '15-30cm', '30-60cm'];
  const SG_LABELS = ['0–5', '5–15', '15–30', '30–60'];
  const SG_W = [5, 10, 15, 30];
  const SG_CONV = {
    phh2o: v => v / 10, sand: v => v / 10, clay: v => v / 10, silt: v => v / 10,
    soc: v => v / 10, nitrogen: v => v / 100, cec: v => v / 10, cfvo: v => v / 10, bdod: v => v / 100
  };

  function computeHydroProps(sandPct, clayPct, socGkg, bdodVal, orgIdx) {
    const S = clamp(sandPct / 100, 0.01, 0.98);
    const C = clamp(clayPct / 100, 0.01, 0.8);
    const OM = clamp(socGkg * 1.724 / 10, 0.1, 8);

    // 1. Минеральная часть (Saxton & Rawls 2006)
    const t1500t = -0.024 * S + 0.487 * C + 0.006 * OM + 0.005 * S * OM - 0.013 * C * OM + 0.068 * S * C + 0.031;
    let pwp = t1500t + (0.14 * t1500t - 0.02);
    const t33t = -0.251 * S + 0.195 * C + 0.011 * OM + 0.006 * S * OM - 0.027 * C * OM + 0.452 * S * C + 0.299;
    let fc = t33t + (1.283 * t33t * t33t - 0.374 * t33t - 0.015);
    const tS33t = 0.278 * S + 0.034 * C + 0.022 * OM - 0.018 * S * OM - 0.027 * C * OM - 0.584 * S * C + 0.078;
    const tS33 = tS33t + (0.636 * tS33t - 0.107);
    pwp = Math.max(0.02, pwp);
    fc = Math.max(pwp + 0.04, fc);

    let ths;
    if (bdodVal && bdodVal > 0.3 && bdodVal < 2.2) ths = clamp(1 - (bdodVal / 2.65), fc + 0.03, 0.9);
    else ths = clamp(fc + tS33 - 0.097 * S + 0.043, fc + 0.05, 0.62);

    const B = (Math.log(1500) - Math.log(33)) / (Math.log(fc) - Math.log(pwp));
    const lam = 1 / B;
    let ks = clamp(1930 * Math.pow(Math.max(0.001, ths - fc), 3 - lam), 0.1, 300);

    // 2. Органическая часть: плавное смешивание с торфом (раньше был жёсткий порог SOC ≥ 120)
    const f = orgIdx != null ? clamp(orgIdx, 0, 1) : clamp((socGkg - 60) / 120, 0, 1);
    if (f > 0) {
      const peat = { ths: 0.86, fc: 0.58, pwp: 0.22, ks: 12 };
      ths = ths * (1 - f) + peat.ths * f;
      fc = fc * (1 - f) + peat.fc * f;
      pwp = pwp * (1 - f) + peat.pwp * f;
      ks = Math.exp(Math.log(ks) * (1 - f) + Math.log(peat.ks) * f);
    }
    ths = Math.max(ths, fc + 0.03);

    let drainage;
    if (ks < 2.5) drainage = { label: WM.t('Плохо дренируемая'), tone: '#ef4444', note: WM.t('вода застаивается, лужи и колеи держатся долго') };
    else if (ks < 10) drainage = { label: WM.t('Медленный дренаж'), tone: '#f97316', note: WM.t('после дождей долго сыро') };
    else if (ks < 40) drainage = { label: WM.t('Хороший дренаж'), tone: '#16a34a', note: WM.t('избыток воды уходит за 1–2 суток') };
    else drainage = { label: WM.t('Очень быстрый дренаж'), tone: '#0284c7', note: WM.t('вода уходит почти мгновенно, почва быстро сохнет') };

    return {
      thetaS: Math.round(ths * 100) / 100, fc: Math.round(fc * 100) / 100, pwp: Math.round(pwp * 100) / 100,
      awc: Math.round((fc - pwp) * 100) / 100, ks: r1(ks), drainage
    };
  }


  function buildSoilGridsUrl(lat, lon) {
    const params = new URLSearchParams();
    params.set('lat', lat.toFixed(5));
    params.set('lon', lon.toFixed(5));
    Object.keys(SG_CONV).forEach(p => params.append('property', p));
    SG_DEPTHS.forEach(d => params.append('depth', d));
    params.append('value', 'mean');
    return `${SOILGRIDS_API}?${params.toString()}`;
  }

  // Загрузка SoilGrids по цепочке: WCS (воркер) -> REST (воркер) -> REST напрямую
  let isricOutageUntil = 0; // Временная метка блокировки при падении серверов ISRIC

  async function fetchSoilGridsRaw(lat, lon, signal) {
    // 1. Проверяем предохранитель: если сервер лежал недавно, не мучаем пользователя
    const now = Date.now();
    if (now < isricOutageUntil) {
      const waitSec = Math.ceil((isricOutageUntil - now) / 1000);
      logTrace({
        channel: 'SoilGrids (CircuitBreaker)',
        url: 'rest.isric.org',
        status: WM.t('⏸️ Пропуск (сервер ISRIC недоступен ещё {0} с)', waitSec),
        ok: false,
        ms: 0,
        error: WM.t('Кластер SoilGrids не отвечает. Запросы временно приостановлены.')
      });
      throw new Error(WM.t('Кластер ISRIC SoilGrids временно недоступен (сбой на стороне Нидерландов)'));
    }

    // 2. Ставим жёсткий общий лимит на ВСЮ цепочку (максимум 9 секунд на всё про всё!)
    const totalCapCtl = new AbortController();
    const totalCapTimer = setTimeout(() => totalCapCtl.abort(), 12000);
    const onOuterAbort = () => totalCapCtl.abort();
    if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });

    const stepSignal = totalCapCtl.signal;
    let json = null;
    let fatalServerOutage = false;

    console.groupCollapsed(`[SoilGrids Chain] Запрос профиля [${lat.toFixed(4)}, ${lon.toFixed(4)}]`);

    try {
      // ШАГ 1: WCS через Cloudflare Worker (таймаут 3.5 с)
      try {
        const wcsUrl = `${PROXY}?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&force=wcs`;
        // Даём WCS честные 8.5 секунд — он успеет вернуть данные даже при дневной нагрузке ISRIC
        json = await fetchJson(wcsUrl, 8500, stepSignal, 'SoilGrids (CF Worker WCS)');
      } catch (e) {
        if (stepSignal.aborted && signal?.aborted) throw e;
        // Если ошибка 502/503/504 — сервер ISRIC наглухо мёртв
        if (/502|503|504/.test(e.message)) fatalServerOutage = true;
      }

      // ШАГ 2: Резерв Yandex Cloud Function (таймаут 4 с) — если не фатальный сбой серверов ISRIC
      if (!fatalServerOutage && (!json?.properties?.layers?.length) && YANDEX_PROXY && !YANDEX_PROXY.includes('YOUR_FUNCTION_ID')) {
        try {
          const yandexUrl = `${YANDEX_PROXY}?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`;
          json = await fetchJson(yandexUrl, 4000, stepSignal, 'SoilGrids (Yandex Function)');
        } catch (e) {
          if (stepSignal.aborted && signal?.aborted) throw e;
          if (/502|503|504/.test(e.message)) fatalServerOutage = true;
        }
      }

      // ШАГ 3: REST API через CF Worker (таймаут 4 с)
      if (!fatalServerOutage && (!json?.properties?.layers?.length)) {
        try {
          const restWorkerUrl = `${PROXY}?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&force=rest`;
          json = await fetchJson(restWorkerUrl, 4000, stepSignal, 'SoilGrids (CF Worker REST)');
        } catch (e) {
          if (stepSignal.aborted && signal?.aborted) throw e;
          if (/502|503|504/.test(e.message)) fatalServerOutage = true;
        }
      }

      // ШАГ 4: Прямой REST к rest.isric.org (только если живы и осталось время)
      if (!fatalServerOutage && (!json?.properties?.layers?.length)) {
        try {
          const directUrl = buildSoilGridsUrl(lat, lon);
          json = await fetchJson(directUrl, 4500, stepSignal, 'SoilGrids (ISRIC Direct REST)');
        } catch (e) {
          if (stepSignal.aborted && signal?.aborted) throw e;
          if (/502|503|504/.test(e.message)) fatalServerOutage = true;
        }
      }
    } finally {
      clearTimeout(totalCapTimer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
      console.groupEnd();
    }

    // Если был зафиксирован фатальный сбой серверов ISRIC или таймаут по общему лимиту:
    const layers = json?.properties?.layers;
    if (!layers || !layers.length) {
      // Активируем предохранитель на 3 минуты, чтобы следующие клики были мгновенными
      isricOutageUntil = Date.now() + 25 * 1000;
      throw new Error(WM.t('Серверы ISRIC SoilGrids не отвечают (таймаут или ошибка кластера)'));
    }

    // Сброс предохранителя при успехе
    isricOutageUntil = 0;

    const get = (name, label) => {
      const l = layers.find(x => x.name === name);
      const d = l && l.depths && l.depths.find(x => x.label === label);
      const v = d && d.values ? d.values.mean : null;
      return v == null ? null : SG_CONV[name](v);
    };

    return SG_DEPTHS.map((d, i) => {
      const o = { label: SG_LABELS[i] };
      Object.keys(SG_CONV).forEach(k => { o[k] = get(k, d); });
      return o;
    });
  }

  function buildSoil(profile) {
    if (!profile) return null;
    const wavg = (k, n) => {
      let s = 0, w = 0;
      for (let i = 0; i < n; i++) {
        if (profile[i][k] != null) { s += profile[i][k] * SG_W[i]; w += SG_W[i]; }
      }
      return w ? s / w : null;
    };

    const top = k => (profile[0][k] != null ? profile[0][k] : profile[1][k]);
    const deep = k => (profile[2][k] != null ? profile[2][k] : profile[1][k]);

    const ph = top('phh2o');
    const sandRaw = wavg('sand', 3);
    const clayRaw = wavg('clay', 3);

    if (ph == null && sandRaw == null && clayRaw == null) return null;

    const sand = Math.round(sandRaw ?? 40);
    const clay = Math.round(clayRaw ?? 20);
    let silt = wavg('silt', 3);
    silt = Math.round(silt != null ? silt : Math.max(0, 100 - sand - clay));

    // SOC по горизонтам: подстилка (0-5), средний (5-15), корнеобитаемый (15-30)
    const socTop = Math.round(top('soc') ?? 30);
    const socMid = Math.round(profile[1].soc ?? socTop);
    const socDeep = Math.round(deep('soc') ?? 20);
    const socRoot = Math.round(wavg('soc', 3) ?? socTop);
    // Индекс «органичности» 0..1: SoilGrids на лесных и торфяных почвах Нечерноземья даёт
    // сходные значения, поэтому он используется только как мягкий признак, а не как «детектор болота».
    const orgIndex = clamp((socTop * 0.3 + socMid * 0.4 + socDeep * 0.3 - 50) / 100, 0, 1);

    const nitrogen = r1(top('nitrogen') ?? 2.0);
    const cec = r1(top('cec') ?? wavg('cec', 3) ?? 15);
    const cfvo = r1(wavg('cfvo', 3) ?? 4);

    // Плотность сложения (вверху и на глубине)
    const bdodTop = r1(top('bdod') ?? 1.1);
    const bdodDeep = r1(deep('bdod') ?? 1.3);

    const phSub = profile[1]?.phh2o != null ? profile[1].phh2o : (profile[2]?.phh2o ?? ph);
    // C:N. Азот SoilGrids в органике сильно завышен (даёт C:N ≈ 8–10 даже у торфа), поэтому
    // сначала считаем «сырое» значение, а при нереалистично узком C:N на органогенной почве
    // заменяем его эмпирической оценкой по SOC и pH.
    const cnRaw = (nitrogen > 0 && socTop > 0) ? r1(socTop / nitrogen) : null;
    let cn = cnRaw, cnEstimated = false;
    if (cnRaw == null || (cnRaw < 13 && socRoot >= 50)) {
      cn = r1(clamp(13 + socRoot * 0.12 - (ph - 5.0) * 3, 10, 38));
      cnEstimated = true;
    }

    // Дифференциация глины по глубине (вымывание / оподзоливание)
    const clayTop = profile[0]?.clay ?? clay;
    const clayDeep = profile[2]?.clay ?? profile[1]?.clay ?? clay;
    const clayDiff = Math.round(clayDeep - clayTop);

    return {
      ph: r1(ph), phSub: r1(phSub), phDiff: r1(phSub - ph),
      sand, clay, silt,
      soc: socTop, socMid, socDeep, socRoot, orgIndex,
      nitrogen, cn, cnRaw, cnEstimated, cec, cfvo,
      bdod: bdodTop, bdodDeep,
      clayDiff,
      profile,
      hydro: computeHydroProps(sand, clay, socRoot, bdodDeep, orgIndex)
    };
  }

  async function getSoilGrids(lat, lon, signal) {
    const key = `${lat.toFixed(3)}_${lon.toFixed(3)}`;
    const hit = soilCache.get(key);
    if (hit && Date.now() - hit.t < 24 * 3600 * 1000) return hit.data;
    const data = buildSoil(await fetchSoilGridsRaw(lat, lon, signal));
    soilCache.set(key, { t: Date.now(), data });
    return data;
  }

  // =========================================================================
  // РЕЛЬЕФ
  // =========================================================================
  function aspectInfo(deg) {
    if (deg == null) return { name: WM.t('Равнинный плакор'), icon: '🟢', note: WM.t('Плоский рельеф: влага распределяется равномерно, без выраженного стока.') };
    if (deg >= 337.5 || deg < 22.5) return { name: WM.t('Северный склон (С)'), icon: '❄️', note: WM.t('Меньше всего солнца. Весной прогревается позже, но летом сохраняет прохладу и влагу.') };
    if (deg < 67.5) return { name: WM.t('Северо-восточный склон (СВ)'), icon: '🌤️', note: WM.t('Мягкое утреннее солнце, устойчивая влажность.') };
    if (deg < 112.5) return { name: WM.t('Восточный склон (В)'), icon: '🌅', note: WM.t('Прогрев первыми лучами, раннее испарение росы.') };
    if (deg < 157.5) return { name: WM.t('Юго-восточный склон (ЮВ)'), icon: '☀️', note: WM.t('Хорошо прогреваемый склон. Весенний старт на 5–7 дней раньше.') };
    if (deg < 202.5) return { name: WM.t('Южный склон (Ю)'), icon: '🔥', note: WM.t('Максимум инсоляции. Весной оттаивает на 10–14 дней раньше (первые сморчки), в засуху быстро пересыхает.') };
    if (deg < 247.5) return { name: WM.t('Юго-западный склон (ЮЗ)'), icon: '🌇', note: WM.t('Очень тёплый склон вечернего солнца, быстрый сход снега.') };
    if (deg < 292.5) return { name: WM.t('Западный склон (З)'), icon: '⛅', note: WM.t('Наветренная сторона для атлантических циклонов, умеренно тёплый.') };
    return { name: WM.t('Северо-западный склон (СЗ)'), icon: '🌧️', note: WM.t('Часто перехватывает осадки, прохладный влажный микроклимат.') };
  }

  function bearingName(deg) {
    const a = [WM.t('С'), WM.t('СВ'), WM.t('В'), WM.t('ЮВ'), WM.t('Ю'), WM.t('ЮЗ'), WM.t('З'), WM.t('СЗ')];
    return a[Math.round(deg / 45) % 8];
  }

  async function fetchTerrain(lat, lon, signal) {
    const key = `${lat.toFixed(4)}_${lon.toFixed(4)}`;
    const hit = terrainCache.get(key);
    if (hit && Date.now() - hit.t < 24 * 3600 * 1000) return hit.data;
    try {
      const rings = [100, 300, 750];
      const dirs = [[1, 0], [0.7071, 0.7071], [0, 1], [-0.7071, 0.7071], [-1, 0], [-0.7071, -0.7071], [0, -1], [0.7071, -0.7071]];
      const cosLat = Math.cos(lat * Math.PI / 180);
      const lonScale = 111139 * (cosLat > 0.05 ? cosLat : 1);
      const pts = [[lat, lon]];
      rings.forEach(r => dirs.forEach(d => pts.push([lat + d[0] * r / 111139, lon + d[1] * r / lonScale])));

      const url = `https://api.open-meteo.com/v1/elevation?latitude=${pts.map(p => p[0].toFixed(6)).join(',')}&longitude=${pts.map(p => p[1].toFixed(6)).join(',')}`;
      const data = await fetchWithFallback(url, 5000, signal);
      if (!data || !Array.isArray(data.elevation) || data.elevation.length < pts.length) return null;
      const z = data.elevation;
      const zc = z[0];
      const ring = k => z.slice(1 + k * 8, 9 + k * 8);

      let sxx = 0, sx = 0, syy = 0, sy = 0;
      ring(0).forEach((zj, j) => {
        const x = dirs[j][1] * rings[0], y = dirs[j][0] * rings[0];
        sx += (zj - zc) * x; sxx += x * x; sy += (zj - zc) * y; syy += y * y;
      });
      const dzdx = sx / sxx, dzdy = sy / syy;
      const slopeDeg = r1(Math.atan(Math.hypot(dzdx, dzdy)) * 180 / Math.PI);

      let aspectDeg = null;
      if (slopeDeg >= 1.5) {
        let a = Math.atan2(-dzdx, -dzdy) * 180 / Math.PI;
        if (a < 0) a += 360;
        aspectDeg = Math.round(a);
      }

      const avg = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
      const deltaLocal = r1(avg(ring(0)) - zc);
      const rel300 = r1(zc - avg(ring(1)));
      const rel750 = r1(zc - avg(ring(2)));
      const all = z.slice(1);
      const zMin = Math.min(...all, zc), zMax = Math.max(...all, zc);
      const range750 = r1(zMax - zMin);
      const hLow = r1(zc - zMin);
      const relPos = range750 > 0 ? (zc - zMin) / range750 : 0.5;

      let lowIdx = -1, lowZ = zc;
      all.forEach((v, i) => { if (v < lowZ - 0.2) { lowZ = v; lowIdx = i; } });
      let lowestDir = null, lowestDist = null;
      if (lowIdx >= 0) {
        const k = Math.floor(lowIdx / 8), j = lowIdx % 8;
        lowestDist = rings[k];
        let b = Math.atan2(dirs[j][1], dirs[j][0]) * 180 / Math.PI;
        if (b < 0) b += 360;
        lowestDir = Math.round(b);
      }

      const isFlat = range750 < 3;
      const isDepression = deltaLocal >= 0.6 && slopeDeg <= 3.5;
      const isValleyBottom = !isFlat && (rel300 <= -1.5 || relPos <= 0.12) && slopeDeg <= 4.5;
      const isRidge = !isFlat && rel300 >= 2 && relPos >= 0.85;

      let wet = 0.5 + clamp(-rel300 / 6, -0.4, 0.4) + (deltaLocal > 0 ? clamp(deltaLocal / 3, 0, 0.2) : 0) - clamp(slopeDeg / 20, 0, 0.3);
      if (isFlat) wet += 0.1;
      const wetness = clamp(wet, 0, 1);

      const asp = aspectInfo(aspectDeg);
      const out = {
        elevationM: Math.round(zc), slopeDeg, aspectDeg, aspectName: asp.name, icon: asp.icon, note: asp.note,
        deltaLocal, rel300, rel750, hLow, relPos, range750, lowestDir, lowestDist,
        isFlat, isDepression, isValleyBottom, isRidge, wetness
      };
      terrainCache.set(key, { t: Date.now(), data: out });
      return out;
    } catch (e) {
      if (signal && signal.aborted) throw e;
      console.warn('[Soil] Не удалось загрузить рельеф:', e);
      return null;
    }
  }

  // =========================================================================
  // ПОКРОВ ПО OpenStreetMap (Overpass) — главный признак для болот, карьеров, торфоразработок
  // SoilGrids (250 м, статистическая модель) почти не различает лес, болото и выработку,
  // поэтому тип местности берём из карты, а почву используем как уточняющий признак.
  // =========================================================================
  const OVERPASS_KEY = 'ovp_EV05aAhEX8JcD7JlrS5NoMyptMf2vkLi';
  const OVERPASS_MIRRORS = [
    `https://api.overpass.ch/v1/${OVERPASS_KEY}/interpreter`, // Основной: быстрый сервер с вашим ключом
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter', // Резерв 1 (быстрое зеркало в РФ)
    'https://overpass-api.de/api/interpreter',                // Резерв 2 (официальный немецкий сервер)
    'https://overpass.kumi.systems/api/interpreter'           // Резерв 3 (европейский резерв)
  ];
  async function fetchLandCover(lat, lon, signal) {
    const key = `${lat.toFixed(4)}_${lon.toFixed(4)}`;
    const hit = landCache.get(key);
    if (hit && Date.now() - hit.t < 24 * 3600 * 1000) return hit.data;

    const la = lat.toFixed(6), lo = lon.toFixed(6);

    const q = `[out:json][timeout:8];
      is_in(${la},${lo})->.a;
      (
        way(pivot.a)["natural"];
        way(pivot.a)["landuse"];
        relation(pivot.a)["natural"];
        relation(pivot.a)["landuse"];
        nwr(around:250,${la},${lo})["natural"~"^(wood|wetland|sand|heath|scree|bare_rock|water)$"];
        nwr(around:250,${la},${lo})["landuse"~"^(forest|quarry|peat_cutting|meadow|farmland|allotments)$"];
        nwr(around:150,${la},${lo})["waterway"~"^(river|stream|canal)$"];
      );
      out tags;`;

    for (const mirrorUrl of OVERPASS_MIRRORS) {
      if (signal && signal.aborted) return null;

      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), 6000);
      const t0 = performance.now();
      const isOverpassCh = mirrorUrl.includes('overpass.ch');
      const channelName = isOverpassCh ? 'OSM (overpass.ch)' : `OSM (${new URL(mirrorUrl).hostname})`;
      const debugUrl = `${mirrorUrl}?data=${encodeURIComponent(q)}`;

      const onAbort = () => ctl.abort();
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      try {
        // Пробуем стандартный POST, а если сервер отвергает preflight (CORS) — через GET с параметром data=
        let res;
        try {
          res = await fetch(mirrorUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Accept': 'application/json' },
            body: 'data=' + encodeURIComponent(q),
            signal: ctl.signal
          });
        } catch (postErr) {
          // Fallback на обычный GET (наиболее всеяден к CORS без preflight)
          res = await fetch(debugUrl, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: ctl.signal
          });
        }

        clearTimeout(tm);
        if (signal) signal.removeEventListener('abort', onAbort);
        const elapsed = Math.round(performance.now() - t0);

        if (res.ok) {
          const data = await res.json();
          logTrace({
            channel: channelName,
            url: debugUrl,
            status: '200 OK',
            ok: true,
            ms: elapsed,
            error: null
          });
          if (data && Array.isArray(data.elements)) {
            const lc = parseLandCover(data.elements);
            landCache.set(key, { t: Date.now(), data: lc });
            return lc;
          }
        } else {
          const errText = await res.text().catch(() => '');
          logTrace({
            channel: channelName,
            url: debugUrl,
            status: `HTTP ${res.status}`,
            ok: false,
            ms: elapsed,
            error: errText.slice(0, 100)
          });
        }
      } catch (e) {
        clearTimeout(tm);
        if (signal) signal.removeEventListener('abort', onAbort);
        const elapsed = Math.round(performance.now() - t0);
        logTrace({
          channel: channelName,
          url: debugUrl,
          status: ctl.signal.aborted ? WM.t('⏱️ Таймаут (> 6 с)') : `❌ ${e.message || WM.t('Ошибка сети / CORS')}`,
          ok: false,
          ms: elapsed,
          error: e.message
        });
      }
    }

    console.warn('[Soil] Ни одно из зеркал OSM Overpass не ответило вовремя');
    return null;
  }
  const landCache = new Map();

  function parseLandCover(elements) {
    const lc = {
      ok: true, hasAny: false, wetland: null, forest: false, leaf: null, planted: false,
      quarry: null, peatWorks: false, sand: false, heath: false, scrub: false, grass: false,
      farm: false, water: false, rock: false, scree: false, urban: false, tags: []
    };
    const WL_RANK = { bog: 4, fen: 3, swamp: 2, marsh: 2, wetland: 1 };
    const WL_MAP = { bog: 'bog', string_bog: 'bog', fen: 'fen', swamp: 'swamp', mangrove: 'swamp', marsh: 'marsh', reedbed: 'marsh', wet_meadow: 'marsh', saltmarsh: 'marsh', tidalflat: 'marsh' };
    const addWetland = (kind) => {
      if (!lc.wetland || WL_RANK[kind] > WL_RANK[lc.wetland]) lc.wetland = kind;
    };
    const seen = new Set();
    const note = (s) => { if (!seen.has(s)) { seen.add(s); lc.tags.push(s); } };

    (elements || []).forEach(el => {
      const t = el.tags || {};
      let used = false;

      if (t.natural === 'wetland' || t.wetland) {
        addWetland(WL_MAP[t.wetland] || 'wetland');
        note('natural=wetland' + (t.wetland ? ' (' + t.wetland + ')' : '')); used = true;
      }
      if (t.natural === 'wood' || t.landuse === 'forest') {
        lc.forest = true;
        let leaf = t.leaf_type || null;
        const sp = String(t.species || t.genus || '').toLowerCase();
        if (!leaf && /pinus|picea|abies|larix/.test(sp)) leaf = 'needleleaved';
        if (!leaf && /betula|quercus|tilia|acer|populus|alnus/.test(sp)) leaf = 'broadleaved';
        if (leaf && (!lc.leaf || lc.leaf === leaf)) lc.leaf = leaf;
        else if (leaf && lc.leaf !== leaf) lc.leaf = 'mixed';
        if (t.planted === 'yes' || t.wood === 'planted') lc.planted = true;
        note((t.natural === 'wood' ? 'natural=wood' : 'landuse=forest') + (leaf ? ' (' + leaf + ')' : '')); used = true;
      }
      if (t.landuse === 'quarry') {
        const r = String(t.resource || '').toLowerCase();
        if (/peat/.test(r)) { lc.quarry = 'peat'; lc.peatWorks = true; }
        else if (/sand/.test(r)) lc.quarry = lc.quarry === 'peat' ? 'peat' : 'sand';
        else if (/gravel|gravel|aggregate/.test(r)) lc.quarry = lc.quarry || 'gravel';
        else if (r) lc.quarry = lc.quarry || 'other';
        else lc.quarry = lc.quarry || 'unknown';
        note('landuse=quarry' + (r ? ' (' + r + ')' : '')); used = true;
      }
      if (t.landuse === 'peat_cutting' || /peat/.test(String(t.resource || '')) || t.industrial === 'peat_cutting') {
        lc.peatWorks = true; if (!lc.quarry) lc.quarry = 'peat'; note(WM.t('торфоразработка (peat)')); used = true;
      }
      if (t.natural === 'sand' || t.natural === 'beach') { lc.sand = true; note('natural=sand'); used = true; }
      if (t.natural === 'heath') { lc.heath = true; note('natural=heath'); used = true; }
      if (t.natural === 'scrub') { lc.scrub = true; note('natural=scrub'); used = true; }
      if (t.natural === 'grassland' || /^(meadow|grass|village_green)$/.test(t.landuse || '')) { lc.grass = true; note(t.natural ? 'natural=grassland' : 'landuse=' + t.landuse); used = true; }
      if (/^(farmland|farmyard|orchard|vineyard|allotments)$/.test(t.landuse || '')) { lc.farm = true; note('landuse=' + t.landuse); used = true; }
      if (t.natural === 'water') { lc.water = true; note('natural=water'); used = true; }
      if (t.natural === 'bare_rock') { lc.rock = true; note('natural=bare_rock'); used = true; }
      if (t.natural === 'scree' || t.natural === 'shingle') { lc.scree = true; note('natural=' + t.natural); used = true; }
      if (/^(residential|industrial|commercial|retail|construction|landfill)$/.test(t.landuse || '')) { lc.urban = true; note('landuse=' + t.landuse); used = true; }
      if (used) lc.hasAny = true;
    });

    // Открытый вид: если лес без явной породы, но есть болото, порода не определена
    return lc;
  }


  // =========================================================================
  // АГРОМЕТЕО (Open-Meteo)
  // =========================================================================
  async function fetchAgro(lat, lon, signal) {
    try {
      // 10 прошлых дней вместо 14 вдвое ускоряет ответ API
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}` +
        `&hourly=temperature_2m,dew_point_2m,precipitation,soil_temperature_0cm,soil_temperature_6cm,soil_temperature_18cm,soil_moisture_0_to_1cm,soil_moisture_3_to_9cm,soil_moisture_9_to_27cm` +
        `&daily=precipitation_sum,et0_fao_evapotranspiration,temperature_2m_max,temperature_2m_min&past_days=10&forecast_days=3&timezone=auto`;
      
      // Таймаут 10000 мс вместо 6000 мс
      const data = await fetchWithFallback(url, 10000, signal, 'AgroMeteo');
      if (!data || !data.hourly || !data.daily) return null;
      const h = data.hourly, d = data.daily;

      const offset = data.utc_offset_seconds || 0;
      const nowStr = new Date(Date.now() + offset * 1000).toISOString();
      const nowHour = nowStr.slice(0, 13) + ':00';
      const todayStr = nowStr.slice(0, 10);
      let ni = h.time.indexOf(nowHour);
      if (ni < 0) { ni = h.time.length - 1; for (let i = 0; i < h.time.length; i++) if (h.time[i] > nowHour) { ni = Math.max(0, i - 1); break; } }
      let di = d.time.indexOf(todayStr);
      if (di < 0) di = Math.min(14, d.time.length - 1);

      const num = v => (v == null || isNaN(v) ? 0 : Number(v));
      const dsum = (arr, a, b) => { let s = 0; for (let i = Math.max(0, a); i <= Math.min(arr.length - 1, b); i++) s += num(arr[i]); return s; };
      const P = d.precipitation_sum || [], ET = d.et0_fao_evapotranspiration || [], TX = d.temperature_2m_max || [], TN = d.temperature_2m_min || [];

      const rain3 = dsum(P, di - 2, di), rain7 = dsum(P, di - 6, di), rain14 = dsum(P, di - 13, di);
      const et7 = dsum(ET, di - 6, di);
      const fcRain = dsum(P, di + 1, di + 2);
      const waterBalance = r1(rain7 - et7);

      let lastBigRainAgo = null;
      for (let k = 0; k <= 13; k++) { if (num(P[di - k]) >= 8) { lastBigRainAgo = k; break; } }

      let tmin3 = 99;
      for (let i = Math.max(0, di - 3); i <= di; i++) if (TN[i] != null) tmin3 = Math.min(tmin3, TN[i]);
      if (tmin3 === 99) tmin3 = 5;

      let shock = false;
      for (let i = Math.max(2, di - 4); i <= di; i++) {
        if (TX[i - 2] != null && TX[i] != null && TX[i - 2] - TX[i] >= 4.5 && rain7 >= 10) { shock = true; break; }
      }

      const hv = (arr, def) => (arr && arr[ni] != null ? arr[ni] : def);
      const airT = hv(h.temperature_2m, 10);
      const dew = hv(h.dew_point_2m, airT - 5);
      const m0 = hv(h.soil_moisture_0_to_1cm, 0.25);
      const m39 = hv(h.soil_moisture_3_to_9cm, m0);
      const t0 = hv(h.soil_temperature_0cm, airT);
      const t6 = hv(h.soil_temperature_6cm, t0);
      const t18 = hv(h.soil_temperature_18cm, t6);

      const s0 = Math.max(0, di - 13);
      const series = {
        dates: d.time.slice(s0), precip: P.slice(s0).map(num), tmax: TX.slice(s0), tmin: TN.slice(s0), todayI: di - s0
      };

      return {
        rain3: r1(rain3), rain7: r1(rain7), rain14: r1(rain14), et7: r1(et7), fcRain: r1(fcRain), waterBalance,
        lastBigRainAgo, tmin3: r1(tmin3), shock, airT: r1(airT),
        dewSpread: r1(Math.abs(airT - dew)), dewLikely: Math.abs(airT - dew) <= 2.2,
        m0, m39, soilT0: r1(t0), soilT6: r1(t6), soilT18: r1(t18), series
      };
    } catch (e) {
      if (signal && signal.aborted) throw e;
      console.warn('[Soil] Не удалось загрузить агрометео:', e);
      return null;
    }
  }

  // =========================================================================
  // ИНТЕРПРЕТАЦИИ
  // =========================================================================
  function usdaTexture(sand, clay, silt) {
    const T = (name, desc) => ({ name, desc });
    if (silt + 1.5 * clay < 15) return T(WM.t('Песок (Sand)'), WM.t('Сыпучая почва, мгновенный дренаж, влагу почти не держит.'));
    if (silt + 1.5 * clay >= 15 && silt + 2 * clay < 30) return T(WM.t('Супесь (Loamy sand)'), WM.t('Отличная аэрация и дренаж; оптимум для сосновых боров.'));
    if ((clay >= 7 && clay < 20 && sand > 52 && silt + 2 * clay >= 30) || (clay < 7 && silt < 50 && silt + 2 * clay >= 30)) return T(WM.t('Лёгкий суглинок (Sandy loam)'), WM.t('Тёплая, быстро прогреваемая почва с умеренной влагоёмкостью.'));
    if (clay >= 7 && clay < 27 && silt >= 28 && silt < 50 && sand <= 52) return T(WM.t('Суглинок (Loam)'), WM.t('Идеальный баланс песка, ила и глины для лесной растительности.'));
    if ((silt >= 50 && clay >= 12 && clay < 27) || (silt >= 50 && silt < 80 && clay < 12)) return T(WM.t('Пылеватый суглинок (Silt loam)'), WM.t('Мягкая, влагоёмкая, легко заплывает и размывается.'));
    if (silt >= 80 && clay < 12) return T(WM.t('Пылеватая почва (Silt)'), WM.t('Очень мягкая, легко размываемая почва речных долин.'));
    if (clay >= 20 && clay < 35 && silt < 28 && sand > 45) return T(WM.t('Песчанистый тяжёлый суглинок'), WM.t('Сбалансированная почва со стабильным водным режимом.'));
    if (clay >= 27 && clay < 40 && sand > 20 && sand <= 45) return T(WM.t('Тяжёлый суглинок (Clay loam)'), WM.t('Влагоёмкая и богатая минералами, но медленно дренируется.'));
    if (clay >= 27 && clay < 40 && sand <= 20) return T(WM.t('Пылеватый тяжёлый суглинок'), WM.t('Влагоёмкая пойменная почва.'));
    if (clay >= 35 && sand > 45) return T(WM.t('Песчанистая глина (Sandy clay)'), WM.t('Плотная, но с песчаной фракцией.'));
    if (clay >= 40 && silt >= 40) return T(WM.t('Пылеватая глина (Silty clay)'), WM.t('Холодная, вязкая и липкая.'));
    if (clay >= 40) return T(WM.t('Тяжёлая глина (Clay)'), WM.t('Плотная, холодная, задерживает воду, трескается при высыхании.'));
    return T(WM.t('Смешанный суглинок'), WM.t('Умеренно лёгкий механический состав с хорошей аэрацией.'));
  }

  function interpretPh(ph) {
    if (ph < 4.5) return { tag: WM.t('Экстремально кислая'), color: '#dc2626', note: WM.t('Угнетает большинство деревьев, кроме сосны и берёзы. Рай для сфагнума, вереска и черники.') };
    if (ph < 5.2) return { tag: WM.t('Сильнокислая'), color: '#ea580c', note: WM.t('Оптимум для хвойников, боровиков, польских грибов и брусники.') };
    if (ph < 6.0) return { tag: WM.t('Слабокислая'), color: '#eab308', note: WM.t('Типична для смешанных лесов, ельников, черничников и подосиновиков.') };
    if (ph <= 7.2) return { tag: WM.t('Нейтральная'), color: '#16a34a', note: WM.t('Идеал для широколиственных дубрав, сморчков, зонтиков и богатого подлеска.') };
    if (ph <= 8.2) return { tag: WM.t('Слабощелочная'), color: '#0284c7', note: WM.t('Карбонатная почва. Любима орхидеями, ясенем и шампиньонами.') };
    return { tag: WM.t('Сильнощелочная'), color: '#7c3aed', note: WM.t('Избыток свободной извести или солей.') };
  }

  function interpretHumus(socGkg) {
    const humusPct = Math.round(socGkg / 10 * 1.724 * 10) / 10;
    if (humusPct < 1.5) return { humusPct, level: WM.t('Бедная гумусом') };
    if (humusPct < 3.5) return { humusPct, level: WM.t('Умеренный гумус') };
    if (humusPct < 7) return { humusPct, level: WM.t('Богатая гумусом') };
    return { humusPct, level: WM.t('Торфянистая / органогенная') };
  }

  function interpretCN(cn) {
    if (cn == null) return { level: WM.t('нет данных'), note: '' };
    if (cn < 10) return { level: WM.t('очень узкое'), note: WM.t('Быстрая минерализация, много азота: нитрофилы (крапива, малина), шампиньоны и дождевики.') };
    if (cn < 15) return { level: WM.t('узкое (мягкий гумус, mull)'), note: WM.t('Плодородный быстро разлагаемый опад: дубравы, зонтики, сморчки.') };
    if (cn < 25) return { level: WM.t('среднее (moder)'), note: WM.t('Типичный лесной гумус: смешанные и хвойные леса, большая часть съедобной микоризы.') };
    return { level: WM.t('широкое (сырой гумус, mor)'), note: WM.t('Кислый грубый гумус: вереск, брусника, сфагнум; микоризные грибы доминируют над сапротрофами.') };
  }

  function interpretNitrogen(n) {
    if (n < 1.0) return { level: WM.t('Низкий (олиготрофный)'), color: '#f59e0b' };
    if (n <= 2.5) return { level: WM.t('Средний (мезотрофный)'), color: '#10b981' };
    return { level: WM.t('Высокий (эутрофный)'), color: '#3b82f6' };
  }

  function interpretCec(v) {
    if (v < 10) return WM.t('Низкая буферность: лёгкие пески быстро теряют соли с осадками.');
    if (v <= 25) return WM.t('Средняя: хороший запас обменного Ca, K и Mg.');
    return WM.t('Высокая: глинистые или гумусные почвы с большой поглотительной способностью.');
  }

  function interpretStoniness(p) {
    if (p < 5) return WM.t('Бескаменистая');
    if (p < 15) return WM.t('Слабокаменистая');
    if (p < 35) return WM.t('Среднекаменистая');
    return WM.t('Сильнокаменистая / скальная');
  }

  function assessMoisture(hydro, agro) {
    const m = agro.m39 != null ? agro.m39 : agro.m0;
    const sat = (m - hydro.pwp) / Math.max(0.04, hydro.fc - hydro.pwp);
    let status = 'moderate', title = WM.t('Умеренная влажность'), icon = '💧', badgeClass = 'moist-moderate';
    if (sat >= 1.12 || agro.waterBalance > 20) { status = 'wet'; title = WM.t('Сырая / промоченная'); icon = '🌧️'; badgeClass = 'moist-wet'; }
    else if (sat < 0.5 || (agro.waterBalance < -15 && sat < 0.8)) { status = 'dry'; title = WM.t('Сухая / пересохшая'); icon = '☀️'; badgeClass = 'moist-dry'; }
    const desc = WM.t('За 7 дн: осадки {0} мм, испарение {1} мм (баланс {2} мм). Заполнение почвенного резервуара ≈ {3}% от полевой влагоёмкости.', agro.rain7, agro.et7, sgn(agro.waterBalance), Math.round(clamp(sat, 0, 1.6) * 100));
    return { status, title, icon, badgeClass, sat: clamp(sat, 0, 2), desc };
  }

  function estimateWetness(soil, terrain, moist, lc) {
    const org = soil.orgIndex != null ? soil.orgIndex : 0;
    const texK = 1 - 0.6 * org; // у органогенных почв «текстура» SoilGrids — это текстура подстилающей породы

    let w = 0.40
      + texK * 0.30 * clamp((soil.clay - 18) / 25, -0.5, 1)
      - texK * 0.35 * clamp((soil.sand - 35) / 45, -0.5, 1)
      + 0.30 * org;

    if (terrain) {
      if (terrain.slopeDeg > 3.0) w -= clamp((terrain.slopeDeg - 2) * 0.06, 0, 0.35);
      if (terrain.isDepression) w += 0.25;
      if (terrain.isValleyBottom) w += 0.20;
      if (terrain.isRidge) w -= 0.20;
      if (terrain.rel300 > 2.0) w -= 0.15;
      if (terrain.isFlat) w += 0.05;
    }

    // Покров OSM — самый прямой признак переувлажнения / сухости
    if (lc && lc.ok) {
      if (lc.water) w += 0.35; // присутствие водоёма прямо рядом увеличивает потенциал влажности
      if (lc.wetland === 'bog') w += 0.45;
      else if (lc.wetland) w += 0.35;
      if (lc.peatWorks) w += 0.15;
      if (lc.quarry === 'sand' || lc.quarry === 'gravel' || lc.sand) w -= 0.25;
      if (lc.heath) w -= 0.10;
      if (lc.rock || lc.scree) w -= 0.25;
    }

    if (moist) w += clamp((moist.sat - 0.9) * 0.15, -0.1, 0.15);
    return clamp(w, 0.05, 0.98);
  }

  // Идентификаторы по типам, чтобы правила ниже читались проще
  const WETLAND_IDS = ['acid_wet_peat', 'pine_sphagnum', 'alder_fen'];
  const DRY_FOREST_IDS = ['acid_sand_dry', 'pine_loam_mixed', 'acid_loam_mesic', 'neutral_rich_loam', 'rocky_slope', 'alkaline_limestone'];

  // Поправка к «расстоянию» биотопа по данным о покрове (OSM). Отрицательная = усиливает биотоп.
  function landcoverDelta(id, lc, soil) {
    if (!lc || !lc.ok || !lc.hasAny) return 0;
    let d = 0;
    const wl = lc.wetland;
    const conifer = lc.forest && lc.leaf === 'needleleaved';
    const isPeatLike = soil.ph < 5.5;

    // — Болота —
    if (wl) {
      if (id === 'acid_wet_peat') {
        if (wl === 'bog') d -= conifer ? 8 : 14;
        else if (wl === 'wetland') d -= 8 + (isPeatLike ? 3 : 0);
        else d += isPeatLike ? -2 : 3;
      } else if (id === 'pine_sphagnum') {
        if (wl === 'bog') d -= conifer ? 15 : 5;
        else if (wl === 'wetland') d -= conifer ? 9 : 5;
        else d -= conifer ? 2 : 0;
      } else if (id === 'alder_fen') {
        if (wl === 'bog') d += 8;
        else if (wl === 'wetland') d -= 7 + (isPeatLike ? -3 : 3);
        else d -= 12;
      } else if (id === 'peat_cutting') {
        d += 2;
      } else if (id === 'heavy_clay_wet') {
        d -= (wl === 'bog' ? 0 : 2);
      } else if (DRY_FOREST_IDS.includes(id) || id === 'meadow_chernozem' || id === 'sand_quarry') {
        d += 10;
      }
    } else if (WETLAND_IDS.includes(id)) {
      // Мапперы не отметили болото: торф по почве одной не подтверждается
      d += 4;
    }
    if (lc.water) {
      if (id === 'heavy_clay_wet' || id === 'alder_fen') d -= 6;
      if (id === 'acid_sand_dry' || id === 'rocky_slope') d += 8;
    }

    // — Торфоразработки и карьеры —
    if (id === 'peat_cutting') {
      if (lc.peatWorks || lc.quarry === 'peat') d -= 20;
      else if (!wl) d += 30;
    } else if (lc.peatWorks || lc.quarry === 'peat') {
      d += 4;
    }

    if (id === 'sand_quarry') {
      const sandQ = lc.quarry === 'sand' || lc.quarry === 'gravel';
      const anyQ = sandQ || lc.quarry === 'unknown';
      // Карьерная почва — отвалы и вскрытый песок, SoilGrids её не видит, поэтому доверяем карте
      if (sandQ || lc.sand) d -= lc.forest ? 18 : 26;
      else if (anyQ) d -= lc.forest ? 12 : 18;
      else if (!wl && !lc.peatWorks) d += 30;
    } else if (lc.quarry === 'sand' || lc.quarry === 'gravel' || lc.sand) {
      if (id === 'acid_sand_dry') d -= lc.forest ? 10 : 4;
      else if (id === 'pine_loam_mixed') d -= 2;
      else if (id === 'acid_loam_mesic' || id === 'neutral_rich_loam') d += 3;
    }

    // — Лес и его тип —
    if (lc.forest && !wl) {
      if (lc.leaf === 'needleleaved') {
        if (id === 'pine_loam_mixed') d -= 3;
        if (id === 'acid_sand_dry') d -= 2;
        if (id === 'acid_loam_mesic') d -= 2;
        if (id === 'neutral_rich_loam') d += 3;
      } else if (lc.leaf === 'broadleaved') {
        if (id === 'neutral_rich_loam') d -= 4;
        if (id === 'acid_loam_mesic') d += 1;
        if (id === 'acid_sand_dry') d += 3;
      } else if (lc.leaf === 'mixed') {
        if (id === 'acid_loam_mesic') d -= 3;
        if (id === 'pine_loam_mixed') d -= 2;
      }
    }

    // — Открытые места —
    if ((lc.grass || lc.farm) && !lc.forest && !wl) {
      if (id === 'meadow_chernozem') d -= 10;
      else if (DRY_FOREST_IDS.includes(id)) d += 5;
    }
    if (lc.heath && id === 'acid_sand_dry') d -= 6;
    if ((lc.rock || lc.scree) && id === 'rocky_slope') d -= 10;

    return d;
  }

  // Климатико-ботаническая зона: ель и болота реже на юге, дубравы и лугостепь — на юго-востоке
  function zoneDelta(id, lat, lon) {
    if (lat == null) return 0;
    let d = 0;
    if (lat < 54.0) {
      if (id === 'acid_loam_mesic') d += 4;
      if (id === 'acid_wet_peat' || id === 'pine_sphagnum') d += 4;
      if (id === 'neutral_rich_loam') d -= 2;
    }
    if (lat < 54.0 && lon > 45) {
      if (id === 'meadow_chernozem') d -= 2;
      if (id === 'neutral_rich_loam') d -= 1;
    }
    if (lat > 58.0 && id === 'neutral_rich_loam') d += 3;
    if (lat > 56.5 && id === 'meadow_chernozem') d += 3;
    return d;
  }

  function matchBiotopes(soil, terrain, moist, lat, lon, lc) {
    const hasLC = !!(lc && lc.ok && lc.hasAny);
    const wet = estimateWetness(soil, terrain, moist, lc);
    const org = soil.orgIndex != null ? soil.orgIndex : 0;
    const texK = 1 - 0.6 * org;

    const isSandy = soil.sand >= 45;
    const isVerySandy = soil.sand >= 65;
    const steep = terrain && terrain.slopeDeg >= 6.0;
    const wetLC = !!(lc && lc.wetland);

    // Гидрологическое подтверждение болота по рельефу (если OSM молчит)
    const terrainWetEv = terrain && (terrain.isDepression || terrain.isValleyBottom || (terrain.isFlat && terrain.wetness >= 0.6));

    const x = {
      ph: soil.ph,
      sand: soil.sand,
      clay: soil.clay,
      soc: soil.socRoot,
      cn: soil.cn != null ? soil.cn : 18,
      wet,
      cfvo: soil.cfvo
    };

    // [вес, масштаб]. Вес текстуры снижается на органогенных почвах, SOC по SoilGrids малоинформативен
    const W = {
      ph: [2.0, 0.9],
      sand: [2.2 * texK, 20],
      clay: [1.8 * texK, 12],
      soc: [0.5, 70],
      cn: [0.5, 10],
      wet: [2.5, 0.25],
      cfvo: [0.8, 15]
    };

    const list = BIOTOPES.map(b => {
      let d2 = 0;
      Object.keys(W).forEach(k => {
        const t = (x[k] - b.profile[k]) / W[k][1];
        d2 += W[k][0] * t * t;
      });

      // ЭКОЛОГИЧЕСКИЕ БАРЬЕРЫ ПО РЕЛЬЕФУ И СОСТАВУ
      if (WETLAND_IDS.includes(b.id)) {
        if (!wetLC) {
          // Без подтверждения из OSM нужна хотя бы форма рельефа + органика
          if (terrainWetEv && org >= 0.5) d2 += 4;
          else d2 += 10;
          if (steep) d2 += 25;
        }
        if (isSandy && b.id === 'alder_fen') d2 += 10;
        if (isVerySandy && !wetLC) d2 += 10;
      } else if (b.id === 'heavy_clay_wet') {
        if (isSandy) d2 += 30;
        if (!terrainWetEv && !wetLC) d2 += 6;
      } else if (wetLC && wet > 0.8 && !['peat_cutting', 'meadow_chernozem'].includes(b.id)) {
        d2 += 6;
      }

      // Песчаные боры
      if (isSandy) {
        if (b.id === 'acid_sand_dry' || b.id === 'pine_loam_mixed') d2 *= 0.55;
        if (isVerySandy && b.id === 'acid_sand_dry') d2 *= 0.6;
      }

      // Каменистый склон / горы (Жигули и пр.)
      if (steep || soil.cfvo >= 14) {
        if (b.id === 'rocky_slope') d2 *= 0.35;
        if (b.id === 'alkaline_limestone' && soil.ph >= 6.0) d2 *= 0.4;
      }

      // Умеренные суглинки
      if (!isSandy && org < 0.8 && soil.clay >= 18 && soil.clay <= 35) {
        if (soil.ph < 5.8 && b.id === 'acid_loam_mesic') d2 *= 0.55;
        if (soil.ph >= 5.8 && b.id === 'neutral_rich_loam') d2 *= 0.55;
      }

      // Выработки без подтверждения картой не выдумываем
      if (!hasLC && (b.id === 'peat_cutting' || b.id === 'sand_quarry')) d2 += 30;

      // Данные о покрове + зональность
      d2 += landcoverDelta(b.id, lc, soil) + zoneDelta(b.id, lat, lon);

      const dFit = Math.max(0, d2);
      return { biotope: b, d2, fit: Math.exp(-0.10 * dFit) };
    });

    // Softmax по расстоянию (с учётом отрицательных значений: сдвигаем минимум в 0)
    const minD = Math.min(...list.map(m => m.d2));
    const sumL = list.reduce((s, m) => s + Math.exp(-0.15 * (m.d2 - minD)), 0);
    list.forEach(m => {
      m.prob = Math.exp(-0.15 * (m.d2 - minD)) / sumL;
      m.similarity = Math.round(clamp((m.fit * 0.6 + m.prob * 0.4) * 100, 10, 98));
    });

    list.sort((a, b) => a.d2 - b.d2);
    list.wet = wet;
    list.hasLC = hasLC;
    list.evidence = ['SoilGrids', terrain ? WM.t('рельеф') : null, moist ? WM.t('влажность') : null, hasLC ? WM.t('карта OSM') : null].filter(Boolean);
    // Уверенность: доля топ-1 в распределении, штраф за отсутствие подтверждения из карты
    list.confidence = Math.round(clamp(list[0].prob * 100 * (hasLC ? 1 : 0.8), 5, 95));
    return list;
  }


  function computeFungalIndex(soil, agro, terrain, moist, month) {
    if (!agro) return { score: 50, phase: WM.t('Нет метеоданных'), color: '#94a3b8', detail: WM.t('Прогноз влажности недоступен.'), window: '', factors: [], shock: false };

    const t6 = agro.soilT6;
    const tempF = t6 < 2 ? 0 : t6 < 6 ? lerp(t6, 2, 6, 0, 0.45) : t6 < 10 ? lerp(t6, 6, 10, 0.45, 1) : t6 <= 17 ? 1 :
      t6 <= 22 ? lerp(t6, 17, 22, 1, 0.55) : t6 <= 27 ? lerp(t6, 22, 27, 0.55, 0.15) : 0.05;

    const sat = moist.sat;
    let satF = sat < 0.4 ? 0.1 : sat < 0.9 ? lerp(sat, 0.4, 0.9, 0.1, 1) : sat <= 1.2 ? 1 : lerp(sat, 1.2, 1.6, 1, 0.55);
    if (soil.clay >= 32 && sat > 1.3) satF *= 0.85;
    const sandy = soil.sand >= 55;
    const rainF = sandy
      ? clamp(agro.rain7 / 20, 0, 1) * 0.6 + clamp(agro.rain14 / 35, 0, 1) * 0.4
      : clamp(agro.rain14 / 35, 0, 1) * 0.7 + clamp(agro.rain7 / 15, 0, 1) * 0.3;
    let moistF = 0.55 * satF + 0.45 * rainF;

    let tF = tempF;
    if (terrain) {
      const a = terrain.aspectDeg;
      if (a != null) {
        if (a >= 135 && a <= 225 && t6 > 17 && moistF < 0.7) moistF -= 0.12;
        if ((a >= 315 || a <= 45) && t6 > 17) moistF += 0.1;
        if (a >= 112 && a <= 248 && t6 < 10 && month >= 3 && month <= 5) tF = Math.min(1, tF + 0.1);
      }
      if (terrain.wetness > 0.65 && moistF < 0.6) moistF += 0.1;
      if (terrain.wetness < 0.35 && moistF < 0.6) moistF -= 0.08;
    }
    moistF = clamp(moistF, 0, 1);

    const frostF = agro.tmin3 < -4 ? 0.25 : agro.tmin3 < -1.5 ? 0.55 : agro.tmin3 < 0 ? 0.8 : 1;
    const prior = SEASON_PRIOR[month] != null ? SEASON_PRIOR[month] : 0.5;

    let score = Math.round(100 * tF * moistF * frostF * (0.45 + 0.55 * prior));
    if (agro.shock && score >= 35) score = Math.min(99, score + 12);
    score = clamp(score, 0, 99);

    const ago = agro.lastBigRainAgo;
    let win;
    if (t6 < 4) win = WM.t('Почва слишком холодная: плодоношение практически остановлено до потепления.');
    else if (agro.rain14 < 12) win = WM.t('Влаги мало: нужно ≥ 20–25 мм за 10 дней, после этого первые плодовые тела через 6–12 дней.');
    else if (ago != null && ago <= 3 && tF >= 0.6) win = WM.t('Недавний значимый дождь ({0} дн. назад): основная волна ожидается через ~{1}–{2} дн.', ago, Math.max(2, 7 - ago), Math.max(4, 12 - ago));
    else if (ago != null && ago <= 12 && tF >= 0.6) win = WM.t('Окно максимума: 4–12 дней после основного дождя — самое время идти.');
    else if (ago == null && agro.rain14 >= 20) win = WM.t('Влага накоплена, но свежих ливней нет: слой доживает, ищите в тенистых и влажных местах.');
    else win = WM.t('Условия переменные: ориентируйтесь на ближайшие осадки и ночные температуры.');
    if (agro.fcRain >= 10 && t6 >= 6) win += WM.t(' Прогноз: ещё {0} мм в ближайшие 2 суток, что поддержит слой.', agro.fcRain);

    let phase, color, detail;
    if (t6 < 2) { phase = WM.t('Анабиоз (почва мёрзлая)'); color = '#38bdf8'; detail = WM.t('Температура почвы около 0 °C. Мицелий шляпочных грибов в покое.'); }
    else if (frostF < 0.6 && (month >= 9 || month <= 4)) { phase = WM.t('Заморозки прервали плодоношение'); color = '#6366f1'; detail = WM.t('Минимум воздуха за 3 дня {0}°C: молодые плодовые тела повреждены.', sgn(agro.tmin3)); }
    else if (moist.status === 'dry' || moistF < 0.3) { phase = WM.t('Засушливая пауза'); color = '#f97316'; detail = sandy ? WM.t('Песок пересох. Шляпочные грибы возможны только в сырых понижениях и у болот.') : WM.t('Дефицит влаги тормозит развитие плодовых тел.'); }
    else if (agro.shock && score >= 60) { phase = WM.t('⚡ Импульс после термошока'); color = '#16a34a'; detail = WM.t('Резкий перепад температур после обильного дождя. Классический пусковой триггер выхода белых, подосиновиков и рыжиков.'); }
    else if (score >= 70) { phase = WM.t('🔥 Мощный оптимум слоя'); color = '#16a34a'; detail = sandy ? WM.t('Идеальный баланс тепла и влаги в бору: слой боровиков и маслят в разгаре.') : WM.t('Тёплая влажная почва, активный рост белых, подосиновиков и груздей.'); }
    else if (score >= 45) { phase = WM.t('Благоприятные условия'); color = '#10b981'; detail = WM.t('Условия подходят для стабильного плодоношения основных сезонных видов.'); }
    else if (score >= 20) { phase = WM.t('Слабая активность'); color = '#eab308'; detail = tF < 0.6 ? WM.t('Сдерживающий фактор: холодная почва.') : WM.t('Сдерживающий фактор: недостаточное увлажнение подстилки.'); }
    else { phase = WM.t('Низкая активность'); color = '#94a3b8'; detail = WM.t('Одновременно не хватает тепла или влаги.'); }

    return {
      score, phase, color, detail, window: win, shock: agro.shock,
      factors: [
        { label: WM.t('🌡️ Температура почвы (6 см)'), val: tF, text: `${sgn(agro.soilT6)}°C` },
        { label: WM.t('💧 Влажность подстилки'), val: moistF, text: WM.t('{0}% ПВ', Math.round(clamp(sat, 0, 2) * 100)) },
        { label: WM.t('🌧️ Осадки 14 дн (с лагом)'), val: rainF, text: WM.t('{0} мм', agro.rain14) },
        { label: WM.t('❄️ Отсутствие заморозков'), val: frostF, text: `Tmin ${sgn(agro.tmin3)}°C` }
      ]
    };
  }

  function whereToGo(c) {
    const { moist, agro, terrain, fungal, biotope } = c;
    const tips = [];
    const cold = agro && agro.soilT6 < 7;
    if (!agro) return WM.t('Метеоданных нет: ориентируйтесь на тип биотопа и рельеф.');
    if (fungal.score < 15 && agro.soilT6 < 3) return WM.t('В ближайшие дни массового плодоношения не ждите: ищите только зимующие виды на валежнике.');
    if (moist.status === 'dry') {
      tips.push(WM.t('ищите в понижениях, у окраин болот, в тени северных склонов и под густым хвойным подростом'));
      if (terrain && terrain.lowestDir != null) tips.push(WM.t('ближайшее понижение — на {0} (~{1} м)', bearingName(terrain.lowestDir), terrain.lowestDist));
    } else if (moist.status === 'wet') {
      tips.push(WM.t('смотрите на повышениях, опушках, гривах и склонах южной экспозиции'));
      if (c.soil.clay >= 32) tips.push(WM.t('избегайте глинистых колей и низин'));
    } else {
      tips.push(WM.t('оптимальны переходные зоны: склоны, опушки, края вырубок и просек с мхом'));
    }
    if (cold) tips.push(WM.t('в холодную погоду лучше прогреваемые южные и юго-восточные склоны и песчаные гривы'));
    return tips.join('; ') + '.';
  }

  function buildInsights(c) {
    const { soil, agro, terrain, moist, biotope, fungal, tex, lc } = c;
    const ph = interpretPh(soil.ph);
    const cn = interpretCN(soil.cn);
    const out = [];

    if (lc && lc.hasAny) out.push(WM.t('🗺️ Карта OSM: {0} — это главный признак типа местности.', lc.tags.map(esc).join(', ')));
    else out.push(WM.t('⚠️ Нет разметки OSM: SoilGrids (250 м) почти одинаков для леса, болота и выработки, поэтому тип местности определён с меньшей уверенностью.'));
    out.push(`${WM.t('🌲 pH {0} ({1}) + {2} → биотоп', soil.ph.toFixed(1), ph.tag.toLowerCase(), tex.name.split(' (')[0].toLowerCase())} <b>«${esc(biotope.title.split(' / ')[0])}»</b>.`);
    out.push(WM.t('💧 {0}: Ksat ≈ {1} мм/ч, общая пористость {2}%, доступная влага {3}%.', soil.hydro.drainage.label, soil.hydro.ks, Math.round(soil.hydro.thetaS * 100), Math.round(soil.hydro.awc * 100)));
    
    // Диагностика подзолистого горизонта
    if (soil.clayDiff >= 8 && soil.phDiff >= 0.4) {
      out.push(`🔍 <b>${WM.t('Профиль оподзолен:')}</b> ${WM.t('на глубине 15–30 см содержание глины выше на +{0}%, а pH на +{1}. Это удерживает влагу в нижнем горизонте даже при сухом верхе.', soil.clayDiff, soil.phDiff)}`);
    }

    // Оценка плотности и аэрации
    if (soil.bdod >= 1.5) {
      out.push(WM.t('⚠️ Плотность почвы высокая ({0} г/см³): аэрация затруднена, мицелий концентрируется строго в верхних 3–5 см подстилки.', soil.bdod));
    }

    if (soil.cn != null) out.push(`🧬 C:N ${soil.cnEstimated ? '≈' : '='} ${soil.cn}${soil.cnEstimated ? WM.t(' (оценка: азот SoilGrids в органике завышен)') : ''} (${cn.level}). ${cn.note}`);
    if (agro) {
      out.push(`${WM.t('🍄 Почва на 6 см {0}°C, осадки за 14 дн {1} мм →', sgn(agro.soilT6), agro.rain14)} <b>${esc(fungal.phase)}</b> (${fungal.score}%).`);
    }
    if (terrain) {
      let t = WM.t('{0} {1}, уклон {2}°', terrain.icon, terrain.aspectName, terrain.slopeDeg);
      if (terrain.isDepression) t += WM.t('; котловина — собирает воду и холодный воздух.');
      else if (terrain.isValleyBottom) t += WM.t('; дно лощины: влага держится дольше, но сыро.');
      else if (terrain.isRidge) t += WM.t('; гребень: сухо и ветрено.');
      out.push(t);
    }
    out.push(`🧭 <b>${WM.t('Куда идти:')}</b> ${whereToGo(c)}`);
    return out;
  }

  function renderClimateChart(agro) {
    const s = agro && agro.series;
    if (!s || s.dates.length < 4) return '';
    const n = s.dates.length, w = 420, h = 130, pL = 28, pR = 26, pT = 10, pB = 22;
    const pw = w - pL - pR, ph = h - pT - pB, bw = pw / n;
    const maxP = Math.max(10, ...s.precip);
    const tAll = [...s.tmax, ...s.tmin].filter(v => v != null);
    const tLo = Math.min(...tAll, 0) - 1, tHi = Math.max(...tAll, 5) + 1;
    const yT = v => pT + ph - ((v - tLo) / (tHi - tLo)) * ph;
    const yP = v => pT + ph - (v / maxP) * ph;
    const cx = i => pL + i * bw + bw / 2;

    const bars = s.precip.map((v, i) => {
      if (!v) return '';
      const col = i < s.todayI ? '#0284c7' : (i === s.todayI ? '#0ea5e9' : '#7dd3fc');
      return `<rect x="${(pL + i * bw + 1).toFixed(1)}" y="${yP(v).toFixed(1)}" width="${Math.max(1, bw - 2).toFixed(1)}" height="${(pT + ph - yP(v)).toFixed(1)}" fill="${col}" opacity="0.85"><title>${WM.t('{0}: {1} мм', s.dates[i], v.toFixed(1))}</title></rect>`;
    }).join('');
    const line = (arr, col) => {
      const pts = arr.map((v, i) => (v == null ? null : `${cx(i).toFixed(1)},${yT(v).toFixed(1)}`)).filter(Boolean).join(' ');
      return `<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.8"/>`;
    };
    const labels = s.dates.map((d, i) => (i % 3 === 0 || i === s.todayI) ? `<text x="${cx(i).toFixed(1)}" y="${h - 7}" font-size="8.5" text-anchor="middle">${d.slice(8, 10)}.${d.slice(5, 7)}</text>` : '').join('');
    const zeroY = (tLo < 0 && tHi > 0) ? `<line x1="${pL}" y1="${yT(0).toFixed(1)}" x2="${w - pR}" y2="${yT(0).toFixed(1)}" stroke="#6366f1" stroke-dasharray="2,3" opacity="0.6"/><text x="${w - pR + 3}" y="${(yT(0) + 3).toFixed(1)}" font-size="8.5">0°</text>` : '';
    return `
      <svg viewBox="0 0 ${w} ${h}" class="gx-svg">
        <line x1="${pL}" y1="${pT + ph}" x2="${w - pR}" y2="${pT + ph}" stroke="var(--border)"/>
        ${bars}${zeroY}${line(s.tmax, '#f97316')}${line(s.tmin, '#64748b')}
        <line x1="${cx(s.todayI).toFixed(1)}" y1="${pT}" x2="${cx(s.todayI).toFixed(1)}" y2="${pT + ph}" stroke="var(--accent)" stroke-dasharray="4,3"/>
        <text x="${pL - 4}" y="${pT + 8}" font-size="8.5" text-anchor="end">${WM.t('{0} мм', Math.round(maxP))}</text>
        <text x="${w - pR + 3}" y="${pT + 8}" font-size="8.5">${Math.round(tHi)}°</text>
        ${labels}
      </svg>
      <div class="gx-note" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:2px;">
        <span><b style="color:#0284c7;">▮</b> ${WM.t('осадки')}</span><span><b style="color:#f97316;">—</b> Tmax</span><span><b style="color:#64748b;">—</b> Tmin</span><span>${WM.t('пунктир: сегодня')}</span>
      </div>`;
  }

  function compassSvg(deg) {
    const arrow = deg == null
      ? '<circle r="4" fill="#16a34a"/>'
      : `<g transform="rotate(${deg})"><path d="M0,-18 L6,5 L0,1 L-6,5 Z" fill="var(--accent)"/></g>`;
    return `<svg width="54" height="54" viewBox="-27 -27 54 54"><circle r="24" fill="none" stroke="var(--border)" stroke-width="2"/><text y="-15" text-anchor="middle" font-size="8" font-weight="700" fill="var(--text-muted)">${WM.t('С')}</text>${arrow}</svg>`;
  }

  const statBox = (label, value) => `<div class="gx-stat"><small>${label}</small><b>${value}</b></div>`;

  function renderDiagnosisResult(ctx) {
    const content = document.getElementById('soil-diagnosis-content');
    if (!content) return;
    ensureStyles();

    const { soil, agro, terrain, lc, lat, lon } = ctx;

    if (!soil) {
      content.innerHTML = `
        <div class="sheet-empty-state" style="padding:16px 12px; margin-bottom:12px; border:1px solid var(--border); border-radius:12px; background:var(--bg-primary);">
          <div style="font-size:24px; margin-bottom:6px;">🧪⚠️</div>
          <div style="font-weight:700; font-size:14px; color:var(--text-main);">${WM.t('Данные SoilGrids сейчас недоступны')}</div>
          <div class="gx-note" style="margin-top:4px;">
            ${WM.t('WCS-сервер, воркер и прямой REST API ISRIC не ответили.')}
          </div>
        </div>


        <div class="inat-traits-source-note" style="margin-top:12px;">
          <span>📚 <b>ISRIC SoilGrids 2.0</b>, <b>Open-Meteo</b>${WM.t('. Расчёт — оценка, а не полевой замер.')}</span>
        </div>
        ${renderDebugAccordion()}
        ${renderRawDataAccordion(ctx)}
      `;
      return;
    }
    const month = new Date().getMonth() + 1;
    const seasonKey = seasonOfMonth(month);

    const phI = interpretPh(soil.ph);
    const tex = usdaTexture(soil.sand, soil.clay, soil.silt);
    const humus = interpretHumus(soil.soc);
    const nI = interpretNitrogen(soil.nitrogen);
    const cnI = interpretCN(soil.cn);
    const hydro = soil.hydro;

    const moist = agro ? assessMoisture(hydro, agro) : { status: 'moderate', sat: 0.9, title: WM.t('Нет данных'), icon: '❔', badgeClass: 'moist-moderate', desc: WM.t('Метеоданные недоступны.') };
    const matches = matchBiotopes(soil, terrain, agro ? moist : null, lat, lon, lc);
    const top = matches[0];
    const biotope = top.biotope;
    const fungal = computeFungalIndex(soil, agro, terrain, moist, month);
    const insights = buildInsights({ soil, agro, terrain, moist, biotope, fungal, tex, month, lc, matches });

    const phScalePct = clamp(Math.round(((soil.ph - 3.5) / 5.0) * 100), 0, 100);

    const seasonTabs = SEASONS.map(([k, name]) => `<button type="button" class="gx-tab ${k === seasonKey ? 'active' : ''}" data-season="${k}">${name}${k === seasonKey ? ' •' : ''}</button>`).join('');
    const seasonPanes = SEASONS.map(([k]) => {
      const list = biotope.fungi[k] || [];
      return `<div class="soil-tags-cloud gx-season-pane" data-pane="${k}" ${k === seasonKey ? '' : 'hidden'}>${
        list.length ? list.map(m => `<span class="soil-item-chip mushroom">🍄 ${esc(m)}</span>`).join('') : `<span class="muted" style="font-size:11.5px;">${WM.t('Для этого сезона активного слоя шляпочных грибов нет.')}</span>`}</div>`;
    }).join('');

    const alts = matches.slice(1, 4).map(m => `
      <div class="gx-alt"><span style="min-width:0;flex:1.4;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(m.biotope.title)}">${esc(m.biotope.title.split(' / ')[0])}</span>
        <div class="gx-bar"><i style="width:${m.similarity}%;background:var(--accent);opacity:.7"></i></div><b style="min-width:32px;text-align:right;">${m.similarity}%</b></div>`).join('');

    const fmt = (v, d = 1) => (v == null ? '—' : (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)));
    const profRows = soil.profile
      .filter(p => p.phh2o != null || p.clay != null || p.sand != null)
      .map(p => `<tr><td>${WM.t('{0} см', p.label)}</td><td>${fmt(p.phh2o)}</td><td>${fmt(p.clay, 0)}%</td><td>${fmt(p.sand, 0)}%</td><td>${fmt(p.soc, 0)}</td><td>${fmt(p.nitrogen)}</td></tr>`)
      .join('');

    const factorRows = fungal.factors.map(f => {
      const pct = Math.round(f.val * 100);
      const col = pct >= 70 ? '#16a34a' : pct >= 40 ? '#eab308' : '#f97316';
      return `<div class="gx-row"><span>${f.label}</span><b style="color:${col}">${f.text}</b></div><div class="gx-bar"><i style="width:${pct}%;background:${col}"></i></div>`;
    }).join('');

    const terrainHtml = terrain ? `
      <div class="soil-section-card">
        <div class="soil-section-header"><span>${WM.t('⛰️ Рельеф и микроклимат')}</span><b style="color:var(--text-main);font-size:13px;">${WM.t('{0} м', terrain.elevationM)}</b></div>
        <div class="gx-split">
          <div style="flex:none;text-align:center;">${compassSvg(terrain.aspectDeg)}<div class="gx-note" style="font-size:9.5px;">${WM.t('куда стекает вода')}</div></div>
          <div>
            <div style="font-weight:700;font-size:13px;color:var(--accent);">${terrain.icon} ${esc(terrain.aspectName)}${terrain.aspectDeg != null ? ` (${terrain.aspectDeg}°)` : ''}</div>
            <div class="gx-note" style="color:var(--text-main);">${esc(terrain.note)}</div>
          </div>
        </div>
        <div class="gx-grid">
          ${statBox(WM.t('Уклон'), terrain.slopeDeg + '°')}
          ${statBox(WM.t('Относительно окрестности 300 м'), WM.t('{0} м', sgn(terrain.rel300)))}
          ${statBox(WM.t('Над ближайшим понижением'), WM.t('{0} м', terrain.hLow))}
          ${statBox(WM.t('Форма'), terrain.isDepression ? WM.t('Котловина') : terrain.isValleyBottom ? WM.t('Дно лощины') : terrain.isRidge ? WM.t('Гребень') : terrain.isFlat ? WM.t('Равнина') : WM.t('Склон'))}
        </div>
        <div class="gx-row"><span class="gx-note">${WM.t('Потенциал увлажнения места')}</span><b>${Math.round(terrain.wetness * 100)}%</b></div>
        <div class="gx-bar"><i style="width:${Math.round(terrain.wetness * 100)}%;background:#0284c7"></i></div>
      </div>` : '';

    const climateHtml = agro ? `
      <div class="gx-row"><span class="gx-note">${WM.t('🌡️ Почва: 0 см / 6 см / 18 см')}</span><b>${sgn(agro.soilT0)} / ${sgn(agro.soilT6)} / ${sgn(agro.soilT18)}°C</b></div>
      <div class="gx-row"><span class="gx-note">${WM.t('💧 Баланс 7 дн (P − ET₀)')}</span><b>${WM.t('{0} мм', sgn(agro.waterBalance))}</b></div>
      <div class="gx-row"><span class="gx-note">${WM.t('🌧️ Дожди 3 / 7 / 14 дн')}</span><b>${WM.t('{0} / {1} / {2} мм', agro.rain3, agro.rain7, agro.rain14)}</b></div>
      <div class="gx-row"><span class="gx-note">${WM.t('🌫️ Роса в мху')}</span><b>${agro.dewLikely ? WM.t('🟢 вероятна') : WM.t('🟡 слабая')}</b></div>
      ${renderClimateChart(agro)}` : '';

    content.innerHTML = `
      <div class="soil-hero-card">
        <div class="soil-hero-badge-row">
          <span class="soil-pill" style="border-color:${phI.color};color:${phI.color};font-weight:800;">pH ${soil.ph.toFixed(1)} · ${phI.tag}</span>
          ${agro ? `<span class="soil-pill ${moist.badgeClass}">${moist.icon} ${moist.title}</span>` : ''}
          <span class="soil-pill" style="border-color:var(--border);color:var(--text-muted);font-size:11px;">${WM.t('Сходство: {0}%', top.similarity)}</span>
          <span class="soil-pill" style="border-color:var(--border);color:${matches.confidence >= 60 ? '#16a34a' : matches.confidence >= 35 ? '#eab308' : '#f97316'};font-size:11px;" title="${WM.t('Основано на: {0}', esc(matches.evidence.join(', ')))}">${WM.t('Уверенность: {0}%', matches.confidence)}</span>
        </div>
        <h4 class="soil-biotope-title">${esc(biotope.title)}</h4>
        <div class="soil-type-name">${esc(biotope.soilTypeRu)} · ${esc(tex.name)}</div>
        <p class="soil-biotope-desc">${esc(biotope.description)}</p>
        <div class="gx-note" style="margin:6px 0;">${lc && lc.hasAny
          ? WM.t('🗺️ По карте OSM: {0}', lc.tags.map(esc).join(', '))
          : (lc ? WM.t('🗺️ OSM: участок без подробной разметки — тип местности оценён по почве и рельефу.') : WM.t('🗺️ Данные OSM недоступны — тип местности оценён только по почве и рельефу (болота, карьеры и торфоразработки по ним не различить).'))}
          <br>${WM.t('Опирался на: {0}.', esc(matches.evidence.join(', ')))}</div>
        <div class="soil-tip-box"><b>${WM.t('💡 Практический вывод:')}</b> ${esc(biotope.foragingTip)}</div>
        <div class="gx-insights"><div style="font-weight:800;margin-bottom:2px;">${WM.t('🔎 Главное (всё в связке)')}</div>${insights.map(t => `<div>${t}</div>`).join('')}</div>
        ${matches.length > 1 ? `<div style="margin-top:10px;"><div class="gx-note" style="font-weight:700;margin-bottom:2px;">${WM.t('Ближайшие альтернативы:')}</div>${alts}</div>` : ''}
      </div>

      <div class="soil-section-card" style="border-left:4px solid ${fungal.color};">
        <div class="soil-section-header"><span>${WM.t('🍄 Индекс активности грибницы')}</span><b style="color:${fungal.color};font-size:13.5px;">${fungal.score}% · ${esc(fungal.phase)}</b></div>
        <div class="gx-bar"><i style="width:${fungal.score}%;background:${fungal.color}"></i></div>
        <div class="gx-note" style="color:var(--text-main);margin-top:6px;">${esc(fungal.detail)}</div>
        ${fungal.window ? `<div class="gx-insights" style="margin-top:6px;">⏱️ ${esc(fungal.window)}</div>` : ''}
        <div style="margin-top:8px;">${factorRows}</div>
        <div style="margin-top:8px;">${climateHtml}</div>
      </div>

      <div class="soil-section-card">
        <div class="soil-section-header"><span>${WM.t('🍄 Что искать (в {0} подсвечен текущий сезон)', MONTHS_PREP[month])}</span></div>
        <div class="gx-tabs" id="gx-soil-season-tabs">${seasonTabs}</div>
        ${seasonPanes}
        <div class="soil-section-header" style="margin-top:10px;"><span>${WM.t('🌿 Деревья и растения-индикаторы')}</span></div>
        <div class="soil-tags-cloud">
          ${biotope.trees.map(t => `<span class="soil-item-chip tree">🌲 ${esc(t)}</span>`).join('')}
          ${biotope.plants.map(p => `<span class="soil-item-chip plant">🌱 ${esc(p)}</span>`).join('')}
        </div>
      </div>

      ${terrainHtml}

      <div class="soil-section-card">
        <div class="soil-section-header"><span>${WM.t('🧪 Химия и сложение (SoilGrids 250 м)')}</span></div>

        <div class="soil-metric-block">
          <div class="soil-metric-header"><span>${WM.t('Кислотность 0–5 / 5–15 см')}</span><b style="color:${phI.color};font-size:15px;">pH ${soil.ph.toFixed(1)} / ${soil.phSub.toFixed(1)}</b></div>
          <div class="soil-ph-track"><div class="soil-ph-gradient"></div><div class="soil-ph-pointer" style="left:${phScalePct}%;"><span class="soil-ph-pointer-badge">${soil.ph.toFixed(1)}</span></div></div>
          <div class="soil-ph-labels"><span>${WM.t('3.5 кислая')}</span><span>6.0</span><span>7.0</span><span>${WM.t('8.5 щелочная')}</span></div>
        </div>

        <hr class="style-divider" style="margin:10px 0;">
        <div class="soil-metric-block">
          <div class="soil-metric-header"><span>${WM.t('Гранулометрия (0–30 см)')}</span><b style="color:var(--text-main);font-size:13px;">${esc(tex.name)}</b></div>
          <div class="soil-texture-bar-wrap">
            <div class="soil-tex-seg sand" style="width:${soil.sand}%;" title="${WM.t('Песок {0}%', soil.sand)}">${soil.sand >= 15 ? WM.t('Песок {0}%', soil.sand) : ''}</div>
            <div class="soil-tex-seg silt" style="width:${soil.silt}%;" title="${WM.t('Ил {0}%', soil.silt)}">${soil.silt >= 15 ? WM.t('Ил {0}%', soil.silt) : ''}</div>
            <div class="soil-tex-seg clay" style="width:${soil.clay}%;" title="${WM.t('Глина {0}%', soil.clay)}">${soil.clay >= 15 ? WM.t('Глина {0}%', soil.clay) : ''}</div>
          </div>
        </div>

        <hr class="style-divider" style="margin:10px 0;">
        <div class="gx-grid">
          ${statBox(WM.t('Азот N'), WM.t('{0} г/кг', soil.nitrogen))}
          ${statBox('C:N' + (soil.cnEstimated ? WM.t(' (оценка)') : ''), soil.cn != null ? (soil.cnEstimated ? '~' : '') + soil.cn : '—')}
          ${statBox(WM.t('Гумус'), `~${humus.humusPct}%`)}
          ${statBox(WM.t('ЕКО'), WM.t('{0} смоль/кг', soil.cec))}
          ${statBox(WM.t('Каменистость'), `${soil.cfvo}%`)}
          ${statBox(WM.t('Плотность'), WM.t('{0} г/см³', soil.bdod))}
        </div>

        <hr class="style-divider" style="margin:10px 0;">
        <div class="soil-metric-header"><span>${WM.t('💦 Водные свойства (Saxton &amp; Rawls)')}</span><b style="color:${hydro.drainage.tone};">${hydro.drainage.label}</b></div>
        <div class="gx-grid">
          ${statBox(WM.t('Пористость'), Math.round(hydro.thetaS * 100) + '%')}
          ${statBox(WM.t('Полевая влагоёмкость'), Math.round(hydro.fc * 100) + '%')}
          ${statBox(WM.t('Влажность завядания'), Math.round(hydro.pwp * 100) + '%')}
          ${statBox('Ksat', WM.t('{0} мм/ч', hydro.ks))}
        </div>

        <hr class="style-divider" style="margin:10px 0;">
        <div class="gx-note" style="font-weight:700;margin-bottom:3px;">${WM.t('Профиль по глубине')}</div>
        <table class="gx-table"><thead><tr><th>${WM.t('Горизонт')}</th><th>pH</th><th>${WM.t('Глина')}</th><th>${WM.t('Песок')}</th><th>${WM.t('SOC г/кг')}</th><th>${WM.t('N г/кг')}</th></tr></thead><tbody>${profRows}</tbody></table>
      </div>

      <div class="nav-actions-grid inat-actions-grid" style="margin-top:12px;">
        <button type="button" class="action-card-btn primary" id="btn-soil-find-plants">${WM.t('🌿 Растения iNat вокруг')}</button>
        <button type="button" class="action-card-btn" id="btn-soil-to-water">${WM.t('🌊 Вода и заболоченность')}</button>
        <button type="button" class="action-card-btn" id="btn-soil-copy-report">${WM.t('📋 Скопировать отчёт')}</button>
      </div>

      <div class="inat-traits-source-note" style="margin-top:12px;">
        <span>📚 <b>ISRIC SoilGrids 2.0</b>, <b>Open-Meteo</b>${WM.t('. Расчёт — оценка, а не полевой замер.')}</span>
      </div>
      ${renderDebugAccordion()}
      ${renderRawDataAccordion(ctx)}
    `;

    content.querySelectorAll('#gx-soil-season-tabs .gx-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        content.querySelectorAll('#gx-soil-season-tabs .gx-tab').forEach(b => b.classList.toggle('active', b === btn));
        content.querySelectorAll('.gx-season-pane').forEach(p => { p.hidden = p.dataset.pane !== btn.dataset.season; });
      });
    });

    document.getElementById('btn-soil-find-plants')?.addEventListener('click', () => {
      closeDiagnosisModal();
      if (WM.inat && WM.inat.openQuickHubModal) WM.inat.openQuickHubModal();
    });

    document.getElementById('btn-soil-to-water')?.addEventListener('click', () => {
      closeDiagnosisModal();
      if (WM.water && WM.water.runDiagnosisForCoords) WM.water.runDiagnosisForCoords(lat, lon);
    });
    document.getElementById('btn-soil-copy-raw-json')?.addEventListener('click', () => {
      const pre = document.getElementById('soil-raw-json-pre');
      if (pre && pre.textContent) {
        navigator.clipboard.writeText(pre.textContent).then(() => {
          if (WM.ui && WM.ui.showToast) WM.ui.showToast(WM.t('📋 Сырые данные почвы (JSON) скопированы'));
        });
      }
    });

    document.getElementById('btn-soil-copy-report')?.addEventListener('click', () => {
      const plain = s => String(s).replace(/<[^>]+>/g, '');
      const text = [
        WM.t('🧪 Почвенно-биотопный анализ [{0}, {1}]:', lat.toFixed(5), lon.toFixed(5)),
        WM.t('• Биотоп: {0} (сходство {1}%, уверенность {2}%)', biotope.title, top.similarity, matches.confidence),
        lc && lc.hasAny ? `• OSM: ${lc.tags.join(', ')}` : '',
        WM.t('• Почва: {0}; {1}', biotope.soilTypeRu, tex.name),
        terrain ? WM.t('• Рельеф: {0} м, {1}, уклон {2}°, над понижением {3} м', terrain.elevationM, terrain.aspectName, terrain.slopeDeg, terrain.hLow) : '',
        WM.t('• pH {0} (5–15 см: {1}); песок {2}%, ил {3}%, глина {4}%', soil.ph.toFixed(1), soil.phSub.toFixed(1), soil.sand, soil.silt, soil.clay),
        WM.t('• N {0} г/кг, C:N {1}, ЕКО {2} смоль/кг, гумус ~{3}%, каменистость {4}%', soil.nitrogen, soil.cn, soil.cec, humus.humusPct, soil.cfvo),
        WM.t('• Вода: {0}, Ksat {1} мм/ч, ПВ {2}%, ВЗ {3}%', hydro.drainage.label, hydro.ks, Math.round(hydro.fc * 100), Math.round(hydro.pwp * 100)),
        agro ? WM.t('• Погода: почва 6 см {0}°C, осадки 7/14 дн {1}/{2} мм, баланс {3} мм, {4}', sgn(agro.soilT6), agro.rain7, agro.rain14, sgn(agro.waterBalance), moist.title) : '',
        WM.t('• Грибной индекс: {0}% ({1})', fungal.score, fungal.phase),
        fungal.window ? `• ${fungal.window}` : '',
        WM.t('• Сейчас в сезоне: {0}', (biotope.fungi[seasonKey] || []).join(', ') || WM.t('нет')),
        `• ${plain(insights[insights.length - 1])}`
      ].filter(Boolean).join('\n');
      navigator.clipboard.writeText(text).then(() => {
        if (WM.ui && WM.ui.showToast) WM.ui.showToast(WM.t('📋 Отчёт о почве и рельефе скопирован'));
      });
    });
  }

  async function runDiagnosisForCoords(lat, lon) {
    const modal = document.getElementById('modal-soil-diagnosis');
    const content = document.getElementById('soil-diagnosis-content');
    const headerCoords = document.getElementById('soil-diagnosis-coords');
    if (!modal || !content) return;

    if (abortController) abortController.abort();
    abortController = new AbortController();
    const signal = abortController.signal;

    if (headerCoords) headerCoords.textContent = `📍 ${lat.toFixed(5)}°, ${lon.toFixed(5)}°`;

    content.innerHTML = `
      <div class="soil-loading-wrap">
        <div class="lb-spinner" style="width:36px;height:36px;border-width:3px;"></div>
        <div class="soil-loading-text">${WM.t('Запрос профиля почвы (SoilGrids), рельефа и погоды…')}</div>
        <small class="hint-text" style="text-align:center;">${WM.t('pH, текстура, органика, C:N, водные свойства, уклон и экспозиция, осадки за 14 дней')}</small>
      </div>`;

    modal.classList.add('open');
    if (WM.ui && WM.ui.pushHistoryState) WM.ui.pushHistoryState('soilDiagnosis');

    try {
      const results = await Promise.allSettled([
        getSoilGrids(lat, lon, signal),
        fetchAgro(lat, lon, signal),
        fetchTerrain(lat, lon, signal),
        fetchLandCover(lat, lon, signal)
      ]);

      if (signal.aborted) return;

      const soil = results[0].status === 'fulfilled' ? results[0].value : null;
      const agro = results[1].status === 'fulfilled' ? results[1].value : null;
      const terrain = results[2].status === 'fulfilled' ? results[2].value : null;
      const lc = results[3] && results[3].status === 'fulfilled' ? results[3].value : null;

      if (!soil && !agro && !terrain) {
        throw new Error(WM.t('Данные временно недоступны. Проверьте соединение с интернетом.'));
      }

      renderDiagnosisResult({ soil, agro, terrain, lc, lat, lon });
    } catch (err) {
      if (signal.aborted || (err && err.name === 'AbortError')) return;
      const msg = (err && err.message) || WM.t('Ошибка получения данных.');
      content.innerHTML = `
        <div class="sheet-empty-state" style="padding:24px 14px;">
          <div class="sheet-empty-icon">⚠️</div>
          <div class="sheet-empty-title">${WM.t('Сервис временно недоступен')}</div>
          <div class="sheet-empty-desc">${esc(msg)}</div>
          <button type="button" class="btn btn-primary" id="btn-soil-retry">${WM.t('↺ Повторить запрос')}</button>
        </div>
        ${renderDebugAccordion()}`;
      document.getElementById('btn-soil-retry')?.addEventListener('click', () => runDiagnosisForCoords(lat, lon));
    }
  }

  function openDiagnosis() {
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
    runDiagnosisForCoords(lat, lon);
  }

  function closeDiagnosisModal(syncHistory = true) {
    if (abortController) { abortController.abort(); abortController = null; }
    const modal = document.getElementById('modal-soil-diagnosis');
    if (modal) modal.classList.remove('open');
    if (syncHistory && WM.ui && WM.ui.clearHistoryState) WM.ui.clearHistoryState('soilDiagnosis');
  }

  function init() {
    const modal = document.getElementById('modal-soil-diagnosis');
    if (!modal || modal._inited) return;
    modal._inited = true;
    ensureStyles();
    document.getElementById('soil-diagnosis-close-x')?.addEventListener('click', () => closeDiagnosisModal());
    document.getElementById('btn-soil-diagnosis-close')?.addEventListener('click', () => closeDiagnosisModal());
    modal.addEventListener('click', (e) => { if (e.target === modal) closeDiagnosisModal(); });
  }

  document.addEventListener('DOMContentLoaded', init);

  WM.soil = {
    init,
    openDiagnosis,
    closeDiagnosisModal,
    runDiagnosisForCoords,
    getSoilGrids,
    getTerrain: fetchTerrain,
    getLandCover: fetchLandCover,
    computeHydroProps,
    fetchAgro,
    matchBiotopes,
    computeFungalIndex,
    assessMoisture,
    whereToGo,
    BIOTOPES
  };
})();
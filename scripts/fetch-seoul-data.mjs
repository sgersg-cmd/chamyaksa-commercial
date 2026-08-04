/**
 * SGIS(국가데이터처 통계지리정보서비스) → 전국 행정동 인구·가구·주택 통계 정적 수집
 *
 * 실행 위치 : GitHub Actions (서버측)
 *
 * [이 스크립트가 필요한 이유]
 *  SGIS의 JavaScript 인증(auth/javascriptAuth)은 지도 SDK(sop)만 내려주며
 *  통계 Data API용 accessToken을 제공하지 않습니다. (실측 확인)
 *  accessToken 발급에는 서비스 ID + 보안 Key 두 값이 필요한데,
 *  보안 Key를 정적 HTML에 넣으면 그대로 공개되므로 브라우저에서는 사용할 수 없습니다.
 *  → 서버에서 연 1회 수집해 시도별 JSON으로 저장소에 커밋합니다.
 *
 * 출력 : data/sgis/index.json      (시도 목록·기준연도·수집 시점)
 *        data/sgis/{시도코드}.json  (시도 → 시군구 → 행정동 3단계 통계)
 *
 * 환경변수
 *   SGIS_CONSUMER_KEY     : 서비스 ID
 *   SGIS_CONSUMER_SECRET  : 보안 Key
 *   SGIS_STAT_YEAR        : 기준연도 (기본 2024)
 *   SGIS_LIMIT_SIDO       : (선택) 시험 실행용. 예) "11" 이면 서울만 수집
 */

const BASE = 'https://sgisapi.mods.go.kr/OpenAPI3';
const CONSUMER_KEY = process.env.SGIS_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.SGIS_CONSUMER_SECRET;
const STAT_YEAR = Number(process.env.SGIS_STAT_YEAR || 2024);
const LIMIT_SIDO = (process.env.SGIS_LIMIT_SIDO || '').trim();
const CONCURRENCY = 6;

// 약국 수요와 직결되는 연령 구간만 수집합니다.
const AGE_DEFINITIONS = [
  ['10대', '31'], ['20대', '32'], ['30대', '33'], ['40대', '34'],
  ['50대', '35'], ['60대', '36'], ['70대', '37'], ['80대', '38'], ['90대', '39']
];
const AGE_UNDER15 = '22';
const AGE_OVER65 = '24';

let accessToken = '';
let callCount = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const num = (value) => {
  const parsed = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

function assertEnv() {
  if (!CONSUMER_KEY || !CONSUMER_SECRET) {
    console.error('환경변수 SGIS_CONSUMER_KEY / SGIS_CONSUMER_SECRET 가 없습니다.');
    console.error('GitHub Secrets 등록을 확인하세요.');
    process.exit(1);
  }
}

async function issueAccessToken() {
  const url = new URL(`${BASE}/auth/authentication.json`);
  url.searchParams.set('consumer_key', CONSUMER_KEY);
  url.searchParams.set('consumer_secret', CONSUMER_SECRET);

  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  const data = await response.json();
  if (Number(data.errCd) !== 0) {
    // 인증값이 로그에 남지 않도록 URL은 출력하지 않습니다.
    throw new Error(`accessToken 발급 실패 (errCd ${data.errCd}): ${data.errMsg || '원인 미상'}`);
  }
  const token = data?.result?.accessToken;
  if (!token) throw new Error('응답에 accessToken이 없습니다.');
  console.log('accessToken 발급 완료');
  return token;
}

/** SGIS Data API 호출. accessToken 만료 시 1회 재발급 후 재시도합니다. */
async function sgis(path, params = {}, retry = 2) {
  const url = new URL(`${BASE}/${path.replace(/^\//, '')}`);
  Object.entries({ ...params, accessToken }).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });

  for (let attempt = 1; attempt <= retry + 1; attempt += 1) {
    try {
      callCount += 1;
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
      const data = await response.json();
      const errCd = Number(data.errCd);
      if (errCd === 0) return data.result || [];
      // -401 계열은 토큰 만료/누락입니다.
      if (errCd === -401 && attempt <= retry) {
        console.warn('  accessToken 재발급 후 재시도합니다.');
        accessToken = await issueAccessToken();
        url.searchParams.set('accessToken', accessToken);
        continue;
      }
      throw new Error(`errCd ${data.errCd}: ${data.errMsg || ''}`);
    } catch (error) {
      if (attempt > retry) throw new Error(`${path} 실패 — ${error.message}`);
      await sleep(1000 * attempt);
    }
  }
  return [];
}

/** 동시 실행 수를 제한하며 작업을 처리합니다. */
async function runPool(items, worker, concurrency = CONCURRENCY) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try { results[index] = await worker(items[index], index); }
      catch (error) { results[index] = { __error: error.message }; }
    }
  });
  await Promise.all(runners);
  return results;
}

function baseStats(row) {
  return {
    admCd: String(row.adm_cd || ''),
    admNm: String(row.adm_nm || ''),
    totalPopulation: num(row.tot_ppltn),
    totalHouseholds: num(row.tot_family),
    totalHousing: num(row.tot_house),
    avgAge: Number(row.avg_age) || null,
    avgHouseholdSize: Number(row.avg_fmember_cnt) || null
  };
}

/** 한 시군구의 하위 행정동 통계를 한 번에 수집합니다. (low_search=1) */
async function collectSigungu(sigunguRow) {
  const admCd = sigunguRow.adm_cd;

  const dongRows = await sgis('stats/population.json', { year: STAT_YEAR, adm_cd: admCd, low_search: 1 });
  const dongs = new Map();
  for (const row of dongRows || []) {
    dongs.set(String(row.adm_cd), { ...baseStats(row), ageGroups: [], singleHouseholds: null, under15: 0, over65: 0 });
  }

  // 1인 가구
  try {
    const singleRows = await sgis('stats/household.json', {
      year: STAT_YEAR, adm_cd: admCd, low_search: 1, household_type: 'A0'
    });
    for (const row of singleRows || []) {
      const entry = dongs.get(String(row.adm_cd));
      if (entry) entry.singleHouseholds = num(row.household_cnt);
    }
  } catch (error) {
    console.warn(`  [1인가구 생략] ${sigunguRow.adm_nm}: ${error.message}`);
  }

  // 연령별 인구 (연령 구간마다 1회, low_search=1 로 하위 행정동 일괄 수신)
  const ageJobs = [
    [AGE_UNDER15, '__under15'],
    [AGE_OVER65, '__over65'],
    ...AGE_DEFINITIONS.map(([label, code]) => [code, label])
  ];
  for (const [ageType, label] of ageJobs) {
    try {
      const rows = await sgis('stats/searchpopulation.json', {
        year: STAT_YEAR, gender: 0, adm_cd: admCd, low_search: 1, age_type: ageType
      });
      for (const row of rows || []) {
        const entry = dongs.get(String(row.adm_cd));
        if (!entry) continue;
        const population = num(row.population);
        if (label === '__under15') entry.under15 = population;
        else if (label === '__over65') entry.over65 = population;
        else entry.ageGroups.push({ label, population });
      }
    } catch (error) {
      console.warn(`  [연령 ${label} 생략] ${sigunguRow.adm_nm}: ${error.message}`);
    }
  }

  // 주택유형 (행정동 단위 개별 조회. low_search 미지원이면 이 경로만 느려집니다)
  const dongCodes = [...dongs.keys()];
  await runPool(dongCodes, async (code) => {
    try {
      const rows = await sgis('startupbiz/housesummary.json', { adm_cd: code });
      const house = rows?.[0];
      if (!house) return;
      const entry = dongs.get(code);
      entry.apartmentHouseholds = house.apart_cnt !== undefined ? num(house.apart_cnt) : null;
      entry.rowHouseholds = house.row_house_cnt !== undefined ? num(house.row_house_cnt) : null;
      entry.detachedHouseholds = house.detach_house_cnt !== undefined ? num(house.detach_house_cnt) : null;
      entry.officetelHouseholds = house.officetel_cnt !== undefined ? num(house.officetel_cnt) : null;
    } catch (error) { /* 주택유형은 선택 항목이므로 조용히 넘어갑니다 */ }
  }, 4);

  // 약국 우선수요 인구 = 15세 미만 + 50대 이상
  for (const entry of dongs.values()) {
    const senior = entry.ageGroups
      .filter((group) => ['50대', '60대', '70대', '80대', '90대'].includes(group.label))
      .reduce((sum, group) => sum + group.population, 0);
    entry.priorityPopulation = entry.under15 + senior;
    entry.ageGroups.sort((a, b) =>
      AGE_DEFINITIONS.findIndex(([l]) => l === a.label) - AGE_DEFINITIONS.findIndex(([l]) => l === b.label)
    );
  }

  return { ...baseStats(sigunguRow), dongs: [...dongs.values()] };
}

async function main() {
  assertEnv();
  const startedAt = Date.now();
  console.log(`SGIS 전국 통계 수집을 시작합니다. (기준연도 ${STAT_YEAR})`);

  accessToken = await issueAccessToken();

  console.log('[1/3] 시도 목록 조회');
  let sidoRows = await sgis('stats/population.json', { year: STAT_YEAR, low_search: 1 });
  sidoRows = (sidoRows || []).filter((row) => row.adm_cd);
  if (LIMIT_SIDO) {
    sidoRows = sidoRows.filter((row) => String(row.adm_cd) === LIMIT_SIDO);
    console.log(`  시험 실행 모드: 시도 ${LIMIT_SIDO} 만 수집합니다.`);
  }
  if (!sidoRows.length) throw new Error('시도 목록이 비어 있습니다. 기준연도 또는 인증값을 확인하세요.');
  console.log(`  시도 ${sidoRows.length}개 확인`);

  const fs = await import('node:fs/promises');
  await fs.mkdir('data/sgis', { recursive: true });

  console.log('[2/3] 시도별 수집');
  const index = [];
  let totalDongs = 0;

  for (const sidoRow of sidoRows) {
    const sidoCd = String(sidoRow.adm_cd);
    const sigunguRows = await sgis('stats/population.json', { year: STAT_YEAR, adm_cd: sidoCd, low_search: 1 });
    const list = (sigunguRows || []).filter((row) => row.adm_cd);

    const sigungus = [];
    for (const sigunguRow of list) {
      const result = await collectSigungu(sigunguRow);
      sigungus.push(result);
      totalDongs += result.dongs.length;
    }

    const payload = {
      schemaVersion: 1,
      year: STAT_YEAR,
      generatedAt: new Date().toISOString(),
      sido: baseStats(sidoRow),
      sigungus
    };
    await fs.writeFile(`data/sgis/${sidoCd}.json`, JSON.stringify(payload), 'utf-8');

    const bytes = (await fs.stat(`data/sgis/${sidoCd}.json`)).size;
    const dongCount = sigungus.reduce((sum, item) => sum + item.dongs.length, 0);
    console.log(`  ${sidoRow.adm_nm} : 시군구 ${sigungus.length} · 행정동 ${dongCount} · ${(bytes / 1024).toFixed(0)}KB`);
    index.push({ admCd: sidoCd, admNm: String(sidoRow.adm_nm || ''), sigunguCount: sigungus.length, dongCount });
  }

  console.log('[3/3] 인덱스 저장');
  await fs.writeFile('data/sgis/index.json', JSON.stringify({
    schemaVersion: 1,
    year: STAT_YEAR,
    generatedAt: new Date().toISOString(),
    source: '국가데이터처 SGIS 오픈API 인구주택총조사 통계 (행정동 단위)',
    notice: '후보지 반경 300m 인구가 아니라 행정동 또는 시군구 단위 통계입니다.',
    partial: Boolean(LIMIT_SIDO),
    sidos: index
  }), 'utf-8');

  console.log('---');
  console.log(`시도 ${index.length} · 행정동 ${totalDongs}`);
  console.log(`API 호출 ${callCount.toLocaleString()}회 (SGIS 일일 한도 50,000회)`);
  console.log(`소요 시간 ${((Date.now() - startedAt) / 60000).toFixed(1)}분`);
}

main().catch((error) => {
  console.error('수집 실패:', error.message);
  process.exit(1);
});

/**
 * 전국 시군구별 약국 포화도 지표 수집
 *
 * 실행 위치 : GitHub Actions (서버측)
 *
 * [이 스크립트가 필요한 이유]
 *  서울 외 지역에는 서울시 상권분석서비스에 해당하는 공식 추정매출 데이터가 없습니다.
 *  (소상공인시장진흥공단 상가정보 API는 점포 목록만 제공하고 매출은 없으며,
 *   심평원 시군구별 진료비 통계는 약국을 제외하고 집계합니다.)
 *  대신 "이 지역이 약국 대비 과밀한가 여유가 있는가"는 전국 어디든 실데이터로 계산할 수 있고,
 *  약국 개설 판단에는 지역 평균 매출보다 오히려 더 직접적인 정보입니다.
 *
 * 산출 지표 (전부 실데이터 기반)
 *   · 약국 1곳당 배후인구  = 시군구 인구 ÷ 시군구 약국 수
 *   · 약국 1곳당 의사 수   = 시군구 의사 수 ÷ 시군구 약국 수
 *   · 전국 백분위          = 전국 시군구 중 위치
 *
 * 입력 : data/sgis/*.json  (이미 수집된 SGIS 시군구 인구를 재사용합니다)
 * 출력 : data/pharmacy-density.json
 */

const API_KEY = process.env.PUBLIC_DATA_KEY;
const ROWS = 500;        // 1,000행 요청은 상위 서버 응답이 30초를 넘겨 타임아웃이 잦았습니다.
const MAX_PAGES = 400;
const CONCURRENCY = 3;   // 동시 요청을 늘리면 타임아웃이 늘어나므로 3건으로 제한합니다.
const REQUEST_TIMEOUT_MS = 45000;
const OUTPUT_PATH = 'data/pharmacy-density.json';

const PHARMACY_URL = 'https://apis.data.go.kr/B551182/pharmacyInfoService/getParmacyBasisList';
const HOSPITAL_URL = 'https://apis.data.go.kr/B551182/hospInfoServicev2/getHospBasisList';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const num = (value) => {
  const parsed = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
};

function assertKey() {
  if (!API_KEY) {
    console.error('환경변수 PUBLIC_DATA_KEY 가 없습니다. GitHub Secrets 등록을 확인하세요.');
    process.exit(1);
  }
}

/** 약국정보서비스는 XML로 응답할 수 있어 JSON·XML 양쪽을 처리합니다. */
function parseItems(text) {
  try {
    const json = JSON.parse(text);
    const header = json?.response?.header;
    if (header && String(header.resultCode) !== '00') {
      throw new Error(`${header.resultCode} ${header.resultMsg || ''}`);
    }
    const item = json?.response?.body?.items?.item;
    const rows = !item ? [] : (Array.isArray(item) ? item : [item]);
    return { rows, total: num(json?.response?.body?.totalCount) };
  } catch (error) {
    if (error instanceof SyntaxError) return parseXmlItems(text);
    throw error;
  }
}

function parseXmlItems(text) {
  const codeMatch = text.match(/<resultCode>([^<]*)<\/resultCode>/);
  if (codeMatch && codeMatch[1].trim() !== '00') {
    const msg = (text.match(/<resultMsg>([^<]*)<\/resultMsg>/) || [])[1] || '';
    throw new Error(`${codeMatch[1].trim()} ${msg}`);
  }
  const totalMatch = text.match(/<totalCount>(\d+)<\/totalCount>/);
  const rows = [];
  const itemPattern = /<item>([\s\S]*?)<\/item>/g;
  let itemMatch;
  while ((itemMatch = itemPattern.exec(text)) !== null) {
    const row = {};
    const fieldPattern = /<([A-Za-z0-9_]+)>([\s\S]*?)<\/\1>/g;
    let fieldMatch;
    while ((fieldMatch = fieldPattern.exec(itemMatch[1])) !== null) {
      row[fieldMatch[1]] = fieldMatch[2].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    }
    rows.push(row);
  }
  return { rows, total: totalMatch ? num(totalMatch[1]) : rows.length };
}

async function callPage(baseUrl, pageNo) {
  const url = new URL(baseUrl);
  url.searchParams.set('serviceKey', API_KEY);
  url.searchParams.set('pageNo', String(pageNo));
  url.searchParams.set('numOfRows', String(ROWS));
  url.searchParams.set('_type', 'json');

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return parseItems(await response.text());
    } catch (error) {
      lastError = error;
      // 인증키가 쿼리에 포함되므로 오류 메시지에 URL을 출력하지 않습니다.
      console.warn(`  [재시도 ${attempt}/3] page ${pageNo}: ${error.message}`);
      await sleep(1000 * attempt);
    }
  }
  throw new Error(`page ${pageNo} 실패 — ${lastError?.message}`);
}

/** 동시 실행 수를 제한하며 작업을 처리합니다. */
async function runPool(items, worker, concurrency) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

/* 전국을 페이지 순회하며 시군구 단위로 집계합니다.
   1,000행 응답은 용량이 커서 공공데이터포털 응답이 페이지당 5~10초 걸립니다.
   순차 처리하면 100페이지 기준 15~25분이 소요되므로 동시 실행으로 단축합니다.
   일일 한도(10,000회) 대비 호출량이 100여 회에 불과해 부담이 없습니다. */
async function collectByDistrict(baseUrl, label, accumulate) {
  const startedAt = Date.now();
  const first = await callPage(baseUrl, 1);
  const total = Math.max(first.rows.length, first.total);
  const pages = Math.min(MAX_PAGES, Math.max(1, Math.ceil(total / ROWS)));
  console.log(`  ${label}: 총 ${total.toLocaleString()}건 / ${pages}페이지 (동시 ${CONCURRENCY}건 처리)`);

  const districts = new Map();
  const absorb = (rows) => {
    for (const row of rows) {
      const sido = String(row.sidoCdNm || '').trim();
      const sggu = String(row.sgguCdNm || '').trim();
      if (!sido || !sggu) continue;
      const key = `${sido}|${sggu}`;
      if (!districts.has(key)) {
        districts.set(key, { sido, sggu, sgguCd: String(row.sgguCd || ''), pharmacies: 0, hospitals: 0, doctors: 0 });
      }
      accumulate(districts.get(key), row);
    }
  };

  absorb(first.rows);
  const remaining = Array.from({ length: Math.max(0, pages - 1) }, (_, index) => index + 2);
  let done = 1;
  await runPool(remaining, async (page) => {
    const result = await callPage(baseUrl, page);
    absorb(result.rows);
    done += 1;
    if (done % 20 === 0 || done === pages) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
      console.log(`    ... ${done}/${pages}페이지 · 시군구 ${districts.size}개 · 경과 ${elapsed}초`);
    }
  }, CONCURRENCY);

  console.log(`  → ${label} 집계 완료: 시군구 ${districts.size}개 (${((Date.now() - startedAt) / 1000).toFixed(0)}초)`);
  return districts;
}

/** 이미 수집해 둔 SGIS 시군구 인구를 재사용합니다. (추가 API 호출 없음) */
async function loadSgisPopulation() {
  const fs = await import('node:fs/promises');
  let files = [];
  try {
    files = (await fs.readdir('data/sgis')).filter((name) => /^\d+\.json$/.test(name));
  } catch (error) {
    throw new Error('data/sgis 폴더가 없습니다. 「SGIS 인구통계 수집」 워크플로를 먼저 실행하세요.');
  }
  if (!files.length) throw new Error('data/sgis 안에 시도별 파일이 없습니다.');

  const population = new Map();
  let year = null;
  for (const file of files) {
    const payload = JSON.parse(await fs.readFile(`data/sgis/${file}`, 'utf-8'));
    year = year || payload.year;
    const sidoName = String(payload.sido?.admNm || '').trim();
    for (const sigungu of payload.sigungus || []) {
      const name = String(sigungu.admNm || '').trim();
      if (!name) continue;
      population.set(`${sidoName}|${name}`, {
        sido: sidoName,
        sggu: name,
        totalPopulation: sigungu.totalPopulation || 0,
        totalHouseholds: sigungu.totalHouseholds || 0
      });
    }
  }
  console.log(`  SGIS 인구 재사용: ${population.size}개 시군구 (${year}년 기준)`);
  return { population, year };
}

/* 심평원과 SGIS는 지역명 표기 방식이 다릅니다. 실측으로 확인된 차이는 세 가지입니다.
     ① 시도명 축약   : 심평원 "경남"        ↔ SGIS "경상남도"
     ② 시도명 접두   : 심평원 "대구남구"     ↔ SGIS "남구"
     ③ 시·구 결합    : 심평원 "성남분당구"   ↔ SGIS "성남시 분당구"
   양쪽에서 가능한 표기를 모두 만들어 교집합으로 대조합니다. */
const SIDO_FULL_NAME = {
  '서울': '서울특별시', '부산': '부산광역시', '대구': '대구광역시', '인천': '인천광역시',
  '광주': '광주광역시', '대전': '대전광역시', '울산': '울산광역시', '세종': '세종특별자치시',
  '경기': '경기도', '강원': '강원특별자치도', '충북': '충청북도', '충남': '충청남도',
  '전북': '전북특별자치도', '전남': '전라남도', '경북': '경상북도', '경남': '경상남도',
  '제주': '제주특별자치도'
};

const trimSidoSuffix = (value) => String(value || '').replace(/(특별자치도|특별자치시|특별시|광역시|도)$/, '');
const compactName = (value) => String(value || '').replace(/\s+/g, '');

function sidoMatches(hiraSido, sgisSido) {
  const short = trimSidoSuffix(hiraSido);
  if (SIDO_FULL_NAME[short] === sgisSido) return true;
  return trimSidoSuffix(sgisSido) === short;
}

/** SGIS "성남시 분당구" → ["성남시분당구", "성남분당구", "분당구"] */
function sgisNameAliases(sggu) {
  const name = compactName(sggu);
  const aliases = new Set([name]);
  const match = name.match(/^(.+?)시(.+구)$/);
  if (match) { aliases.add(match[1] + match[2]); aliases.add(match[2]); }
  return aliases;
}

/** 심평원 "대구남구"(시도 접두) → ["대구남구", "남구"] */
function hiraNameAliases(sido, sggu) {
  const name = compactName(sggu);
  const short = trimSidoSuffix(sido);
  const aliases = new Set([name]);
  if (short && name.startsWith(short) && name.length > short.length) aliases.add(name.slice(short.length));
  return aliases;
}

function matchPopulation(populationMap, sido, sggu) {
  const candidates = hiraNameAliases(sido, sggu);
  let looseHit = null;
  for (const [, value] of populationMap) {
    const aliases = sgisNameAliases(value.sggu);
    let hit = false;
    for (const candidate of candidates) { if (aliases.has(candidate)) { hit = true; break; } }
    if (!hit) continue;
    if (sidoMatches(sido, value.sido)) return value;   // 시도까지 일치하면 확정
    looseHit = looseHit || value;                       // 시군구명만 맞으면 예비 후보
  }
  return looseHit;
}

function percentileRank(sortedValues, value) {
  if (!sortedValues.length) return null;
  let below = 0;
  for (const item of sortedValues) {
    if (item < value) below += 1; else break;
  }
  return Math.round((below / sortedValues.length) * 100);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

async function main() {
  assertKey();
  const startedAt = Date.now();
  console.log('전국 약국 포화도 지표 수집을 시작합니다.');

  console.log('[1/4] SGIS 시군구 인구 불러오기');
  const { population, year } = await loadSgisPopulation();

  console.log('[2/4] 전국 약국 집계');
  const pharmacyMap = await collectByDistrict(PHARMACY_URL, '약국정보서비스', (entry) => {
    entry.pharmacies += 1;
  });

  console.log('[3/4] 전국 의료기관·의사 집계');
  const hospitalMap = await collectByDistrict(HOSPITAL_URL, '병원정보서비스', (entry, row) => {
    entry.hospitals += 1;
    entry.doctors += num(row.drTotCnt);
  });

  console.log('[4/4] 지표 산출');
  const districts = [];
  for (const [key, pharmacy] of pharmacyMap) {
    if (!pharmacy.pharmacies) continue;
    const hospital = hospitalMap.get(key);
    const matched = matchPopulation(population, pharmacy.sido, pharmacy.sggu);
    districts.push({
      sido: pharmacy.sido,
      sggu: pharmacy.sggu,
      sgguCd: pharmacy.sgguCd,
      pharmacies: pharmacy.pharmacies,
      hospitals: hospital?.hospitals || 0,
      doctors: hospital?.doctors || 0,
      population: matched?.totalPopulation || 0,
      populationPerPharmacy: matched?.totalPopulation ? Math.round(matched.totalPopulation / pharmacy.pharmacies) : null,
      doctorsPerPharmacy: hospital?.doctors ? Number((hospital.doctors / pharmacy.pharmacies).toFixed(2)) : null
    });
  }

  const popValues = districts.map((d) => d.populationPerPharmacy).filter((v) => v > 0).sort((a, b) => a - b);
  const docValues = districts.map((d) => d.doctorsPerPharmacy).filter((v) => v > 0).sort((a, b) => a - b);

  districts.forEach((district) => {
    district.populationPercentile = district.populationPerPharmacy ? percentileRank(popValues, district.populationPerPharmacy) : null;
    district.doctorsPercentile = district.doctorsPerPharmacy ? percentileRank(docValues, district.doctorsPerPharmacy) : null;
  });

  const matchedCount = districts.filter((d) => d.populationPerPharmacy).length;
  const unmatched = districts.filter((d) => !d.populationPerPharmacy).map((d) => `${d.sido} ${d.sggu}`);
  if (unmatched.length) {
    console.log(`  인구 미매칭 ${unmatched.length}건: ${unmatched.slice(0, 20).join(', ')}${unmatched.length > 20 ? ' …' : ''}`);
  }
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    populationYear: year,
    source: '심평원 약국정보서비스·병원정보서비스 실데이터 + 국가데이터처 SGIS 인구',
    notice: '시군구 단위 실측 집계입니다. 후보지 반경 수치가 아니며 매출을 의미하지도 않습니다.',
    national: {
      districtCount: districts.length,
      matchedCount,
      totalPharmacies: districts.reduce((sum, d) => sum + d.pharmacies, 0),
      medianPopulationPerPharmacy: median(popValues),
      medianDoctorsPerPharmacy: docValues.length ? Number(median(docValues.map((v) => v * 100)) / 100) : 0
    },
    districts: districts.sort((a, b) => (a.sido + a.sggu).localeCompare(b.sido + b.sggu))
  };

  const fs = await import('node:fs/promises');
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(payload), 'utf-8');
  const bytes = (await fs.stat(OUTPUT_PATH)).size;

  console.log('---');
  console.log(`시군구            : ${districts.length} (인구 매칭 ${matchedCount})`);
  console.log(`전국 약국         : ${payload.national.totalPharmacies.toLocaleString()}개`);
  console.log(`약국 1곳당 배후인구 중앙값 : ${payload.national.medianPopulationPerPharmacy.toLocaleString()}명`);
  console.log(`약국 1곳당 의사 수 중앙값  : ${payload.national.medianDoctorsPerPharmacy}명`);
  console.log(`파일 크기         : ${(bytes / 1024).toFixed(0)} KB`);
  console.log(`소요 시간         : ${((Date.now() - startedAt) / 60000).toFixed(1)}분`);
}

main().catch((error) => {
  console.error('수집 실패:', error.message);
  process.exit(1);
});

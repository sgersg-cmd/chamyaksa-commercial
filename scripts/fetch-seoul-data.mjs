/**
 * 서울 열린데이터광장 → 약국(의약품) 업종 상권데이터 정적 수집 스크립트
 *
 * 실행 위치 : GitHub Actions (서버측)
 * 목적      : 브라우저가 공개 CORS 프록시를 거치지 않고 정적 JSON만 읽도록 만든다.
 *
 * [이 스크립트가 필요한 이유]
 *  - 서울 열린데이터광장 OpenAPI는 HTTP만 제공한다. (HTTPS 미지원 실측 확인)
 *  - GitHub Pages는 HTTPS이므로 브라우저 직접 호출은 Mixed Content로 차단된다.
 *  - 공개 CORS 프록시(allorigins/corsproxy)는 응답 2~4초, 간헐 실패, 인증키 제3자 경유 문제가 있다.
 *  - 매출 서비스는 분기 필터를 적용해도 16,000행 이상이라 브라우저에서 탐색이 사실상 불가능하다.
 *  → 서버에서 분기 1회 수집해 424개 행정동 × 3종만 남긴 JSON을 저장소에 커밋한다.
 *
 * 출력 : data/seoul-commercial.json
 */

const API_KEY = process.env.SEOUL_API_KEY;
const BASE = 'http://openapi.seoul.go.kr:8088';
const PAGE_SIZE = 1000;
const OUTPUT_PATH = 'data/seoul-commercial.json';

const SERVICES = {
  sales: 'VwsmAdstrdSelngW',   // 행정동별 추정매출
  stores: 'VwsmAdstrdStorW',   // 행정동별 점포
  flow: 'VwsmAdstrdFlpopW'     // 행정동별 생활인구
};

// 저장할 필드만 추립니다. (전체 필드를 담으면 파일이 불필요하게 커집니다)
const KEEP_FIELDS = {
  sales: ['THSMON_SELNG_AMT', 'THSMON_SELNG_CO'],
  stores: ['SIMILR_INDUTY_STOR_CO', 'STOR_CO', 'FRC_STOR_CO', 'OPBIZ_RT', 'CLSBIZ_RT'],
  flow: [
    'TOT_FLPOP_CO',
    'MON_FLPOP_CO', 'TUES_FLPOP_CO', 'WED_FLPOP_CO', 'THUR_FLPOP_CO', 'FRI_FLPOP_CO',
    'SAT_FLPOP_CO', 'SUN_FLPOP_CO',
    'TMZON_00_06_FLPOP_CO', 'TMZON_06_11_FLPOP_CO', 'TMZON_11_14_FLPOP_CO',
    'TMZON_14_17_FLPOP_CO', 'TMZON_17_21_FLPOP_CO', 'TMZON_21_24_FLPOP_CO'
  ]
};

const PHARMACY_PATTERN = /의약품|약국/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assertKey() {
  if (!API_KEY) {
    console.error('환경변수 SEOUL_API_KEY 가 없습니다. GitHub Secrets 등록을 확인하세요.');
    process.exit(1);
  }
}

/** 서울 OpenAPI 1회 호출. 실패 시 최대 3회 재시도합니다. */
async function callSeoul(service, startIndex, endIndex, quarter) {
  const suffix = quarter ? `${encodeURIComponent(quarter)}/` : '';
  const url = `${BASE}/${API_KEY}/json/${service}/${startIndex}/${endIndex}/${suffix}`;

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      const envelope = json[service];
      if (!envelope) {
        const message = json?.RESULT?.MESSAGE || '응답 구조 확인 실패';
        throw new Error(message);
      }
      const code = envelope?.RESULT?.CODE || '';
      if (code && code !== 'INFO-000') throw new Error(`${code} ${envelope?.RESULT?.MESSAGE || ''}`);
      return {
        total: Number(envelope.list_total_count || 0),
        rows: Array.isArray(envelope.row) ? envelope.row : []
      };
    } catch (error) {
      lastError = error;
      // 인증키가 URL 경로에 포함되므로 오류 메시지에 URL을 절대 출력하지 않습니다.
      console.warn(`  [재시도 ${attempt}/3] ${service} ${startIndex}-${endIndex}: ${error.message}`);
      await sleep(2000 * attempt);
    }
  }
  throw new Error(`${service} ${startIndex}-${endIndex} 호출 실패: ${lastError?.message}`);
}

/**
 * 최신 기준분기 판정.
 * 서울 API는 정렬을 보장하지 않으므로 앞·중간·끝 표본 중 최대 분기코드를 사용합니다.
 * (실측: 1행 = 20253, 마지막 행 = 20261 → 최신은 목록 끝에 위치)
 */
async function resolveLatestQuarter(service) {
  const first = await callSeoul(service, 1, 1, null);
  const total = Math.max(1, first.total);
  const positions = [...new Set([1, Math.floor(total / 2) || 1, total])];

  const quarters = [];
  for (const position of positions) {
    const page = position === 1 ? first : await callSeoul(service, position, position, null);
    const value = String(page.rows?.[0]?.STDR_YYQU_CD || '');
    if (/^\d{5}$/.test(value)) quarters.push(value);
  }
  if (!quarters.length) throw new Error(`${service} 기준분기를 확인하지 못했습니다.`);

  const latest = quarters.sort((a, b) => Number(b) - Number(a))[0];
  console.log(`  기준분기 후보 ${quarters.join(', ')} → 최신 ${latest} 선택`);
  return latest;
}

/** 특정 분기의 전체 행을 순회하며 filterFn 을 통과한 행만 모읍니다. */
async function collectRows(service, quarter, filterFn) {
  const first = await callSeoul(service, 1, PAGE_SIZE, quarter);
  const total = Math.max(1, first.total);
  const pages = Math.ceil(total / PAGE_SIZE);
  console.log(`  ${service} ${quarter} 총 ${total.toLocaleString()}행 / ${pages}페이지`);

  const collected = new Map();
  const absorb = (rows) => {
    for (const row of rows) {
      if (!filterFn(row)) continue;
      const code = String(row.ADSTRD_CD || '').replace(/\D/g, '').slice(0, 8);
      if (!code) continue;
      collected.set(code, row);
    }
  };

  absorb(first.rows);
  for (let page = 2; page <= pages; page += 1) {
    const start = (page - 1) * PAGE_SIZE + 1;
    const end = Math.min(total, start + PAGE_SIZE - 1);
    const result = await callSeoul(service, start, end, quarter);
    absorb(result.rows);
    if (page % 5 === 0) console.log(`    ... ${page}/${pages} 페이지 (누적 ${collected.size}개 행정동)`);
    await sleep(300); // 서버 부하 방지
  }

  console.log(`  → ${service} 수집 완료: ${collected.size}개 행정동`);
  return collected;
}

function pickFields(row, fields) {
  const picked = {};
  for (const field of fields) {
    if (row[field] !== undefined && row[field] !== null) picked[field] = row[field];
  }
  return picked;
}

async function main() {
  assertKey();
  console.log('서울 상권데이터 수집을 시작합니다.');

  console.log('[1/4] 최신 기준분기 확인');
  const quarter = await resolveLatestQuarter(SERVICES.sales);

  console.log('[2/4] 의약품 업종 추정매출 수집');
  const sales = await collectRows(SERVICES.sales, quarter, (row) =>
    PHARMACY_PATTERN.test(String(row.SVC_INDUTY_CD_NM || '').replace(/\s+/g, ''))
  );

  console.log('[3/4] 의약품 업종 점포 수집');
  const stores = await collectRows(SERVICES.stores, quarter, (row) =>
    PHARMACY_PATTERN.test(String(row.SVC_INDUTY_CD_NM || '').replace(/\s+/g, ''))
  );

  console.log('[4/4] 생활인구 수집');
  const flow = await collectRows(SERVICES.flow, quarter, () => true);

  const codes = new Set([...sales.keys(), ...stores.keys(), ...flow.keys()]);
  if (codes.size === 0) throw new Error('수집 결과가 비어 있습니다. 서비스명 또는 인증키를 확인하세요.');

  const dongs = {};
  for (const code of [...codes].sort()) {
    const anyRow = sales.get(code) || stores.get(code) || flow.get(code);
    dongs[code] = {
      name: String(anyRow?.ADSTRD_CD_NM || ''),
      sales: sales.has(code) ? pickFields(sales.get(code), KEEP_FIELDS.sales) : null,
      stores: stores.has(code) ? pickFields(stores.get(code), KEEP_FIELDS.stores) : null,
      flow: flow.has(code) ? pickFields(flow.get(code), KEEP_FIELDS.flow) : null
    };
  }

  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    quarter,
    source: '서울특별시 열린데이터광장 · 서울신용보증재단 우리마을가게 상권분석서비스 (행정동 단위 공식 추정데이터)',
    notice: '특정 약국의 실제 매출이나 후보지 반경의 실측 보행량이 아닙니다.',
    counts: { sales: sales.size, stores: stores.size, flow: flow.size, dongs: codes.size },
    dongs
  };

  const fs = await import('node:fs/promises');
  await fs.mkdir('data', { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(payload, null, 0), 'utf-8');

  const bytes = (await fs.stat(OUTPUT_PATH)).size;
  console.log('---');
  console.log(`기준분기      : ${quarter}`);
  console.log(`행정동 수     : ${codes.size}`);
  console.log(`매출/점포/유동: ${sales.size} / ${stores.size} / ${flow.size}`);
  console.log(`파일 크기     : ${(bytes / 1024).toFixed(1)} KB`);
  console.log(`저장 위치     : ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error('수집 실패:', error.message);
  process.exit(1);
});

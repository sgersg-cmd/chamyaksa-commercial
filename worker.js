const VERSION = '5.3.0';
const ALLOWED_ORIGINS = new Set([
  'https://sgersg-cmd.github.io',
  'http://127.0.0.1:8765',
  'http://localhost:8765',
]);

const SEOUL_SERVICES = new Set([
  'TbgisAdstrdRelmW',
  'VwsmAdstrdSelngW',
  'VwsmAdstrdStorW',
  'VwsmAdstrdFlpopW',
]);

const BUILDING_PERMIT_OPERATIONS = new Set([
  'getApBasisOulnInfo',
  'getApBasisInfo',
]);

function corsHeaders(origin) {
  const allowedOrigin = ALLOWED_ORIGINS.has(origin)
    ? origin
    : 'https://sgersg-cmd.github.io';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Expose-Headers': 'X-Chamyaksa-Data-Source, X-Chamyaksa-Snapshot-At, X-Chamyaksa-Proxy-Version',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function jsonResponse(data, status, origin, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Chamyaksa-Proxy-Version': VERSION,
      ...corsHeaders(origin),
      ...extraHeaders,
    },
  });
}

function cleanText(value, maxLength = 100) {
  return String(value || '').trim().slice(0, maxLength);
}

function cleanInteger(value, fallback, min, max) {
  const number = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function copyAllowedParams(source, target, names) {
  for (const name of names) {
    const value = cleanText(source.get(name), 200);
    if (value) target.searchParams.set(name, value);
  }
}

function addPublicDataDefaults(target, source, secret) {
  target.searchParams.set('serviceKey', secret);
  target.searchParams.set('_type', 'json');
  target.searchParams.set('pageNo', String(cleanInteger(source.get('pageNo'), 1, 1, 1000)));
  target.searchParams.set('numOfRows', String(cleanInteger(source.get('numOfRows'), 100, 1, 1000)));
}

function buildHiraBasisUrl(source, env) {
  const target = new URL('https://apis.data.go.kr/B551182/hospInfoServicev2/getHospBasisList');
  addPublicDataDefaults(target, source, env.PUBLIC_DATA_KEY);
  copyAllowedParams(source, target, [
    'emdongNm', 'sidoCd', 'sgguCd', 'xPos', 'yPos', 'radius',
  ]);
  // 의료기관 기본정보는 수시 변동성이 낮아 6시간 동안 정상 응답을 엣지 캐시에서 재사용합니다.
  return { target, cacheTtl: 21600 };
}

function buildHiraDetailUrl(source, env) {
  const ykiho = cleanText(source.get('ykiho'), 120);
  if (!ykiho) throw new Error('ykiho가 필요합니다.');
  const target = new URL('https://apis.data.go.kr/B551182/MadmDtlInfoService2.8/getDgsbjtInfo2.8');
  addPublicDataDefaults(target, source, env.PUBLIC_DATA_KEY);
  target.searchParams.set('ykiho', ykiho);
  return { target, cacheTtl: 86400 };
}

function addBuildingParams(target, source, env) {
  addPublicDataDefaults(target, source, env.PUBLIC_DATA_KEY);
  copyAllowedParams(source, target, [
    'sigunguCd', 'bjdongCd', 'platGbCd', 'bun', 'ji',
  ]);
}

function buildBuildingLedgerUrl(source, env) {
  const target = new URL('https://apis.data.go.kr/1613000/BldRgstHubService/getBrTitleInfo');
  addBuildingParams(target, source, env);
  return { target, cacheTtl: 86400 };
}

function buildBuildingPermitUrl(source, env) {
  const operation = cleanText(source.get('operation'), 40);
  if (!BUILDING_PERMIT_OPERATIONS.has(operation)) {
    throw new Error('허용되지 않은 건축인허가 조회 항목입니다.');
  }
  const target = new URL(`https://apis.data.go.kr/1613000/ArchPmsHubService/${operation}`);
  addBuildingParams(target, source, env);
  return { target, cacheTtl: 3600 };
}

function buildSeoulUrl(source, env) {
  if (!env.SEOUL_OPEN_DATA_KEY) {
    throw new Error('SEOUL_OPEN_DATA_KEY가 등록되지 않았습니다.');
  }
  const service = cleanText(source.get('service'), 50);
  if (!SEOUL_SERVICES.has(service)) {
    throw new Error('허용되지 않은 서울시 데이터 서비스입니다.');
  }
  const start = cleanInteger(source.get('start'), 1, 1, 1000000);
  const end = cleanInteger(source.get('end'), start, start, Math.min(1000000, start + 999));
  const quarter = cleanText(source.get('quarter'), 5);
  if (quarter && !/^\d{5}$/.test(quarter)) {
    throw new Error('기준분기 형식이 올바르지 않습니다.');
  }
  const suffix = quarter ? `/${quarter}` : '';
  const target = new URL(
    `http://openapi.seoul.go.kr:8088/${env.SEOUL_OPEN_DATA_KEY}/json/${service}/${start}/${end}${suffix}/`,
  );
  return { target, cacheTtl: 3600 };
}

function resolveUpstream(pathname, source, env) {
  if (!env.PUBLIC_DATA_KEY && pathname !== '/api/seoul') {
    throw new Error('PUBLIC_DATA_KEY가 등록되지 않았습니다.');
  }
  switch (pathname) {
    case '/api/hira/basis':
      return buildHiraBasisUrl(source, env);
    case '/api/hira/detail':
      return buildHiraDetailUrl(source, env);
    case '/api/building/ledger':
      return buildBuildingLedgerUrl(source, env);
    case '/api/building/permit':
      return buildBuildingPermitUrl(source, env);
    case '/api/seoul':
      return buildSeoulUrl(source, env);
    default:
      return null;
  }
}

async function fetchWithTimeout(target, cacheTtl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('upstream timeout'), 20000);
  try {
    return await fetch(target, {
      signal: controller.signal,
      headers: { Accept: 'application/json, application/xml, text/xml;q=0.9, */*;q=0.8' },
      cf: {
        cacheEverything: true,
        cacheTtl,
        cacheTtlByStatus: { '200-299': cacheTtl, '400-599': 0 },
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return jsonResponse({ ok: false, error: '허용되지 않은 사이트입니다.' }, 403, origin);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== 'GET') {
      return jsonResponse({ ok: false, error: 'GET 요청만 허용됩니다.' }, 405, origin);
    }

    if (requestUrl.pathname === '/health') {
      return jsonResponse({
        ok: true,
        service: 'chamyaksa-api',
        version: VERSION,
        publicDataKeyConfigured: Boolean(env.PUBLIC_DATA_KEY),
        seoulKeyConfigured: Boolean(env.SEOUL_OPEN_DATA_KEY),
      }, 200, origin);
    }

    let upstream;
    try {
      upstream = resolveUpstream(requestUrl.pathname, requestUrl.searchParams, env);
      if (!upstream) {
        return jsonResponse({ ok: false, error: '존재하지 않는 API 경로입니다.' }, 404, origin);
      }
    } catch (error) {
      return jsonResponse({ ok: false, error: error.message || '요청값이 올바르지 않습니다.' }, 400, origin);
    }

    try {
      const upstreamResponse = await fetchWithTimeout(upstream.target, upstream.cacheTtl);
      const body = await upstreamResponse.arrayBuffer();
      const headers = new Headers(corsHeaders(origin));
      headers.set('Content-Type', upstreamResponse.headers.get('Content-Type') || 'application/json; charset=utf-8');
      headers.set('Cache-Control', `public, max-age=${Math.min(upstream.cacheTtl, 3600)}`);
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('X-Chamyaksa-Proxy-Version', VERSION);
      const cacheStatus = String(upstreamResponse.headers.get('CF-Cache-Status') || '').toUpperCase();
      headers.set('X-Chamyaksa-Data-Source', cacheStatus === 'HIT' ? 'edge-cache' : 'live');
      headers.set('X-Chamyaksa-Snapshot-At', upstreamResponse.headers.get('Date') || new Date().toUTCString());
      return new Response(body, { status: upstreamResponse.status, headers });
    } catch (error) {
      const timedOut = error?.name === 'AbortError';
      return jsonResponse({
        ok: false,
        error: timedOut ? '공공데이터 응답 시간이 초과되었습니다.' : '공공데이터 연결에 실패했습니다.',
      }, timedOut ? 504 : 502, origin);
    }
  },
};

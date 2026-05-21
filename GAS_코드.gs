/**
 * ╔════════════════════════════════════════════════════════════════════╗
 * ║  Google Apps Script: Stock & Bond Price Fetcher v2               ║
 * ║                                                                    ║
 * ║  역할 1: 야후/네이버에서 주가 + 등락 조회                         ║
 * ║  역할 2: 공공데이터포털 금융위원회 API로 국채 시세 조회            ║
 * ║  역할 3: 네이버 금융에서 하나은행 고시 환율 조회                   ║
 * ║                                                                    ║
 * ║  v2 변경사항:                                                      ║
 * ║    - 주가 응답에 change, changeRate, prevClose 추가 (등락 표시)    ║
 * ║    - Yahoo: 전일 종가 비교로 등락 계산                             ║
 * ║    - Naver: changePrice, fluctuationsRatio 필드 활용               ║
 * ╚════════════════════════════════════════════════════════════════════╝
 */

const TIMEOUT_MS = 8000;
const RETRIES    = 2;

function doGet(e) {
  try {
    const type = (e.parameter.type || '').trim().toLowerCase();

    if (type === 'bond') return fetchBondPrice(e);
    if (type === 'fx')   return fetchNaverFX(e);

    // ── 주가 조회 ──────────────────────────────────────────────
    let ticker = e.parameter.ticker ? String(e.parameter.ticker).trim() : '';
    const symbol = e.parameter.symbol ? String(e.parameter.symbol).trim() : '';

    if (!ticker && !symbol) {
      return createResponse({ success: false, error: 'ticker 또는 symbol 필요' }, 400);
    }

    let resolvedSymbol;
    if (symbol) {
      resolvedSymbol = symbol;
    } else {
      // KOSPI: .KS, KOSDAQ: .KQ — 기본 KQ 시도 후 KS 폴백
      resolvedSymbol = String(ticker).padStart(6, '0') + '.KQ';
    }

    Logger.log('주가 조회 시작: ' + resolvedSymbol);

    let result = fetchViaYahoo(resolvedSymbol);

    // KOSDAQ 실패 시 KOSPI 시도
    if (!result && resolvedSymbol.endsWith('.KQ')) {
      const ksTicker = resolvedSymbol.replace('.KQ', '.KS');
      Logger.log('KQ 실패, KS 재시도: ' + ksTicker);
      result = fetchViaYahoo(ksTicker);
    }

    // Yahoo 실패 시 네이버 폴백
    if (!result) {
      const naverCode = resolvedSymbol.replace(/\.(KS|KQ)$/, '');
      result = fetchViaNaver(naverCode);
    }

    if (!result) {
      return createResponse({ success: false, error: '주가 조회 실패 (야후/네이버 모두 응답 없음)' }, 503);
    }

    return createResponse({
      success:     true,
      price:       result.price,
      prevClose:   result.prevClose   || null,
      change:      result.change      || null,
      changeRate:  result.changeRate  || null,
      date:        result.date,
      source:      result.source,
      symbol:      resolvedSymbol
    }, 200);

  } catch (err) {
    Logger.log('ERROR: ' + err.toString());
    return createResponse({ success: false, error: err.toString().slice(0, 100) }, 500);
  }
}


// ══════════════════════════════════════════════════════════════════════
//  Yahoo Finance v8 — 주가 + 전일 종가 → 등락 계산
// ══════════════════════════════════════════════════════════════════════
function fetchViaYahoo(symbol) {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/'
              + encodeURIComponent(symbol)
              + '?interval=1d&range=5d&includePrePost=false';

    const options = {
      method:  'get',
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept':     'application/json',
        'Referer':    'https://finance.yahoo.com/'
      },
      muteHttpExceptions: true,
      timeout:            TIMEOUT_MS
    };

    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() !== 200) {
      Logger.log('Yahoo HTTP ' + response.getResponseCode());
      return null;
    }

    const data   = JSON.parse(response.getContentText());
    const result = data.chart && data.chart.result && data.chart.result[0];
    if (!result) return null;

    const meta       = result.meta || {};
    const closes     = (result.indicators && result.indicators.quote &&
                        result.indicators.quote[0] && result.indicators.quote[0].close) || [];
    const timestamps = result.timestamp || [];

    // 가장 최근 유효 종가 찾기
    let price = null, priceDate = null, priceIdx = -1;
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] !== null && closes[i] !== undefined && closes[i] > 0) {
        price     = Math.round(closes[i]);
        priceDate = formatDate(new Date(timestamps[i] * 1000));
        priceIdx  = i;
        break;
      }
    }
    if (price === null) return null;

    // 전일 종가: 바로 이전 유효 종가
    let prevClose = null;
    for (let i = priceIdx - 1; i >= 0; i--) {
      if (closes[i] !== null && closes[i] !== undefined && closes[i] > 0) {
        prevClose = Math.round(closes[i]);
        break;
      }
    }

    // meta.previousClose가 있으면 우선 사용
    if (meta.previousClose && meta.previousClose > 0) {
      prevClose = Math.round(meta.previousClose);
    }
    if (meta.chartPreviousClose && meta.chartPreviousClose > 0) {
      prevClose = Math.round(meta.chartPreviousClose);
    }

    // 등락 계산
    let change = null, changeRate = null;
    if (prevClose && prevClose > 0) {
      change     = price - prevClose;
      changeRate = Math.round((change / prevClose * 100) * 100) / 100;
    }

    Logger.log('Yahoo 성공: ' + symbol + ' ' + price + '원 (전일: ' + prevClose + ', 등락: ' + change + ')');

    return {
      price,
      prevClose,
      change,
      changeRate,
      date:   priceDate,
      source: 'yahoo'
    };

  } catch (e) {
    Logger.log('fetchViaYahoo error: ' + e.toString());
    return null;
  }
}


// ══════════════════════════════════════════════════════════════════════
//  네이버 증권 모바일 API — 주가 + 등락 (Yahoo 폴백)
// ══════════════════════════════════════════════════════════════════════
function fetchViaNaver(code6) {
  const endpoints = [
    'https://m.stock.naver.com/api/stock/' + code6 + '/basic',
    'https://m.stock.naver.com/api/stock/' + code6 + '/integration'
  ];

  for (const url of endpoints) {
    try {
      const options = {
        method:  'get',
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Accept':     'application/json',
          'Referer':    'https://m.stock.naver.com/'
        },
        muteHttpExceptions: true,
        timeout:            TIMEOUT_MS
      };

      const response = UrlFetchApp.fetch(url, options);
      if (response.getResponseCode() !== 200) continue;

      const data = JSON.parse(response.getContentText());

      // basic 엔드포인트: closePrice, compareToPreviousClosePrice, fluctuationsRatio
      if (data.closePrice !== undefined && data.closePrice > 0) {
        const price      = Math.round(data.closePrice);
        const change     = data.compareToPreviousClosePrice != null
                           ? Math.round(data.compareToPreviousClosePrice) : null;
        const changeRate = data.fluctuationsRatio != null
                           ? parseFloat(data.fluctuationsRatio) : null;
        const prevClose  = (price !== null && change !== null) ? price - change : null;

        Logger.log('Naver 성공(basic): ' + code6 + ' ' + price + '원 등락: ' + change);
        return { price, prevClose, change, changeRate, date: formatDate(new Date()), source: 'naver' };
      }

      // integration 엔드포인트
      if (data.data && data.data.quoteInfo) {
        const qi    = data.data.quoteInfo;
        const price = Math.round(qi.closePrice || qi.now || 0);
        if (price > 0) {
          const change     = qi.compareToPreviousClosePrice != null
                             ? Math.round(qi.compareToPreviousClosePrice) : null;
          const changeRate = qi.fluctuationsRatio != null
                             ? parseFloat(qi.fluctuationsRatio) : null;
          const prevClose  = (price && change !== null) ? price - change : null;

          Logger.log('Naver 성공(integration): ' + code6 + ' ' + price + '원');
          return { price, prevClose, change, changeRate, date: formatDate(new Date()), source: 'naver' };
        }
      }

    } catch (e) {
      Logger.log('fetchViaNaver endpoint ' + url + ' error: ' + e.toString());
      continue;
    }
  }
  return null;
}


// ══════════════════════════════════════════════════════════════════════
//  채권 시세 조회 — 금융위원회 공공데이터 API
// ══════════════════════════════════════════════════════════════════════
function fetchBondPrice(e) {
  try {
    const isinCd = (e.parameter.isinCd || '').trim();
    const basDt  = (e.parameter.basDt  || '').trim();

    if (!isinCd) {
      return createResponse({ success: false, error: 'isinCd 파라미터가 필요합니다' }, 400);
    }

    const apiKey = PropertiesService.getScriptProperties().getProperty('BOND_API_KEY');
    if (!apiKey) {
      return createResponse({ success: false, error: 'BOND_API_KEY가 스크립트 속성에 없습니다' }, 500);
    }

    let url = 'https://apis.data.go.kr/1160100/service/'
            + 'GetBondSecuritiesInfoService/getBondPriceInfo'
            + '?serviceKey=' + apiKey
            + '&resultType=json'
            + '&numOfRows=5'
            + '&isinCd=' + encodeURIComponent(isinCd);

    if (basDt) url += '&basDt=' + basDt;

    const resp = UrlFetchApp.fetch(url, {
      method: 'get', muteHttpExceptions: true, timeout: TIMEOUT_MS
    });

    if (resp.getResponseCode() !== 200) {
      return createResponse({ success: false, error: '공공데이터 API HTTP ' + resp.getResponseCode() }, 502);
    }

    const raw  = resp.getContentText();
    const data = JSON.parse(raw);
    const body  = data && data.response && data.response.body;
    const items = body && body.items && body.items.item;

    let item = null;
    if (Array.isArray(items)) {
      for (let i = 0; i < items.length; i++) {
        if (items[i].clprPrc && parseFloat(items[i].clprPrc) > 0) { item = items[i]; break; }
      }
    } else if (items && items.clprPrc) {
      item = items;
    }

    if (!item) {
      return createResponse({ success: false, error: isinCd + ' 시세 데이터가 없습니다' }, 404);
    }

    const price = parseFloat(item.clprPrc);
    const rate  = parseFloat(item.clprBnfRt);

    return createResponse({
      success:  true,
      price:    price,
      rate:     isNaN(rate) ? null : rate,
      date:     item.basDt,
      isinCd:   item.isinCd,
      name:     item.itmsNm || isinCd,
      market:   item.mrktCtg || '',
      clprVs:   parseFloat(item.clprVs) || 0,
      source:   'data.go.kr'
    }, 200);

  } catch (err) {
    Logger.log('fetchBondPrice ERROR: ' + err.toString());
    return createResponse({ success: false, error: err.toString().slice(0, 150) }, 500);
  }
}


// ══════════════════════════════════════════════════════════════════════
//  환율 조회 — 네이버 금융 하나은행 고시 환율
// ══════════════════════════════════════════════════════════════════════
function fetchNaverFX(e) {
  try {
    const fxCodes = { USD: 'FX_USDKRW', EUR: 'FX_EURKRW', JPY: 'FX_JPYKRW', GBP: 'FX_GBPKRW', CNY: 'FX_CNYKRW' };
    const rates = {};
    let fetchedCount = 0;

    for (const [cur, code] of Object.entries(fxCodes)) {
      try {
        const fxResp = UrlFetchApp.fetch(
          'https://api.finance.naver.com/service/itemSummary.nhn?itemcode=' + code,
          {
            method: 'get',
            headers: { 'User-Agent': getRandomUserAgent(), 'Referer': 'https://finance.naver.com/marketindex/' },
            muteHttpExceptions: true,
            timeout: 5000
          }
        );
        if (fxResp.getResponseCode() === 200) {
          const fxData = JSON.parse(fxResp.getContentText());
          let val = parseFloat(fxData.closePrice || fxData.now || 0);
          if (cur === 'JPY' && val > 100) val = val / 100;
          if (val > 0) { rates[cur] = Math.round(val * 100) / 100; fetchedCount++; }
        }
      } catch(fe) {
        Logger.log('FX ' + cur + ' 조회 실패: ' + fe.toString());
      }
    }

    if (fetchedCount === 0) {
      return createResponse({ success: false, error: '환율 데이터 조회 실패' }, 503);
    }

    return createResponse({
      success: true, rates, date: formatDate(new Date()),
      source: '네이버금융(하나은행)', fetched: fetchedCount
    }, 200);

  } catch (err) {
    Logger.log('fetchNaverFX ERROR: ' + err.toString());
    return createResponse({ success: false, error: err.toString().slice(0, 100) }, 500);
  }
}


// ══════════════════════════════════════════════════════════════════════
//  공통 유틸
// ══════════════════════════════════════════════════════════════════════
function createResponse(data, statusCode) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}

function getRandomUserAgent() {
  const agents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  ];
  return agents[Math.floor(Math.random() * agents.length)];
}


// ══════════════════════════════════════════════════════════════════════
//  테스트 함수
// ══════════════════════════════════════════════════════════════════════
function testStock() {
  Logger.log('=== 주가 + 등락 테스트 ===');
  const cases = [
    { ticker: '108860', name: '셀바스에이아이' },
    { ticker: '208370', name: '셀바스헬스케어' },
    { ticker: '041920', name: '메디아나'       },
  ];
  for (const c of cases) {
    const result = fetchViaYahoo(c.ticker.padStart(6,'0') + '.KQ');
    if (result) {
      Logger.log('✓ ' + c.name + ': ' + result.price + '원'
        + ' (전일: ' + result.prevClose + ', 등락: ' + result.change
        + ', 등락률: ' + result.changeRate + '%)');
    } else {
      Logger.log('✗ ' + c.name + ': 조회 실패');
    }
  }
}

function testBond() {
  const e = { parameter: { type: 'bond', isinCd: 'KR103502GF39' } };
  const result = JSON.parse(fetchBondPrice(e).getContent());
  Logger.log('=== 채권 시세 테스트 ===');
  if (result.success) {
    Logger.log('✓ ' + result.name + ' — ' + result.price + '원 (' + result.date + ')');
  } else {
    Logger.log('✗ ' + result.error);
  }
}

function testFX() {
  const e = { parameter: { type: 'fx' } };
  const result = JSON.parse(fetchNaverFX(e).getContent());
  Logger.log('=== 환율 테스트 ===');
  if (result.success) {
    for (const [cur, val] of Object.entries(result.rates)) {
      Logger.log('✓ ' + cur + '/KRW: ' + val + '원');
    }
  } else {
    Logger.log('✗ ' + result.error);
  }
}

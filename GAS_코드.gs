/**
 * ╔════════════════════════════════════════════════════════════════════╗
 * ║  Google Apps Script: Stock Price Fetcher Web App                  ║
 * ║                                                                    ║
 * ║  역할: 네이버 금융 또는 야후 파이낸스에서 주가 조회                 ║
 * ║  (Google 서버 IP는 한국 금융사이트 봇 탐지를 우회할 수 있음)      ║
 * ║                                                                    ║
 * ║  배포 후 "웹앱으로 배포" URL을 treasury index.html에 입력           ║
 * ║                                                                    ║
 * ║  사용: GET https://script.google.com/...?ticker=005930            ║
 * ╚════════════════════════════════════════════════════════════════════╝
 */

// ── 전역 설정 ───────────────────────────────────────────────────────
const TIMEOUT_MS = 8000;  // 요청 타임아웃
const RETRIES = 2;        // 재시도 횟수

/**
 * Core Handler: GET 요청 처리
 * 쿼리 파라미터: ?ticker=005930 또는 ?symbol=005930.KS
 */
function doGet(e) {
  try {
    // ── 파라미터 추출 ──────────────────────────────────────────
    let ticker = e.parameter.ticker ? String(e.parameter.ticker).trim() : '';
    const symbol = e.parameter.symbol ? String(e.parameter.symbol).trim() : '';

    // ticker 또는 symbol 중 하나 필수
    if (!ticker && !symbol) {
      return createResponse({
        success: false,
        error: '종목코드(ticker) 또는 심볼(symbol)이 필요합니다. 예: ?ticker=005930'
      }, 400);
    }

    // symbol 파라미터가 있으면 우선 사용 (예: 005930.KS)
    let resolvedSymbol;
    if (symbol) {
      resolvedSymbol = symbol;
    } else {
      // ticker만 있으면 KOSPI 기본 가정 (suffix: .KS)
      resolvedSymbol = String(ticker).padStart(6, '0') + '.KS';
    }

    Logger.log('주가 조회 시작: ' + resolvedSymbol);

    // ── 주가 조회 (Yahoo Finance 우선, 실패 시 네이버) ────────
    let result = fetchViaYahoo(resolvedSymbol);
    
    if (!result) {
      // Yahoo 실패 시 네이버 시도
      const naverCode = resolvedSymbol.replace(/\.(KS|KQ)$/, '');
      result = fetchViaNaver(naverCode);
    }

    if (!result) {
      return createResponse({
        success: false,
        error: '주가 조회 실패. 네이버/야후 모두 응답 없음'
      }, 503);
    }

    return createResponse({
      success: true,
      price: result.price,
      date: result.date,
      source: result.source,
      symbol: resolvedSymbol
    }, 200);

  } catch (err) {
    Logger.log('ERROR: ' + err.toString());
    return createResponse({
      success: false,
      error: err.toString().slice(0, 100)
    }, 500);
  }
}

/**
 * Yahoo Finance v8 API 호출
 * 반환: { price, date, source } | null
 */
function fetchViaYahoo(symbol) {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' +
                encodeURIComponent(symbol) +
                '?interval=1d&range=5d&includePrePost=false';

    const options = {
      method: 'get',
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'application/json',
        'Referer': 'https://finance.yahoo.com/'
      },
      muteHttpExceptions: true,
      timeout: TIMEOUT_MS
    };

    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() !== 200) {
      Logger.log('Yahoo HTTP ' + response.getResponseCode());
      return null;
    }

    const data = JSON.parse(response.getContentText());
    const result = data.chart?.result?.[0];
    
    if (!result) return null;

    const closes = result.indicators?.quote?.[0]?.close || [];
    const timestamps = result.timestamp || [];

    // 최신 유효 종가 찾기 (역순)
    for (let i = closes.length - 1; i >= 0; i--) {
      const price = closes[i];
      if (price !== null && price !== undefined && price > 0) {
        const date = formatDate(new Date(timestamps[i] * 1000));
        return {
          price: Math.round(price),
          date: date,
          source: 'yahoo'
        };
      }
    }

    return null;
  } catch (e) {
    Logger.log('fetchViaYahoo error: ' + e.toString());
    return null;
  }
}

/**
 * 네이버 증권 모바일 API 호출
 * 반환: { price, date, source } | null
 */
function fetchViaNaver(code6) {
  const endpoints = [
    'https://m.stock.naver.com/api/stock/' + code6 + '/basic',
    'https://m.stock.naver.com/api/stock/' + code6 + '/integration'
  ];

  for (const url of endpoints) {
    try {
      const options = {
        method: 'get',
        headers: {
          'User-Agent': getRandomUserAgent(),
          'Accept': 'application/json',
          'Referer': 'https://m.stock.naver.com/'
        },
        muteHttpExceptions: true,
        timeout: TIMEOUT_MS
      };

      const response = UrlFetchApp.fetch(url, options);
      if (response.getResponseCode() !== 200) continue;

      const data = JSON.parse(response.getContentText());
      
      // naver basic API 응답 분석
      if (data.closePrice !== undefined && data.closePrice > 0) {
        const today = formatDate(new Date());
        return {
          price: Math.round(data.closePrice),
          date: today,
          source: 'naver'
        };
      }

      // naver integration API 응답 분석
      if (data.data?.quoteInfo?.closePrice !== undefined) {
        const today = formatDate(new Date());
        return {
          price: Math.round(data.data.quoteInfo.closePrice),
          date: today,
          source: 'naver'
        };
      }
    } catch (e) {
      Logger.log('fetchViaNaver endpoint ' + url + ' error: ' + e.toString());
      continue;
    }
  }

  return null;
}

/**
 * 응답 생성 헬퍼
 */
function createResponse(data, statusCode) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
  
  // 참고: Apps Script 배포 시 CORS는 자동으로 허용됨
}

/**
 * 날짜 포맷팅 (YYYY-MM-DD)
 */
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return year + '-' + month + '-' + day;
}

/**
 * 봇 탐지 우회용 User-Agent (무작위 선택)
 */
function getRandomUserAgent() {
  const agents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
  ];
  return agents[Math.floor(Math.random() * agents.length)];
}

/**
 * 테스트 함수 (앱스 스크립트 에디터에서 실행 가능)
 * 메뉴: 실행 → 함수 선택 → testFetch 실행
 */
function testFetch() {
  const testCases = [
    { ticker: '005930', expected: '[삼성전자]' },
    { ticker: '000660', expected: '[SK하이닉스]' }
  ];

  Logger.log('=== GAS Stock Fetcher 테스트 시작 ===');
  
  for (const test of testCases) {
    const result = fetchViaYahoo(test.ticker + '.KS');
    if (result) {
      Logger.log('✓ ' + test.ticker + ': ' + result.price + '원 (' + result.date + ')');
    } else {
      Logger.log('✗ ' + test.ticker + ': 조회 실패');
    }
  }

  Logger.log('=== 테스트 완료 ===');
}

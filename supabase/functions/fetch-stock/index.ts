// ╔══════════════════════════════════════════════════════════════════╗
// ║  Supabase Edge Function: fetch-stock                            ║
// ║                                                                  ║
// ║  역할: 브라우저 대신 서버에서 주가를 조회하여 반환               ║
// ║        → CORS 프록시 / IP 차단 문제 원천 해결                   ║
// ║                                                                  ║
// ║  배포 방법:                                                      ║
// ║    1. 폴더 생성:  supabase/functions/fetch-stock/               ║
// ║    2. 이 파일을   index.ts 로 저장                               ║
// ║    3. 명령 실행:  supabase functions deploy fetch-stock          ║
// ╚══════════════════════════════════════════════════════════════════╝

// ── CORS 헤더 ─────────────────────────────────────────────────────
// 브라우저(프론트엔드)에서 직접 호출하기 때문에 반드시 필요
const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── 봇 차단 우회용 브라우저 User-Agent ────────────────────────────
// Yahoo Finance / 네이버 모두 빈 UA는 403 반환 → 실제 브라우저 UA 사용
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

// ── 응답 헬퍼 ────────────────────────────────────────────────────
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// ── Yahoo Finance v8 API 파서 ─────────────────────────────────────
// 반환: { price: number, date: string, source: 'yahoo' } | null
function parseYahoo(data: Record<string, unknown>): { price: number; date: string; source: string } | null {
  try {
    const result = (data as any)?.chart?.result?.[0]
    if (!result) return null
    const closes:     (number | null)[] = result.indicators?.quote?.[0]?.close ?? []
    const timestamps: number[]          = result.timestamp ?? []
    for (let i = closes.length - 1; i >= 0; i--) {
      const c = closes[i]
      if (c !== null && c !== undefined && c > 0) {
        const d = new Date(timestamps[i] * 1000)
        const date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
        return { price: Math.round(c), date, source: 'yahoo' }
      }
    }
  } catch (_) {}
  return null
}

// ── 소스 1: Yahoo Finance v8 (서버→직접 호출, IP 차단 없음) ──────
async function fetchYahoo(
  symbol: string,
  range = '5d',
): Promise<{ price: number; date: string; source: string } | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
              `?interval=1d&range=${range}&includePrePost=false`
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept':     'application/json',
        'Referer':    'https://finance.yahoo.com/',
      },
      // Deno Edge Runtime 에서는 signal/AbortController 사용 가능
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) {
      console.warn(`[fetch-stock] Yahoo ${symbol} HTTP ${resp.status}`)
      return null
    }
    const data = await resp.json()
    return parseYahoo(data)
  } catch (e) {
    console.warn(`[fetch-stock] Yahoo ${symbol} 실패:`, e)
    return null
  }
}

// ── 소스 2: 네이버 증권 모바일 JSON API ──────────────────────────
// Deno 서버에서는 네이버 API를 직접 호출 가능 (IP 차단 없음)
async function fetchNaver(
  code6: string,
): Promise<{ price: number; date: string; source: string } | null> {
  const endpoints = [
    `https://m.stock.naver.com/api/stock/${code6}/basic`,
    `https://m.stock.naver.com/api/stock/${code6}/integration`,
  ]
  for (const url of endpoints) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': UA,
          'Accept':     'application/json',
          'Referer':    'https://m.stock.naver.com/',
        },
        signal: AbortSignal.timeout(8000),
      })
      if (!resp.ok) continue
      const data = await resp.json() as Record<string, unknown>

      // 네이버 API 버전별 필드명 다중 대응
      const raw: unknown =
        (data as any)?.closePrice         ??   // 구버전
        (data as any)?.currentPrice       ??
        (data as any)?.price              ??
        (data as any)?.stockPrice?.closePrice ??
        (data as any)?.stockInfo?.closePrice  ??
        (data as any)?.dealTrendInfos?.[0]?.closePrice ?? ''

      const price = parseInt(String(raw).replace(/,/g, ''), 10)
      if (price > 100) {
        const today = new Date().toISOString().slice(0, 10)
        return { price, date: today, source: 'naver' }
      }
    } catch (e) {
      console.warn(`[fetch-stock] Naver ${code6} 실패:`, e)
    }
  }
  return null
}

// ── 메인 핸들러 ───────────────────────────────────────────────────
Deno.serve(async (req: Request): Promise<Response> => {

  // ① OPTIONS pre-flight (브라우저 CORS 사전 요청)
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: corsHeaders })
  }

  // ② POST 외 거부
  if (req.method !== 'POST') {
    return json({ success: false, error: 'POST 요청만 허용됩니다' }, 405)
  }

  // ③ 요청 파싱
  let body: { symbol?: string; range?: string } = {}
  try {
    body = await req.json()
  } catch (_) {
    return json({ success: false, error: '요청 본문이 올바른 JSON이 아닙니다' }, 400)
  }

  const symbol = (body.symbol ?? '').trim()
  if (!symbol) {
    return json({ success: false, error: 'symbol 필드가 필요합니다 (예: 108860.KQ)' }, 400)
  }

  // ④ 종목코드 전처리: 6자리 패딩 + 시장 구분자
  //    예: "108860"    → "108860.KQ" (KOSDAQ 기본)
  //        "5930.KS"   → "005930.KS" (5자리 패딩)
  //        "108860.KQ" → 그대로 사용
  let finalSymbol = symbol
  if (!symbol.includes('.')) {
    const code6 = symbol.padStart(6, '0')
    // 구분자 없이 코드만 넘어오면 KOSPI 기본 (필요시 body.market 필드로 오버라이드)
    const market = (body as any).market === 'KOSDAQ' ? 'KQ' : 'KS'
    finalSymbol  = `${code6}.${market}`
  } else {
    const [rawCode, suffix] = symbol.split('.')
    finalSymbol = `${rawCode.padStart(6, '0')}.${suffix}`
  }

  const code6 = finalSymbol.split('.')[0]
  const range = body.range ?? '5d'

  console.log(`[fetch-stock] 조회 시작: ${finalSymbol} (range=${range})`)

  // ⑤ 두 소스 병렬 호출 — 먼저 성공한 값 사용
  //    Yahoo Finance 가 더 안정적이므로 1순위, 네이버는 폴백
  const [yahooResult, naverResult] = await Promise.allSettled([
    fetchYahoo(finalSymbol, range),
    fetchNaver(code6),
  ])

  const result =
    (yahooResult.status === 'fulfilled' ? yahooResult.value : null) ??
    (naverResult.status === 'fulfilled' ? naverResult.value : null)

  if (result) {
    console.log(`[fetch-stock] 성공: ${finalSymbol} → ${result.price}원 (${result.date}, ${result.source})`)
    return json({
      success: true,
      symbol:  finalSymbol,
      price:   result.price,
      date:    result.date,
      source:  result.source,
    })
  }

  // ⑥ 모든 소스 실패
  console.error(`[fetch-stock] 전체 실패: ${finalSymbol}`)
  return json({
    success: false,
    symbol:  finalSymbol,
    error:   `${finalSymbol} 주가 조회 실패 — Yahoo/Naver 모두 응답 없음`,
  }, 502)
})
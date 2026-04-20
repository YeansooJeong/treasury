// ╔══════════════════════════════════════════════════════════════════╗
// ║  Supabase Edge Function: fetch-stock  v2                        ║
// ║                                                                  ║
// ║  변경사항 (v2):                                                  ║
// ║  - prevClose(전일 종가), change(변동액), changeRate(등락률)      ║
// ║    필드 추가 반환 (그룹사 주가 전광판용)                         ║
// ║  - Yahoo Finance meta.chartPreviousClose / previousClose 파싱   ║
// ║  - 네이버 API compareToPreviousClosePrice 파싱 추가              ║
// ╚══════════════════════════════════════════════════════════════════╝

// ── CORS 헤더 ────────────────────────────────────────────────────
const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── 봇 탐지 우회용 User-Agent ─────────────────────────────────────
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'

// ── 응답 타입 ─────────────────────────────────────────────────────
interface PriceResult {
  price:      number
  prevClose:  number | null   // 전일 종가
  change:     number | null   // 변동액 (price - prevClose)
  changeRate: number | null   // 등락률 (%)
  date:       string
  source:     string
}

// ── 응답 헬퍼 ────────────────────────────────────────────────────
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// ── Yahoo Finance v8 파서 ─────────────────────────────────────────
function parseYahoo(data: Record<string, unknown>): PriceResult | null {
  try {
    const result = (data as any)?.chart?.result?.[0]
    if (!result) return null

    // meta에서 전일 종가 추출 (가장 신뢰도 높음)
    const meta       = result.meta ?? {}
    const prevClose: number | null =
      meta.chartPreviousClose ?? meta.previousClose ?? null

    const closes:     (number | null)[] = result.indicators?.quote?.[0]?.close ?? []
    const timestamps: number[]          = result.timestamp ?? []

    for (let i = closes.length - 1; i >= 0; i--) {
      const c = closes[i]
      if (c !== null && c !== undefined && c > 0) {
        const price     = Math.round(c)
        const d         = new Date(timestamps[i] * 1000)
        const date      = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
        const change     = prevClose !== null ? Math.round(price - prevClose) : null
        const changeRate = prevClose !== null && prevClose > 0
          ? Math.round((price - prevClose) / prevClose * 10000) / 100
          : null

        return { price, prevClose, change, changeRate, date, source: 'yahoo' }
      }
    }
  } catch (_) {}
  return null
}

// ── 소스 1: Yahoo Finance v8 ─────────────────────────────────────
async function fetchYahoo(symbol: string, range = '5d'): Promise<PriceResult | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
              `?interval=1d&range=${range}&includePrePost=false`
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com/' },
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) { console.warn(`[fetch-stock] Yahoo ${symbol} HTTP ${resp.status}`); return null }
    const data = await resp.json()
    return parseYahoo(data)
  } catch (e) {
    console.warn(`[fetch-stock] Yahoo ${symbol} 실패:`, e)
    return null
  }
}

// ── 소스 2: 네이버 증권 모바일 JSON API ──────────────────────────
async function fetchNaver(code6: string): Promise<PriceResult | null> {
  const endpoints = [
    `https://m.stock.naver.com/api/stock/${code6}/basic`,
    `https://m.stock.naver.com/api/stock/${code6}/integration`,
  ]
  for (const url of endpoints) {
    try {
      const resp = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json', 'Referer': 'https://m.stock.naver.com/' },
        signal: AbortSignal.timeout(8000),
      })
      if (!resp.ok) continue
      const data = await resp.json() as Record<string, unknown>

      // 현재가 — 버전별 필드명 다중 대응
      const priceRaw: unknown =
        (data as any)?.closePrice         ??
        (data as any)?.currentPrice       ??
        (data as any)?.price              ??
        (data as any)?.stockPrice?.closePrice ??
        (data as any)?.stockInfo?.closePrice  ??
        (data as any)?.dealTrendInfos?.[0]?.closePrice ?? ''

      const price = parseInt(String(priceRaw).replace(/,/g, ''), 10)
      if (!(price > 100)) continue

      // 전일 대비 변동액 — compareToPreviousClosePrice 필드
      const changeRaw: unknown =
        (data as any)?.compareToPreviousClosePrice ??
        (data as any)?.stockPrice?.compareToPreviousClosePrice ??
        (data as any)?.fluctuations ??
        null

      const changeNum  = changeRaw !== null ? parseInt(String(changeRaw).replace(/,/g, ''), 10) : null
      const prevClose  = (changeNum !== null && !isNaN(changeNum)) ? price - changeNum : null
      const changeRate = prevClose !== null && prevClose > 0
        ? Math.round((price - prevClose) / prevClose * 10000) / 100
        : null

      const today = new Date().toISOString().slice(0, 10)
      return { price, prevClose, change: changeNum, changeRate, date: today, source: 'naver' }
    } catch (e) {
      console.warn(`[fetch-stock] Naver ${code6} 실패:`, e)
    }
  }
  return null
}

// ── 메인 핸들러 ───────────────────────────────────────────────────
Deno.serve(async (req: Request): Promise<Response> => {

  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return json({ success: false, error: 'POST 요청만 허용됩니다' }, 405)
  }

  let body: { symbol?: string; range?: string; market?: string } = {}
  try { body = await req.json() } catch (_) {
    return json({ success: false, error: '요청 본문이 올바른 JSON이 아닙니다' }, 400)
  }

  const symbol = (body.symbol ?? '').trim()
  if (!symbol) {
    return json({ success: false, error: 'symbol 필드가 필요합니다 (예: 108860.KQ)' }, 400)
  }

  // 종목코드 전처리: 6자리 패딩 + 시장 구분자 자동 부여
  let finalSymbol = symbol
  if (!symbol.includes('.')) {
    const code6 = symbol.padStart(6, '0')
    const mkt   = body.market === 'KOSDAQ' ? 'KQ' : 'KS'
    finalSymbol = `${code6}.${mkt}`
  } else {
    const [rawCode, suffix] = symbol.split('.')
    finalSymbol = `${rawCode.padStart(6, '0')}.${suffix}`
  }

  const code6 = finalSymbol.split('.')[0]
  const range = body.range ?? '5d'

  console.log(`[fetch-stock] 조회: ${finalSymbol} range=${range}`)

  // 두 소스 병렬 호출
  const [yahooRes, naverRes] = await Promise.allSettled([
    fetchYahoo(finalSymbol, range),
    fetchNaver(code6),
  ])

  const result: PriceResult | null =
    (yahooRes.status === 'fulfilled' ? yahooRes.value : null) ??
    (naverRes.status === 'fulfilled' ? naverRes.value : null)

  if (result) {
    console.log(`[fetch-stock] 성공: ${finalSymbol} ${result.price}원 (${result.changeRate}%, ${result.source})`)
    return json({
      success:    true,
      symbol:     finalSymbol,
      price:      result.price,
      prevClose:  result.prevClose,
      change:     result.change,
      changeRate: result.changeRate,
      date:       result.date,
      source:     result.source,
    })
  }

  console.error(`[fetch-stock] 전체 실패: ${finalSymbol}`)
  return json({
    success: false,
    symbol:  finalSymbol,
    error:   `${finalSymbol} 주가 조회 실패 — Yahoo/Naver 모두 응답 없음`,
  }, 502)
})
# Selvas Treasury — 통합자금관리 시스템 기술 문서

> **최종 업데이트**: 2026-04-15  
> **퍼블리싱 URL**: https://yeansoojeong.github.io/treasury/  
> **GitHub 저장소**: https://github.com/yeansoojeong/treasury  
> **파일 구성**: 단일 HTML 파일 (`index.html`) + 이미지 3개

---

## 1. 시스템 개요

### 목적
셀바스에이아이(A社), 셀바스헬스케어(B社), 메디아나(C社) 3개 법인의 자금을 통합 관리하는 웹 대시보드. 현재는 A社 단독 운영 후 검증이 완료되면 나머지 법인을 순차 추가할 예정.

### 기술 스택
| 항목 | 내용 |
|------|------|
| 프론트엔드 | 순수 HTML/CSS/JavaScript (프레임워크 없음) |
| 데이터 저장 | 브라우저 `localStorage` (서버·DB 없음) |
| 차트 | Chart.js (CDN) |
| 퍼블리싱 | GitHub Pages (무료) |
| 환율 API | exchangerate-api.com → open.er-api.com 폴백 |
| 주가 API | Yahoo Finance (CORS 프록시 3개 병렬 조회) |

### 파일 목록 (GitHub 저장소 루트)
```
treasury/
├── index.html            # 전체 앱 (1,854줄)
├── selvasai.png          # 셀바스에이아이 로고
├── selvashealthcare.png  # 셀바스헬스케어 로고
├── mediana.png           # 메디아나 로고
└── README.md             # GitHub 기본 설명
```

---

## 2. 메뉴 구조

| 메뉴 ID | 메뉴명 | 상태 | 주요 기능 |
|---------|--------|------|----------|
| `dashboard` | 통합 상황판 | ✅ 완료 | 원화/외화 요약카드, 자금지표 4개, 차트, 지분투자 현황 |
| `input` | 운전자금 입력 | ✅ 완료 | 일일 원화·외화 잔액 입력, 10건 페이지네이션 이력 |
| `invest` | 운용자금(단기투자) | ✅ 완료 | 정기예금·국공채 등 운용상품 등록, 국공채 시세 연동 |
| `loans` | 차입금(대출) | ✅ 완료 | 차입금 건별 등록, D-Day, 만기 알림 |
| `equity` | 지분투자 관리 | ✅ 완료 | 보유 주식 등록, 종목 검색, 주가 자동조회, 평가금액 |
| `history` | 자금 변동 이력 | ✅ 완료 | 기간별 운전자금 조회 |
| `fx` | 환율 현황 | ✅ 완료 | 실시간 환율 표시 |
| `policy` | 자금정책 | ⏳ 개발예정 | - |
| `report` | 자금일보 출력 | ⏳ 개발예정 | - |

---

## 3. 데이터 구조 (localStorage)

모든 데이터는 브라우저의 `localStorage`에 JSON 배열로 저장됩니다.

### 3-1. `daily` — 운전자금 일일 잔액
```json
{
  "date": "2026-04-15",
  "company": "셀바스에이아이",
  "writer": "홍길동",
  "krw_demand": 5773127665,
  "krw_govt": 275285207,
  "krw_mmda": 0,
  "fx_usd": 49979.75,
  "fx_eur": 0,
  "fx_jpy": 23145868,
  "fx_krw": 292393072,
  "loan_krw": 14800000000,
  "loan_fx": 0,
  "inv_krw": 0,
  "inv_fx": 0,
  "memo": "특이사항"
}
```

### 3-2. `investments` — 운용자금(단기투자)
```json
{
  "id": 1713139200000,
  "active": true,
  "company": "셀바스에이아이",
  "bank": "산업은행",
  "product": "정기예금",
  "currency": "KRW",
  "amount": 5000000000,
  "rate": 3.5,
  "start": "2026-01-01",
  "maturity": "2026-12-31"
}
```
> **국공채인 경우 추가 필드:**
```json
{
  "product": "국공채",
  "bondName": "국고채 3년",
  "bondTicker": "KR103501GCC6",
  "bondQty": 10000,
  "bondPrice": 10234,
  "priceDate": "2026-04-14"
}
```

### 3-3. `loans` — 차입금
```json
{
  "id": 1713139200000,
  "active": true,
  "company": "셀바스에이아이",
  "lender": "하나은행 반포남",
  "type": "담보대출",
  "currency": "KRW",
  "amount": 5000000000,
  "rate": 3.311,
  "start": "2025-06-23",
  "maturity": "2026-06-23"
}
```

### 3-4. `equities` — 지분투자
```json
{
  "id": 1713139200000,
  "date": "2026-04-15",
  "company": "셀바스에이아이",
  "name": "셀바스헬스케어",
  "ticker": "208370",
  "purpose": "경영참여",
  "market": "KOSDAQ",
  "shares": 9803082,
  "price": 4295,
  "total_value": 42104237190
}
```

---

## 4. 주요 함수 목록

### 네비게이션
| 함수 | 역할 |
|------|------|
| `goto(page)` | 메뉴 페이지 전환 |
| `setCompany(comp, btn)` | 법인 탭 전환 (셀바스에이아이/헬스케어/메디아나) |
| `getFiltered(table)` | 현재 선택 법인 기준으로 localStorage 데이터 필터링 |

### 환율
| 함수 | 역할 |
|------|------|
| `refreshFX()` | 환율 API 호출 (1순위: exchangerate-api, 2순위: open.er-api, 3순위: 기본값) |
| `updateFXDisplay()` | 환율 값 화면 업데이트 |
| `calcKRW(amount, currency)` | 외화 → 원화 환산 |

### 주가 조회
| 함수 | 역할 |
|------|------|
| `_fetchStockParallel(symbol)` | 3개 프록시 병렬 조회, 먼저 성공한 것 반환 (타임아웃 3.5초) |
| `_fetchViaProxy(url, timeout)` | 단일 프록시 호출 |
| `_extractYahooPrice(data)` | Yahoo Finance 응답에서 최신 종가 추출 |
| `fetchStockPrice()` | 지분투자 입력 폼의 주가 조회 버튼 핸들러 |
| `refreshEquityPrice(id, ticker, market)` | 목록에서 특정 종목 시세 업데이트 |

### 종목 검색
| 함수 | 역할 |
|------|------|
| `searchStock(query)` | 종목명 입력 시 드롭다운 표시 (로컬 30종 + Yahoo 검색) |
| `selectStock(name, code, market)` | 드롭다운에서 종목 선택 → 자동 주가 조회 |

### 운전자금
| 함수 | 역할 |
|------|------|
| `saveDaily()` | 일일 운전자금 저장 |
| `renderDailyHistory(page)` | 입력 이력 테이블 렌더링 (페이지당 10건) |
| `deleteDaily(date, company)` | 특정 날짜 데이터 삭제 |

### 운용자금
| 함수 | 역할 |
|------|------|
| `onInvestProductChange()` | 상품 구분 변경 시 국공채 전용 폼 토글 |
| `saveInvestment()` | 운용상품 등록 (일반/국공채 분기 처리) |
| `renderInvestments()` | 운용자금 목록 렌더링 |
| `searchBond(query)` | 국공채 종목 검색 드롭다운 |
| `fetchBondPrice()` | 국공채 ETF 기준가 조회 |
| `refreshBondPrice(id, bondName)` | 목록에서 국공채 기준가 업데이트 |
| `calcBondValue()` | 좌수 × 기준가 = 평가금액 자동계산 |

### 차입금
| 함수 | 역할 |
|------|------|
| `saveLoan()` | 차입금 등록 |
| `renderLoans()` | 차입금 목록 렌더링 (D-Day, 만기 경과 표시) |

### 지분투자
| 함수 | 역할 |
|------|------|
| `saveEquity()` | 지분 등록 (법인 드롭박스 선택값 사용) |
| `renderEquity()` | 지분 목록 렌더링 (종목별 최신 1건) |
| `deleteEquity(id)` | 지분 삭제 |

### 대시보드 & 차트
| 함수 | 역할 |
|------|------|
| `renderDashboard()` | 대시보드 전체 업데이트 (지표, 요약카드, 지분투자 카드) |
| `setChartPeriod(days, btn)` | 차트 기간 변경 (7일/30일/90일/1년) |
| `updateMainChart(records)` | 현금흐름 자금추이 차트 렌더링 |
| `updateEquityChart(records)` | 지분투자 평가추이 차트 렌더링 |
| `toggleMetric(key, event)` | 카드 클릭으로 차트 표시 항목 전환 |

---

## 5. 외부 API 현황 및 주의사항

### 환율 API ⚠️ 검토 필요
| 순위 | API | 상태 |
|------|-----|------|
| 1순위 | `v6.exchangerate-api.com` | API 키 없이 사용 중 — **정식 사용 아님** |
| 2순위 | `open.er-api.com` | 공개 데모 엔드포인트 — **정식 사용 아님** |
| **권장 대안** | **한국은행 ECOS OpenAPI** | **무료 공식 API, 키 발급 필요** |

> 🔑 **조치 필요**: [ecos.bok.or.kr](https://ecos.bok.or.kr/#/AuthKeyInfo) 에서 API 키 발급 후 코드 교체

### 주가 API (Yahoo Finance 프록시)
| 순위 | 프록시 | 비고 |
|------|--------|------|
| 1순위 | `api.allorigins.win` | 가장 빠름 |
| 2순위 | `corsproxy.io` | 안정적 |
| 3순위 | `thingproxy.freeboard.io` | 폴백 |

> Yahoo Finance 데이터 자체는 공개 데이터이나, 상업적 사용 시 약관 검토 필요  
> 타임아웃: 3.5초 (3개 중 가장 먼저 성공한 것 채택)

### 국공채 ETF 매핑 (Yahoo Finance)
| 채권명 | ETF 심볼 | ETF명 |
|--------|----------|-------|
| 국고채 3년 | `148070.KS` | KODEX 국채3년 |
| 국고채 10년 | `148830.KS` | KODEX 장기국채 |
| 국고채 30년 | `304660.KS` | KODEX 국고채30년액티브 |
| 통안채 1년 | `157450.KS` | KODEX 단기채권 |

---

## 6. 법인별 주요 데이터 현황 (실제 파일 기준)

| 항목 | 셀바스에이아이 (A社) | 셀바스헬스케어 (B社) | 메디아나 (C社) |
|------|---------------------|---------------------|----------------|
| 종목코드 | 108860 (KOSDAQ) | 208370 (KOSDAQ) | 041920 (KOSDAQ) |
| 차입금 | 148억 (하나은행 4건) | 10.8억 (JPY 외화대출) | 해당 없음 |
| 외화 보유 | USD·EUR·JPY | USD·EUR·JPY·GBP | USD·JPY·EUR |
| MS365 | ✅ | ❌ (Google Workspace) | ✅ |

---

## 7. 알려진 제한사항 및 향후 개발 예정

### 현재 제한사항
- **데이터 로컬 저장**: `localStorage`는 해당 브라우저에만 저장됨. 다른 PC/브라우저에서 접속하면 데이터가 없음
- **환율 API**: 정식 계약 없이 사용 중 → ECOS API로 교체 필요
- **국공채 기준가**: ETF 매핑이 있는 4종만 자동조회 가능, 나머지는 직접 입력
- **다중 사용자**: 현재는 1인 사용 전제 (B社·C社 담당자 미초대 상태)

### 개발 예정 (Phase 2)
- [ ] **자금정책 모니터링** — 법인별 차입한도·환헷지비율 설정 및 준수 현황
- [ ] **자금일보 출력** — 법인별 양식의 자금일보 PDF/인쇄
- [ ] **ECOS 환율 API 연동** — 한국은행 공식 API 키 적용
- [ ] **B社·C社 확장** — 셀바스헬스케어·메디아나 담당자 초대
- [ ] **데이터 동기화** — SharePoint/Google Sheets 연동으로 다중 사용자 지원
- [ ] **차입금 만기 알림** — D-90 이하 이메일/알림

---

## 8. 배포 및 수정 방법

### GitHub Pages 배포 구조
```
GitHub 저장소 (yeansoojeong/treasury)
    └── index.html (수정 후 커밋 → 1~2분 후 자동 반영)
            ↓
GitHub Pages: https://yeansoojeong.github.io/treasury/
            ↓
SharePoint 통합자금관리 페이지 (iframe 연결)
```

### 코드 수정 절차
1. Claude에 `index.html` 첨부 후 수정 요청
2. 수정된 `index.html` 다운로드
3. GitHub 저장소 접속 → `index.html` 클릭 → 연필 아이콘(Edit)
4. 전체 선택(`Ctrl+A`) → 삭제 → 새 내용 붙여넣기
5. **Commit changes** 클릭
6. 1~2분 후 https://yeansoojeong.github.io/treasury/ 에서 확인

### Claude에 수정 요청 시 권장 방법
```
1. 이 MD 파일을 먼저 공유 (현재 상태 컨텍스트 제공)
2. 최신 index.html 파일 첨부
3. 수정 요청 내용 설명
```

---

## 9. 변경 이력

| 날짜 | 주요 변경 내용 |
|------|--------------|
| 2026-04-14 | 프로젝트 시작, SharePoint 사이트 생성 |
| 2026-04-14 | GitHub Pages 퍼블리싱 (yeansoojeong.github.io/treasury) |
| 2026-04-14 | 기본 앱 구조 구축 (Gemini Pro 초기 코드 기반) |
| 2026-04-14 | 버그 수정: 이미지 로딩 먹통, chart.js 블로킹, goto() 오류 |
| 2026-04-14 | 환율 API 3단계 폴백 구조 적용 |
| 2026-04-15 | 지분투자 법인 드롭박스 + 주가 자동조회 (Yahoo Finance) |
| 2026-04-15 | 종목 실시간 검색 드롭다운 (로컬 사전 + Yahoo 검색) |
| 2026-04-15 | 운전자금·운용자금·차입금 법인 드롭박스 독립화 |
| 2026-04-15 | 운전자금 이력 테이블 + 페이지네이션 (10건/페이지) |
| 2026-04-15 | 대시보드 원화/외화 구분 요약카드 + 비율 바 |
| 2026-04-15 | 차트 기간 선택 (7일/30일/90일/1년) + setChartPeriod 구현 |
| 2026-04-15 | 지분투자 카드 종목별 상세 표시 |
| 2026-04-15 | 차입금 회사별 필터 버그 수정 (DB.get → getFiltered) |
| 2026-04-15 | 국공채 좌수 입력 + ETF 기준가 자동조회 |
| 2026-04-15 | 주가 조회 속도 개선: 3개 프록시 병렬 + 타임아웃 3.5초 |
| 2026-04-15 | 차입금 0이면 차트 미표시, 자금정책·자금일보 메뉴 (개발예정) 표시 |

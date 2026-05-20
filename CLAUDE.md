# Dividend Rotation App - Claude Code 작업 규칙

## 프로젝트 개요
NVDY / AMDW 배당 회전 전략 보조 도구. 진입 타이밍 자동 판단 + 회전 이력 관리.

- **소유자**: 손성욱 (패스파인더랩)
- **배포**: Cloudflare Pages (GitHub: rhdn669-ai/dividend-rotation)
- **스택**: Vite + React 18 + Yahoo Finance API + CF Pages Functions

---

## 절대 규칙

1. **API 키를 코드에 하드코딩하지 않는다** — 모든 키는 .env 또는 CF Pages 환경변수
2. **CORS 우회는 반드시 CF Pages Functions로 처리** — 클라이언트 직접 호출 금지
3. **검증된 데이터만 표시** — 통상적 경험칙은 반드시 "통상적" 또는 "검증 안 됨" 명시
4. **사용자 데이터는 본인 Firebase Firestore + localStorage 캐시** — 타사 서버 전송 금지. 비로그인 시 localStorage만 사용 (오프라인 모드)
5. **localStorage 키 prefix**: `dividend-rotation:` (충돌 방지)
6. **세금/투자 자문 멘트 금지** — "투자 권유 아님" 디스클레이머 유지

---

## 코드 스타일

- 함수형 컴포넌트만 사용 (class 금지)
- Hooks 사용 시 의존성 배열 정확히
- 인라인 스타일 허용 (CSS 모듈 도입 전)
- **변수명 영어로** (한국어 변수명 금지)
- 정규식에서 `/\n/g` 사용 금지 (Korean text 깨짐)
- 모든 fetch는 try-catch 필수

---

## 라이브러리 제약

- 신규 라이브러리 추가는 사용자 승인 후
- 현재 허용: React, Recharts (차트 추가 시)
- 금지: jQuery, Bootstrap, 무거운 UI 프레임워크

---

## 진입 조건 평가 규칙

`src/lib/evaluator.js`에서 관리. 조건 추가/수정 시:

1. 통상적 경험칙인 경우 `description`에 "통상적" 표기
2. 공식 출처가 있으면 코드 주석에 출처 명시
3. 가중치 조정 시 사용자 확인

현재 8개 조건:
1. CPI/FOMC 이벤트 없음
2. NVDA/AMD 시간외 ±2% 이내
3. ETF 당일 변동 ±4% 이내
4. QQQ 나스닥 -2% 이상
5. VIX 20 미만
6. ETF 거래량 평균 0.5~1.8배
7. NVDA/AMD 거래량 급증 없음 (<2배)
8. 배당락일 1~3거래일 전

---

## 데이터 소스

- **시세**: Yahoo Finance Chart API (비공식, 딜레이 15~20분)
- **CPI/FOMC**: federalreserve.gov, bls.gov (수동 입력)
- **실적 발표일**: 각 회사 IR (수동 입력)
- **배당락일**: YieldMax / Roundhill 공식 (수동 입력)

API 변경 시 `src/lib/yahooApi.js`만 수정.

---

## 배포 체크리스트

배포 전 확인:
- [ ] .env 파일이 .gitignore에 포함됨
- [ ] CF Pages 환경변수 설정 완료
- [ ] functions/api/quote.js 작동 확인
- [ ] 모든 탭 렌더링 정상
- [ ] localStorage 키 prefix 적용
- [ ] 콘솔 에러 없음

---

## 작업 순서 권장

1. 단일 App.jsx → 컴포넌트 분리
2. lib/ 모듈 추출 (yahooApi, evaluator, storage)
3. localStorage 연동 (이벤트, 회전이력, VIX)
4. functions/api/quote.js 추가
5. 실적 일정 하드코딩 데이터 추가
6. 에러 처리 보강
7. 로컬 테스트 → GitHub push → CF Pages 자동 배포

---

## 패스파인더랩 표준 준수

- **검증된 데이터만**: 출처 없는 수치 금지
- **통상적 경험칙은 명시**: "공식 검증 안 됨" 라벨
- **파일 버전 명시**: 큰 변경 시 v3, v4 등 버전 표기
- **이전 데이터 보존**: 마이그레이션 전 백업

---

## 문의 / 참고

소유자 작업 스타일:
- 간결한 소통 선호
- 위치 기반 수정 지시 선호 (전체 파일 덮어쓰기 X)
- 사실 검증 중요 — 추측 답변 시 "검증 안 됨" 명시

# 📄 Markdown 뷰어 (MD → PDF · HWPX)

마크다운(`.md`) 파일을 **끌어다 놓기/파일 선택**으로 업로드하면 깔끔한 화면으로 보여 주고,
**PDF** 또는 **HWPX(한글)** 파일로 내보낼 수 있는 정적 웹앱입니다.

- 🔒 **프라이버시 우선** — 업로드한 파일은 **서버로 전송되지 않고 브라우저 안에서만** 처리됩니다. (DB·서버 저장 없음)
- 🛡 **앱 자체는 외부 요청 없음** — 모든 라이브러리를 저장소에 **동봉(self-host)** 하여 앱은 외부 서버와 통신하지 않습니다(CDN·추적 없음). *단, 문서에 포함된 원격 이미지(`![](https://…)`)는 그 이미지 서버에 접속이 발생합니다.*
- 📱 **모바일 최적화 + PWA** — 홈 화면에 설치하면 **오프라인**으로도 동작합니다.
- 🌗 **라이트/다크 테마**, 자동 **목차(TOC)**·**읽기 진행바**·스크롤 위치 추적
- 🖨 **PDF 다운로드 / 인쇄**, 📑 **HWPX 내보내기**, 📥 **원본 .md 다운로드** (상단 **내보내기** 메뉴)
- ♿ **접근성** — 키보드 내비게이션, 포커스 표시, 스크린리더 라벨, 44px 터치 타겟
- 🈚 **인코딩 자동 감지** — UTF-8 우선, 실패 시 EUC-KR/CP949 자동 폴백

## 🚀 GitHub Pages 배포 방법

1. 이 폴더의 **모든 파일**(숨김 파일 `.nojekyll` 포함)을 GitHub 저장소에 올립니다.
   ```bash
   git init
   git add -A          # .nojekyll, vendor/ 등 모두 포함
   git commit -m "Markdown 뷰어"
   git branch -M main
   git remote add origin https://github.com/<사용자명>/<저장소명>.git
   git push -u origin main
   ```
2. 저장소 → **Settings → Pages** 로 이동합니다.
3. **Source** 를 **Deploy from a branch**, **Branch** 를 `main` / `/ (root)` 으로 지정 후 **Save**.
4. 잠시 후 `https://<사용자명>.github.io/<저장소명>/` 에서 접속할 수 있습니다.

> `.nojekyll` 이 포함되어 Jekyll 처리 없이 정적 파일이 그대로 서비스됩니다.
> 모든 경로가 **상대경로(`./`)** 라 사용자/프로젝트 페이지 어디에 배포해도 동작합니다.

## 🗂 파일 구조

```
.
├── index.html              # 메인 페이지
├── css/styles.css          # 스타일 (라이트/다크, 반응형, 인쇄)
├── js/
│   ├── app.js              # 업로드·렌더링·목차·내보내기 로직
│   └── hwpx.js             # 브라우저용 HWPX(OWPML) 생성기
├── vendor/                 # 동봉 라이브러리 (외부 CDN 미사용)
│   ├── marked.min.js · purify.min.js · jszip.min.js
│   ├── html2pdf.bundle.min.js · highlight.min.js
│   └── hljs-styles/github(.dark).min.css
├── manifest.webmanifest    # PWA 매니페스트
├── sw.js                   # 서비스 워커(오프라인 캐시)
├── favicon.svg · icon-192/512.png · apple-touch-icon.png · og-image.png
├── 404.html
├── sample.md               # 데모 문서 ("데모 문서 열기" 버튼)
├── .nojekyll
└── README.md
```

## 🧩 사용 라이브러리 (모두 로컬 동봉)

| 라이브러리 | 용도 |
|------|------|
| [marked](https://marked.js.org/) 12 | 마크다운 파싱 |
| [DOMPurify](https://github.com/cure53/DOMPurify) 3 | XSS 방지(HTML 살균) |
| [highlight.js](https://highlightjs.org/) 11 | 코드 구문 강조 |
| [JSZip](https://stuk.github.io/jszip/) 3 | HWPX(ZIP) 패키징 |
| [html2pdf.js](https://github.com/eKoopmans/html2pdf.js) | PDF 생성 |

## 🔐 보안 / 프라이버시 설계

- 파일은 `FileReader` 로 **메모리에서만** 읽으며, 새로고침하면 사라집니다. (localStorage·DB·서버 업로드 없음 — 저장되는 건 테마 설정뿐)
- 렌더링 시 **DOMPurify** 로 스크립트/`svg`/`math`/이벤트 핸들러 등 위험 요소를 제거합니다.
- **Content-Security-Policy**(meta)로 외부 스크립트·연결을 차단하고, `referrer: no-referrer` 로 참조 정보 유출을 막습니다.
- 라이브러리를 **동봉**하여 CDN 공급망 변조 위험과 외부 요청을 제거했습니다.
- 모든 변환(PDF·HWPX)은 **클라이언트에서** 수행됩니다. 앱이 파일을 외부로 전송하지 않으며, 다운로드/공유는 사용자가 직접 수행하는 별개 동작입니다.
- 클릭재킹 방지를 위해 다른 사이트의 iframe 안에서는 동작하지 않습니다(frame-busting). meta 기반 CSP의 한계로 `frame-ancestors`는 적용되지 않습니다.
- 동봉 라이브러리 버전: marked 12.0.2 · DOMPurify 3.1.6 · highlight.js 11.9.0 · JSZip 3.10.1 · html2pdf.js 0.10.2 (보안 패치는 주기적으로 갱신 권장)

> 참고: 문서에 **원격 이미지**(`![](https://...)`)가 들어 있으면, 그 이미지를 표시하기 위해 **해당 이미지 서버**로의 접속은 발생할 수 있습니다(파일 내용 자체는 전송되지 않음). 평문 `http:` 이미지는 CSP로 차단되며 `https:` 만 허용됩니다.

## 💡 사용 팁

- 데스크톱: 파일을 화면에 끌어다 놓거나 **파일 선택**(또는 `Ctrl/⌘ + O`). 처음이라면 **데모 문서 열기** 로 바로 체험하세요.
- 내보내기는 상단 **내보내기 ▾** 메뉴에서:
  - **PDF로 저장** — 한 번 클릭 다운로드(그림 기반).
  - **인쇄 / PDF 저장** — 대화상자에서 *PDF로 저장* 선택. **텍스트 선택·검색이 가능한 고품질** 결과(권장, 특히 긴 문서).
  - **HWPX (한글)** — 한컴오피스 한글에서 열립니다. 제목·문단·**표·코드블록·목록·인용·서식**이 반영됩니다.
  - **원본 .md 다운로드** — 업로드한 파일 그대로 저장.
- 아이폰(iOS Safari)에서는 HWPX 등 다운로드 시 **공유 시트**가 떠 *파일 앱에 저장*할 수 있습니다.

### HWPX 변환 범위
표·코드블록·제목·목록·인용·굵게/기울임/취소선/인라인코드/링크(URL 병기)는 반영됩니다.
**이미지와 수식은 대체 텍스트로 변환**되며 원본 그림은 포함되지 않습니다.

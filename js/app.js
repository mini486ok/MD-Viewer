/* app.js — Markdown 뷰어 메인 로직 (순수 클라이언트, 서버 전송 없음) */
(function () {
  'use strict';

  // 클릭재킹 방어: meta CSP 는 frame-ancestors 를 적용하지 못하므로 frame-busting 으로 보완
  try {
    if (window.top !== window.self) {
      document.documentElement.style.display = 'none';
      window.top.location = window.self.location.href;
    }
  } catch (e) {
    if (document.documentElement) document.documentElement.style.display = 'none';
  }

  var $ = function (id) { return document.getElementById(id); };
  var dom = {
    body: document.body,
    fileInput: $('file-input'),
    dropzone: $('dropzone'),
    doc: $('doc'),
    filelist: $('filelist'),
    toc: $('toc'),
    exportActions: $('export-actions'),
    btnExport: $('btn-export'),
    exportMenu: $('export-menu'),
    btnNew: $('btn-newfile'),
    btnMenu: $('btn-menu'),
    overlay: $('overlay'),
    overlayMsg: $('overlay-msg'),
    toastWrap: $('toast-wrap'),
    sidebar: $('sidebar'),
    scrim: $('scrim'),
    drophint: $('drophint'),
    progress: $('progress'),
    progressBar: $('progress-bar'),
    btnFontSize: $('btn-fontsize'),
    main: $('content')
  };

  var MAX_BYTES = 10 * 1024 * 1024;     // 파일당 10MB 상한
  var BIG_TEXT = 300 * 1024;            // 렌더 시 오버레이 임계
  var HLJS_MAX = 30 * 1024;             // 이보다 큰 코드블록은 하이라이트 생략

  // 상태(메모리에만 — 새로고침 시 소멸 = 최대 프라이버시)
  var files = [];        // { id, name, text }
  var activeId = null;
  var seq = 0;
  var tocHeadings = [];  // 현재 문서 heading 요소 배열(스크롤스파이용)
  var rafPending = false;
  var lastFocusBeforeSidebar = null;

  var IOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  function isMobile() { return window.matchMedia('(max-width: 760px)').matches; }
  function appbarH() { var h = document.querySelector('.appbar'); return h ? h.offsetHeight : 56; }

  // ── 유틸 ────────────────────────────────────────────────────────────────────
  function baseName(name) {
    var n = String(name || 'document').replace(/\.(md|markdown|mdown|mkd|txt)$/i, '');
    return sanitizeFilename(n);
  }
  // 파일명/문서제목 안전화: 경로구분자·제어문자·RTL override·예약문자 제거
  function sanitizeFilename(s) {
    s = String(s || '')
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g, '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '')
      .slice(0, 120)
      .trim();
    return s || 'document';
  }
  function activeFile() { return files.find(function (f) { return f.id === activeId; }) || null; }

  function toast(msg, kind) {
    // 동시 토스트 최대 2개
    var existing = dom.toastWrap.querySelectorAll('.toast');
    if (existing.length >= 2) existing[0].remove();
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' is-' + kind : '');
    var icon = kind === 'error'
      ? '<svg viewBox="0 0 24 24"><path d="M12 8v5M12 16h.01"/><circle cx="12" cy="12" r="9"/></svg>'
      : kind === 'ok'
        ? '<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>'
        : '<svg viewBox="0 0 24 24"><path d="M12 8v5M12 16h.01"/><circle cx="12" cy="12" r="9"/></svg>';
    el.innerHTML = icon + '<span></span>';
    el.querySelector('span').textContent = msg;
    dom.toastWrap.appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .3s, transform .3s';
      el.style.opacity = '0'; el.style.transform = 'translateY(8px)';
      setTimeout(function () { el.remove(); }, 320);
    }, kind === 'error' ? 4600 : 2600);
  }

  function showOverlay(msg) { dom.overlayMsg.textContent = msg || '처리 중…'; dom.overlay.hidden = false; }
  function hideOverlay() { dom.overlay.hidden = true; }

  function anchorDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a); a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 4000);
  }
  // iOS Safari 는 a.download 으로 임의 MIME 다운로드가 불안정 → Web Share(파일 저장)로 폴백
  function downloadBlob(blob, filename, mime) {
    if (IOS && navigator.canShare) {
      try {
        var file = new File([blob], filename, { type: mime || blob.type || 'application/octet-stream' });
        if (navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file], title: filename }).catch(function (err) {
            if (err && err.name === 'AbortError') return; // 사용자가 취소
            anchorDownload(blob, filename);
          });
          return;
        }
      } catch (e) { /* fallthrough */ }
    }
    anchorDownload(blob, filename);
  }

  // ── 테마 ────────────────────────────────────────────────────────────────────
  function applyTheme(theme) {
    dom.body.setAttribute('data-theme', theme);
    var l = $('hljs-light'), d = $('hljs-dark');
    if (l && d) { l.disabled = theme === 'dark'; d.disabled = theme !== 'dark'; }
    try { localStorage.setItem('md-theme', theme); } catch (e) {}
  }
  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('md-theme'); } catch (e) {}
    if (!saved) saved = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    applyTheme(saved);
  }
  function toggleTheme() { applyTheme(dom.body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); }

  // ── 글자 크기 ───────────────────────────────────────────────────────────────
  var FONT_SIZES = [15, 16, 17.5, 19];
  var FONT_LABELS = ['보통', '크게', '더 크게', '가장 크게'];
  var fontIdx = 1;
  function applyFontSize() {
    document.documentElement.style.setProperty('--doc-font-size', FONT_SIZES[fontIdx] + 'px');
    try { localStorage.setItem('md-fontsize', String(fontIdx)); } catch (e) {}
  }
  function cycleFontSize() {
    fontIdx = (fontIdx + 1) % FONT_SIZES.length;
    applyFontSize();
    toast('글자 크기: ' + FONT_LABELS[fontIdx], 'ok');
  }
  function initFontSize() {
    try { var s = localStorage.getItem('md-fontsize'); if (s !== null) { var n = parseInt(s, 10); if (!isNaN(n)) fontIdx = Math.min(FONT_SIZES.length - 1, Math.max(0, n)); } } catch (e) {}
    applyFontSize();
  }

  // ── Markdown 렌더링 ─────────────────────────────────────────────────────────
  function librariesReady() { return typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined'; }

  function configureMarked() {
    if (typeof marked === 'undefined') return;
    // id 는 buildTOC 에서 직접 부여. (headerIds/mangle 옵션은 marked v12에서 제거됨)
    marked.setOptions({ gfm: true, breaks: false });
  }

  function slugify(text, used) {
    var base = String(text).trim().toLowerCase()
      .replace(/[^\w가-힣\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'section';
    var slug = base, i = 1;
    while (used[slug]) { slug = base + '-' + (i++); }
    used[slug] = true;
    return slug;
  }

  function doRender(text) {
    var rawHtml = marked.parse(text || '');
    var clean = DOMPurify.sanitize(rawHtml, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ['target', 'rel'],
      FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'svg', 'math', 'link', 'base'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'srcset', 'ping', 'style'],
      // 허용 스킴: http(s)·mailto·상대경로·#프래그먼트 (tel/sms/callto/xmpp/cid 등 차단)
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i
    });
    dom.doc.innerHTML = clean;

    // 표를 가로 스크롤 래퍼로 감싸기(모바일)
    Array.prototype.forEach.call(dom.doc.querySelectorAll('table'), function (t) {
      if (t.parentElement && t.parentElement.classList.contains('table-wrap')) return;
      var w = document.createElement('div'); w.className = 'table-wrap';
      t.parentNode.insertBefore(w, t); w.appendChild(t);
    });

    // 코드 하이라이트(너무 큰 블록은 생략)
    if (typeof hljs !== 'undefined') {
      Array.prototype.forEach.call(dom.doc.querySelectorAll('pre code'), function (block) {
        if (block.textContent && block.textContent.length > HLJS_MAX) return;
        try { hljs.highlightElement(block); } catch (e) {}
      });
    }

    // 링크: 외부는 새 탭 + 보안속성, target=_blank 인 모든 링크에 rel 보강
    Array.prototype.forEach.call(dom.doc.querySelectorAll('a[href]'), function (a) {
      var href = a.getAttribute('href') || '';
      if (/^https?:/i.test(href)) { a.target = '_blank'; }
      if (a.getAttribute('target') === '_blank') a.rel = 'noopener noreferrer';
    });

    // 태스크 리스트 클래스
    Array.prototype.forEach.call(dom.doc.querySelectorAll('li > input[type="checkbox"]'), function (cb) {
      cb.setAttribute('disabled', '');
      var li = cb.closest('li'); if (li) li.classList.add('task-list-item');
      var ul = li && li.parentElement; if (ul) ul.classList.add('contains-task-list');
    });

    buildTOC();
  }

  function renderMarkdown(text) {
    if (!librariesReady()) {
      // 핵심 라이브러리 미로딩 → 평문 폴백 + 안내
      dom.doc.textContent = text || '';
      toast('필수 라이브러리를 불러오지 못했습니다. 네트워크/CDN을 확인하세요.', 'error');
      dom.toc.innerHTML = '';
      return;
    }
    if ((text || '').length > BIG_TEXT) {
      showOverlay('문서를 그리는 중…');
      setTimeout(function () { try { doRender(text); } finally { hideOverlay(); } }, 30);
    } else {
      doRender(text);
    }
  }

  // ── 목차 + 스크롤스파이 ─────────────────────────────────────────────────────
  var tocLinks = {};
  function buildTOC() {
    var used = {};
    var headings = dom.doc.querySelectorAll('h1, h2, h3, h4, h5, h6');
    dom.toc.innerHTML = '';
    tocLinks = {};
    tocHeadings = [];
    if (!headings.length) return;

    var frag = document.createDocumentFragment();
    Array.prototype.forEach.call(headings, function (h) {
      if (!h.id) h.id = slugify(h.textContent, used);
      var a = document.createElement('a');
      a.href = '#' + h.id;
      a.textContent = h.textContent;
      a.setAttribute('data-level', h.tagName.substring(1));
      a.setAttribute('data-target', h.id);
      frag.appendChild(a);
      tocLinks[h.id] = a;
      tocHeadings.push(h);
    });
    dom.toc.appendChild(frag);
    updateActiveHeading();
  }

  function highlightToc(id) {
    Object.keys(tocLinks).forEach(function (k) {
      var on = (k === id);
      tocLinks[k].classList.toggle('is-active', on);
      if (on) tocLinks[k].setAttribute('aria-current', 'location');
      else tocLinks[k].removeAttribute('aria-current');
    });
  }

  function updateActiveHeading() {
    if (!tocHeadings.length) return;
    var offset = appbarH() + 48;  // heading scroll-margin-top 과 정합
    var current = 0;
    for (var i = 0; i < tocHeadings.length; i++) {
      if (tocHeadings[i].getBoundingClientRect().top <= offset) current = i; else break;
    }
    // 문서 끝 근처면 마지막 섹션 활성화
    if ((window.innerHeight + window.scrollY) >= (document.documentElement.scrollHeight - 4)) {
      current = tocHeadings.length - 1;
    }
    highlightToc(tocHeadings[current].id);
  }

  function updateProgress() {
    var h = document.documentElement;
    var max = h.scrollHeight - h.clientHeight;
    dom.progress.classList.toggle('is-hidden', max < 80); // 스크롤 거의 없으면 진행바 숨김
    var p = max > 0 ? (window.scrollY / max) : 0;
    dom.progressBar.style.width = Math.max(0, Math.min(1, p)) * 100 + '%';
  }

  function onScroll() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(function () {
      rafPending = false;
      updateActiveHeading();
      updateProgress();
    });
  }

  // ── 파일 목록 UI (이벤트 위임) ───────────────────────────────────────────────
  function renderFileList() {
    dom.filelist.innerHTML = '';
    files.forEach(function (f) {
      var li = document.createElement('li');
      li.className = 'filelist__item' + (f.id === activeId ? ' is-active' : '');
      li.setAttribute('role', 'presentation');
      var active = f.id === activeId;
      li.innerHTML =
        '<span class="filelist__open" role="button" tabindex="0" data-id="' + f.id + '"' +
        (active ? ' aria-current="true"' : '') + '>' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>' +
        '<span class="filelist__name"></span></span>' +
        '<button class="filelist__close" data-close="' + f.id + '" aria-label="파일 닫기" title="닫기"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg></button>';
      li.querySelector('.filelist__name').textContent = f.name;
      dom.filelist.appendChild(li);
    });
  }

  function setActive(id) {
    activeId = id;
    var f = activeFile();
    if (!f) { showEmptyState(); return; }
    dom.dropzone.hidden = true;
    dom.doc.hidden = false;
    dom.exportActions.hidden = false;
    dom.btnNew.hidden = false;
    dom.btnFontSize.hidden = false;
    renderMarkdown(f.text);
    renderFileList();
    window.scrollTo(0, 0);
    updateProgress();
  }

  function isAcceptable(f) {
    return /\.(md|markdown|mdown|mkd|txt)$/i.test(f.name) || /text\//.test(f.type) || f.type === '';
  }

  // 인코딩 자동 감지(UTF-8 우선, 실패 시 EUC-KR/CP949 폴백)
  function decodeText(buffer) {
    var bytes = new Uint8Array(buffer);
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF)
      return new TextDecoder('utf-8').decode(bytes.subarray(3));
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) return new TextDecoder('utf-16le').decode(bytes);
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) return new TextDecoder('utf-16be').decode(bytes);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (e) {
      try { return new TextDecoder('euc-kr').decode(bytes); }
      catch (e2) { return new TextDecoder('utf-8').decode(bytes); }
    }
  }

  function addFiles(fileList) {
    var arr = Array.prototype.slice.call(fileList || []);
    var accepted = arr.filter(isAcceptable);
    if (!accepted.length) { toast('마크다운(.md) 또는 텍스트 파일을 선택하세요.', 'error'); return; }

    var results = new Array(accepted.length);
    var remaining = accepted.length;
    function done() { if (--remaining === 0) finishLoad(results); }

    accepted.forEach(function (file, idx) {
      if (file.size > MAX_BYTES) {
        toast('"' + file.name + '"은(는) 10MB를 초과해 건너뜁니다.', 'error');
        results[idx] = null; done(); return;
      }
      var reader = new FileReader();
      reader.onload = function () {
        try { results[idx] = { name: file.name, text: decodeText(reader.result) }; }
        catch (e) { results[idx] = null; toast('파일을 해석하지 못했습니다: ' + file.name, 'error'); }
        done();
      };
      reader.onerror = function () { results[idx] = null; toast('파일을 읽지 못했습니다: ' + file.name, 'error'); done(); };
      reader.readAsArrayBuffer(file);
    });
  }

  function finishLoad(results) {
    var firstNewId = null, added = 0, replaced = 0, total = 0, activeReplaced = false;
    results.forEach(function (r) {
      if (!r) return;
      total++;
      var existing = files.find(function (f) { return f.name === r.name; });
      if (existing) {
        existing.text = r.text; replaced++;
        if (existing.id === activeId) activeReplaced = true;
      } else {
        var id = 'f' + (++seq);
        files.push({ id: id, name: r.name, text: r.text }); added++;
        if (firstNewId === null) firstNewId = id;
      }
    });
    if (!total) return;
    renderFileList();
    if (firstNewId) setActive(firstNewId);          // 새 파일이 있으면 그 파일로 전환
    else if (activeReplaced) refreshActive();        // 활성 파일 갱신: 제자리 재렌더(스크롤 보존)
    // 그 외(비활성 파일만 갱신): 읽던 활성 문서/스크롤 유지, 목록만 갱신

    var msg = added === 0
      ? (replaced === 1 ? '파일을 새로고침했습니다.' : replaced + '개 파일을 새로고침했습니다.')
      : (total === 1 ? '파일을 불러왔습니다.' : total + '개 파일을 불러왔습니다.');
    toast(msg, 'ok');
  }

  // 활성 파일 내용 갱신(스크롤 위치 보존 — '새로고침'용)
  function refreshActive() {
    var f = activeFile(); if (!f) return;
    var sy = window.scrollY;
    renderMarkdown(f.text);
    renderFileList();
    window.scrollTo(0, sy);
    updateProgress();
  }

  function closeFile(id) {
    var wasActive = (id === activeId);
    files = files.filter(function (f) { return f.id !== id; });
    if (wasActive) {
      activeId = files.length ? files[files.length - 1].id : null;
      if (activeId) setActive(activeId); else showEmptyState();
    } else {
      renderFileList(); // 활성 문서는 다시 그리지 않음(읽던 위치 유지)
    }
  }

  function showEmptyState() {
    activeId = null;
    dom.doc.hidden = true;
    dom.doc.innerHTML = '';
    dom.dropzone.hidden = false;
    dom.exportActions.hidden = true;
    dom.btnNew.hidden = true;
    dom.btnFontSize.hidden = true;
    dom.toc.innerHTML = '';
    tocHeadings = []; tocLinks = {};
    dom.progressBar.style.width = '0%';
    closeExportMenu();
    renderFileList();
  }

  // ── 데모 문서 ────────────────────────────────────────────────────────────────
  function loadDemo() {
    fetch('./sample.md').then(function (r) {
      if (!r.ok) throw new Error('not found');
      return r.text();
    }).then(function (text) {
      var existing = files.find(function (f) { return f.name === 'sample.md'; });
      var id;
      if (existing) { existing.text = text; id = existing.id; }
      else { id = 'f' + (++seq); files.push({ id: id, name: 'sample.md', text: text }); }
      renderFileList(); setActive(id);
    }).catch(function () { toast('데모 문서를 불러오지 못했습니다.', 'error'); });
  }

  // ── 사이드바(모바일 드로어) ──────────────────────────────────────────────────
  function focusables(container) {
    return Array.prototype.slice.call(container.querySelectorAll(
      'a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"]),input,select,textarea'
    )).filter(function (el) { return el.offsetParent !== null; });
  }
  function openSidebar() {
    lastFocusBeforeSidebar = document.activeElement;
    dom.body.classList.add('sidebar-open');
    dom.scrim.hidden = false;
    dom.btnMenu.setAttribute('aria-expanded', 'true');
    if (isMobile()) {
      dom.sidebar.setAttribute('role', 'dialog');
      dom.sidebar.setAttribute('aria-modal', 'true');
      dom.main.setAttribute('aria-hidden', 'true');
      var first = dom.sidebar.querySelector('.filelist__open, .addfile, .toc a');
      if (first) setTimeout(function () { try { first.focus(); } catch (e) {} }, 50);
    }
  }
  function closeSidebar() {
    var wasOpen = dom.body.classList.contains('sidebar-open');
    dom.body.classList.remove('sidebar-open');
    dom.scrim.hidden = true;
    dom.btnMenu.setAttribute('aria-expanded', 'false');
    dom.sidebar.removeAttribute('role');
    dom.sidebar.removeAttribute('aria-modal');
    dom.main.removeAttribute('aria-hidden');
    if (wasOpen && lastFocusBeforeSidebar && isMobile()) { try { lastFocusBeforeSidebar.focus(); } catch (e) {} }
  }
  // 드로어 열림(모바일) 동안 Tab 포커스 가두기
  function trapSidebarTab(e) {
    if (e.key !== 'Tab') return;
    if (!isMobile() || !dom.body.classList.contains('sidebar-open')) return;
    var f = focusables(dom.sidebar);
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  // ── 내보내기 메뉴 ────────────────────────────────────────────────────────────
  function openExportMenu() {
    dom.exportMenu.hidden = false;
    dom.btnExport.setAttribute('aria-expanded', 'true');
    var first = dom.exportMenu.querySelector('.menu__item');
    if (first) setTimeout(function () { first.focus(); }, 20);
  }
  function closeExportMenu() {
    if (dom.exportMenu.hidden) return;
    var hadFocus = dom.exportMenu.contains(document.activeElement);
    dom.exportMenu.hidden = true;
    dom.btnExport.setAttribute('aria-expanded', 'false');
    if (hadFocus) { try { dom.btnExport.focus(); } catch (e) {} } // 포커스 트리거로 복귀
  }
  function toggleExportMenu() { if (dom.exportMenu.hidden) openExportMenu(); else closeExportMenu(); }

  // ── 내보내기: 라이트 테마 강제(다크에서도 흰 배경 출력) ───────────────────────
  function withLightTheme(fn) {
    var prev = dom.body.getAttribute('data-theme');
    applyTheme('light');
    return Promise.resolve().then(fn).then(
      function (r) { applyTheme(prev); return r; },
      function (e) { applyTheme(prev); throw e; });
  }

  // ── PDF 내보내기 (html2pdf) ─────────────────────────────────────────────────
  function exportPDF() {
    var f = activeFile(); if (!f) return;
    closeExportMenu();
    if (typeof html2pdf === 'undefined') { toast('PDF 라이브러리를 불러오지 못했습니다.', 'error'); return; }
    showOverlay('PDF 만드는 중… 문서가 길면 시간이 걸릴 수 있습니다.');

    withLightTheme(function () {
      var PAGE_W = 800; // 캡처 폭(px). 모든 콘텐츠를 이 폭 안에 맞춰 우측 잘림 방지
      var holder = document.createElement('div');
      // 화면 밖(left:-99999px)에 두면 html2canvas가 x오프셋을 잘못 잡아 좌측이 잘림 →
      // 좌상단에 두되 진행 오버레이(z-index 70)로 가린다.
      holder.style.cssText = 'position:fixed;left:0;top:0;z-index:1;width:' + PAGE_W + 'px;background:#fff;';
      holder.className = 'pdf-rendering';
      var page = document.createElement('div');
      page.className = 'markdown-body';
      page.style.cssText = 'width:' + PAGE_W + 'px;padding:0;background:#fff;color:#1f2328;font-size:15px;line-height:1.75;box-sizing:border-box;';

      var head = document.createElement('div');
      head.style.cssText = 'margin:0 0 20px;padding-bottom:12px;border-bottom:1.5px solid #222;';
      head.innerHTML = '<div style="font-size:21px;font-weight:800;letter-spacing:-.02em;"></div>' +
        '<div style="font-size:11px;color:#666;margin-top:5px;">Markdown 뷰어 · ' + formatDate(new Date()) + '</div>';
      head.querySelector('div').textContent = baseName(f.name);

      page.appendChild(head);
      var clone = dom.doc.cloneNode(true);
      while (clone.firstChild) page.appendChild(clone.firstChild);
      holder.appendChild(page);
      document.body.appendChild(holder);

      var scale = isMobile() ? 1.5 : 2;
      var opt = {
        margin: [13, 13, 14, 13],   // 상우하좌(mm) 대칭 여백 → 중앙 배치
        filename: baseName(f.name) + '.pdf',
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: scale, useCORS: true, backgroundColor: '#ffffff', logging: false, width: PAGE_W, windowWidth: PAGE_W, x: 0, y: 0, scrollX: 0, scrollY: 0 },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy'] }
      };

      function cleanup() {
        holder.remove();
        Array.prototype.forEach.call(document.querySelectorAll('.html2pdf__overlay, .html2pdf__container'), function (n) { n.remove(); });
      }
      return html2pdf().set(opt).from(page).save().then(function () {
        cleanup(); hideOverlay(); toast('PDF 파일을 저장했습니다.', 'ok');
      }).catch(function (err) {
        cleanup(); hideOverlay(); console.error(err);
        toast('PDF 생성에 실패했습니다. "인쇄 / PDF 저장"을 이용해 보세요.', 'error');
      });
    });
  }

  // ── 인쇄 (네이티브 → PDF 저장 가능, 텍스트 선택 가능) ────────────────────────
  var printing = false;
  function printDoc() {
    var f = activeFile(); if (!f) return;
    if (printing) return;          // 진행 중 재호출 방지
    printing = true;
    closeExportMenu();
    var prev = dom.body.getAttribute('data-theme');
    applyTheme('light');
    var restored = false;
    var restore = function () { if (restored) return; restored = true; printing = false; applyTheme(prev); window.removeEventListener('afterprint', restore); };
    window.addEventListener('afterprint', restore, { once: true });
    setTimeout(function () { window.print(); setTimeout(restore, 1500); }, 60);
  }

  // ── HWPX 내보내기 ───────────────────────────────────────────────────────────
  function exportHWPX() {
    var f = activeFile(); if (!f) return;
    closeExportMenu();
    if (typeof HwpxExporter === 'undefined') { toast('HWPX 모듈을 불러오지 못했습니다.', 'error'); return; }
    showOverlay('HWPX(한글) 문서를 만드는 중…');
    HwpxExporter.fromMarkdown(f.text, { title: baseName(f.name) }).then(function (blob) {
      downloadBlob(blob, baseName(f.name) + '.hwpx', 'application/hwp+zip');
      hideOverlay(); toast('HWPX 파일을 저장했습니다.', 'ok');
    }).catch(function (err) {
      hideOverlay(); console.error(err);
      toast('HWPX 생성에 실패했습니다. 원본 .md 다운로드를 이용해 보세요.', 'error');
    });
  }

  function downloadMD() {
    var f = activeFile(); if (!f) return;
    closeExportMenu();
    var blob = new Blob([f.text], { type: 'text/markdown;charset=utf-8' });
    downloadBlob(blob, baseName(f.name) + '.md', 'text/markdown');
    toast('원본 파일을 저장했습니다.', 'ok');
  }

  function formatDate(d) { return d.getFullYear() + '. ' + (d.getMonth() + 1) + '. ' + d.getDate() + '.'; }

  // ── 드래그앤드롭 ────────────────────────────────────────────────────────────
  function hasFiles(e) {
    return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1;
  }
  function setupDnD() {
    var dz = dom.dropzone;
    var depth = 0;
    function showDrag() { if (dom.doc.hidden) dz.classList.add('is-drag'); else dom.drophint.hidden = false; }
    function clearDrag() { dz.classList.remove('is-drag'); dom.drophint.hidden = true; }
    document.addEventListener('dragenter', function (e) { if (!hasFiles(e)) return; e.preventDefault(); depth++; showDrag(); });
    document.addEventListener('dragover', function (e) { if (hasFiles(e)) e.preventDefault(); });
    document.addEventListener('dragleave', function (e) { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (depth === 0) clearDrag(); });
    document.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0; clearDrag();
      addFiles(e.dataTransfer.files);
    });
    dz.addEventListener('click', function (e) { if (e.target.closest('button')) return; dom.fileInput.click(); });
    dz.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dom.fileInput.click(); } });
  }

  // ── 이벤트 바인딩 ───────────────────────────────────────────────────────────
  function bind() {
    $('btn-pick').addEventListener('click', function () { dom.fileInput.click(); });
    $('btn-add').addEventListener('click', function () { dom.fileInput.click(); });
    $('btn-demo').addEventListener('click', loadDemo);
    dom.btnNew.addEventListener('click', function () { dom.fileInput.click(); });
    dom.fileInput.addEventListener('change', function () { addFiles(dom.fileInput.files); dom.fileInput.value = ''; });

    // 내보내기 메뉴
    dom.btnExport.addEventListener('click', function (e) { e.stopPropagation(); toggleExportMenu(); });
    $('mi-pdf').addEventListener('click', exportPDF);
    $('mi-print').addEventListener('click', printDoc);
    $('mi-hwpx').addEventListener('click', exportHWPX);
    $('mi-md').addEventListener('click', downloadMD);
    document.addEventListener('click', function (e) {
      if (!dom.exportMenu.hidden && !e.target.closest('.menu-wrap')) closeExportMenu();
    });

    $('btn-theme').addEventListener('click', toggleTheme);
    dom.btnFontSize.addEventListener('click', cycleFontSize);
    dom.btnMenu.addEventListener('click', function () {
      if (dom.body.classList.contains('sidebar-open')) closeSidebar(); else openSidebar();
    });
    dom.scrim.addEventListener('click', closeSidebar);
    dom.sidebar.addEventListener('keydown', trapSidebarTab);

    // 내보내기 메뉴 화살표 키 내비게이션
    dom.exportMenu.addEventListener('keydown', function (e) {
      var items = focusables(dom.exportMenu);
      if (!items.length) return;
      var i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); (items[i + 1] || items[0]).focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); (items[i - 1] || items[items.length - 1]).focus(); }
      else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
    });

    // 파일목록(위임)
    dom.filelist.addEventListener('click', function (e) {
      var close = e.target.closest('[data-close]');
      if (close) { closeFile(close.getAttribute('data-close')); return; }
      var open = e.target.closest('[data-id]');
      if (open) { setActive(open.getAttribute('data-id')); closeSidebar(); }
    });
    dom.filelist.addEventListener('keydown', function (e) {
      var open = e.target.closest('[data-id]');
      if (open && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setActive(open.getAttribute('data-id')); closeSidebar(); }
    });

    // 목차(위임)
    dom.toc.addEventListener('click', function (e) {
      var a = e.target.closest('a[data-target]');
      if (!a) return;
      e.preventDefault();
      var target = a.getAttribute('data-target');
      var el = document.getElementById(target);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      highlightToc(target);   // 클릭 즉시 활성 표시(스크롤 정착 전 직전항목 강조 방지)
      closeSidebar();
      history.replaceState(null, '', '#' + target);
    });

    // 스크롤(진행바 + 스크롤스파이)
    window.addEventListener('scroll', onScroll, { passive: true });

    // 키보드
    document.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey) {
        if (e.key === 'o') { e.preventDefault(); dom.fileInput.click(); }
        else if (e.key === 'p' && activeFile()) { e.preventDefault(); printDoc(); }
      }
      if (e.key === 'Escape') { closeExportMenu(); closeSidebar(); }
    });

    window.addEventListener('resize', function () {
      if (rafPending) return; rafPending = true;
      requestAnimationFrame(function () { rafPending = false; if (window.innerWidth > 760) closeSidebar(); updateProgress(); });
    });
  }

  function registerSW() {
    if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('./sw.js').catch(function () {});
      });
    }
  }

  function init() {
    initTheme();
    initFontSize();
    configureMarked();
    setupDnD();
    bind();
    showEmptyState();
    registerSW();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

/*
 * hwpx.js — 브라우저에서 Markdown을 HWPX(한글/OWPML) 문서로 변환하는 순수 클라이언트 생성기
 *
 * 의존성: marked(전역 marked.lexer), JSZip(전역 JSZip)
 * 사용법:  const blob = await HwpxExporter.fromMarkdown(markdownText, { title: '문서제목' });
 *
 * 설계 메모
 *  - HWPX는 OPC(ZIP) 컨테이너. mimetype 은 반드시 첫 엔트리이며 비압축(STORE).
 *  - header.xml : 글자/문단/테두리 스타일 정의. 본 모듈은 검증된 base 템플릿 골격에
 *                 마크다운 표현에 필요한 CharShape/ParaShape/BorderFill 을 확장해 둠.
 *  - section0.xml : 실제 본문. 첫 문단의 첫 run 에 secPr(페이지/여백) 포함.
 *  - marked.lexer 로 얻은 토큰을 순회하며 문단/표/코드블록 XML 을 생성한다.
 */
(function (global) {
  'use strict';

  // ──────────────────────────────────────────────────────────────────────────
  // 단위/상수
  // ──────────────────────────────────────────────────────────────────────────
  var BODY_WIDTH = 42520; // A4 본문폭(HWPUNIT) = 59528 - 8504*2

  // CharShape ID 맵
  var CP = {
    NORMAL: 0, BOLD: 7, ITALIC: 8, BOLD_ITALIC: 9, CODE: 10, CODE_BLOCK: 11,
    H1: 12, H2: 13, H3: 14, H4: 15, H5: 16, H6: 17, LINK: 18, STRIKE: 19,
    TH: 20, QUOTE: 21
  };
  // ParaShape ID 맵
  var PP = {
    BODY: 0, HEADING: 20, CODE: 21, QUOTE: 22,
    LIST1: 23, LIST2: 24, LIST3: 25,
    TD_LEFT: 26, TD_CENTER: 27, TD_RIGHT: 28, HR: 29
  };
  // BorderFill ID 맵
  var BF = { NONE: 2, CELL: 3, TH: 4, CODE: 5, HR: 6 };

  var HEAD_CP = [CP.H1, CP.H2, CP.H3, CP.H4, CP.H5, CP.H6];

  // ──────────────────────────────────────────────────────────────────────────
  // 고유 ID 발급
  // ──────────────────────────────────────────────────────────────────────────
  var _id = 0;
  function resetId() { _id = 2000000000; }
  function nextId() { _id += 1; return _id; }

  // ──────────────────────────────────────────────────────────────────────────
  // XML 이스케이프
  // ──────────────────────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '') // 잘못된 XML 제어문자 제거
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')       // lone high surrogate
      .replace(/(^|[^\uD800-\uDBFF])([\uDC00-\uDFFF])/g, '$1')  // lone low surrogate
      .replace(/[\uFDD0-\uFDEF\uFFFE\uFFFF]/g, '')              // XML noncharacter
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
  function stripTags(s) { return String(s == null ? '' : s).replace(/<[^>]*>/g, ''); }
  function decodeEntities(s) {
    return String(s == null ? '' : s)
      .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, function (m, n) { try { return String.fromCodePoint(parseInt(n, 10)); } catch (e) { return ''; } })
      .replace(/&#x([0-9a-fA-F]+);/g, function (m, n) { try { return String.fromCodePoint(parseInt(n, 16)); } catch (e) { return ''; } })
      .replace(/&amp;/g, '&');
  }

  // ──────────────────────────────────────────────────────────────────────────
  // run / paragraph 빌더
  // ──────────────────────────────────────────────────────────────────────────
  function run(cp, text) {
    if (text === '' || text == null) return '<hp:run charPrIDRef="' + cp + '"><hp:t/></hp:run>';
    return '<hp:run charPrIDRef="' + cp + '"><hp:t>' + esc(text) + '</hp:t></hp:run>';
  }
  function emptyRun() { return '<hp:run charPrIDRef="0"><hp:t/></hp:run>'; }
  function lineBreakRun(cp) { return '<hp:run charPrIDRef="' + cp + '"><hp:lineBreak/></hp:run>'; }

  function para(ppr, runsXml) {
    return '<hp:p id="' + nextId() + '" paraPrIDRef="' + ppr +
      '" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">' +
      (runsXml || emptyRun()) + '</hp:p>';
  }
  function emptyPara() { return para(PP.BODY, emptyRun()); }

  // ──────────────────────────────────────────────────────────────────────────
  // 인라인 토큰 → run 들
  // ──────────────────────────────────────────────────────────────────────────
  function charPrFor(style) {
    if (style.link) return CP.LINK;
    if (style.strike) return CP.STRIKE;
    if (style.fixed != null) return style.fixed;
    if (style.bold && style.italic) return CP.BOLD_ITALIC;
    if (style.bold) return CP.BOLD;
    if (style.italic) return CP.ITALIC;
    return CP.NORMAL;
  }

  function inlineRuns(tokens, style) {
    if (!tokens) return '';
    style = style || {};
    var out = '';
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      switch (t.type) {
        case 'text':
        case 'escape':
          if (t.tokens && t.tokens.length) out += inlineRuns(t.tokens, style);
          else out += run(charPrFor(style), t.text);
          break;
        case 'strong':
          out += inlineRuns(t.tokens, assign(style, { bold: true }));
          break;
        case 'em':
          out += inlineRuns(t.tokens, assign(style, { italic: true }));
          break;
        case 'del':
          out += inlineRuns(t.tokens, assign(style, { strike: true }));
          break;
        case 'codespan':
          out += run(CP.CODE, t.text);
          break;
        case 'link':
          out += inlineRuns(t.tokens, assign(style, { link: true }));
          // URL 병기는 본문 맥락에서만(헤딩/표헤더 style.fixed 에서는 생략 — 제목 크기로 깨지는 것 방지),
          // 병기 텍스트는 링크 글자모양(CP.LINK)으로 강제
          if (style.fixed == null && /^https?:\/\//i.test(t.href || '') && (t.href || '') !== plainText(t)) {
            out += run(CP.LINK, ' (' + (t.href || '') + ')');
          }
          break;
        case 'image':
          var _alt = t.text || t.title || '이미지';
          out += run(charPrFor(style), '🖼 ' + _alt + (t.href ? ' (' + t.href + ')' : ''));
          break;
        case 'br':
          out += lineBreakRun(charPrFor(style));
          break;
        case 'html':
          if (/<br\s*\/?>/i.test(t.text || '')) { out += lineBreakRun(charPrFor(style)); break; }
          var txt = decodeEntities(stripTags(t.text));
          if (txt.trim()) out += run(charPrFor(style), txt);
          break;
        default:
          if (t.tokens && t.tokens.length) out += inlineRuns(t.tokens, style);
          else if (t.text != null) out += run(charPrFor(style), t.text);
      }
    }
    return out;
  }

  function assign(a, b) {
    var o = {}; var k;
    for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) o[k] = a[k];
    for (k in b) if (Object.prototype.hasOwnProperty.call(b, k)) o[k] = b[k];
    return o;
  }

  function plainText(token) {
    if (token == null) return '';
    if (typeof token === 'string') return token;
    if (token.text != null && (!token.tokens || !token.tokens.length)) return token.text;
    if (token.tokens) {
      var s = '';
      for (var i = 0; i < token.tokens.length; i++) s += plainText(token.tokens[i]);
      return s;
    }
    return token.text || '';
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 블록 토큰 렌더링
  // ──────────────────────────────────────────────────────────────────────────
  function renderHeading(t) {
    var depth = Math.min(Math.max(t.depth || 1, 1), 6);
    return para(PP.HEADING, inlineRuns(t.tokens, { fixed: HEAD_CP[depth - 1] }));
  }

  function listParaPr(depth) {
    if (depth <= 0) return PP.LIST1;
    if (depth === 1) return PP.LIST2;
    return PP.LIST3;
  }

  function renderList(list, depth) {
    var xml = '';
    var idx = (list.start != null && !isNaN(list.start)) ? list.start : 1;
    for (var i = 0; i < list.items.length; i++) {
      var item = list.items[i];
      var marker;
      if (list.ordered) marker = idx + '. ';
      else if (item.task) marker = item.checked ? '☑ ' : '☐ ';
      else marker = '• ';

      var first = true;
      var blocks = item.tokens || [];
      var rendered = false;
      for (var j = 0; j < blocks.length; j++) {
        var blk = blocks[j];
        if (blk.type === 'list') {
          if (first) { xml += para(listParaPr(depth), run(CP.NORMAL, marker)); first = false; rendered = true; }
          xml += renderList(blk, depth + 1);
        } else {
          var inner = blk.tokens ? inlineRuns(blk.tokens, {}) : run(CP.NORMAL, blk.text || '');
          var prefixRun = first ? run(CP.NORMAL, marker) : run(CP.NORMAL, '   ');
          xml += para(listParaPr(depth), prefixRun + inner);
          first = false;
          rendered = true;
        }
      }
      if (!rendered) {
        xml += para(listParaPr(depth), run(CP.NORMAL, marker));
      }
      if (list.ordered) idx++;
    }
    return xml;
  }

  function renderBlockquote(bq) {
    var xml = '';
    var toks = bq.tokens || [];
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (t.type === 'blockquote') {
        xml += renderBlockquote(t);
      } else if (t.type === 'list') {
        xml += renderList(t, 1);
      } else if (t.type === 'space') {
        // skip
      } else if (t.type === 'code') {
        xml += renderCode(t);
      } else {
        xml += para(PP.QUOTE, inlineRuns(t.tokens || [], { fixed: CP.QUOTE }) || run(CP.QUOTE, plainText(t)));
      }
    }
    return xml;
  }

  // 코드블록: 회색 배경의 1x1 표 안에 라인별 문단
  function renderCode(t) {
    try {
      var raw = String(t.text == null ? '' : t.text).replace(/\n$/, '');
      var lines = raw.split('\n');
      var inner = '';
      for (var i = 0; i < lines.length; i++) {
        inner += para(PP.CODE, run(CP.CODE_BLOCK, lines[i].length ? lines[i] : ' '));
      }
      var h = Math.max(900, lines.length * 360 + 560);
      var tc = '<hp:tc name="" header="0" hasMargin="1" protect="0" editable="0" dirty="0" borderFillIDRef="' + BF.CODE + '">' +
        '<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">' +
        inner +
        '</hp:subList>' +
        '<hp:cellAddr colAddr="0" rowAddr="0"/>' +
        '<hp:cellSpan colSpan="1" rowSpan="1"/>' +
        '<hp:cellSz width="' + BODY_WIDTH + '" height="' + h + '"/>' +
        '<hp:cellMargin left="566" right="566" top="340" bottom="340"/>' +
        '</hp:tc>';
      return tableWrap(1, 1, h, '<hp:tr>' + tc + '</hp:tr>') + emptyPara();
    } catch (e) {
      // 폴백: 단순 모노스페이스 문단
      var ls = String(t.text || '').replace(/\n$/, '').split('\n');
      var out = '';
      for (var k = 0; k < ls.length; k++) out += para(PP.CODE, run(CP.CODE_BLOCK, ls[k] || ' '));
      return out + emptyPara();
    }
  }

  function tableWrap(rowCnt, colCnt, totalHeight, trsXml) {
    var tbl = '<hp:tbl id="' + nextId() + '" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" ' +
      'textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" ' +
      'rowCnt="' + rowCnt + '" colCnt="' + colCnt + '" cellSpacing="0" borderFillIDRef="' + BF.CELL + '" noAdjust="0">' +
      '<hp:sz width="' + BODY_WIDTH + '" widthRelTo="ABSOLUTE" height="' + totalHeight + '" heightRelTo="ABSOLUTE" protect="0"/>' +
      '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" ' +
      'vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>' +
      '<hp:outMargin left="0" right="0" top="0" bottom="0"/>' +
      '<hp:inMargin left="0" right="0" top="0" bottom="0"/>' +
      trsXml +
      '</hp:tbl>';
    return '<hp:p id="' + nextId() + '" paraPrIDRef="' + PP.BODY + '" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">' +
      '<hp:run charPrIDRef="0">' + tbl + '</hp:run></hp:p>';
  }

  function colWidths(n) {
    var each = Math.floor(BODY_WIDTH / n);
    var arr = [];
    for (var i = 0; i < n; i++) arr.push(each);
    arr[n - 1] = BODY_WIDTH - each * (n - 1);
    return arr;
  }

  function alignParaPr(a) {
    if (a === 'center') return PP.TD_CENTER;
    if (a === 'right') return PP.TD_RIGHT;
    return PP.TD_LEFT;
  }

  function tableCell(runsXml, bf, ppr, ci, ri, w, h, isHeader) {
    return '<hp:tc name="" header="' + (isHeader ? 1 : 0) + '" hasMargin="1" protect="0" editable="0" dirty="0" borderFillIDRef="' + bf + '">' +
      '<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">' +
      '<hp:p id="' + nextId() + '" paraPrIDRef="' + ppr + '" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">' +
      (runsXml || emptyRun()) + '</hp:p>' +
      '</hp:subList>' +
      '<hp:cellAddr colAddr="' + ci + '" rowAddr="' + ri + '"/>' +
      '<hp:cellSpan colSpan="1" rowSpan="1"/>' +
      '<hp:cellSz width="' + w + '" height="' + h + '"/>' +
      '<hp:cellMargin left="510" right="510" top="141" bottom="141"/>' +
      '</hp:tc>';
  }

  function renderTable(t) {
    try {
      var ncol = t.header.length;
      if (!ncol) return '';
      var widths = colWidths(ncol);
      var aligns = t.align || [];
      var rowH = 2800;
      var rowsXml = '';
      var rowCount = 1 + t.rows.length;

      // 헤더
      var th = '';
      for (var c = 0; c < ncol; c++) {
        th += tableCell(inlineRuns(t.header[c].tokens, { fixed: CP.TH }), BF.TH, PP.TD_CENTER, c, 0, widths[c], rowH, true);
      }
      rowsXml += '<hp:tr>' + th + '</hp:tr>';

      // 본문
      for (var r = 0; r < t.rows.length; r++) {
        var rowCells = t.rows[r];
        var trx = '';
        for (var cc = 0; cc < ncol; cc++) {
          var cellTok = rowCells[cc] ? rowCells[cc].tokens : null;
          trx += tableCell(inlineRuns(cellTok, {}), BF.CELL, alignParaPr(aligns[cc]), cc, r + 1, widths[cc], rowH, false);
        }
        rowsXml += '<hp:tr>' + trx + '</hp:tr>';
      }

      return tableWrap(rowCount, ncol, rowH * rowCount, rowsXml) + emptyPara();
    } catch (e) {
      // 폴백: 표를 단순 텍스트로
      var out = '';
      var head = t.header.map(function (x) { return plainText(x); }).join(' | ');
      out += para(PP.BODY, run(CP.BOLD, head));
      for (var i = 0; i < t.rows.length; i++) {
        out += para(PP.BODY, run(CP.NORMAL, t.rows[i].map(function (x) { return plainText(x); }).join(' | ')));
      }
      return out + emptyPara();
    }
  }

  function renderToken(t) {
    switch (t.type) {
      case 'heading': return renderHeading(t);
      case 'paragraph': return para(PP.BODY, inlineRuns(t.tokens, {}));
      case 'text': return para(PP.BODY, t.tokens ? inlineRuns(t.tokens, {}) : run(CP.NORMAL, t.text));
      case 'list': return renderList(t, 0);
      case 'code': return renderCode(t);
      case 'blockquote': return renderBlockquote(t);
      case 'table': return renderTable(t);
      case 'hr': return para(PP.HR, emptyRun());
      case 'html':
        var htxt = decodeEntities(stripTags(t.text)).trim();
        return htxt ? para(PP.BODY, run(CP.NORMAL, htxt)) : '';
      case 'space': return '';
      default:
        // 미지원 확장 토큰(각주/정의목록 등)도 내용을 잃지 않도록 폴백
        if (t.tokens && t.tokens.length) return para(PP.BODY, inlineRuns(t.tokens, {}));
        var ptxt = plainText(t);
        return ptxt ? para(PP.BODY, run(CP.NORMAL, ptxt)) : '';
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // header.xml 생성 (base 골격 + 마크다운용 스타일 확장)
  // ──────────────────────────────────────────────────────────────────────────
  function charPr(id, height, font, color, opts) {
    opts = opts || {};
    var shade = opts.shade || 'none';
    var ulType = opts.underline ? 'BOTTOM' : 'NONE';
    var ulColor = opts.underlineColor || '#000000';
    var strike = opts.strike ? 'SOLID' : 'NONE';
    return '<hh:charPr id="' + id + '" height="' + height + '" textColor="' + (color || '#000000') +
      '" shadeColor="' + shade + '" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="2">' +
      '<hh:fontRef hangul="' + font + '" latin="' + font + '" hanja="' + font + '" japanese="' + font + '" other="' + font + '" symbol="' + font + '" user="' + font + '"/>' +
      '<hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>' +
      '<hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>' +
      '<hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>' +
      '<hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>' +
      (opts.bold ? '<hh:bold/>' : '') +
      (opts.italic ? '<hh:italic/>' : '') +
      '<hh:underline type="' + ulType + '" shape="SOLID" color="' + ulColor + '"/>' +
      '<hh:strikeout shape="' + strike + '" color="#000000"/>' +
      '<hh:outline type="NONE"/>' +
      '<hh:shadow type="NONE" color="#C0C0C0" offsetX="10" offsetY="10"/>' +
      '</hh:charPr>';
  }

  function borderFill(id, sides, fillColor) {
    // sides: { l,r,t,b } each true(SOLID) / false(NONE)
    function bd(name, on, w, color) {
      return '<hh:' + name + ' type="' + (on ? 'SOLID' : 'NONE') + '" width="' + w + '" color="' + color + '"/>';
    }
    var w = '0.12 mm', col = '#BBBBBB';
    var xml = '<hh:borderFill id="' + id + '" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">' +
      '<hh:slash type="NONE" Crooked="0" isCounter="0"/>' +
      '<hh:backSlash type="NONE" Crooked="0" isCounter="0"/>' +
      bd('leftBorder', sides.l, w, col) +
      bd('rightBorder', sides.r, w, col) +
      bd('topBorder', sides.t, w, col) +
      bd('bottomBorder', sides.b, w, col) +
      '<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>';
    if (fillColor) {
      xml += '<hc:fillBrush><hc:winBrush faceColor="' + fillColor + '" hatchColor="#999999" alpha="0"/></hc:fillBrush>';
    }
    xml += '</hh:borderFill>';
    return xml;
  }

  function paraPr(id, opts) {
    // opts: align, line(%), left, intent, prev, next, bf
    var align = opts.align || 'JUSTIFY';
    var line = opts.line || 160;
    var left = opts.left || 0, intent = opts.intent || 0, prev = opts.prev || 0, next = opts.next || 0;
    var bf = opts.bf != null ? opts.bf : 2;
    function margins(mult) {
      return '<hh:margin>' +
        '<hc:intent value="' + (intent * mult) + '" unit="HWPUNIT"/>' +
        '<hc:left value="' + (left * mult) + '" unit="HWPUNIT"/>' +
        '<hc:right value="0" unit="HWPUNIT"/>' +
        '<hc:prev value="' + (prev * mult) + '" unit="HWPUNIT"/>' +
        '<hc:next value="' + (next * mult) + '" unit="HWPUNIT"/>' +
        '</hh:margin>' +
        '<hh:lineSpacing type="PERCENT" value="' + line + '" unit="HWPUNIT"/>';
    }
    return '<hh:paraPr id="' + id + '" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0" textDir="LTR">' +
      '<hh:align horizontal="' + align + '" vertical="BASELINE"/>' +
      '<hh:heading type="NONE" idRef="0" level="0"/>' +
      '<hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="BREAK_WORD" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>' +
      '<hh:autoSpacing eAsianEng="0" eAsianNum="0"/>' +
      '<hp:switch>' +
      '<hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">' + margins(1) + '</hp:case>' +
      '<hp:default>' + margins(2) + '</hp:default>' +
      '</hp:switch>' +
      '<hh:border borderFillIDRef="' + bf + '" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/>' +
      '</hh:paraPr>';
  }

  function buildHeader() {
    // 기존 base 의 charPr 0~6 (그대로 사용)
    var baseChar0_6 =
      charPr(0, 1000, 1, '#000000', {}) +
      charPr(1, 1000, 0, '#000000', {}) +
      charPr(2, 900, 0, '#000000', {}) +
      charPr(3, 900, 1, '#000000', {}) +
      charPr(4, 900, 0, '#000000', {}) +
      charPr(5, 1600, 0, '#2E74B5', {}) +
      charPr(6, 1100, 0, '#000000', {});
    // 확장 charPr 7~21
    var extChar =
      charPr(CP.BOLD, 1000, 1, '#000000', { bold: true }) +
      charPr(CP.ITALIC, 1000, 1, '#000000', { italic: true }) +
      charPr(CP.BOLD_ITALIC, 1000, 1, '#000000', { bold: true, italic: true }) +
      charPr(CP.CODE, 1000, 0, '#C7254E', { shade: '#F2EEF0' }) +
      charPr(CP.CODE_BLOCK, 960, 0, '#24292E', {}) +
      charPr(CP.H1, 1900, 0, '#1A1A1A', { bold: true }) +
      charPr(CP.H2, 1600, 0, '#1A1A1A', { bold: true }) +
      charPr(CP.H3, 1350, 0, '#1A1A1A', { bold: true }) +
      charPr(CP.H4, 1200, 0, '#333333', { bold: true }) +
      charPr(CP.H5, 1080, 0, '#333333', { bold: true }) +
      charPr(CP.H6, 1000, 0, '#6A737D', { bold: true }) +
      charPr(CP.LINK, 1000, 1, '#2563EB', { underline: true, underlineColor: '#2563EB' }) +
      charPr(CP.STRIKE, 1000, 1, '#000000', { strike: true }) +
      charPr(CP.TH, 1000, 0, '#1A1A1A', { bold: true }) +
      charPr(CP.QUOTE, 1000, 1, '#57606A', { italic: true });
    var charProps = '<hh:charProperties itemCnt="22">' + baseChar0_6 + extChar + '</hh:charProperties>';

    // borderFill 1,2 (base) + 3~6 (확장)
    var bf1 = '<hh:borderFill id="1" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">' +
      '<hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>' +
      '<hh:leftBorder type="NONE" width="0.1 mm" color="#000000"/><hh:rightBorder type="NONE" width="0.1 mm" color="#000000"/>' +
      '<hh:topBorder type="NONE" width="0.1 mm" color="#000000"/><hh:bottomBorder type="NONE" width="0.1 mm" color="#000000"/>' +
      '<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/></hh:borderFill>';
    var bf2 = '<hh:borderFill id="2" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">' +
      '<hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>' +
      '<hh:leftBorder type="NONE" width="0.1 mm" color="#000000"/><hh:rightBorder type="NONE" width="0.1 mm" color="#000000"/>' +
      '<hh:topBorder type="NONE" width="0.1 mm" color="#000000"/><hh:bottomBorder type="NONE" width="0.1 mm" color="#000000"/>' +
      '<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>' +
      '<hc:fillBrush><hc:winBrush faceColor="none" hatchColor="#999999" alpha="0"/></hc:fillBrush></hh:borderFill>';
    var borderFills = '<hh:borderFills itemCnt="6">' + bf1 + bf2 +
      borderFill(BF.CELL, { l: true, r: true, t: true, b: true }, null) +
      borderFill(BF.TH, { l: true, r: true, t: true, b: true }, '#EEF1F5') +
      borderFill(BF.CODE, { l: true, r: true, t: true, b: true }, '#F6F8FA') +
      borderFill(BF.HR, { l: false, r: false, t: false, b: true }, null) +
      '</hh:borderFills>';

    // base paraPr 0~19 는 별도 정의가 필요 없으나, 본문은 0 만 사용.
    // 단순화를 위해 base paraPr 0~19 중 본 모듈이 참조하는 0 만 base 동일하게 두고,
    // 나머지(1~19)도 형태 유지를 위해 생성한다(스타일 참조 정합성 유지).
    var baseParas = '';
    // paraPr 0: 본문 기본
    baseParas += paraPr(0, { align: 'JUSTIFY', line: 160 });
    // 1~19: base 와 동일 의미를 갖도록 최소 형태로 생성(미사용이지만 styles 참조 충족)
    for (var p = 1; p <= 19; p++) {
      baseParas += paraPr(p, { align: 'JUSTIFY', line: 160 });
    }
    // 확장 20~29
    var extParas =
      paraPr(PP.HEADING, { align: 'LEFT', line: 160, prev: 500, next: 200 }) +
      paraPr(PP.CODE, { align: 'LEFT', line: 130 }) +
      paraPr(PP.QUOTE, { align: 'JUSTIFY', line: 160, left: 600, prev: 50, next: 50 }) +
      paraPr(PP.LIST1, { align: 'JUSTIFY', line: 160, left: 700, intent: -350 }) +
      paraPr(PP.LIST2, { align: 'JUSTIFY', line: 160, left: 1400, intent: -350 }) +
      paraPr(PP.LIST3, { align: 'JUSTIFY', line: 160, left: 2100, intent: -350 }) +
      paraPr(PP.TD_LEFT, { align: 'LEFT', line: 130 }) +
      paraPr(PP.TD_CENTER, { align: 'CENTER', line: 130 }) +
      paraPr(PP.TD_RIGHT, { align: 'RIGHT', line: 130 }) +
      paraPr(PP.HR, { align: 'JUSTIFY', line: 100, prev: 150, next: 150, bf: BF.HR });
    var paraProps = '<hh:paraProperties itemCnt="30">' + baseParas + extParas + '</hh:paraProperties>';

    return HEADER_PREFIX + borderFills + charProps + HEADER_MID + paraProps + HEADER_SUFFIX;
  }

  // ── 정적 골격 조각들 ───────────────────────────────────────────────────────
  var NS_HEAD = 'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"';

  var FONTFACES = (function () {
    var langs = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'];
    var ti = '<hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>';
    var s = '<hh:fontfaces itemCnt="7">';
    for (var i = 0; i < langs.length; i++) {
      s += '<hh:fontface lang="' + langs[i] + '" fontCnt="2">' +
        '<hh:font id="0" face="함초롬돋움" type="TTF" isEmbedded="0">' + ti + '</hh:font>' +
        '<hh:font id="1" face="함초롬바탕" type="TTF" isEmbedded="0">' + ti + '</hh:font>' +
        '</hh:fontface>';
    }
    s += '</hh:fontfaces>';
    return s;
  })();

  var HEADER_PREFIX =
    "<?xml version='1.0' encoding='UTF-8'?>" +
    '<hh:head ' + NS_HEAD + ' version="1.5" secCnt="1">' +
    '<hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/>' +
    '<hh:refList>' +
    FONTFACES;

  var TAB_NUM =
    '<hh:tabProperties itemCnt="3">' +
    '<hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/>' +
    '<hh:tabPr id="1" autoTabLeft="1" autoTabRight="0"/>' +
    '<hh:tabPr id="2" autoTabLeft="0" autoTabRight="1"/>' +
    '</hh:tabProperties>' +
    '<hh:numberings itemCnt="1">' +
    '<hh:numbering id="1" start="0">' +
    '<hh:paraHead start="1" level="1" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="4294967295" checkable="0">^1.</hh:paraHead>' +
    '<hh:paraHead start="1" level="2" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="HANGUL_SYLLABLE" charPrIDRef="4294967295" checkable="0">^2.</hh:paraHead>' +
    '<hh:paraHead start="1" level="3" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="4294967295" checkable="0">^3)</hh:paraHead>' +
    '<hh:paraHead start="1" level="4" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="HANGUL_SYLLABLE" charPrIDRef="4294967295" checkable="0">^4)</hh:paraHead>' +
    '<hh:paraHead start="1" level="5" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="4294967295" checkable="0">(^5)</hh:paraHead>' +
    '<hh:paraHead start="1" level="6" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="HANGUL_SYLLABLE" charPrIDRef="4294967295" checkable="0">(^6)</hh:paraHead>' +
    '<hh:paraHead start="1" level="7" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="CIRCLED_DIGIT" charPrIDRef="4294967295" checkable="1">^7</hh:paraHead>' +
    '<hh:paraHead start="1" level="8" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="CIRCLED_HANGUL_SYLLABLE" charPrIDRef="4294967295" checkable="1">^8</hh:paraHead>' +
    '<hh:paraHead start="1" level="9" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="HANGUL_JAMO" charPrIDRef="4294967295" checkable="0"/>' +
    '<hh:paraHead start="1" level="10" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="ROMAN_SMALL" charPrIDRef="4294967295" checkable="1"/>' +
    '</hh:numbering>' +
    '</hh:numberings>';

  // charProps 다음, paraProps 앞에 들어갈 부분(tab/numbering)
  var HEADER_MID = TAB_NUM;

  var STYLES =
    '<hh:styles itemCnt="23">' +
    '<hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/>' +
    '<hh:style id="1" type="PARA" name="본문" engName="Body" paraPrIDRef="1" charPrIDRef="0" nextStyleIDRef="1" langID="1042" lockForm="0"/>' +
    '<hh:style id="2" type="PARA" name="개요 1" engName="Outline 1" paraPrIDRef="2" charPrIDRef="0" nextStyleIDRef="2" langID="1042" lockForm="0"/>' +
    '<hh:style id="3" type="PARA" name="개요 2" engName="Outline 2" paraPrIDRef="3" charPrIDRef="0" nextStyleIDRef="3" langID="1042" lockForm="0"/>' +
    '<hh:style id="4" type="PARA" name="개요 3" engName="Outline 3" paraPrIDRef="4" charPrIDRef="0" nextStyleIDRef="4" langID="1042" lockForm="0"/>' +
    '<hh:style id="5" type="PARA" name="개요 4" engName="Outline 4" paraPrIDRef="5" charPrIDRef="0" nextStyleIDRef="5" langID="1042" lockForm="0"/>' +
    '<hh:style id="6" type="PARA" name="개요 5" engName="Outline 5" paraPrIDRef="6" charPrIDRef="0" nextStyleIDRef="6" langID="1042" lockForm="0"/>' +
    '<hh:style id="7" type="PARA" name="개요 6" engName="Outline 6" paraPrIDRef="7" charPrIDRef="0" nextStyleIDRef="7" langID="1042" lockForm="0"/>' +
    '<hh:style id="8" type="PARA" name="개요 7" engName="Outline 7" paraPrIDRef="8" charPrIDRef="0" nextStyleIDRef="8" langID="1042" lockForm="0"/>' +
    '<hh:style id="9" type="PARA" name="개요 8" engName="Outline 8" paraPrIDRef="18" charPrIDRef="0" nextStyleIDRef="9" langID="1042" lockForm="0"/>' +
    '<hh:style id="10" type="PARA" name="개요 9" engName="Outline 9" paraPrIDRef="16" charPrIDRef="0" nextStyleIDRef="10" langID="1042" lockForm="0"/>' +
    '<hh:style id="11" type="PARA" name="개요 10" engName="Outline 10" paraPrIDRef="17" charPrIDRef="0" nextStyleIDRef="11" langID="1042" lockForm="0"/>' +
    '<hh:style id="12" type="CHAR" name="쪽 번호" engName="Page Number" paraPrIDRef="0" charPrIDRef="1" nextStyleIDRef="0" langID="1042" lockForm="0"/>' +
    '<hh:style id="13" type="CHAR" name="줄 번호" engName="Line Number" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/>' +
    '<hh:style id="14" type="PARA" name="머리말" engName="Header" paraPrIDRef="9" charPrIDRef="2" nextStyleIDRef="14" langID="1042" lockForm="0"/>' +
    '<hh:style id="15" type="PARA" name="각주" engName="Footnote" paraPrIDRef="10" charPrIDRef="3" nextStyleIDRef="15" langID="1042" lockForm="0"/>' +
    '<hh:style id="16" type="PARA" name="미주" engName="Endnote" paraPrIDRef="10" charPrIDRef="3" nextStyleIDRef="16" langID="1042" lockForm="0"/>' +
    '<hh:style id="17" type="PARA" name="메모" engName="Memo" paraPrIDRef="11" charPrIDRef="4" nextStyleIDRef="17" langID="1042" lockForm="0"/>' +
    '<hh:style id="18" type="PARA" name="차례 제목" engName="TOC Heading" paraPrIDRef="12" charPrIDRef="5" nextStyleIDRef="18" langID="1042" lockForm="0"/>' +
    '<hh:style id="19" type="PARA" name="차례 1" engName="TOC 1" paraPrIDRef="13" charPrIDRef="6" nextStyleIDRef="19" langID="1042" lockForm="0"/>' +
    '<hh:style id="20" type="PARA" name="차례 2" engName="TOC 2" paraPrIDRef="14" charPrIDRef="6" nextStyleIDRef="20" langID="1042" lockForm="0"/>' +
    '<hh:style id="21" type="PARA" name="차례 3" engName="TOC 3" paraPrIDRef="15" charPrIDRef="6" nextStyleIDRef="21" langID="1042" lockForm="0"/>' +
    '<hh:style id="22" type="PARA" name="캡션" engName="Caption" paraPrIDRef="19" charPrIDRef="0" nextStyleIDRef="22" langID="1042" lockForm="0"/>' +
    '</hh:styles>';

  var HEADER_SUFFIX =
    STYLES +
    '</hh:refList>' +
    '<hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument>' +
    '<hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption>' +
    '<hh:metaTag>{"name":""}</hh:metaTag>' +
    '<hh:trackchageConfig flags="56"/>' +
    '</hh:head>';

  // section0.xml 첫 문단(secPr 포함) — base 와 동일
  var SECTION_HEAD =
    "<?xml version='1.0' encoding='UTF-8'?>" +
    '<hs:sec ' + NS_HEAD + '>' +
    '<hp:p id="2000000000" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">' +
    '<hp:run charPrIDRef="0">' +
    '<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">' +
    '<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/>' +
    '<hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>' +
    '<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>' +
    '<hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>' +
    '<hp:pagePr landscape="WIDELY" width="59528" height="84186" gutterType="LEFT_ONLY">' +
    '<hp:margin header="4252" footer="4252" gutter="0" left="8504" right="8504" top="5668" bottom="4252"/>' +
    '</hp:pagePr>' +
    '<hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr>' +
    '<hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr>' +
    '<hp:pageBorderFill type="BOTH" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>' +
    '<hp:pageBorderFill type="EVEN" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>' +
    '<hp:pageBorderFill type="ODD" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>' +
    '</hp:secPr>' +
    '<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>' +
    '</hp:run>' +
    '<hp:run charPrIDRef="0"><hp:t/></hp:run>' +
    '<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="42520" flags="393216"/></hp:linesegarray>' +
    '</hp:p>';
  var SECTION_TAIL = '</hs:sec>';

  // 정적 패키지 파일들
  var MIMETYPE = 'application/hwp+zip';
  var VERSION_XML = "<?xml version='1.0' encoding='UTF-8'?>" +
    '<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="1" buildNumber="0" os="1" xmlVersion="1.5" application="MD Viewer" appVersion="1.0"/>';
  var SETTINGS_XML = "<?xml version='1.0' encoding='UTF-8'?>" +
    '<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0">' +
    '<ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>';
  var CONTAINER_XML = "<?xml version='1.0' encoding='UTF-8'?>" +
    '<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf">' +
    '<ocf:rootfiles>' +
    '<ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/>' +
    '<ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/>' +
    '<ocf:rootfile full-path="META-INF/container.rdf" media-type="application/rdf+xml"/>' +
    '</ocf:rootfiles></ocf:container>';
  var MANIFEST_XML = "<?xml version='1.0' encoding='UTF-8'?>" +
    '<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>';
  var CONTAINER_RDF = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>' +
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/header.xml"/></rdf:Description>' +
    '<rdf:Description rdf:about="Contents/header.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#HeaderFile"/></rdf:Description>' +
    '<rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/section0.xml"/></rdf:Description>' +
    '<rdf:Description rdf:about="Contents/section0.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#SectionFile"/></rdf:Description>' +
    '<rdf:Description rdf:about=""><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#Document"/></rdf:Description>' +
    '</rdf:RDF>';

  function contentHpf(title) {
    return "<?xml version='1.0' encoding='UTF-8'?>" +
      '<opf:package xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" version="" unique-identifier="" id="">' +
      '<opf:metadata>' +
      '<opf:title>' + esc(title || '') + '</opf:title>' +
      '<opf:language>ko</opf:language>' +
      '<opf:meta name="creator" content="MD Viewer"/>' +
      '</opf:metadata>' +
      '<opf:manifest>' +
      '<opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>' +
      '<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>' +
      '<opf:item id="settings" href="settings.xml" media-type="application/xml"/>' +
      '</opf:manifest>' +
      '<opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine>' +
      '</opf:package>';
  }

  function previewText(md) {
    var t = String(md || '').replace(/[#*`>_~\-]/g, ' ').replace(/\s+/g, ' ').trim();
    return t.slice(0, 200) || ' ';
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 공개 API
  // ──────────────────────────────────────────────────────────────────────────
  function buildSection(markdown) {
    if (typeof marked === 'undefined' || !marked.lexer) {
      throw new Error('marked 라이브러리가 필요합니다.');
    }
    resetId();
    var tokens = marked.lexer(markdown || '');
    var body = '';
    for (var i = 0; i < tokens.length; i++) {
      try {
        body += renderToken(tokens[i]);
      } catch (e) {
        if (typeof console !== 'undefined') console.warn('[hwpx] 토큰 변환 실패:', tokens[i] && tokens[i].type, e);
        body += para(PP.BODY, run(CP.NORMAL, plainText(tokens[i])));
      }
    }
    return SECTION_HEAD + body + SECTION_TAIL;
  }

  function fromMarkdown(markdown, opts) {
    opts = opts || {};
    if (typeof JSZip === 'undefined') {
      return Promise.reject(new Error('JSZip 라이브러리가 필요합니다.'));
    }
    var section = buildSection(markdown);
    var header = buildHeader();

    var zip = new JSZip();
    // mimetype 은 반드시 첫 엔트리 + 비압축(STORE)
    zip.file('mimetype', MIMETYPE, { compression: 'STORE' });
    zip.file('version.xml', VERSION_XML);
    zip.file('settings.xml', SETTINGS_XML);
    var metaInf = zip.folder('META-INF');
    metaInf.file('container.xml', CONTAINER_XML);
    metaInf.file('manifest.xml', MANIFEST_XML);
    metaInf.file('container.rdf', CONTAINER_RDF);
    var contents = zip.folder('Contents');
    contents.file('header.xml', header);
    contents.file('section0.xml', section);
    contents.file('content.hpf', contentHpf(opts.title));
    zip.folder('Preview').file('PrvText.txt', previewText(markdown));

    return zip.generateAsync({
      type: 'blob',
      mimeType: 'application/hwp+zip',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });
  }

  global.HwpxExporter = {
    fromMarkdown: fromMarkdown,
    buildSection: buildSection,
    buildHeader: buildHeader,
    _internal: { renderToken: renderToken, inlineRuns: inlineRuns }
  };
})(typeof window !== 'undefined' ? window : this);

'use strict';

const app = document.getElementById('app');
const state = { manifest: null, query: '', chip: '' };

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const absUrl = (path) => new URL(path, document.baseURI).href;

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  const trim = (x, d) => x.toFixed(d).replace(/\.?0+$/, '');
  if (n < 1024 * 1024) return `${trim(n / 1024, 1)} KiB`;
  return `${trim(n / 1024 / 1024, 2)} MiB`;
}

async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', {}, text);
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const old = btn.textContent;
  btn.textContent = '복사됨';
  btn.classList.add('done');
  setTimeout(() => { btn.textContent = old; btn.classList.remove('done'); }, 1200);
}

const copyBtn = (text, label = '복사') =>
  h('button', { class: 'copy', type: 'button', title: text, onclick: (e) => { e.stopPropagation(); copy(text, e.currentTarget); } }, label);

const chipOf = (id) => state.manifest.chips.find((c) => c.id === id) || { id, name: id };
const loaderOf = (id) => state.manifest.loaders.find((l) => l.id === id);

function downloads(v, compact) {
  return h('div', { class: 'dl' },
    h('a', { class: 'btn primary', href: v.sd_zip.url, download: '', onclick: (e) => e.stopPropagation() },
      compact ? 'SD 패키지' : `SD 패키지 (${fmtSize(v.sd_zip.size)})`),
    h('a', { class: 'btn', href: v.image.url, download: '', onclick: (e) => e.stopPropagation() }, 'BIN'),
    h('a', { class: 'btn', href: v.fw_txt.url, download: '', onclick: (e) => e.stopPropagation() }, 'fw.txt'));
}

/* ---------- 목록 ---------- */

function renderList() {
  const m = state.manifest;
  const chipsInUse = m.chips.filter((c) => m.projects.some((p) => p.chip === c.id));
  const results = h('div', {});
  const pills = [];

  function refresh() {
    const q = state.query.trim().toLowerCase();
    const list = [...m.projects].sort((a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id)).filter((p) =>
      (!state.chip || p.chip === state.chip) &&
      (!q || [p.id, p.name, p.description, chipOf(p.chip).name].join(' ').toLowerCase().includes(q)));
    pills.forEach((b) => { const on = b.dataset.chip === state.chip; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    results.replaceChildren(list.length ? h('div', { class: 'grid' }, list.map(card)) : h('p', { class: 'muted none' }, '조건에 맞는 펌웨어가 없습니다.'));
  }

  const body = m.projects.length === 0
    ? h('div', { class: 'empty' },
        h('h3', {}, '등록된 펌웨어가 없습니다'),
        h('p', {}, '등록 페이지에서 BIN을 올려 PR을 만들고, 머지하면 여기에 나타납니다.'),
        h('a', { class: 'btn primary', href: '#/upload' }, '펌웨어 등록하기'))
    : results;

  const search = h('input', {
    class: 'search', type: 'search', placeholder: '이름, ID, 칩 검색', value: state.query, 'aria-label': '검색',
    oninput: (e) => { state.query = e.target.value; refresh(); },
  });
  const pill = (id, label) => {
    const b = h('button', { type: 'button', class: 'pill', 'data-chip': id, onclick: () => { state.chip = id; refresh(); } }, label);
    pills.push(b);
    return b;
  };

  app.replaceChildren(...[
    h('section', { class: 'hero' },
      h('h1', {}, '펌웨어 저장소'),
      h('p', { class: 'lead' }, 'HG-SWD-PROG 오프라인 SWD 프로그래머에 넣을 펌웨어를 칩별로 모아 둔 곳입니다. SD 패키지를 받아 카드에 풀면 바로 기록할 수 있습니다.'),
      h('dl', { class: 'stats' },
        stat('프로젝트', m.projects.length),
        stat('버전', m.projects.reduce((n, p) => n + p.versions.length, 0)),
        stat('지원 칩', m.chips.length))),
    m.projects.length ? h('div', { class: 'toolbar' }, search,
      h('div', { class: 'pills', role: 'group', 'aria-label': '칩 필터' }, pill('', '전체'), chipsInUse.map((c) => pill(c.id, c.name)))) : null,
    body].filter(Boolean));
  if (m.projects.length) refresh();
}

const stat = (label, value) => h('div', { class: 'stat' }, h('dt', {}, label), h('dd', {}, value));

function card(p) {
  const v = p.versions.find((x) => x.version === p.latest);
  const go = () => { location.hash = `#/p/${p.id}`; };
  return h('article', { class: 'card', tabindex: '0', onclick: go, onkeydown: (e) => { if (e.key === 'Enter') go(); } },
    h('div', { class: 'card-top' },
      h('span', { class: 'chip-badge' }, chipOf(p.chip).name),
      h('span', { class: 'ver' }, `v${p.latest}`)),
    h('h3', {}, p.name),
    h('code', { class: 'pid' }, p.id),
    p.description ? h('p', { class: 'desc' }, p.description) : null,
    h('div', { class: 'meta' },
      h('span', {}, fmtSize(v.image.size)),
      h('span', {}, `${v.image.sectors} 섹터`),
      h('span', {}, v.date),
      p.versions.length > 1 ? h('span', {}, `${p.versions.length}개 버전`) : null),
    downloads(v, true));
}

/* ---------- 상세 ---------- */

function renderProject(id, ver) {
  const p = state.manifest.projects.find((x) => x.id === id);
  if (!p) return renderMissing(`프로젝트 "${id}"를 찾을 수 없습니다.`);
  const v = p.versions.find((x) => x.version === (ver || p.latest));
  if (!v) return renderMissing(`버전 "${ver}"을 찾을 수 없습니다.`);
  const chip = chipOf(p.chip);
  const isLatest = v.version === p.latest;

  const fact = (k, val, extra, wide) => h('div', { class: wide ? 'fact wide' : 'fact' }, h('dt', {}, k), h('dd', {}, val, extra || null));
  const emb = v.image.embedded;

  app.replaceChildren(
    h('a', { class: 'back', href: '#/' }, '← 목록'),
    h('section', { class: 'detail-head' },
      h('div', { class: 'card-top' }, h('span', { class: 'chip-badge' }, chip.name), h('code', { class: 'pid' }, p.id)),
      h('h1', {}, p.name),
      p.description ? h('p', { class: 'lead' }, p.description) : null),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' },
        h('div', {},
          h('span', { class: 'big-ver' }, `v${v.version}`),
          isLatest ? h('span', { class: 'tag ok' }, '최신') : null,
          v.prerelease ? h('span', { class: 'tag warn' }, '프리릴리스') : null,
          h('span', { class: 'muted' }, ` · ${v.date}`)),
        downloads(v, false)),
      h('dl', { class: 'facts' },
        fact('크기', `${fmtSize(v.image.size)} (${v.image.size.toLocaleString()} B)`),
        fact('지울 섹터', `${v.image.sectors} × ${fmtSize(chip.sector_size)}`),
        fact('기록 주소', h('code', {}, chip.flash_base)),
        fact('CRC32', h('code', {}, v.image.crc32), copyBtn(v.image.crc32)),
        emb ? fact('내장 버전', `${emb.version || '-'} / ${emb.name || '-'}`) : null,
        fact('SHA-256', h('code', { class: 'hash' }, v.image.sha256), copyBtn(v.image.sha256), true)),
      v.notes ? h('div', { class: 'notes' }, h('h3', {}, '변경 내용'), h('pre', {}, v.notes)) : null),
    h('section', {},
      h('h2', {}, '버전 기록'),
      h('div', { class: 'table-wrap' },
        h('table', { class: 'versions' },
          h('thead', {}, h('tr', {}, ['버전', '날짜', '크기', 'CRC32', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, p.versions.map((x) => h('tr', { class: x.version === v.version ? 'sel' : null },
            h('td', {}, h('a', { href: `#/p/${p.id}/${x.version}` }, `v${x.version}`),
              x.version === p.latest ? h('span', { class: 'tag ok' }, '최신') : null,
              x.prerelease ? h('span', { class: 'tag warn' }, 'pre') : null),
            h('td', {}, x.date),
            h('td', {}, fmtSize(x.image.size)),
            h('td', {}, h('code', {}, x.image.crc32)),
            h('td', { class: 'right' }, downloads(x, true)))))))),
    h('section', {},
      h('h2', {}, '기기 업데이트 경로'),
      h('div', { class: 'endpoint-line' }, h('span', { class: 'method' }, 'GET'), h('code', {}, absUrl(p.latest_url)), copyBtn(absUrl(p.latest_url)))));
  window.scrollTo(0, 0);
}

function renderMissing(msg) {
  app.replaceChildren(h('a', { class: 'back', href: '#/' }, '← 목록'), h('div', { class: 'empty' }, h('h3', {}, msg)));
}

/* ---------- SD / API ---------- */

function renderSd() {
  app.replaceChildren(document.getElementById('tpl-sd').content.cloneNode(true));
  const box = app.querySelector('#loaders');
  box.append(...state.manifest.loaders.map((l) => h('article', { class: 'panel loader' },
    h('h3', {}, l.name),
    h('dl', { class: 'facts' },
      h('div', { class: 'fact' }, h('dt', {}, 'SD 위치'), h('dd', {}, h('code', {}, l.sd_path))),
      h('div', { class: 'fact' }, h('dt', {}, '원본'), h('dd', {}, h('code', {}, l.source))),
      h('div', { class: 'fact' }, h('dt', {}, '크기'), h('dd', {}, `${l.size.toLocaleString()} B`)),
      h('div', { class: 'fact' }, h('dt', {}, 'CRC32'), h('dd', {}, h('code', {}, l.crc32))),
      h('div', { class: 'fact wide' }, h('dt', {}, 'SHA-256'), h('dd', {}, h('code', { class: 'hash' }, l.sha256), copyBtn(l.sha256)))),
    l.url ? h('a', { class: 'btn primary', href: l.url, download: '' }, '로더 받기')
          : h('p', { class: 'muted' }, '배포하지 않는 파일입니다. 설치된 CubeCLT/CubeProgrammer에서 복사한 뒤 SHA-256이 같은지 확인하세요.'))));
}

async function renderApi() {
  app.replaceChildren(document.getElementById('tpl-api').content.cloneNode(true));
  const root = absUrl('./');
  for (const el of app.querySelectorAll('[data-url]')) el.textContent = root + el.dataset.url;
  const pre = app.querySelector('#latest-sample');
  const p = state.manifest.projects[0];
  if (!p) { pre.textContent = '(등록된 프로젝트가 없습니다)'; return; }
  try {
    pre.textContent = `# ${absUrl(p.latest_url)}\n` + await (await fetch(p.latest_url, { cache: 'no-cache' })).text();
  } catch {
    pre.textContent = '(불러오기 실패)';
  }
}

/* ---------- 라우팅 ---------- */

function render() {
  const [, page, id, ver] = (location.hash || '#/').split('/').map(decodeURIComponent);
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === `#/${page === 'p' ? '' : page || ''}`));
  if (page === 'p') renderProject(id, ver);
  else if (page === 'sd') renderSd();
  else if (page === 'api') renderApi();
  else if (page === 'upload') renderUpload();
  else renderList();
}

async function init() {
  try {
    const res = await fetch('manifest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.manifest = await res.json();
  } catch (e) {
    app.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, 'manifest.json을 불러오지 못했습니다'), h('p', { class: 'muted' }, String(e))));
    return;
  }
  const gen = new Date(state.manifest.generated);
  document.getElementById('generated').textContent = isNaN(gen) ? '' : `갱신 ${gen.toLocaleString('ko-KR')}`;
  window.addEventListener('hashchange', render);
  render();
}

init();

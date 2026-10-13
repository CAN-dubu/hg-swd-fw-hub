'use strict';

const app = document.getElementById('app');
const state = { manifest: null, query: '', chip: '', open: '', fresh: new Set(), checkedAt: 0, refreshing: false };

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
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

const eraseText = (v) => `${v.erase.count} × ${fmtSize(v.erase.unit)}`;

/* 파일 모양 아이콘. 칩 종류 색은 바깥의 --k를 따른다. 고정 문자열만 넣는다 */
function fileIcon(kind, cls = 'fw-ico') {
  const s = h('span', { class: `${cls} k-${kind}`, 'aria-hidden': 'true' });
  s.innerHTML = '<svg viewBox="0 0 44 52"><path class="doc" d="M7 1.5h21l14.5 14.5v29A5.5 5.5 0 0 1 37 50.5H7A5.5 5.5 0 0 1 1.5 45V7A5.5 5.5 0 0 1 7 1.5z"/>' +
    '<path class="fold" d="M28 1.5V11a5 5 0 0 0 5 5h9.5"/><rect class="band" x="1.5" y="29" width="29" height="13" rx="3"/>' +
    '<text x="16" y="38.6">BIN</text></svg>';
  return s;
}

/* ---------- 표시 도우미 ---------- */

const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const kindOf = (chip) => chip.kind || 'stm32';
const IFACE = { stm32: 'SWD', esp: 'UART' };

const chipBadge = (chip) =>
  h('span', { class: `chip-badge k-${kindOf(chip)}` }, chip.name, h('span', { class: 'iface' }, IFACE[kindOf(chip)]));

function daysAgo(iso) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((today - new Date(`${iso}T00:00:00`)) / 86400000);
}

function relDate(iso) {
  const d = daysAgo(iso);
  if (d <= 0) return '오늘';
  if (d === 1) return '어제';
  if (d < 7) return `${d}일 전`;
  if (d < 35) return `${Math.floor(d / 7)}주 전`;
  return iso;
}

function countUp(el, to) {
  if (reduceMotion() || !to) { el.textContent = to; return; }
  const start = performance.now();
  const tick = (t) => {
    const k = Math.min(1, (t - start) / 700);
    el.textContent = Math.round(to * (1 - (1 - k) ** 3));
    if (k < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ---------- 목록 ---------- */

const byRecent = (a, b) => b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id);

function renderList() {
  const m = state.manifest;
  const chipsInUse = m.chips.filter((c) => m.projects.some((p) => p.chip === c.id));
  if (state.chip && !chipsInUse.some((c) => c.id === state.chip)) state.chip = '';
  const results = h('div', { class: 'results' });
  const pills = [];
  let first = true;

  function refresh() {
    const q = state.query.trim().toLowerCase();
    const list = m.projects.filter((p) =>
      (!state.chip || p.chip === state.chip) &&
      (!q || [p.id, p.name, p.description, chipOf(p.chip).name].join(' ').toLowerCase().includes(q))).sort(byRecent);
    pills.forEach((b) => { const on = b.dataset.chip === state.chip; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    // 칩마다 한 칸: 최근에 바뀐 칩이 앞으로
    const shelves = chipsInUse.map((c) => [c, list.filter((p) => p.chip === c.id)]).filter(([, ps]) => ps.length)
      .sort(([, a], [, b]) => byRecent(a[0], b[0]));
    // 처음엔 하나씩 떠오르고, 필터를 바꿀 때는 짧게 페이드만 한다
    let i = 0;
    const anim = first ? 'rise' : 'fade';
    results.replaceChildren(shelves.length
      ? h('div', { class: 'shelves' }, shelves.map(([c, ps]) => shelf(c, ps, anim, () => i++)))
      : h('div', { class: 'none fade' },
          h('p', {}, '조건에 맞는 펌웨어가 없습니다.'),
          h('button', { type: 'button', class: 'btn', onclick: () => { state.query = ''; state.chip = ''; search.value = ''; refresh(); } }, '필터 초기화')));
    first = false;
    placePeek(false);
  }

  const body = m.projects.length === 0
    ? h('div', { class: 'empty rise' },
        h('div', { class: 'empty-icon' }, '⌁'),
        h('h3', {}, '등록된 펌웨어가 없습니다'),
        h('p', {}, '등록 페이지에서 BIN을 올려 PR을 만들고, 머지하면 여기에 나타납니다. 머지 후 1~2분 뒤 오른쪽 위 새로고침을 누르세요.'),
        h('a', { class: 'btn primary', href: '#/upload' }, '펌웨어 등록하기'))
    : results;

  const search = h('input', {
    class: 'search', type: 'search', placeholder: '이름, ID, 칩 검색', value: state.query, 'aria-label': '검색',
    oninput: (e) => { state.query = e.target.value; refresh(); },
  });
  const pill = (id, label, kind) => {
    const b = h('button', { type: 'button', class: `pill${kind ? ` k-${kind}` : ''}`, 'data-chip': id, onclick: () => { state.chip = id; refresh(); } }, label);
    pills.push(b);
    return b;
  };

  const stats = [['folder', '프로젝트', m.projects.length], ['chip', '지원 칩', m.chips.length]]
    .map(([ico, label, value]) => ({ ico, label, value, n: h('b', { class: 'stat-n' }, '0') }));

  app.replaceChildren(...[
    h('section', { class: 'hero' },
      h('div', { class: 'hero-text' },
        h('h1', {}, '펌웨어 저장소'),
        h('p', { class: 'lead' }, '파일을 누르면 요약이 펼쳐집니다. SD 패키지를 받아 카드에 풀면 바로 기록할 수 있습니다.')),
      h('div', { class: 'stats' }, stats.map((s) => h('div', { class: 'stat' }, icon(s.ico, 'stat-ico'), s.n, h('span', { class: 'stat-label' }, s.label))))),
    m.projects.length ? h('div', { class: 'toolbar' },
      h('div', { class: 'search-wrap' }, search, h('kbd', { class: 'kbd', title: '/ 키로 검색' }, '/')),
      h('div', { class: 'pills', role: 'group', 'aria-label': '칩 필터' },
        pill('', '전체'),
        chipsInUse.map((c) => pill(c.id, c.name, kindOf(c))))) : null,
    body].filter(Boolean));
  stats.forEach((s) => countUp(s.n, s.value));
  updateStamp();
  if (m.projects.length) refresh();
}

/* 칩 한 칸: 펌웨어는 이름만 단 파일 아이콘으로 늘어놓고, 누르면 그 줄 아래에 요약을 펼친다 */
function shelf(chip, projects, anim, nextI) {
  const kind = kindOf(chip);
  return h('section', { class: `shelf k-${kind} ${anim}`, style: `--i:${Math.min(nextI(), 12)}` },
    h('header', { class: 'shelf-head' },
      icon('chip', 'shelf-ico'),
      h('h2', {}, chip.name),
      h('span', { class: 'shelf-sub' }, IFACE[kind]),
      h('span', { class: 'shelf-n', title: `프로젝트 ${projects.length}개` }, projects.length)),
    h('div', { class: 'fw-grid' }, projects.map((p) => fileTile(p, kind, anim, nextI()))));
}

function fileTile(p, kind, anim, i) {
  const fresh = state.fresh.has(p.id);
  const recent = fresh || daysAgo(p.updated) < 7;
  return h('button', {
    type: 'button', class: `fw ${anim}${fresh ? ' fresh' : ''}`, style: `--i:${Math.min(i, 12)}`,
    'data-id': p.id, 'aria-expanded': 'false', title: p.name,
    onclick: () => { state.open = state.open === p.id ? '' : p.id; placePeek(true); },
  },
    h('span', { class: 'fw-ico-wrap' }, fileIcon(kind),
      recent ? h('span', { class: 'fw-new', title: fresh ? '방금 반영' : '최근 7일 안에 업데이트' }) : null),
    h('span', { class: 'fw-name' }, p.name));
}

/* 고른 파일이 있는 줄 바로 뒤에 요약을 끼운다. 한 줄에 놓이는 개수는 화면 폭에 따라 바뀌므로 매번 다시 찾는다 */
function placePeek(scroll) {
  app.querySelector('.peek')?.remove();
  let tile = null;
  for (const t of app.querySelectorAll('.fw')) {
    const on = t.dataset.id === state.open;
    t.classList.toggle('open', on);
    t.setAttribute('aria-expanded', String(on));
    if (on) tile = t;
  }
  const p = tile && state.manifest.projects.find((x) => x.id === state.open);
  if (!p) return;
  const row = [...tile.parentElement.children].filter((t) => t.offsetTop === tile.offsetTop);
  const panel = peek(p);
  row[row.length - 1].after(panel);
  const grid = tile.parentElement.getBoundingClientRect();
  const r = tile.getBoundingClientRect();
  panel.style.setProperty('--x', `${r.left + r.width / 2 - grid.left}px`);
  if (scroll) panel.scrollIntoView({ block: 'nearest', behavior: reduceMotion() ? 'auto' : 'smooth' });
}

function closePeek() {
  const tile = app.querySelector('.fw.open');
  state.open = '';
  placePeek(false);
  tile?.focus();
}

function peek(p) {
  const v = p.versions.find((x) => x.version === p.latest);
  const fact = (label, value, title) => h('div', {}, h('dt', {}, label), h('dd', { title }, value));
  return h('div', { class: 'peek', role: 'region', 'aria-label': `${p.name} 요약` },
    h('div', { class: 'peek-head' },
      h('div', { class: 'peek-title' }, h('h3', {}, p.name), h('code', { class: 'pid' }, p.id)),
      h('button', { type: 'button', class: 'peek-x', 'aria-label': '닫기', onclick: closePeek }, '✕')),
    p.description ? h('p', { class: 'peek-desc' }, p.description) : null,
    h('dl', { class: 'peek-facts' },
      fact('버전', `v${v.version}`),
      fact('업데이트', relDate(v.date), v.date),
      fact('크기', fmtSize(v.size), `${v.size.toLocaleString()} B`),
      fact('구성', `BIN ${v.images.length}개`)),
    h('div', { class: 'peek-actions' },
      h('a', { class: 'btn', href: `#/p/${p.id}` }, '상세 보기'),
      h('a', { class: 'btn primary', href: v.sd_zip.url, download: '' }, icon('download'), `SD 패키지 · ${fmtSize(v.sd_zip.size)}`)));
}

/* ---------- 새로고침 ---------- */

function updateStamp() {
  const gen = new Date(state.manifest.generated);
  document.getElementById('generated').textContent = isNaN(gen) ? '' : `갱신 ${gen.toLocaleString('ko-KR')}`;
}

/* action = { label, onclick }이 있으면 버튼을 달고 사용자가 누를 때까지 남겨 둔다 */
function toast(text, kind = '', action = null) {
  const box = document.getElementById('toasts');
  const t = h('div', { class: `toast ${kind}`, role: 'status' }, text,
    action ? h('button', { type: 'button', class: 'toast-btn', onclick: action.onclick }, action.label) : null);
  box.append(t);
  if (action) return;
  setTimeout(() => {
    t.classList.add('out');
    t.addEventListener('animationend', () => t.remove(), { once: true });
    setTimeout(() => t.remove(), 600);
  }, 3600);
}

/* 열어 둔 페이지가 예전 사이트 코드면 새로고침을 권한다 (Pages가 파일을 10분 캐시함) */
function checkSiteBuild(m) {
  const mine = document.querySelector('meta[name="hub-build"]')?.content;
  if (!mine || !m.build || m.build === mine) return false;
  if (!state.buildNotified) toast('사이트가 업데이트되었습니다', 'info', { label: '새로고침', onclick: () => location.reload() });
  state.buildNotified = true;
  return true;
}

async function fetchManifest() {
  // Pages CDN이 10분간 캐시하므로 쿼리로 우회한다
  const res = await fetch(`manifest.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function refreshManifest({ silent = false } = {}) {
  const btn = document.getElementById('refresh');
  if (state.refreshing) return;
  state.refreshing = true;
  btn.classList.add('spin');
  btn.disabled = true;
  const started = Date.now();
  try {
    const next = await fetchManifest();
    const prev = new Map(state.manifest.projects.map((p) => [p.id, new Set(p.versions.map((v) => v.version))]));
    const added = next.projects.filter((p) => !prev.has(p.id)).map((p) => p.id);
    const bumped = next.projects.filter((p) => prev.has(p.id) && p.versions.some((v) => !prev.get(p.id).has(v.version)));
    const newVersions = bumped.reduce((n, p) => n + p.versions.filter((v) => !prev.get(p.id).has(v.version)).length, 0);
    const removed = [...prev.keys()].some((id) => !next.projects.some((p) => p.id === id));
    state.manifest = next;
    state.checkedAt = Date.now();
    const siteChanged = checkSiteBuild(next);
    const changed = [...added, ...bumped.map((p) => p.id)];
    if (changed.length || removed) {
      changed.forEach((id) => state.fresh.add(id));
      if (route()[0] !== 'upload') render({ transition: false });
      const parts = [added.length && `새 프로젝트 ${added.length}개`, newVersions && `새 버전 ${newVersions}개`, removed && '삭제된 항목 반영'].filter(Boolean);
      toast(`✔ ${parts.join(' · ')}`, 'ok');
      setTimeout(() => {
        changed.forEach((id) => state.fresh.delete(id));
        app.querySelectorAll('.fw.fresh').forEach((c) => c.classList.remove('fresh'));
      }, 6000);
    } else {
      updateStamp();
      if (!silent && !siteChanged) toast('이미 최신 상태입니다');
    }
  } catch (e) {
    if (!silent) toast(`새로고침 실패: ${e.message}`, 'err');
  } finally {
    // 너무 짧게 돌면 눌렸는지 알기 어려워 최소 한 바퀴는 돈다
    setTimeout(() => { btn.classList.remove('spin'); btn.disabled = false; state.refreshing = false; }, Math.max(0, 600 - (Date.now() - started)));
  }
}

/* ---------- 상세 ---------- */

function renderProject(id, ver) {
  const p = state.manifest.projects.find((x) => x.id === id);
  if (!p) return renderMissing(`프로젝트 "${id}"를 찾을 수 없습니다.`);
  const v = p.versions.find((x) => x.version === (ver || p.latest));
  if (!v) return renderMissing(`버전 "${ver}"을 찾을 수 없습니다.`);
  const chip = chipOf(p.chip);
  const kind = kindOf(chip);
  const esp = kind === 'esp';
  const emb = v.embedded;
  const embText = emb && ([emb.version, emb.name, emb.idf && `IDF ${emb.idf}`].filter(Boolean).join(' / ') || '-');
  const verTags = (x) => [x.version === p.latest ? h('span', { class: 'tag ok' }, '최신') : null,
    x.prerelease ? h('span', { class: 'tag warn' }, '프리릴리스') : null];

  const kv = (label, value, { title, wide } = {}) =>
    h('div', { class: wide ? 'kv wide' : 'kv' }, h('dt', {}, label), h('dd', { title }, value));
  // 기기에 기록하는 BIN이 먼저, 패키지 설명 파일(release.txt, fw.txt)은 아래에 옅게
  const texts = [v.notice && { name: 'NOTICE.txt', ...v.notice }, v.release_txt && { name: 'release.txt', ...v.release_txt },
    { name: 'fw.txt', ...v.fw_txt }].filter(Boolean);
  const fileRow = (f, side) => h('tr', { class: side ? 'side' : null },
    h('td', {}, h('a', { href: f.url, download: '' }, f.name)),
    h('td', {}, f.address ? h('code', {}, f.address) : h('span', { class: 'muted' }, '—')),
    h('td', { class: 'num' }, f.size.toLocaleString()),
    h('td', {}, h('code', {}, f.crc32)),
    h('td', {}, h('code', { class: 'hash-short', title: f.sha256 }, `${f.sha256.slice(0, 12)}…`), copyBtn(f.sha256)));
  const th = (labels) => h('thead', {}, h('tr', {}, labels.map(([t, cls]) => h('th', { class: cls }, t))));

  app.replaceChildren(...[
    h('a', { class: 'back', href: '#/' }, '← 목록'),
    h('section', { class: `d-head k-${kind}` },
      fileIcon(kind, 'fw-ico d-ico'),
      h('div', { class: 'd-title' },
        h('div', { class: 'd-meta' }, chipBadge(chip), h('code', { class: 'pid' }, p.id)),
        h('h1', {}, p.name),
        p.description ? h('p', { class: 'lead' }, p.description) : null),
      h('div', { class: 'd-get' },
        h('a', { class: 'btn primary d-sd', href: v.sd_zip.url, download: '' }, icon('download'), 'SD 패키지 받기'),
        h('span', { class: 'd-get-sub' }, `v${v.version} · zip ${fmtSize(v.sd_zip.size)}`))),
    h('dl', { class: 'kvs' },
      kv('버전', [`v${v.version}`, ...verTags(v)]),
      kv('날짜', v.date, { title: relDate(v.date) }),
      kv('크기', fmtSize(v.size), { title: `${v.size.toLocaleString()} B` }),
      kv('지울 영역', eraseText(v)),
      esp ? kv('필요 Flash', fmtSize(parseInt(v.flash_size, 16))) : kv('기록 방식', 'SWD · ST 로더'),
      esp ? kv('UART 상한', v.baud === 'auto' ? 'auto' : `${v.baud} bps`, { title: v.baud === 'auto' ? '921600부터 낮춰 가며 연결' : null }) : null,
      emb ? kv(esp ? '앱 정보' : '내장 버전', embText, { title: embText, wide: true }) : null),
    v.notes ? h('section', { class: 'd-sec' }, h('h2', {}, '변경 내용'), h('pre', { class: 'd-notes' }, v.notes)) : null,
    h('section', { class: 'd-sec' },
      h('h2', {}, '파일', h('span', { class: 'h-sub' }, `기록 BIN ${v.images.length}개 · SD 패키지에 모두 들어 있음`)),
      h('div', { class: 'table-wrap' },
        h('table', { class: 'versions' },
          th([['파일'], ['주소'], ['크기 (B)', 'num'], ['CRC32'], ['SHA-256']]),
          h('tbody', {}, v.images.map((i) => fileRow(i, false)), texts.map((t) => fileRow(t, true)))))),
    p.versions.length > 1 ? h('section', { class: 'd-sec' },
      h('h2', {}, '버전 기록', h('span', { class: 'h-sub' }, `${p.versions.length}개`)),
      h('div', { class: 'table-wrap' },
        h('table', { class: 'versions' },
          th([['버전'], ['날짜'], ['크기', 'num'], ['']]),
          h('tbody', {}, p.versions.map((x) => h('tr', { class: x.version === v.version ? 'sel' : null },
            h('td', {}, h('a', { href: `#/p/${p.id}/${x.version}` }, `v${x.version}`), verTags(x)),
            h('td', {}, x.date),
            h('td', { class: 'num' }, fmtSize(x.size)),
            h('td', { class: 'right' }, h('a', { class: 'btn dl-mini', href: x.sd_zip.url, download: '', title: 'SD 패키지' },
              icon('download'), fmtSize(x.sd_zip.size))))))))) : null,
    h('details', { class: 'd-api' },
      h('summary', {}, '기기 업데이트 경로 (LTE)'),
      h('p', {}, '프로그래머가 최신 정식 버전을 받을 때 읽는 파일입니다.'),
      h('div', { class: 'endpoint-line' }, h('span', { class: 'method' }, 'GET'), h('code', {}, absUrl(p.latest_url)), copyBtn(absUrl(p.latest_url)))),
  ].filter(Boolean));
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

const route = () => (location.hash || '#/').split('/').map(decodeURIComponent).slice(1);

function render({ transition = true } = {}) {
  const [page, id, ver] = route();
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === `#/${page === 'p' ? '' : page || ''}`));
  if (page === 'p') renderProject(id, ver);
  else if (page === 'sd') renderSd();
  else if (page === 'api') renderApi();
  else if (page === 'upload') renderUpload();
  else renderList();
  app.removeAttribute('aria-busy');
  if (transition && !reduceMotion()) {
    // 화면이 바뀔 때 섹션이 차례로 떠오른다
    app.classList.remove('enter');
    void app.offsetWidth;
    app.classList.add('enter');
  }
}

async function init() {
  try {
    state.manifest = await fetchManifest();
    state.checkedAt = Date.now();
    checkSiteBuild(state.manifest);
  } catch (e) {
    app.replaceChildren(h('div', { class: 'empty' }, h('h3', {}, 'manifest.json을 불러오지 못했습니다'), h('p', { class: 'muted' }, String(e)),
      h('button', { type: 'button', class: 'btn', onclick: () => location.reload() }, '다시 시도')));
    return;
  }
  window.addEventListener('hashchange', () => { window.scrollTo(0, 0); render(); });
  document.getElementById('refresh').addEventListener('click', () => refreshManifest());
  // 작성 중인 등록 폼은 다시 그리지 않도록 등록 페이지에서는 자동 확인을 하지 않는다
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && route()[0] !== 'upload' && Date.now() - state.checkedAt > 60000) refreshManifest({ silent: true });
  });
  // 화면 폭이 바뀌면 한 줄의 파일 수가 바뀌므로 펼친 요약을 다시 놓는다
  let resizing = 0;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizing);
    resizing = requestAnimationFrame(() => { if (state.open && app.querySelector('.peek')) placePeek(false); });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && app.querySelector('.peek') && !document.querySelector('dialog[open]')) { closePeek(); return; }
    const search = app.querySelector('.search');
    if (e.key === '/' && search && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      e.preventDefault();
      search.focus();
    }
  });
  render();
  updateStamp();
}

init();

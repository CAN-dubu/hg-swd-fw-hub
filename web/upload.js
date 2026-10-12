'use strict';

/* 웹 등록: 브라우저에서 검사한 뒤 GitHub API로 브랜치·커밋·PR을 만든다.
   브라우저 검사는 편의용이고, 최종 검증은 PR의 CI(tools/build_registry.py)가 한다. */

const REPO = { owner: 'CAN-dubu', name: 'hg-swd-fw-hub', base: 'main' };
const TOKEN_KEY = 'hgfw.token';
const ID_RE = /^[A-Za-z0-9_-]{1,24}$/;
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/;
const NAME_RE = /^[\x20-\x7E]{1,47}$/;
const VER_OFFSET = 0x400;
const VER_MAGIC = 0x56455220;

const up = { chip: '', project: '', id: '', name: '', desc: '', image: null, version: '', date: '', notes: '', token: null, busy: false };

/* ---------- 계산 ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const hex32 = (v) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');

async function sha256(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function cstr(bytes) {
  const end = bytes.indexOf(0);
  return new TextDecoder('ascii').decode(bytes.subarray(0, end < 0 ? bytes.length : end)).trim();
}

/* build_registry.inspect_image와 같은 검사 */
function inspectImage(bytes, chip) {
  const out = { errors: [], ok: [], info: [], embedded: null };
  const base = parseInt(chip.flash_base, 16);
  const n = bytes.length;
  if (n < 8 || n > chip.flash_size) {
    out.errors.push(`크기 ${n.toLocaleString()} B: 8 B ~ ${fmtSize(chip.flash_size)} 범위를 벗어남`);
    return out;
  }
  out.ok.push(`크기 ${n.toLocaleString()} B, ${Math.ceil(n / chip.sector_size)}개 섹터 삭제`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, n);
  const sp = dv.getUint32(0, true);
  const reset = dv.getUint32(4, true);
  const inRam = chip.ram.some(([lo, hi]) => sp > parseInt(lo, 16) && sp <= parseInt(hi, 16));
  if (!inRam || sp & 7) out.errors.push(`초기 SP ${hex32(sp)}: ${chip.name} RAM이 아니거나 8바이트 정렬이 아님`);
  else out.ok.push(`초기 SP ${hex32(sp)}`);
  const pc = (reset & ~1) >>> 0;
  if (!(reset & 1) || pc < base || pc >= base + n) out.errors.push(`Reset 벡터 ${hex32(reset)}: 이미지 밖이거나 Thumb 아님. ${chip.flash_base}부터 시작하는 전체 BIN인지 확인`);
  else out.ok.push(`Reset 벡터 ${hex32(reset)}`);
  if (n >= VER_OFFSET + 72 && dv.getUint32(VER_OFFSET, true) === VER_MAGIC) {
    if (dv.getUint32(VER_OFFSET + 68, true) !== base) out.errors.push('VER 헤더의 주소가 Flash 시작 주소와 다름');
    out.embedded = { version: cstr(bytes.subarray(VER_OFFSET + 4, VER_OFFSET + 36)), name: cstr(bytes.subarray(VER_OFFSET + 36, VER_OFFSET + 68)) };
    out.info.push(`내장 버전 ${out.embedded.version || '-'} / ${out.embedded.name || '-'}`);
  }
  return out;
}

function makeFwTxt(name, chip, loader, image) {
  return `name=${name}\n` +
    `device=${chip.device}\n` +
    `algo=${loader.sd_path}\n` +
    `image=app.bin @ ${chip.flash_base}\n` +
    `crc32=${hex32(image.crc)}\n` +
    `loader_crc32=${loader.crc32}\n`;
}

/* TOML 문자열. 여러 줄이면 리터럴 문자열(''')로 써서 사람이 읽기 쉽게 둔다. */
function tomlString(s, multiline) {
  s = s.replace(/\r\n?/g, '\n');
  if (multiline && s.includes('\n') && !s.includes("'''") && !/[\x00-\x08\x0B-\x1F\x7F]/.test(s)) return `'''\n${s}\n'''`;
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
    .replace(/[\x00-\x1F\x7F]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '"';
}

function suggestVersion(project) {
  if (!project) return '1.0.0';
  const m = VERSION_RE.exec(project.versions[0].version);
  return m[4] ? `${m[1]}.${m[2]}.${m[3]}` : `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

/* Pretendard가 0x 사이의 x를 ×로 바꾸므로 16진수 값은 code로 감싼다 */
const hexify = (text) => text.split(/(0x[0-9A-Fa-f]+)/).map((part, i) => (i % 2 ? h('code', {}, part) : part));

/* ---------- 토큰 ---------- */

function loadToken() {
  for (const store of ['sessionStorage', 'localStorage']) {
    try {
      const t = window[store].getItem(TOKEN_KEY);
      if (t) return { value: t, remember: store === 'localStorage' };
    } catch { /* 저장소를 못 쓰는 환경 */ }
  }
  return { value: '', remember: false };
}

function saveToken(value, remember) {
  for (const store of ['sessionStorage', 'localStorage']) {
    try { window[store].removeItem(TOKEN_KEY); } catch { /* 무시 */ }
  }
  if (!value) return;
  try { window[remember ? 'localStorage' : 'sessionStorage'].setItem(TOKEN_KEY, value); } catch { /* 무시 */ }
}

/* ---------- GitHub API ---------- */

async function gh(token, method, path, body, allow404) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (allow404 && res.status === 404) return null;
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(`GitHub ${method} ${path.replace(/^\/repos\/[^/]+\/[^/]+/, '')} → ${res.status} ${data?.message || ''}`.trim());
  return data;
}

const repoPath = `/repos/${REPO.owner}/${REPO.name}`;
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
const existsOnBase = (token, path) => gh(token, 'GET', `${repoPath}/contents/${encPath(path)}?ref=${REPO.base}`, null, true).then(Boolean);

/* ---------- 화면 ---------- */

function renderUpload() {
  const m = state.manifest;
  if (!m.chips.some((c) => c.id === up.chip)) up.chip = m.chips[0]?.id || '';
  if (!up.date) up.date = new Date().toLocaleDateString('sv-SE');
  if (up.token === null) up.token = loadToken();
  const el = {};

  const errSpan = (key) => (el[`err_${key}`] = h('span', { class: 'err' }));
  const field = (label, control, key, opts = {}) =>
    (el[`f_${key}`] = h('label', { class: 'field' + (opts.wide ? ' wide' : '') },
      h('span', { class: 'field-label' }, label), control, opts.hint ? h('span', { class: 'hint' }, opts.hint) : null, errSpan(key)));
  const bind = (key, tag, attrs = {}) => {
    const c = h(tag, { ...attrs, oninput: (e) => { up[key] = e.target.value; update(); } });
    c.value = up[key];
    return (el[key] = c);
  };

  /* 1. 대상 */
  el.chip = h('select', { onchange: (e) => { up.chip = e.target.value; up.project = ''; fillProjects(); onProject(); } },
    m.chips.map((c) => h('option', { value: c.id }, c.name)));
  el.chip.value = up.chip;
  el.project = h('select', { onchange: (e) => { up.project = e.target.value; onProject(); } });
  el.newBox = h('div', { class: 'fields sub' },
    field('프로젝트 ID', bind('id', 'input', { placeholder: 'h723', autocomplete: 'off', spellcheck: 'false' }), 'id',
      { hint: 'SD의 /prog/fw/<ID>/ 폴더명. 영문·숫자·_·- 1~24자' }),
    field('이름', bind('name', 'input', { placeholder: 'H723 GFX firmware', autocomplete: 'off' }), 'name',
      { hint: '프로그래머 화면과 fw.txt에 표시. ASCII 47자 이내' }),
    field('설명', bind('desc', 'input', { placeholder: '사이트에만 표시, 한글 가능', autocomplete: 'off' }), 'desc', { wide: true }));
  el.chipFacts = h('dl', { class: 'facts' });

  /* 2. 바이너리 */
  el.file = h('input', { type: 'file', accept: '.bin,application/octet-stream', onchange: (e) => e.target.files[0] && loadFile(e.target.files[0]) });
  el.dropText = h('span', { class: 'drop-main' });
  el.dropSub = h('span', { class: 'drop-sub' });
  el.drop = h('label', {
    class: 'drop',
    ondragover: (e) => { e.preventDefault(); el.drop.classList.add('over'); },
    ondragleave: () => el.drop.classList.remove('over'),
    ondrop: (e) => { e.preventDefault(); el.drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) loadFile(f); },
  }, el.file, el.dropText, el.dropSub);
  el.checks = h('ul', { class: 'checks' });

  /* 3. 릴리스 */
  /* 4. 확인 */
  el.files = h('ul', { class: 'files' });
  el.fwtxt = h('pre', { class: 'code' });
  el.tokenInput = h('input', { type: 'password', placeholder: 'github_pat_…', autocomplete: 'off', spellcheck: 'false', value: up.token.value,
    oninput: (e) => { up.token.value = e.target.value.trim(); saveToken(up.token.value, up.token.remember); el.tokenStatus.textContent = ''; update(); } });
  el.remember = h('input', { type: 'checkbox', checked: up.token.remember,
    onchange: (e) => { up.token.remember = e.target.checked; saveToken(up.token.value, up.token.remember); } });
  el.tokenStatus = h('span', { class: 'hint' });
  el.submit = h('button', { type: 'button', class: 'btn primary', onclick: submit }, 'PR 만들기');
  el.blocker = h('span', { class: 'hint' });
  el.log = h('ul', { class: 'checks log' });
  el.result = h('div', {});

  const step = (n, title, ...body) => h('section', { class: 'panel step' }, h('h2', {}, h('span', { class: 'step-no' }, n), title), ...body);

  app.replaceChildren(h('section', { class: 'page' },
    h('h1', {}, '펌웨어 등록'),
    h('p', { class: 'lead' }, '바이너리를 올리면 저장소에 PR이 만들어집니다. PR의 CI 검사가 통과한 뒤 GitHub에서 머지하면 사이트에 게시됩니다.'),
    h('div', { class: 'form' },
      step('1', '대상',
        h('div', { class: 'fields' },
          field('칩', el.chip, 'chip'),
          field('프로젝트', el.project, 'project')),
        el.newBox,
        h('div', { class: 'fixed' }, h('span', { class: 'fixed-title' }, '칩이 정하는 값 (수정 불가)'), el.chipFacts)),
      step('2', '바이너리', el.drop, el.checks),
      step('3', '릴리스 정보',
        h('div', { class: 'fields' },
          field('버전', bind('version', 'input', { autocomplete: 'off', spellcheck: 'false' }), 'version',
            { hint: 'x.y.z. 태그(-rc.1 등)를 붙이면 프리릴리스로 기기 자동 업데이트에서 빠짐' }),
          field('날짜', bind('date', 'input', { type: 'date' }), 'date'),
          field('변경 내용', bind('notes', 'textarea', { rows: '4', placeholder: '- 변경 내용' }), 'notes', { wide: true }))),
      step('4', '확인 및 등록',
        h('h3', { class: 'mini' }, '커밋될 파일'), el.files,
        h('h3', { class: 'mini' }, '생성될 fw.txt'), el.fwtxt,
        h('h3', { class: 'mini' }, 'GitHub 토큰'),
        h('div', { class: 'token-row' }, el.tokenInput,
          h('button', { type: 'button', class: 'btn', onclick: checkToken }, '연결 확인')),
        h('label', { class: 'check' }, el.remember, ' 이 브라우저에 기억 (끄면 탭을 닫을 때 지움)'),
        el.tokenStatus,
        h('details', { class: 'help' },
          h('summary', {}, '토큰 만드는 법'),
          h('ol', {},
            h('li', {}, h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener' }, 'Fine-grained token 만들기'), '를 엽니다.'),
            h('li', {}, 'Repository access: ', h('b', {}, 'Only select repositories'), ' → ', h('code', {}, `${REPO.owner}/${REPO.name}`)),
            h('li', {}, 'Permissions: ', h('b', {}, 'Contents'), '와 ', h('b', {}, 'Pull requests'), '를 Read and write로'),
            h('li', {}, '만든 토큰을 위 칸에 붙여 넣습니다. 토큰은 이 브라우저에만 저장되고 GitHub API 외에는 보내지 않습니다.'))),
        h('div', { class: 'actions' }, el.submit, el.blocker),
        el.log, el.result))));

  function fillProjects() {
    const list = m.projects.filter((p) => p.chip === up.chip);
    el.project.replaceChildren(
      ...list.map((p) => h('option', { value: p.id }, `${p.name} (${p.id}) · v${p.latest}`)),
      h('option', { value: '' }, '＋ 새 프로젝트'));
    if (!list.some((p) => p.id === up.project)) up.project = list[0]?.id || '';
    el.project.value = up.project;
  }

  function onProject() {
    up.version = suggestVersion(m.projects.find((p) => p.id === up.project));
    el.version.value = up.version;
    update();
  }

  async function loadFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    up.image = { name: file.name, bytes, crc: crc32(bytes), sha: await sha256(bytes) };
    el.result.replaceChildren();
    el.log.replaceChildren();
    update();
  }

  async function checkToken() {
    el.tokenStatus.className = 'hint';
    el.tokenStatus.textContent = '확인 중…';
    try {
      const r = await gh(up.token.value, 'GET', repoPath);
      const ok = r.permissions?.push;
      el.tokenStatus.className = ok ? 'hint ok' : 'hint bad';
      el.tokenStatus.textContent = ok ? `✔ ${r.full_name} 쓰기 권한 확인` : `✖ ${r.full_name} 쓰기 권한 없음`;
    } catch (e) {
      el.tokenStatus.className = 'hint bad';
      el.tokenStatus.textContent = `✖ ${e.message}`;
    }
  }

  /* 현재 입력으로 검사 결과·미리보기·커밋 내용을 만든다 */
  function plan() {
    const chip = chipOf(up.chip);
    const loader = loaderOf(chip.loader);
    const proj = m.projects.find((p) => p.id === up.project) || null;
    const errors = {};
    const err = (k, msg) => { errors[k] = errors[k] || msg; };
    const pid = proj ? proj.id : up.id.trim();
    const pname = proj ? proj.name : up.name;
    const ver = up.version.trim();

    if (!proj) {
      if (!ID_RE.test(pid)) err('id', 'ID 형식이 맞지 않습니다');
      else if (m.projects.some((p) => p.id.toLowerCase() === pid.toLowerCase())) err('id', '이미 있는 ID입니다 (SD는 대소문자를 구분하지 않음)');
      if (!NAME_RE.test(pname) || pname !== pname.trim()) err('name', '출력 가능한 ASCII 1~47자, 앞뒤 공백 없이');
    }
    if (!VERSION_RE.test(ver)) err('version', 'x.y.z 또는 x.y.z-태그 형식');
    else if (proj?.versions.some((v) => v.version === ver)) err('version', '이미 게시된 버전입니다');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(up.date)) err('date', '날짜를 고르세요');

    const insp = up.image ? inspectImage(up.image.bytes, chip) : null;
    if (!up.image) err('image', 'BIN 파일을 선택하세요');
    else if (insp.errors.length) err('image', '바이너리 검사 실패');

    const fwTxt = !errors.name && insp && !insp.errors.length ? makeFwTxt(pname, chip, loader, up.image) : null;
    if (fwTxt && fwTxt.length > 1024) err('image', 'fw.txt가 1,024바이트를 넘습니다');

    const dir = `registry/firmware/${pid || '<ID>'}`;
    const files = [];
    if (!proj) files.push([`${dir}/project.toml`,
      `name        = ${tomlString(pname)}\nchip        = ${tomlString(chip.id)}\ndescription = ${tomlString(up.desc.trim())}\n`]);
    const notes = up.notes.trim();
    files.push([`${dir}/${ver || '<버전>'}/release.toml`, `date  = ${up.date}\n` + (notes ? `notes = ${tomlString(notes, true)}\n` : '')]);
    files.push([`${dir}/${ver || '<버전>'}/app.bin`, up.image ? up.image.bytes : null]);
    return { chip, loader, proj, pid, pname, ver, errors, insp, fwTxt, files };
  }

  function update() {
    const p = plan();
    const { chip, loader, insp } = p;

    el.newBox.hidden = !!p.proj;
    el.chipFacts.replaceChildren(
      ...[['device', chip.device], ['로더', loader.sd_path], ['기록 주소', chip.flash_base],
        ['Flash / 섹터', `${fmtSize(chip.flash_size)} / ${fmtSize(chip.sector_size)}`]]
        .map(([k, v]) => h('div', { class: 'fact' }, h('dt', {}, k), h('dd', {}, h('code', {}, v)))));

    for (const k of ['id', 'name', 'version', 'date']) {
      const quiet = (k === 'id' || k === 'name') && up[k] === '';  // 아직 입력 전이면 표시하지 않음
      const msg = quiet ? '' : p.errors[k] || '';
      el[`err_${k}`].textContent = msg;
      el[`f_${k}`].classList.toggle('invalid', !!msg);
    }

    el.dropText.textContent = up.image ? up.image.name : 'BIN 파일을 끌어다 놓거나 눌러서 선택';
    el.dropSub.replaceChildren(...hexify(up.image ? `${fmtSize(up.image.bytes.length)} · CRC32 ${hex32(up.image.crc)} · 다른 파일로 바꾸려면 다시 선택` : `${chip.flash_base}부터 시작하는 전체 이미지, 최대 ${fmtSize(chip.flash_size)}`));
    el.drop.classList.toggle('has', !!up.image);
    el.checks.replaceChildren(...(insp ? [
      ...insp.ok.map((t) => h('li', {}, h('span', {}, hexify(t)))),
      ...insp.errors.map((t) => h('li', { class: 'err' }, h('span', {}, hexify(t)))),
      ...insp.info.map((t) => h('li', { class: 'info' }, h('span', {}, hexify(t)))),
      insp.embedded?.version && p.ver && insp.embedded.version.replace(/^v/i, '') !== p.ver
        ? h('li', { class: 'info' }, `내장 버전과 등록 버전(${p.ver})이 다릅니다. 게시는 되지만 확인하세요.`) : null,
      h('li', { class: 'info' }, h('span', {}, 'SHA-256 ', h('code', { class: 'hash' }, up.image.sha))),
    ].filter(Boolean) : []));

    el.files.replaceChildren(...p.files.map(([path, content]) => h('li', {},
      h('code', {}, path),
      h('span', { class: 'muted' }, content == null ? '' : typeof content === 'string' ? `${content.length} B` : fmtSize(content.length)))));
    el.fwtxt.textContent = p.fwTxt || '(이름과 바이너리 검사가 끝나면 표시됩니다)';

    const firstError = Object.values(p.errors)[0];
    const blocker = firstError || (!up.token.value ? 'GitHub 토큰을 입력하세요' : '');
    el.submit.disabled = !!blocker || up.busy;
    el.blocker.textContent = up.busy ? '진행 중…' : blocker;
    return p;
  }

  async function submit() {
    const p = update();
    if (el.submit.disabled) return;
    up.busy = true;
    update();
    el.log.replaceChildren();
    el.result.replaceChildren();
    const log = (text, cls) => { const li = h('li', { class: cls || null }, text); el.log.append(li); return li; };
    const t = up.token.value;
    const dir = `registry/firmware/${p.pid}`;
    try {
      log(`${REPO.base} 브랜치 확인`);
      const ref = await gh(t, 'GET', `${repoPath}/git/ref/heads/${REPO.base}`, null, true);
      if (!ref) throw new Error(`${REPO.base} 브랜치가 없습니다. 저장소에 첫 커밋을 먼저 푸시하세요.`);
      const baseSha = ref.object.sha;
      const baseCommit = await gh(t, 'GET', `${repoPath}/git/commits/${baseSha}`);

      log('중복 확인 (사이트 배포 전에 머지된 것 포함)');
      if (await existsOnBase(t, `${dir}/${p.ver}/release.toml`)) throw new Error(`${p.pid} ${p.ver}가 이미 ${REPO.base}에 있습니다.`);
      if (!p.proj && await existsOnBase(t, `${dir}/project.toml`)) throw new Error(`프로젝트 ${p.pid}가 이미 ${REPO.base}에 있습니다. 새로고침 후 기존 프로젝트로 선택하세요.`);

      const tree = [];
      for (const [path, content] of p.files) {
        log(`업로드 ${path.split('/').slice(-2).join('/')}`);
        const blob = await gh(t, 'POST', `${repoPath}/git/blobs`, typeof content === 'string'
          ? { content, encoding: 'utf-8' } : { content: base64(content), encoding: 'base64' });
        tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
      }
      const newTree = await gh(t, 'POST', `${repoPath}/git/trees`, { base_tree: baseCommit.tree.sha, tree });

      const emb = p.insp.embedded;
      const title = `Add ${p.pid} ${p.ver} (${p.chip.name})`;
      const facts = [
        `BIN: app.bin, ${up.image.bytes.length} bytes, CRC32 ${hex32(up.image.crc)}`,
        `SHA-256: ${up.image.sha}`,
        emb ? `Embedded: ${emb.version || '-'} / ${emb.name || '-'}` : null,
        `Source file: ${up.image.name}`,
      ].filter(Boolean);
      log('커밋 생성');
      const commit = await gh(t, 'POST', `${repoPath}/git/commits`, {
        message: `${title}\n\n${facts.join('\n')}\nRegistered from the HG-SWD FW Hub web form.`,
        tree: newTree.sha, parents: [baseSha],
      });

      let branch = `fw/${p.pid}-${p.ver}`;
      if (await gh(t, 'GET', `${repoPath}/git/ref/heads/${encPath(branch)}`, null, true)) branch += `-${Date.now().toString(36)}`;
      log(`브랜치 ${branch}`);
      await gh(t, 'POST', `${repoPath}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });

      log('PR 생성');
      const body = [
        `| 항목 | 값 |`, `| --- | --- |`,
        `| 프로젝트 | ${p.pname} (\`${p.pid}\`)${p.proj ? '' : ' — 새 프로젝트'} |`,
        `| 칩 | ${p.chip.name} |`,
        `| 버전 | ${p.ver} (${up.date}) |`,
        `| 크기 | ${up.image.bytes.length.toLocaleString()} B |`,
        `| CRC32 | \`${hex32(up.image.crc)}\` |`,
        `| SHA-256 | \`${up.image.sha}\` |`,
        emb ? `| 내장 버전 | ${emb.version || '-'} / ${emb.name || '-'} |` : null,
        '', '### fw.txt', '```ini', p.fwTxt.trimEnd(), '```',
        up.notes.trim() ? `\n### 변경 내용\n${up.notes.trim()}` : null,
        '', 'CI(Build and deploy)가 통과하면 머지하세요. 머지 후 1~2분 안에 사이트에 게시됩니다.',
      ].filter((x) => x !== null).join('\n');
      const pr = await gh(t, 'POST', `${repoPath}/pulls`, { title, head: branch, base: REPO.base, body });

      log(`PR #${pr.number} 생성 완료`, 'ok-strong');
      el.result.append(h('div', { class: 'done-box' },
        h('div', {}, h('b', {}, `PR #${pr.number}`), ` ${title}`),
        h('p', { class: 'muted' }, 'PR 페이지에서 CI 검사 결과를 확인하고 Merge 하세요. 머지하면 Actions가 사이트를 다시 배포합니다.'),
        h('a', { class: 'btn primary', href: pr.html_url, target: '_blank', rel: 'noopener' }, 'PR 열기')));
      up.image = null;
      el.file.value = '';
    } catch (e) {
      log(e.message || String(e), 'err');
    } finally {
      up.busy = false;
      update();
    }
  }

  fillProjects();
  if (!up.version) up.version = suggestVersion(m.projects.find((p) => p.id === up.project));
  el.version.value = up.version;
  update();
}

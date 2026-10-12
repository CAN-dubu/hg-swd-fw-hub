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
const ESP_SECTOR = 0x1000;
const ESP_APP_DESC_MAGIC = 0xABCD5432;

const up = { chip: '', project: '', id: '', name: '', desc: '', image: null, esp: {}, baud: 'auto', version: '', date: '', notes: '', token: null, busy: false };

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
const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

async function sha256(bytes) {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

/* Web Crypto에 MD5가 없어 파티션 표 검사용으로 직접 구현 (RFC 1321) */
const MD5_K = Uint32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32));
const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

function md5(bytes) {
  const n = bytes.length;
  const len = Math.ceil((n + 9) / 64) * 64;
  const buf = new Uint8Array(len);
  buf.set(bytes);
  buf[n] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(len - 8, (n * 8) >>> 0, true);
  dv.setUint32(len - 4, Math.floor(n / 0x20000000), true);
  const st = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476];
  for (let off = 0; off < len; off += 64) {
    let [a, b, c, d] = st;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const x = (a + f + MD5_K[i] + dv.getUint32(off + g * 4, true)) | 0;
      const s = MD5_S[(i >> 4) * 4 + (i & 3)];
      a = d; d = c; c = b;
      b = (b + ((x << s) | (x >>> (32 - s)))) | 0;
    }
    st[0] = (st[0] + a) | 0; st[1] = (st[1] + b) | 0; st[2] = (st[2] + c) | 0; st[3] = (st[3] + d) | 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  st.forEach((v, i) => out.setUint32(i * 4, v, true));
  return new Uint8Array(out.buffer);
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

const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/* ---------- STM32: build_registry.inspect_stm32_image와 같은 검사 ---------- */

function inspectStm32Image(bytes, chip) {
  const out = { errors: [], ok: [], info: [], embedded: null };
  const base = parseInt(chip.flash_base, 16);
  const n = bytes.length;
  if (n < 8 || n > chip.flash_size) {
    out.errors.push(`크기 ${n.toLocaleString()} B: 8 B ~ ${fmtSize(chip.flash_size)} 범위를 벗어남`);
    return out;
  }
  out.ok.push(`크기 ${n.toLocaleString()} B, ${Math.ceil(n / chip.sector_size)}개 섹터 삭제`);
  const dv = view(bytes);
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

/* ---------- ESP: build_registry.inspect_esp_* (= HG-SWD-PROG prepare_esp_sd.py)와 같은 검사 ---------- */

/* 세그먼트를 따라가 체크섬 바이트가 끝나는 위치. 형식이 깨졌으면 -1 */
function espImageEnd(b) {
  if (b.length < 24 || b[0] !== 0xE9 || b[1] < 1 || b[1] > 16) return -1;
  const dv = view(b);
  let off = 24;
  for (let s = 0; s < b[1]; s++) {
    if (off + 8 > b.length) return -1;
    const size = dv.getUint32(off + 4, true);
    off += 8;
    if (size > b.length - off) return -1;
    off += size;
  }
  const end = (off + 16) & ~15;
  return end > b.length ? -1 : end;
}

/* 파일을 읽을 때 한 번 계산: 이미지 뒤에 붙은 SHA-256이 맞는지 (붙어 있지 않으면 null) */
async function espAppendedHashOk(b) {
  const end = espImageEnd(b);
  if (end < 0 || !b[23]) return null;
  if (end + 32 > b.length) return false;
  return (await sha256(b.subarray(0, end))) === toHex(b.subarray(end, end + 32));
}

function inspectEspImage(file, chipId) {
  const b = file.bytes;
  if (b.length < 24 || b[0] !== 0xE9 || b[1] < 1 || b[1] > 16) return { error: 'ESP 이미지 헤더가 아님 (0xE9)' };
  const id = view(b).getUint16(12, true);
  if (id !== chipId) return { error: `이미지의 칩 ID ${id}가 선택한 칩(${chipId})과 다름` };
  const end = espImageEnd(b);
  if (end < 0) return { error: '세그먼트가 잘림' };
  let sum = 0xEF;
  const dv = view(b);
  for (let s = 0, off = 24; s < b[1]; s++) {
    const size = dv.getUint32(off + 4, true);
    off += 8;
    for (let i = off; i < off + size; i++) sum ^= b[i];
    off += size;
  }
  if (b[end - 1] !== sum) return { error: '체크섬 불일치' };
  if (file.hashOk === false) return { error: '이미지 뒤에 붙은 SHA-256 불일치' };
  const code = b[3] >> 4;
  if (code > 4) return { error: 'Flash 크기 설정이 1~16 MiB가 아님' };
  return { flash: 0x100000 << code };
}

function inspectEspPartitions(b, flash, appSize) {
  const dv = view(b);
  const entries = [];
  for (let off = 0; off < b.length; off += 32) {
    if (off + 32 > b.length) return { error: '파티션 항목이 잘림' };
    const magic = dv.getUint16(off, true);
    if (magic === 0xFFFF) break;
    if (magic === 0xEBEB) {
      if (toHex(md5(b.subarray(0, off))) !== toHex(b.subarray(off + 16, off + 32))) return { error: '파티션 표 MD5 불일치' };
      break;
    }
    if (magic !== 0x50AA) return { error: '파티션 항목 형식 오류' };
    const [kind, sub, addr, size] = [b[off + 2], b[off + 3], dv.getUint32(off + 4, true), dv.getUint32(off + 8, true)];
    if (!size || addr & 4095 || size & 4095 || addr + size > flash) return { error: `파티션 범위 오류 (${hex32(addr)})` };
    if (entries.some((o) => addr < o.addr + o.size && o.addr < addr + size)) return { error: '파티션이 겹침' };
    entries.push({ kind, sub, addr, size });
  }
  const apps = entries.filter((e) => e.kind === 0 && e.addr === 0x10000);
  if (apps.length !== 1 || appSize > apps[0].size || (apps[0].sub !== 0 && apps[0].sub !== 0x10)) {
    return { error: '0x10000에 firmware.bin이 들어갈 factory/ota_0 앱 파티션이 없음' };
  }
  const ota = entries.filter((e) => e.kind === 1 && e.sub === 0);
  if (ota.length > 1 || (ota.length && ota[0].size !== 0x2000)) return { error: 'OTA data 파티션 형식이 예상과 다름' };
  if (apps[0].sub === 0x10 && !ota.length) return { error: 'OTA 앱에 OTA data 파티션이 없음' };
  return { app: apps[0], ota: ota[0] || null };
}

function espAppDesc(b) {
  if (b.length < 176 || view(b).getUint32(32, true) !== ESP_APP_DESC_MAGIC) return null;
  return { version: cstr(b.subarray(48, 80)), name: cstr(b.subarray(80, 112)), idf: cstr(b.subarray(144, 176)) };
}

/* ---------- 공통 ---------- */

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

async function readFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { name: file.name, bytes, crc: crc32(bytes), sha: await sha256(bytes), hashOk: await espAppendedHashOk(bytes) };
}

/* Pretendard가 0x 사이의 x를 ×로 바꾸므로 16진수 값은 code로 감싼다 */
const hexify = (text) => text.split(/(0x[0-9A-Fa-f]+)/).map((part, i) => (i % 2 ? h('code', {}, part) : part));
const checkItem = ([cls, text]) => h('li', { class: cls || null }, h('span', {}, hexify(text)));

/* ---------- 칩 종류별 패키지 계획 ---------- */

/* STM32: app.bin 하나. HG-SWD-PROG prog_inspect.c가 읽는 fw.txt */
function planStm32(chip, pname) {
  const loader = loaderOf(chip.loader);
  const out = { checks: [], slotChecks: {}, images: [], fwTxt: null, error: null, embedded: null, upload: [] };
  if (!up.image) {
    out.error = 'BIN 파일을 선택하세요';
    return out;
  }
  const insp = inspectStm32Image(up.image.bytes, chip);
  out.checks = [...insp.ok.map((t) => ['', t]), ...insp.errors.map((t) => ['err', t]), ...insp.info.map((t) => ['info', t])];
  out.embedded = insp.embedded;
  out.upload = [['app.bin', up.image.bytes]];
  if (insp.errors.length) {
    out.error = '바이너리 검사 실패';
    return out;
  }
  out.images = [{ ...up.image, source: up.image.name, name: 'app.bin', address: chip.flash_base }];
  out.erase = `${Math.ceil(up.image.bytes.length / chip.sector_size)} × ${fmtSize(chip.sector_size)}`;
  if (pname) {
    out.fwTxt = `name=${pname}\ndevice=${chip.device}\nalgo=${loader.sd_path}\nimage=app.bin @ ${chip.flash_base}\n` +
      `crc32=${hex32(up.image.crc)}\nloader_crc32=${loader.crc32}\n`;
  }
  return out;
}

/* ESP: 고정 슬롯 3개 + 파티션 표에 OTA data가 있으면 ota-reset.bin 생성. HG-SWD-PROG esp_project.c가 읽는 fw.txt */
function planEsp(chip, pname) {
  const out = { checks: [], slotChecks: {}, images: [], fwTxt: null, error: null, embedded: null, upload: [] };
  const f = Object.fromEntries(chip.slots.map((s) => [s.name, up.esp[s.name] || null]));
  const sc = (name, cls, text) => (out.slotChecks[name] = out.slotChecks[name] || []).push([cls, text]);
  const fail = (msg) => { out.error = out.error || msg; };
  const boot = f['bootloader.bin'], parts = f['partitions.bin'], app = f['firmware.bin'];
  const bootAddr = parseInt(chip.slots[0].address, 16);
  out.upload = chip.slots.map((s) => [s.name, f[s.name]?.bytes ?? null]);

  let flash = null;
  if (boot) {
    const r = inspectEspImage(boot, chip.chip_id);
    if (r.error) { sc('bootloader.bin', 'err', r.error); fail('bootloader.bin 검사 실패'); }
    else if (bootAddr + boot.bytes.length > 0x8000) { sc('bootloader.bin', 'err', `${hex32(bootAddr)}부터 0x8000을 넘음`); fail('bootloader.bin 검사 실패'); }
    else { flash = r.flash; sc('bootloader.bin', '', `헤더·체크섬${boot.hashOk ? '·SHA-256' : ''} OK, Flash 설정 ${fmtSize(flash)}`); }
  }
  let appOk = false;
  if (app) {
    const r = inspectEspImage(app, chip.chip_id);
    if (r.error) { sc('firmware.bin', 'err', r.error); fail('firmware.bin 검사 실패'); }
    else if (flash && r.flash !== flash) { sc('firmware.bin', 'err', `Flash 설정 ${fmtSize(r.flash)}이 bootloader.bin(${fmtSize(flash)})과 다름`); fail('firmware.bin 검사 실패'); }
    else { appOk = true; sc('firmware.bin', '', `헤더·체크섬${app.hashOk ? '·SHA-256' : ''} OK`); }
    out.embedded = espAppDesc(app.bytes);
    if (out.embedded) sc('firmware.bin', 'info', `앱 정보 ${out.embedded.version || '-'} / ${out.embedded.name || '-'} / IDF ${out.embedded.idf || '-'}`);
  }
  let ota = null;
  if (parts) {
    if (parts.bytes.length > 4096) { sc('partitions.bin', 'err', '4 KiB보다 큼'); fail('partitions.bin 검사 실패'); }
    else if (flash && app && appOk) {
      const r = inspectEspPartitions(parts.bytes, flash, app.bytes.length);
      if (r.error) { sc('partitions.bin', 'err', r.error); fail('partitions.bin 검사 실패'); }
      else {
        ota = r.ota;
        sc('partitions.bin', '', `MD5 OK, 앱 영역 ${fmtSize(r.app.size)} (firmware.bin ${Math.round(app.bytes.length / r.app.size * 100)}%)`);
        sc('partitions.bin', 'info', ota ? `OTA data ${hex32(ota.addr)} → ota-reset.bin 자동 생성 (app0으로 부팅)` : 'OTA data 없음 → ota-reset.bin 생략');
      }
    } else sc('partitions.bin', 'info', 'bootloader.bin과 firmware.bin 검사가 끝나면 확인합니다');
  }
  const missing = chip.slots.filter((s) => !f[s.name]).map((s) => s.name);
  if (missing.length) fail(`${missing.join(', ')}을(를) 선택하세요`);
  if (out.error) return out;

  const images = chip.slots.map((s) => ({ ...f[s.name], source: f[s.name].name, name: s.name, address: s.address }));
  if (ota) {
    const bytes = new Uint8Array(ota.size).fill(0xFF);
    images.push({ name: 'ota-reset.bin', address: hex32(ota.addr), bytes, crc: crc32(bytes), generated: true });
  }
  images.sort((a, b) => parseInt(a.address, 16) - parseInt(b.address, 16));
  let prevEnd = 0;
  for (const img of images) {
    const addr = parseInt(img.address, 16);
    if (addr < prevEnd) return { ...out, error: `${img.name}가 앞 이미지의 삭제 범위와 겹침` };
    prevEnd = addr + Math.ceil(img.bytes.length / ESP_SECTOR) * ESP_SECTOR;
  }
  out.images = images;
  out.erase = `${images.reduce((n, i) => n + Math.ceil(i.bytes.length / ESP_SECTOR), 0)} × 4 KiB`;
  out.checks.push(['', `${images.length}개 이미지, 총 ${fmtSize(images.reduce((n, i) => n + i.bytes.length, 0))}, Flash ${fmtSize(flash)} 필요`]);
  if (pname) {
    out.fwTxt = [`name=${pname}`, `device=${chip.device}`, `baud=${up.baud}`, `flash_size=${hex32(flash)}`,
      ...images.map((i) => `image=${i.name},${hex32(parseInt(i.address, 16))},${hex32(i.bytes.length)},${hex32(i.crc)}`)].join('\n') + '\n';
  }
  return out;
}

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
  if (!m.chips.some((c) => c.id === up.chip)) up.chip = (m.chips.find((c) => c.kind !== 'esp') || m.chips[0])?.id || '';
  if (!up.date) up.date = new Date().toLocaleDateString('sv-SE');
  if (up.token === null) up.token = loadToken();
  const el = { slots: {} };

  const errSpan = (key) => (el[`err_${key}`] = h('span', { class: 'err' }));
  const field = (label, control, key, opts = {}) =>
    (el[`f_${key}`] = h('label', { class: 'field' + (opts.wide ? ' wide' : '') },
      h('span', { class: 'field-label' }, label), control, opts.hint ? h('span', { class: 'hint' }, opts.hint) : null, errSpan(key)));
  const bind = (key, tag, attrs = {}, children = []) => {
    const c = h(tag, { ...attrs, [tag === 'select' ? 'onchange' : 'oninput']: (e) => { up[key] = e.target.value; update(); } }, children);
    c.value = up[key];
    return (el[key] = c);
  };
  const dropZone = (onFile, accept = '.bin,application/octet-stream') => {
    const z = { input: h('input', { type: 'file', accept, onchange: (e) => e.target.files[0] && onFile(e.target.files[0]) }),
      main: h('span', { class: 'drop-main' }), sub: h('span', { class: 'drop-sub' }) };
    z.label = h('label', {
      class: 'drop',
      ondragover: (e) => { e.preventDefault(); z.label.classList.add('over'); },
      ondragleave: () => z.label.classList.remove('over'),
      ondrop: (e) => { e.preventDefault(); z.label.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) onFile(f); },
    }, z.input, z.main, z.sub);
    return z;
  };

  /* 1. 대상 */
  const kinds = [['stm32', 'STM32 · SWD'], ['esp', 'ESP32 · UART']];
  el.chip = h('select', { onchange: (e) => { up.chip = e.target.value; up.project = ''; fillProjects(); buildSlots(); onProject(); } },
    kinds.map(([k, label]) => h('optgroup', { label }, m.chips.filter((c) => (c.kind || 'stm32') === k).map((c) => h('option', { value: c.id }, c.name)))));
  el.chip.value = up.chip;
  el.project = h('select', { onchange: (e) => { up.project = e.target.value; onProject(); } });
  el.newBox = h('div', { class: 'fields sub' },
    field('프로젝트 ID', bind('id', 'input', { placeholder: 'h723', autocomplete: 'off', spellcheck: 'false' }), 'id',
      { hint: 'SD의 /prog/fw/<ID>/ 폴더명. 영문·숫자·_·- 1~24자' }),
    field('이름', bind('name', 'input', { placeholder: 'H723 GFX firmware', autocomplete: 'off' }), 'name',
      { hint: '프로그래머 화면과 fw.txt에 표시. ASCII 47자 이내' }),
    field('설명', bind('desc', 'input', { placeholder: '사이트에만 표시, 한글 가능', autocomplete: 'off' }), 'desc', { wide: true }));
  el.chipFacts = h('dl', { class: 'facts' });

  /* 2. 바이너리: STM32는 하나, ESP는 고정 슬롯 */
  el.stm32 = dropZone(async (file) => { up.image = await readFile(file); clearResult(); update(); });
  el.stm32Box = h('div', {}, el.stm32.label);
  el.espBox = h('div', { class: 'slots' });
  el.checks = h('ul', { class: 'checks' });

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
      step('2', '바이너리', el.stm32Box, el.espBox, el.checks),
      step('3', '릴리스 정보',
        h('div', { class: 'fields' },
          field('버전', bind('version', 'input', { autocomplete: 'off', spellcheck: 'false' }), 'version',
            { hint: 'x.y.z. 태그(-rc.1 등)를 붙이면 프리릴리스로 기기 자동 업데이트에서 빠짐' }),
          field('날짜', bind('date', 'input', { type: 'date' }), 'date'),
          field('UART 속도 상한', bind('baud', 'select', {}, ['auto', '921600', '460800', '230400', '115200']
            .map((b) => h('option', { value: b }, b === 'auto' ? 'auto (921600부터 검사)' : `${b} bps`))), 'baud',
            { hint: '연결 검사에 실패하면 프로그래머가 자동으로 낮춤' }),
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

  function clearResult() {
    el.result.replaceChildren();
    el.log.replaceChildren();
  }

  function fillProjects() {
    const list = m.projects.filter((p) => p.chip === up.chip);
    el.project.replaceChildren(
      ...list.map((p) => h('option', { value: p.id }, `${p.name} (${p.id}) · v${p.latest}`)),
      h('option', { value: '' }, '＋ 새 프로젝트'));
    if (!list.some((p) => p.id === up.project)) up.project = list[0]?.id || '';
    el.project.value = up.project;
  }

  /* ESP 칩마다 부트로더 주소가 달라 슬롯을 다시 만든다 */
  function buildSlots() {
    const chip = chipOf(up.chip);
    el.slots = {};
    el.espBox.replaceChildren(...(chip.kind === 'esp' ? [
      ...chip.slots.map((s) => {
        const z = dropZone(async (file) => { up.esp[s.name] = await readFile(file); clearResult(); update(); });
        const checks = h('ul', { class: 'checks' });
        el.slots[s.name] = { ...z, checks };
        return h('div', { class: 'slot' },
          h('div', { class: 'slot-head' }, h('code', { class: 'slot-name' }, s.name), h('span', { class: 'muted' }, '@ ', h('code', {}, s.address))),
          z.label, checks);
      }),
      h('p', { class: 'hint slot-note' }, 'ota-reset.bin은 올리지 않습니다. 파티션 표에 OTA data가 있으면 CI가 0xFF로 채워 생성합니다.'),
    ] : []));
  }

  function onProject() {
    up.version = suggestVersion(m.projects.find((p) => p.id === up.project));
    el.version.value = up.version;
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
    const esp = chip.kind === 'esp';
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

    const pkg = (esp ? planEsp : planStm32)(chip, errors.name ? null : pname);
    if (pkg.error) err('image', pkg.error);
    if (pkg.fwTxt && pkg.fwTxt.length > 1024) err('image', 'fw.txt가 1,024바이트를 넘습니다');

    const dir = `registry/firmware/${pid || '<ID>'}`;
    const vdir = `${dir}/${ver || '<버전>'}`;
    const notes = up.notes.trim();
    const files = [];
    if (!proj) files.push([`${dir}/project.toml`,
      `name        = ${tomlString(pname)}\nchip        = ${tomlString(chip.id)}\ndescription = ${tomlString(up.desc.trim())}\n`]);
    files.push([`${vdir}/release.toml`, `date  = ${up.date}\n` + (esp ? `baud  = "${up.baud}"\n` : '') + (notes ? `notes = ${tomlString(notes, true)}\n` : '')]);
    files.push(...pkg.upload.map(([name, bytes]) => [`${vdir}/${name}`, bytes]));
    return { chip, esp, proj, pid, pname, ver, errors, pkg, files };
  }

  function update() {
    const p = plan();
    const { chip, pkg } = p;

    el.newBox.hidden = !!p.proj;
    el.stm32Box.hidden = p.esp;
    el.espBox.hidden = !p.esp;
    el.f_baud.hidden = !p.esp;
    const facts = p.esp
      ? [['device', chip.device], ['방식', 'UART · RAM stub (로더 파일 불필요)'],
        ['기록 주소', chip.slots.map((s) => `${s.name.replace('.bin', '')} ${s.address}`).join(' · ')], ['Flash / 섹터', `최대 16 MiB / 4 KiB`]]
      : [['device', chip.device], ['로더', loaderOf(chip.loader).sd_path], ['기록 주소', chip.flash_base],
        ['Flash / 섹터', `${fmtSize(chip.flash_size)} / ${fmtSize(chip.sector_size)}`]];
    el.chipFacts.replaceChildren(...facts.map(([k, v]) => h('div', { class: 'fact' + (k === '기록 주소' && p.esp ? ' wide' : '') }, h('dt', {}, k), h('dd', {}, h('code', {}, v)))));

    for (const k of ['id', 'name', 'version', 'date']) {
      const quiet = (k === 'id' || k === 'name') && up[k] === '';  // 아직 입력 전이면 표시하지 않음
      const msg = quiet ? '' : p.errors[k] || '';
      el[`err_${k}`].textContent = msg;
      el[`f_${k}`].classList.toggle('invalid', !!msg);
    }

    const showFile = (z, file, empty) => {
      z.main.textContent = file ? file.name : 'BIN 파일을 끌어다 놓거나 눌러서 선택';
      z.sub.replaceChildren(...hexify(file ? `${fmtSize(file.bytes.length)} · CRC32 ${hex32(file.crc)} · 바꾸려면 다시 선택` : empty));
      z.label.classList.toggle('has', !!file);
    };
    if (p.esp) {
      for (const s of chip.slots) {
        const z = el.slots[s.name];
        showFile(z, up.esp[s.name], `${s.name}를 놓으세요`);
        z.checks.replaceChildren(...(pkg.slotChecks[s.name] || []).map(checkItem));
      }
    } else {
      showFile(el.stm32, up.image, `${chip.flash_base}부터 시작하는 전체 이미지, 최대 ${fmtSize(chip.flash_size)}`);
    }
    const emb = pkg.embedded;
    el.checks.replaceChildren(...[
      ...pkg.checks.map(checkItem),
      !p.esp && emb?.version && p.ver && emb.version.replace(/^v/i, '') !== p.ver
        ? checkItem(['info', `내장 버전과 등록 버전(${p.ver})이 다릅니다. 게시는 되지만 확인하세요.`]) : null,
      !p.esp && up.image ? h('li', { class: 'info' }, h('span', {}, 'SHA-256 ', h('code', { class: 'hash' }, up.image.sha))) : null,
    ].filter(Boolean));

    el.files.replaceChildren(...p.files.map(([path, content]) => h('li', {},
      h('code', {}, path),
      h('span', { class: 'muted' }, content == null ? '' : typeof content === 'string' ? `${content.length} B` : fmtSize(content.length)))));
    el.fwtxt.textContent = pkg.fwTxt || '(이름과 바이너리 검사가 끝나면 표시됩니다)';

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
    clearResult();
    const log = (text, cls) => { const li = h('li', { class: cls || null }, text); el.log.append(li); return li; };
    const t = up.token.value;
    const dir = `registry/firmware/${p.pid}`;
    const { images, embedded: emb, fwTxt } = p.pkg;
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

      const title = `Add ${p.pid} ${p.ver} (${p.chip.name})`;
      const embText = emb ? `${emb.version || '-'} / ${emb.name || '-'}${emb.idf ? ` / IDF ${emb.idf}` : ''}` : null;
      const facts = [
        ...images.map((i) => `${i.name} @ ${hex32(parseInt(i.address, 16))}: ${i.bytes.length} bytes, CRC32 ${hex32(i.crc)}` +
          (i.generated ? ' (generated)' : `, from ${i.source}`)),
        embText ? `Embedded: ${embText}` : null,
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
        p.esp ? `| UART 속도 상한 | ${up.baud} |` : null,
        embText ? `| 내장 정보 | ${embText} |` : null,
        '', '| 파일 | 주소 | 크기 | CRC32 | SHA-256 |', '| --- | --- | ---: | --- | --- |',
        ...images.map((i) => `| ${i.name}${i.generated ? ' (CI 생성)' : ''} | \`${hex32(parseInt(i.address, 16))}\` | ${i.bytes.length.toLocaleString()} | \`${hex32(i.crc)}\` | ${i.sha ? `\`${i.sha.slice(0, 16)}…\`` : '-'} |`),
        '', '### fw.txt', '```ini', fwTxt.trimEnd(), '```',
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
      up.esp = {};
      app.querySelectorAll('input[type=file]').forEach((i) => { i.value = ''; });
    } catch (e) {
      log(e.message || String(e), 'err');
    } finally {
      up.busy = false;
      update();
    }
  }

  fillProjects();
  buildSlots();
  if (!up.version) up.version = suggestVersion(m.projects.find((p) => p.id === up.project));
  el.version.value = up.version;
  update();
}

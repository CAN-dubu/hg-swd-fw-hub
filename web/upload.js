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

const up = { chip: '', project: '', id: '', name: '', desc: '', image: null, esp: {}, espMode: 'split', merged: null, mergedSplit: null,
  baud: 'auto', version: '', date: '', notes: '', notice: '', token: null, busy: false };

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

/* 이미지가 차지하는 길이: 세그먼트, 체크섬 패딩, 붙은 SHA-256. 형식이 깨졌으면 -1 (build_registry.esp_image_length) */
function espImageLength(b) {
  const end = espImageEnd(b);
  if (end < 0) return -1;
  return b[23] ? Math.min(end + 32, b.length) : end; // 잘린 해시는 inspectEspImage가 불일치로 알린다
}

/* 통파일(esptool merge-bin)의 파일 위치 0이 가리키는 Flash 주소. --target-offset으로 부트로더부터 합친 경우도 받는다 */
const mergedBase = (b, chip) => {
  const boot = parseInt(chip.slots[0].address, 16);
  return boot && b[0] === 0xE9 ? boot : 0;
};

/* 3분할 칸에 통파일을 놓았는지: 0x8000에 파티션 표, 0x10000에 앱 이미지 */
function looksMerged(b, chip) {
  const base = mergedBase(b, chip);
  return b.length > 0x10000 - base + 24 && b[0x10000 - base] === 0xE9 && view(b).getUint16(0x8000 - base, true) === 0x50AA;
}

/* build_registry.split_esp_merged: 통파일을 세 칸 파일로 자른다 */
async function splitMerged(file, chip) {
  const b = file.bytes;
  const base = mergedBase(b, chip);
  if (b.length <= 0x10000 - base + 24) return { error: '0x10000의 firmware까지 들어 있는 통파일이 아님' };
  const parts = {};
  for (const s of chip.slots) {
    const off = parseInt(s.address, 16) - base;
    const len = s.name === 'partitions.bin' ? 0xC00 : espImageLength(b.subarray(off));
    if (len < 0) return { error: `${s.address}에 ${s.name} 이미지가 없음` };
    const bytes = b.slice(off, off + len);
    parts[s.name] = { name: `${file.name} @ ${s.address}`, bytes, crc: crc32(bytes), sha: await sha256(bytes), hashOk: await espAppendedHashOk(bytes) };
  }
  return { base, parts };
}

/* build_registry.check_merged_rest: 기록하지 않는 영역에 데이터가 있으면 그 주소, 없으면 -1 */
function mergedStray(b, base, images) {
  const ranges = images.map((i) => [parseInt(i.address, 16) - base, parseInt(i.address, 16) - base + i.bytes.length]).sort((x, y) => x[0] - y[0]);
  let pos = 0;
  for (const [lo, hi] of [...ranges, [b.length, b.length]]) {
    for (let i = pos; i < lo; i++) if (b[i] !== 0xFF) return base + i;
    pos = Math.max(pos, hi);
  }
  return -1;
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

/* ESP: 고정 슬롯 3개(또는 그걸 자른 통파일) + 파티션 표에 OTA data가 있으면 ota-reset.bin 생성.
   HG-SWD-PROG esp_project.c가 읽는 fw.txt */
function planEsp(chip, pname) {
  const out = { checks: [], slotChecks: {}, images: [], fwTxt: null, error: null, embedded: null, upload: [] };
  const merged = up.espMode === 'merged';
  const src = merged ? up.mergedSplit?.parts || {} : up.esp;
  const f = Object.fromEntries(chip.slots.map((s) => [s.name, src[s.name] || null]));
  const sc = (name, cls, text) => (out.slotChecks[name] = out.slotChecks[name] || []).push([cls, text]);
  const fail = (msg) => { out.error = out.error || msg; };
  const boot = f['bootloader.bin'], parts = f['partitions.bin'], app = f['firmware.bin'];
  const bootAddr = parseInt(chip.slots[0].address, 16);
  out.upload = merged ? [['merged.bin', up.merged?.bytes ?? null]] : chip.slots.map((s) => [s.name, f[s.name]?.bytes ?? null]);
  if (merged) {
    if (!up.merged) { fail('통파일을 선택하세요'); return out; }
    if (up.mergedSplit?.error) { out.checks.push(['err', up.mergedSplit.error]); fail(up.mergedSplit.error); return out; }
  }

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

  const images = chip.slots.map((s) => ({ ...f[s.name], source: merged ? 'merged.bin' : f[s.name].name, name: s.name, address: s.address }));
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
  if (merged) {
    const stray = mergedStray(up.merged.bytes, up.mergedSplit.base, images);
    if (stray >= 0) return { ...out, checks: [['err', `${hex32(stray)}에 기록되지 않을 데이터가 있음 (NVS·SPIFFS 등). 3분할로 올리세요`]], error: '통파일에 다른 데이터가 있음' };
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

/* ---------- 화면: 세 가지를 고르고(칩 → 프로젝트 → 파일) 확인하면 PR ---------- */

const NEW_PROJECT = '\u0000new';

const ICONS = {
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2.5v3.5M15 2.5v3.5M9 18v3.5M15 18v3.5M2.5 9h3.5M2.5 15h3.5M18 9h3.5M18 15h3.5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  key: '<circle cx="8" cy="15.5" r="4.5"/><path d="M11.2 12.3L20 3.5M16 7.5l2.8 2.8M13.6 9.9l1.8 1.8"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  alert: '<path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  'folder-plus': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10.5v5M9.5 13h5"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M9 7V4h6v3"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/>',
};

function icon(name, cls = 'ico') {
  const s = h('span', { class: cls, 'aria-hidden': 'true' });
  s.innerHTML = `<svg viewBox="0 0 24 24">${ICONS[name]}</svg>`; // 고정 문자열만 넣는다
  return s;
}

/* replaceChildren은 null을 글자로 넣으므로 빈 칸을 걸러서 채운다 */
const put = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));

/* 열고 닫을 때 부드럽게 움직이는 모달. close()는 애니메이션이 끝난 뒤 제거한다 */
function openModal(title, { body, footer, wide, locked, onClose } = {}) {
  const box = h('div', { class: 'modal-box' });
  const dlg = h('dialog', { class: 'modal' + (wide ? ' wide' : '') }, box);
  const m = {
    dlg, locked: !!locked,
    set(b, f) {
      put(box,
        h('header', { class: 'modal-head' }, h('h2', {}, title),
          m.locked ? null : h('button', { class: 'modal-x', type: 'button', 'aria-label': '닫기', onclick: () => m.close() }, '✕')),
        h('div', { class: 'modal-body' }, b),
        f ? h('footer', { class: 'modal-foot' }, f) : null);
    },
    close() {
      if (!dlg.open || dlg.classList.contains('closing')) return;
      dlg.classList.add('closing');
      setTimeout(() => { dlg.close(); dlg.remove(); onClose?.(); }, reduceMotion() ? 0 : 170);
    },
  };
  m.set(body, footer);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); if (!m.locked) m.close(); });
  dlg.addEventListener('mousedown', (e) => { if (e.target === dlg && !m.locked) m.close(); }); // 바깥 클릭
  document.body.append(dlg);
  dlg.showModal();
  return m;
}

/* 파일을 놓는 칸. multiple이면 여러 파일을 한 번에 받는다 */
function dropZone(onFiles, { multiple = false, title, hint } = {}) {
  const input = h('input', { type: 'file', accept: '.bin,application/octet-stream', multiple: multiple || null,
    // 읽기 전에 value를 비우면 Chrome이 파일 접근을 거둘 수 있어 그대로 둔다 (읽은 뒤 칸을 다시 그림)
    onchange: (e) => { if (e.target.files.length) onFiles([...e.target.files]); } });
  const z = h('label', {
    class: 'drop',
    ondragover: (e) => { e.preventDefault(); z.classList.add('over'); },
    ondragleave: () => z.classList.remove('over'),
    ondrop: (e) => { e.preventDefault(); z.classList.remove('over'); const f = [...e.dataTransfer.files]; if (f.length) onFiles(multiple ? f : f.slice(0, 1)); },
  }, input, icon('upload', 'drop-ico'), h('span', { class: 'drop-main' }, title), h('span', { class: 'drop-sub' }, hint));
  return z;
}

/* 파일 이름으로 ESP 칸을 고른다. 한 번에 여러 파일을 놓을 때 쓴다 */
function espSlotFor(name) {
  const n = name.toLowerCase();
  if (n.includes('ota')) return null; // ota-reset.bin은 CI가 만든다
  if (n.includes('boot')) return 'bootloader.bin';
  if (n.includes('partition')) return 'partitions.bin';
  return 'firmware.bin';
}

function planUpload() {
  const m = state.manifest;
  const chip = up.chip ? chipOf(up.chip) : null;
  const esp = chip?.kind === 'esp';
  const isNew = up.project === NEW_PROJECT;
  const proj = !isNew && up.project ? m.projects.find((p) => p.id === up.project) || null : null;
  const errors = {};
  const err = (k, msg) => { errors[k] = errors[k] || msg; };
  const pid = proj ? proj.id : up.id.trim();
  const pname = proj ? proj.name : up.name;
  const ver = up.version.trim();

  if (!chip) err('chip', '칩을 고르세요');
  if (!proj && !isNew) err('project', '프로젝트를 고르세요');
  if (isNew) {
    if (!ID_RE.test(pid)) err('id', '영문·숫자·_·- 1~24자');
    else if (m.projects.some((p) => p.id.toLowerCase() === pid.toLowerCase())) err('id', '이미 있는 ID입니다 (SD는 대소문자를 구분하지 않음)');
    if (!NAME_RE.test(pname) || pname !== pname.trim()) err('name', '영문·숫자 등 ASCII 1~47자');
    if (errors.id || errors.name) err('project', '새 프로젝트 정보를 확인하세요');
  }
  if (!VERSION_RE.test(ver)) err('version', 'x.y.z 형식 (예: 1.0.0)');
  else if (proj?.versions.some((v) => v.version === ver)) err('version', '이미 게시된 버전입니다');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(up.date)) err('date', '날짜를 고르세요');

  const empty = { checks: [], slotChecks: {}, images: [], fwTxt: null, error: '파일을 고르세요', embedded: null, upload: [] };
  const pkg = chip ? (esp ? planEsp : planStm32)(chip, errors.name || !pname ? null : pname) : empty;
  if (pkg.error) err('image', pkg.error);
  if (pkg.fwTxt && pkg.fwTxt.length > 1024) err('image', 'fw.txt가 1,024바이트를 넘습니다');
  if (isNew) {
    // build_registry.load_notice와 같은 검사
    const unknown = [...up.notice.matchAll(LICENSE_REF_RE)].map((x) => x[1]).filter((f) => !(m.licenses || []).includes(f));
    if (!up.notice.trim()) err('notice', '펌웨어에 들어간 오픈소스와 라이선스를 적으세요');
    else if (up.notice.includes('TODO')) err('notice', 'TODO 줄을 채우거나 지우세요');
    else if (unknown.length) err('notice', `없는 라이선스 파일: ${[...new Set(unknown)].join(', ')}`);
  }

  const dir = `registry/firmware/${pid || '<ID>'}`;
  const vdir = `${dir}/${ver || '<버전>'}`;
  const notes = up.notes.trim();
  const files = [];
  if (isNew) files.push([`${dir}/project.toml`,
    `name        = ${tomlString(pname)}\nchip        = ${tomlString(chip?.id || '')}\ndescription = ${tomlString(up.desc.trim())}\n`],
    [`${dir}/NOTICE.txt`, up.notice.replace(/\r\n?/g, '\n').trimEnd() + '\n']);
  files.push([`${vdir}/release.toml`, `date  = ${up.date}\n` + (esp ? `baud  = "${up.baud}"\n` : '') + (notes ? `notes = ${tomlString(notes, true)}\n` : '')]);
  files.push(...pkg.upload.map(([name, bytes]) => [`${vdir}/${name}`, bytes]));
  return { chip, esp, proj, isNew, pid, pname, ver, errors, pkg, files };
}

const selectionReady = (p) => !p.errors.chip && !p.errors.project && !p.errors.image;

const LICENSE_REF_RE = /licenses\/([A-Za-z0-9._-]+\.txt)/g;

/* 새 프로젝트의 NOTICE.txt 초안. 확인할 곳은 TODO로 남겨 두고, 남아 있으면 등록할 수 없다 */
function noticeTemplate(p) {
  const head = [`${p.pname} (${p.pid}) - third-party software notices`, '',
    'TODO: copyright line for this firmware, e.g. Copyright (c) 2026 Higenis.',
    'License texts named licenses/<file> are in prog/licenses/ of the SD package,',
    'licenses/ on the FW Hub site and registry/licenses/ in the repository.', '', ''];
  const item = (n, name, copyright, license) => [`${n}. ${name}`, `   ${copyright}`, `   License: ${license}`, ''];
  const body = p.esp ? [
    ...item(1, 'Arduino-ESP32 core TODO: core version (Arduino IDE > Boards Manager > esp32)',
      'Copyright 2015-2026 Espressif Systems (Shanghai) PTE LTD and contributors',
      'GNU Lesser General Public License v2.1 (licenses/LGPL-2.1.txt)'),
    ...item(2, `ESP-IDF ${p.pkg.embedded?.idf || 'TODO: version'} (bootloader, drivers and system components)`,
      'Copyright Espressif Systems (Shanghai) CO LTD', 'Apache License 2.0 (licenses/Apache-2.0.txt)'),
    ...item(3, 'FreeRTOS Kernel (ESP-IDF port)', 'Copyright (C) 2021 Amazon.com, Inc. or its affiliates.  All Rights Reserved.',
      'MIT (licenses/MIT.txt)'),
    ...item(4, 'Mbed TLS', 'Copyright The Mbed TLS Contributors', 'Apache License 2.0 (licenses/Apache-2.0.txt)'),
    ...item(5, 'newlib C library (Espressif toolchain)', 'Copyright: see the license file', 'various permissive licenses (licenses/newlib.txt)'),
    'TODO: add each library the sketch uses (name, version, copyright, license), or delete this line.',
  ] : [
    'TODO: list each third-party library linked into app.bin (name, version, copyright, license).',
    'Parts most STM32 builds contain:', '',
    ...item(1, 'STM32 HAL driver', 'Copyright (c) STMicroelectronics', 'BSD-3-Clause (licenses/BSD-3-Clause.txt)'),
    ...item(2, 'CMSIS', 'Copyright (c) Arm Limited', 'Apache License 2.0 (licenses/Apache-2.0.txt)'),
    ...item(3, 'newlib C library (Arm GNU toolchain)', 'Copyright: see the license file', 'various permissive licenses (licenses/newlib.txt)'),
  ];
  return [...head, ...body].join('\n').trimEnd() + '\n';
}

/* 파일 칸: [고른 수, 필요한 수]. ESP 통파일은 1개 */
function fileProgress(chip) {
  if (chip.kind !== 'esp') return [up.image ? 1 : 0, 1];
  if (up.espMode === 'merged') return [up.merged ? 1 : 0, 1];
  return [Object.keys(up.esp).length, chip.slots.length];
}

const clearFiles = () => Object.assign(up, { image: null, esp: {}, merged: null, mergedSplit: null });

/* ESP 올리는 방식. 장단점은 파일 창에서 고를 때 보여 준다 */
const ESP_MODES = {
  split: {
    title: '3분할 파일', sub: 'bootloader · partitions · firmware',
    pros: ['빌드 폴더 결과물을 그대로 사용', '파일마다 검사 결과를 따로 확인'],
    cons: ['세 파일을 모두 골라야 함', '다른 빌드의 파일이 섞일 수 있음'],
  },
  merged: {
    title: '통파일 1개', sub: 'merged.bin · esptool merge-bin',
    pros: ['파일 하나로 끝, 빌드 간 혼용 없음', '받은 원본 그대로 저장소에 보관'],
    cons: ['0x0부터 합친 파일만 가능', 'NVS·SPIFFS 등 다른 데이터가 있으면 불가', '빈 영역(0xFF)만큼 파일이 조금 큼'],
  },
};

function resetUpload(keepToken = true) {
  clearFiles();
  Object.assign(up, { chip: '', project: '', id: '', name: '', desc: '', baud: 'auto', version: '', notes: '', notice: '',
    date: new Date().toLocaleDateString('sv-SE') });
  if (!keepToken) up.token = loadToken();
}

function renderUpload() {
  const m = state.manifest;
  if (!up.date) up.date = new Date().toLocaleDateString('sv-SE');
  if (up.token === null) up.token = loadToken();
  if (up.chip && !m.chips.some((c) => c.id === up.chip)) resetUpload();

  const tiles = h('div', { class: 'wizard' });
  const next = h('button', { type: 'button', class: 'btn primary next-btn', onclick: () => openConfirm() }, '다음');
  const nextHint = h('p', { class: 'next-hint' });
  const conn = h('button', { type: 'button', class: 'conn', onclick: () => openSettings() });

  app.replaceChildren(h('section', { class: 'page upload-page' },
    h('div', { class: 'upload-head' },
      h('div', {},
        h('h1', {}, '펌웨어 등록'),
        h('p', { class: 'lead' }, '세 가지를 고르고 다음을 누르면 등록 요청(PR)이 만들어집니다.')),
      conn),
    tiles,
    h('div', { class: 'next-row' }, next, nextHint),
    h('p', { class: 'upload-foot' }, 'PR의 자동 검사가 통과한 뒤 GitHub에서 머지하면 사이트에 게시됩니다. ',
      h('a', { href: 'https://github.com/CAN-dubu/hg-swd-fw-hub/tree/main/registry/firmware', target: '_blank', rel: 'noopener' }, '파일로 직접 등록하는 법'))));

  function tile(n, kind, label, { value, sub, state: st, disabled, onclick }) {
    return h('button', { type: 'button', class: `tile ${st || ''}`, disabled: disabled || null, onclick },
      h('span', { class: 'tile-n' }, n),
      icon(kind, 'tile-ico'),
      h('span', { class: 'tile-label' }, label),
      h('span', { class: 'tile-value' }, value),
      h('span', { class: 'tile-sub' }, sub || ''));
  }

  function refresh() {
    const p = planUpload();
    const chip = p.chip;
    const [fileCount, need] = chip ? fileProgress(chip) : [0, 1];
    const slotError = Object.values(p.pkg.slotChecks).flat().some(([c]) => c === 'err') || p.pkg.checks.some(([c]) => c === 'err');
    const partial = fileCount < need && !slotError;
    const fileState = !fileCount ? '' : partial ? 'partial' : p.errors.image ? 'bad' : 'done';
    const fileValue = !fileCount ? '파일 선택'
      : need > 1 ? `파일 ${fileCount} / ${need}` : (chip.kind === 'esp' ? up.merged : up.image).name;
    const fileSub = !fileCount ? (chip?.kind === 'esp' ? ESP_MODES[up.espMode].sub : chip ? 'BIN 파일 하나' : '')
      : partial ? `${need - fileCount}개 더 필요` : p.errors.image ? p.errors.image : `${fmtSize(p.pkg.images.reduce((n, i) => n + i.bytes.length, 0))} · 검사 통과`;

    tiles.replaceChildren(
      tile('1', 'chip', '칩', chip
        ? { value: chip.name, sub: chip.kind === 'esp' ? 'UART로 기록' : 'SWD로 기록', state: 'done', onclick: () => openChip() }
        : { value: '칩 선택', sub: 'STM32 · ESP32', onclick: () => openChip() }),
      icon('chevron', 'tile-arrow'),
      tile('2', 'folder', '프로젝트', !chip
        ? { value: '프로젝트 선택', sub: '칩을 먼저 고르세요', disabled: true }
        : p.proj ? { value: p.proj.name, sub: `${p.proj.id} · 현재 v${p.proj.latest}`, state: 'done', onclick: () => openProject() }
        : p.isNew ? { value: p.pname || '새 프로젝트', sub: p.errors.project ? '정보 입력 필요' : `새로 만들기 · ${p.pid}`, state: p.errors.project ? 'bad' : 'done', onclick: () => openProject() }
        : { value: '프로젝트 선택', sub: '기존 또는 새 프로젝트', onclick: () => openProject() }),
      icon('chevron', 'tile-arrow'),
      tile('3', 'file', '펌웨어 파일', !chip
        ? { value: '파일 선택', sub: '칩을 먼저 고르세요', disabled: true }
        : { value: fileValue, sub: fileSub, state: fileState, onclick: () => openFiles() }));

    const ready = selectionReady(p);
    next.disabled = !ready;
    nextHint.textContent = ready ? '' : p.errors.chip || p.errors.project || (fileCount ? p.errors.image : '펌웨어 파일을 고르세요');
    conn.replaceChildren(icon('key'), up.token.value ? 'GitHub 연결됨' : 'GitHub 연결');
    conn.classList.toggle('on', !!up.token.value);
    return p;
  }

  /* ① 칩 */
  function openChip() {
    const groups = [['stm32', 'STM32 · SWD', '내부 Flash에 SWD로 기록합니다. ST 로더를 사용합니다.'],
      ['esp', 'ESP32 · UART', '부트로더·파티션·앱을 UART로 기록합니다. 3분할 또는 통파일로 올립니다.']];
    const modal = openModal('칩 선택', {
      body: h('div', { class: 'opt-list' }, groups.map(([kind, title, desc]) => {
        const chips = m.chips.filter((c) => (c.kind || 'stm32') === kind);
        return chips.length ? [h('div', { class: 'opt-group' }, h('b', {}, title), h('span', {}, desc)),
          chips.map((c) => option(c.name, kind === 'esp' ? `${c.device} · 부트로더 ${c.slots[0].address}` : `${c.device} · Flash ${fmtSize(c.flash_size)}`,
            `k-${kind}`, up.chip === c.id, () => {
              if (up.chip !== c.id) { up.project = ''; clearFiles(); }
              up.chip = c.id;
              modal.close();
              refresh();
              setTimeout(openProject, reduceMotion() ? 0 : 200);
            }, 'chip'))] : null;
      })),
    });
  }

  /* ② 프로젝트 */
  function openProject() {
    const chip = chipOf(up.chip);
    const list = m.projects.filter((p) => p.chip === up.chip);
    let modal;
    const form = h('div', { class: 'new-form' });
    const choose = (id) => {
      up.project = id;
      up.version = suggestVersion(m.projects.find((p) => p.id === id));
      modal.close();
      refresh();
      if (!fileProgress(chip)[0]) setTimeout(openFiles, reduceMotion() ? 0 : 200);
    };

    function newForm() {
      const field = (label, key, attrs, hint) => {
        const err = h('span', { class: 'err' });
        const input = h('input', { ...attrs, autocomplete: 'off', spellcheck: 'false', oninput: (e) => { up[key] = e.target.value; check(); } });
        input.value = up[key];
        return { el: h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'hint' }, hint) : null, err), err, input, key };
      };
      const f = [field('프로젝트 ID', 'id', { placeholder: 'h723-gfx' }, 'SD카드 폴더 이름이 됩니다'),
        field('표시 이름', 'name', { placeholder: 'H723 GFX firmware' }, '프로그래머 화면에 나옵니다 (영문)'),
        field('설명 (선택)', 'desc', { placeholder: '한글로 자유롭게' })];
      const ok = h('button', { type: 'button', class: 'btn primary', onclick: () => {
        up.project = NEW_PROJECT;
        if (!check(true)) return;
        up.version = '1.0.0';
        modal.close();
        refresh();
        if (!fileProgress(chip)[0]) setTimeout(openFiles, reduceMotion() ? 0 : 200);
      } }, '이 프로젝트로 만들기');
      function check(force) {
        const saved = up.project;
        up.project = NEW_PROJECT;
        const p = planUpload();
        up.project = saved;
        for (const x of f) x.err.textContent = (force || up[x.key]) ? p.errors[x.key] || '' : '';
        ok.disabled = !!(p.errors.id || p.errors.name);
        return !ok.disabled;
      }
      form.replaceChildren(...f.map((x) => x.el), h('div', { class: 'form-actions' }, ok));
      form.classList.add('open');
      check();
      setTimeout(() => f[0].input.focus(), 50);
    }

    modal = openModal('프로젝트 선택', {
      body: h('div', {},
        h('p', { class: 'modal-lead' }, chipBadge(chip), ' 에 기록할 프로젝트를 고르세요.'),
        h('div', { class: 'opt-list' },
          list.length ? list.map((p) => option(p.name, `${p.id} · 현재 v${p.latest} · ${relDate(p.updated)}`, '', up.project === p.id, () => choose(p.id), 'folder'))
            : h('p', { class: 'muted empty-note' }, '이 칩으로 등록된 프로젝트가 아직 없습니다.'),
          option('새 프로젝트 만들기', '처음 등록하는 펌웨어', 'new', up.project === NEW_PROJECT, newForm, 'plus')),
        form),
    });
    if (up.project === NEW_PROJECT || !list.length) newForm();
  }

  /* ③ 파일 */
  function openFiles() {
    const chip = chipOf(up.chip);
    const esp = chip.kind === 'esp';
    const body = h('div', {});
    const done = h('button', { type: 'button', class: 'btn primary', onclick: () => modal.close() }, '완료');
    const modal = openModal(esp ? '펌웨어 파일 (ESP)' : '펌웨어 파일', { body, footer: done, wide: esp });

    let note = '';

    async function take(files) {
      for (const f of files) {
        const read = await readFile(f);
        if (!esp) { up.image = read; continue; }
        // 3분할 칸에 통파일을 놓으면 방식을 바꿔 준다
        if (up.espMode === 'merged' || looksMerged(read.bytes, chip)) {
          if (up.espMode !== 'merged') note = `${f.name}은(는) 통파일이라 통파일 방식으로 바꿨습니다.`;
          up.espMode = 'merged';
          up.merged = read;
          up.mergedSplit = await splitMerged(read, chip);
          break;
        }
        const slot = espSlotFor(f.name);
        if (slot) up.esp[slot] = read;
      }
      draw();
      refresh();
    }

    function draw() {
      const p = planUpload();
      const list = (items) => h('ul', { class: 'checks' }, items.map(checkItem));
      const picked = (file, onReplace) => h('div', { class: 'picked' }, icon('file', 'picked-ico'), h('div', {}, h('b', {}, file.name),
        h('span', { class: 'muted' }, ` ${fmtSize(file.bytes.length)}`)), h('button', { type: 'button', class: 'link-btn', onclick: onReplace }, '바꾸기'));
      if (!esp) {
        put(body,
          up.image
            ? picked(up.image, () => { up.image = null; draw(); refresh(); })
            : dropZone(take, { title: 'BIN 파일을 끌어다 놓거나 눌러서 선택', hint: `${chip.flash_base}부터 시작하는 전체 이미지 · 최대 ${fmtSize(chip.flash_size)}` }),
          p.pkg.checks.length ? list(p.pkg.checks) : null);
        done.textContent = p.errors.image ? '닫기' : '완료';
        return;
      }
      const merged = up.espMode === 'merged';
      const src = merged ? up.mergedSplit?.parts || {} : up.esp;
      const modes = h('div', { class: 'mode-pick', role: 'radiogroup', 'aria-label': '올리는 방식' }, Object.entries(ESP_MODES).map(([k, m]) => {
        const on = up.espMode === k;
        return h('button', { type: 'button', role: 'radio', 'aria-checked': String(on), class: `mode${on ? ' sel' : ''}`,
          onclick: () => { if (!on) { up.espMode = k; note = ''; draw(); refresh(); } } },
          h('span', { class: 'mode-head' }, h('span', { class: 'mode-radio' }), h('b', {}, m.title)),
          h('span', { class: 'mode-sub' }, m.sub),
          h('ul', { class: 'pc' }, m.pros.map((t) => h('li', { class: 'pro' }, h('span', {}, t))), m.cons.map((t) => h('li', { class: 'con' }, h('span', {}, hexify(t))))));
      }));
      const rows = h('div', { class: 'slot-list' + (merged ? ' derived' : '') }, chip.slots.map((s) => {
        const f = src[s.name];
        const checks = p.pkg.slotChecks[s.name] || [];
        const bad = checks.some(([c]) => c === 'err');
        return h('div', { class: `slot-row ${f ? (bad ? 'bad' : 'done') : ''}` },
          h('span', { class: 'slot-state' }, f ? icon(bad ? 'alert' : 'check') : icon('file')),
          h('div', { class: 'slot-main' },
            h('div', {}, h('b', {}, s.name), h('code', { class: 'slot-addr' }, s.address)),
            f ? h('span', { class: 'muted' }, merged ? `통파일에서 분리 · ${fmtSize(f.bytes.length)}` : `${f.name} · ${fmtSize(f.bytes.length)}`)
              : h('span', { class: 'muted' }, merged ? '통파일을 고르면 채워집니다' : '비어 있음'),
            checks.length ? list(checks) : null),
          merged ? null : h('label', { class: 'btn slot-pick' }, f ? '바꾸기' : '선택',
            h('input', { type: 'file', accept: '.bin', hidden: true, onchange: async (e) => {
              if (!e.target.files[0]) return;
              up.esp[s.name] = await readFile(e.target.files[0]);
              draw();
              refresh();
            } })));
      }));
      put(body,
        modes,
        note ? h('p', { class: 'mode-note' }, icon('alert'), note) : null,
        merged
          ? (up.merged ? picked(up.merged, () => { up.merged = null; up.mergedSplit = null; draw(); refresh(); })
            : dropZone(take, { title: '통파일을 끌어다 놓거나 눌러서 선택', hint: '0x0부터 합친 이미지 (idf.py merge-bin, Arduino의 merged.bin)' }))
          : Object.keys(up.esp).length < chip.slots.length
            ? dropZone(take, { multiple: true, title: '세 파일을 한 번에 끌어다 놓으세요', hint: '파일 이름을 보고 아래 칸에 자동으로 넣습니다' })
            : null,
        p.pkg.checks.length ? list(p.pkg.checks) : null,
        rows,
        h('p', { class: 'hint' }, 'ota-reset.bin은 올리지 않아도 됩니다. 파티션에 OTA 영역이 있으면 자동으로 만듭니다.'));
      done.textContent = p.errors.image ? '닫기' : '완료';
    }
    draw();
  }

  /* 다음 → 확인 */
  function openConfirm() {
    const p0 = planUpload();
    if (!selectionReady(p0)) return;
    if (!up.version || p0.errors.version) up.version = suggestVersion(p0.proj);
    if (p0.isNew && !up.notice) up.notice = noticeTemplate(p0);
    const body = h('div', {});
    const submitBtn = h('button', { type: 'button', class: 'btn primary', onclick: () => run() }, '등록 요청 만들기');
    const cancel = h('button', { type: 'button', class: 'btn', onclick: () => modal.close() }, '취소');
    const reason = h('span', { class: 'foot-reason' });
    const modal = openModal('등록 확인', { body, footer: [reason, cancel, submitBtn] });
    let tokenInput = null;

    const field = (label, control, key, hint) => h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control,
      hint ? h('span', { class: 'hint' }, hint) : null, h('span', { class: 'err', 'data-err': key }));
    const bindInput = (key, tag, attrs = {}, children = []) => {
      const c = h(tag, { ...attrs, [tag === 'select' ? 'onchange' : 'oninput']: (e) => { up[key] = e.target.value; check(); } }, children);
      c.value = up[key];
      return c;
    };
    const p = planUpload();
    const summary = h('dl', { class: 'summary' },
      h('div', {}, h('dt', {}, '칩'), h('dd', {}, chipBadge(p.chip))),
      h('div', {}, h('dt', {}, '프로젝트'), h('dd', {}, p.pname, h('code', {}, p.pid), p.isNew ? h('span', { class: 'tag ok' }, '새로 만들기') : null)),
      h('div', {}, h('dt', {}, '파일'), h('dd', {}, p.pkg.images.map((i) => h('span', { class: 'file-chip' }, i.name, i.generated ? ' (자동)' : '')),
        h('span', { class: 'muted' }, ` 총 ${fmtSize(p.pkg.images.reduce((n, i) => n + i.bytes.length, 0))}`),
        p.esp && up.espMode === 'merged' ? h('span', { class: 'muted' }, ` · 통파일 ${up.merged.name}에서 분리`) : null)));
    const preview = h('pre', { class: 'code' });
    const commitList = h('ul', { class: 'files' });

    body.append(summary,
      h('div', { class: 'fields' },
        field('버전', bindInput('version', 'input', { autocomplete: 'off', spellcheck: 'false' }), 'version',
          p.proj ? `지금 게시된 버전은 v${p.proj.latest}입니다` : '처음이면 1.0.0'),
        field('변경 내용 (선택)', bindInput('notes', 'textarea', { rows: '3', placeholder: '무엇이 바뀌었는지 한두 줄' }), 'notes'),
        p.isNew ? field('오픈소스 고지 (NOTICE.txt)', bindInput('notice', 'textarea', { rows: '10', class: 'mono', spellcheck: 'false' }), 'notice',
          '새 프로젝트에 한 번 적습니다. 펌웨어에 들어간 오픈소스의 저작권과 라이선스를 적고 TODO 줄을 채우세요. SD 패키지에 함께 들어갑니다.') : null),
      h('details', { class: 'more' }, h('summary', {}, '고급 설정'),
        h('div', { class: 'fields' },
          field('날짜', bindInput('date', 'input', { type: 'date' }), 'date'),
          p.esp ? field('UART 속도 상한', bindInput('baud', 'select', {}, ['auto', '921600', '460800', '230400', '115200']
            .map((b) => h('option', { value: b }, b === 'auto' ? 'auto (권장)' : `${b} bps`))), 'baud', '통신이 불안정하면 낮추세요') : null)),
      h('details', { class: 'more' }, h('summary', {}, '자세히 보기 (fw.txt · 커밋 파일)'), preview, commitList));
    if (!up.token.value) {
      tokenInput = h('input', { type: 'password', placeholder: 'github_pat_…', autocomplete: 'off', spellcheck: 'false',
        oninput: (e) => { up.token.value = e.target.value.trim(); saveToken(up.token.value, up.token.remember); check(); refresh(); } });
      body.append(h('div', { class: 'token-box' },
        h('b', {}, 'GitHub 연결이 한 번 필요합니다'),
        h('p', { class: 'hint' }, '이 저장소에 쓸 수 있는 토큰을 붙여 넣으세요. 이 브라우저에만 저장됩니다. ',
          h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener' }, '토큰 만들기'),
          ' (저장소: ', h('code', {}, `${REPO.owner}/${REPO.name}`), ', 권한: Contents·Pull requests 쓰기)'),
        tokenInput));
    }

    function check() {
      const q = planUpload();
      body.querySelectorAll('[data-err]').forEach((e) => { e.textContent = q.errors[e.dataset.err] || ''; });
      preview.textContent = q.pkg.fwTxt || '';
      commitList.replaceChildren(...q.files.map(([path, content]) => h('li', {}, h('code', {}, path),
        h('span', { class: 'muted' }, typeof content === 'string' ? `${content.length} B` : fmtSize(content.length)))));
      const why = Object.values(q.errors)[0] || (!up.token.value ? 'GitHub 토큰을 넣어 주세요' : '');
      submitBtn.disabled = !!why;
      reason.textContent = why;
      return q;
    }
    check();

    async function run() {
      const q = check();
      if (submitBtn.disabled) return;
      modal.locked = true;
      const bar = h('div', { class: 'bar-fill' });
      const stepText = h('p', { class: 'run-step' }, '준비 중…');
      modal.set(h('div', { class: 'run' }, h('div', { class: 'run-ring' }, icon('upload')), h('h3', {}, `${q.pname} v${q.ver}`),
        h('div', { class: 'bar' }, bar), stepText), null);
      const total = q.files.length + 4;
      let n = 0;
      const step = (text) => { n++; stepText.textContent = text; bar.style.width = `${Math.round((n / total) * 100)}%`; };
      try {
        const pr = await submitPlan(q, step);
        bar.style.width = '100%';
        modal.locked = false;
        modal.set(h('div', { class: 'run done' },
          h('div', { class: 'run-ring ok' }, icon('check')),
          h('h3', {}, '등록 요청을 만들었습니다'),
          h('p', { class: 'muted' }, `PR #${pr.number} · ${q.pid} v${q.ver}`),
          h('p', { class: 'hint' }, 'PR에서 자동 검사가 통과하면 Merge 하세요. 1~2분 뒤 사이트에 게시되고, 오른쪽 위 새로고침으로 확인할 수 있습니다.')),
        [h('button', { type: 'button', class: 'btn', onclick: () => { modal.close(); resetUpload(); renderUpload(); } }, '다른 펌웨어 등록'),
          h('a', { class: 'btn primary', href: pr.html_url, target: '_blank', rel: 'noopener' }, 'PR 열기')]);
      } catch (e) {
        modal.locked = false;
        modal.set(h('div', { class: 'run' },
          h('div', { class: 'run-ring bad' }, icon('alert')),
          h('h3', {}, '등록하지 못했습니다'),
          h('p', { class: 'run-error' }, e.message || String(e))),
        [h('button', { type: 'button', class: 'btn', onclick: () => modal.close() }, '닫기'),
          h('button', { type: 'button', class: 'btn primary', onclick: () => { modal.close(); setTimeout(openConfirm, 200); } }, '다시 시도')]);
      }
    }
  }

  /* GitHub 연결 설정 */
  function openSettings() {
    const status = h('p', { class: 'hint' });
    const input = h('input', { type: 'password', placeholder: 'github_pat_…', autocomplete: 'off', spellcheck: 'false', value: up.token.value,
      oninput: (e) => { up.token.value = e.target.value.trim(); saveToken(up.token.value, up.token.remember); status.textContent = ''; refresh(); } });
    const remember = h('input', { type: 'checkbox', checked: up.token.remember || null,
      onchange: (e) => { up.token.remember = e.target.checked; saveToken(up.token.value, up.token.remember); } });
    const test = h('button', { type: 'button', class: 'btn', onclick: async () => {
      status.className = 'hint';
      status.textContent = '확인 중…';
      try {
        const r = await gh(up.token.value, 'GET', repoPath);
        status.className = r.permissions?.push ? 'hint ok' : 'hint bad';
        status.textContent = r.permissions?.push ? `✔ ${r.full_name}에 쓸 수 있습니다` : `✖ ${r.full_name}에 쓰기 권한이 없습니다`;
      } catch (e) {
        status.className = 'hint bad';
        status.textContent = `✖ ${e.message}`;
      }
    } }, '연결 확인');
    openModal('GitHub 연결', {
      body: h('div', {},
        h('p', { class: 'modal-lead' }, '등록 요청(PR)을 만들 때 쓰는 토큰입니다. 이 브라우저에만 저장되고 GitHub 외에는 보내지 않습니다.'),
        h('div', { class: 'token-row' }, input, test),
        h('label', { class: 'check' }, remember, ' 이 브라우저에 계속 기억 (끄면 탭을 닫을 때 지움)'),
        status,
        h('ol', { class: 'steps-mini' },
          h('li', {}, h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener' }, 'Fine-grained token 만들기'), ' 열기'),
          h('li', {}, 'Repository access: ', h('b', {}, 'Only select repositories'), ' → ', h('code', {}, `${REPO.owner}/${REPO.name}`)),
          h('li', {}, 'Permissions: ', h('b', {}, 'Contents'), ', ', h('b', {}, 'Pull requests'), '를 Read and write로'),
          h('li', {}, '만든 토큰을 위 칸에 붙여 넣기'))),
      footer: h('button', { type: 'button', class: 'btn', onclick: () => { saveToken('', false); up.token = { value: '', remember: false }; input.value = ''; refresh(); } }, '연결 해제'),
    });
  }

  function option(title, sub, cls, selected, onclick, ico) {
    return h('button', { type: 'button', class: `opt ${cls}${selected ? ' sel' : ''}`, onclick },
      icon(ico, 'opt-ico'),
      h('span', { class: 'opt-text' }, h('b', {}, title), h('span', {}, sub)),
      selected ? icon('check', 'opt-end') : icon('chevron', 'opt-end'));
  }

  refresh();
}

/* 브랜치·커밋 하나·PR을 만든다. step(text)로 진행 상황을 알린다 */
async function submitPlan(p, step) {
  const t = up.token.value;
  const dir = `registry/firmware/${p.pid}`;
  const { images, embedded: emb, fwTxt } = p.pkg;

  step('저장소 확인');
  const ref = await gh(t, 'GET', `${repoPath}/git/ref/heads/${REPO.base}`, null, true);
  if (!ref) throw new Error(`${REPO.base} 브랜치가 없습니다. 저장소에 첫 커밋을 먼저 푸시하세요.`);
  const baseSha = ref.object.sha;
  const baseCommit = await gh(t, 'GET', `${repoPath}/git/commits/${baseSha}`);

  step('중복 확인');
  if (await existsOnBase(t, `${dir}/${p.ver}/release.toml`)) throw new Error(`${p.pid} ${p.ver}는 이미 등록되어 있습니다. 버전을 올려 주세요.`);
  if (p.isNew && await existsOnBase(t, `${dir}/project.toml`)) throw new Error(`프로젝트 ${p.pid}가 이미 있습니다. 새로고침 후 기존 프로젝트로 고르세요.`);

  const tree = [];
  for (const [path, content] of p.files) {
    step(`업로드 ${path.split('/').pop()}`);
    const blob = await gh(t, 'POST', `${repoPath}/git/blobs`, typeof content === 'string'
      ? { content, encoding: 'utf-8' } : { content: base64(content), encoding: 'base64' });
    tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await gh(t, 'POST', `${repoPath}/git/trees`, { base_tree: baseCommit.tree.sha, tree });

  step('커밋 만들기');
  const title = `Add ${p.pid} ${p.ver} (${p.chip.name})`;
  const embText = emb ? `${emb.version || '-'} / ${emb.name || '-'}${emb.idf ? ` / IDF ${emb.idf}` : ''}` : null;
  const facts = [
    ...images.map((i) => `${i.name} @ ${hex32(parseInt(i.address, 16))}: ${i.bytes.length} bytes, CRC32 ${hex32(i.crc)}` +
      (i.generated ? ' (generated)' : `, from ${i.source}`)),
    embText ? `Embedded: ${embText}` : null,
  ].filter(Boolean);
  const commit = await gh(t, 'POST', `${repoPath}/git/commits`, {
    message: `${title}\n\n${facts.join('\n')}\nRegistered from the HG-SWD FW Hub web form.`,
    tree: newTree.sha, parents: [baseSha],
  });
  let branch = `fw/${p.pid}-${p.ver}`;
  if (await gh(t, 'GET', `${repoPath}/git/ref/heads/${encPath(branch)}`, null, true)) branch += `-${Date.now().toString(36)}`;
  await gh(t, 'POST', `${repoPath}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });

  step('PR 만들기');
  const body = [
    `| 항목 | 값 |`, `| --- | --- |`,
    `| 프로젝트 | ${p.pname} (\`${p.pid}\`)${p.isNew ? ' — 새 프로젝트' : ''} |`,
    `| 칩 | ${p.chip.name} |`,
    `| 버전 | ${p.ver} (${up.date}) |`,
    p.esp ? `| UART 속도 상한 | ${up.baud} |` : null,
    p.esp ? `| 올린 형식 | ${up.espMode === 'merged' ? `통파일 \`merged.bin\` (${up.merged.name})` : '3분할'} |` : null,
    embText ? `| 내장 정보 | ${embText} |` : null,
    '', '| 파일 | 주소 | 크기 | CRC32 | SHA-256 |', '| --- | --- | ---: | --- | --- |',
    ...images.map((i) => `| ${i.name}${i.generated ? ' (CI 생성)' : ''} | \`${hex32(parseInt(i.address, 16))}\` | ${i.bytes.length.toLocaleString()} | \`${hex32(i.crc)}\` | ${i.sha ? `\`${i.sha.slice(0, 16)}…\`` : '-'} |`),
    '', '### fw.txt', '```ini', fwTxt.trimEnd(), '```',
    up.notes.trim() ? `\n### 변경 내용\n${up.notes.trim()}` : null,
    '', 'CI(Build and deploy)가 통과하면 머지하세요. 머지 후 1~2분 안에 사이트에 게시됩니다.',
  ].filter((x) => x !== null).join('\n');
  return gh(t, 'POST', `${repoPath}/pulls`, { title, head: branch, base: REPO.base, body });
}

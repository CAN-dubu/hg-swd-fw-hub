"""Validate the HG-SWD firmware registry and build the static site.

registry/  ->  _site/manifest.json, fw/<id>/latest.txt, fw/<id>/<ver>/{images, fw.txt, *-sd.zip}

Rules mirror HG-SWD-PROG firmware/H5_SWD_PRG:
  STM32 fw.txt: src/ap/modules/prog/prog.c, prog_inspect.c, tools/prepare_h723_sd.py
  ESP fw.txt:   src/ap/modules/prog/esp_project.c, tools/prepare_esp_sd.py
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import re
import shutil
import struct
import sys
import tomllib
import zipfile
import zlib
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCHEMA = 1
ID_RE = re.compile(r'[A-Za-z0-9_-]{1,24}')        # prog.c ID_SIZE 25
FILE_RE = re.compile(r'[A-Za-z0-9._-]{1,47}')     # prog_manifest_t.image[48]
VERSION_RE = re.compile(r'(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?')
NAME_MAX = 47                                      # prog_manifest_t.name[48], esp_project_t.name[48]
FW_TXT_MAX = 1024                                  # prog.c progLoadManifest
VER_OFFSET, VER_MAGIC = 0x400, 0x56455220          # STM32 'VER ' image header
ESP_BAUDS = ('auto', '115200', '230400', '460800', '921600')
ESP_SECTOR = 0x1000
ESP_APP_DESC_MAGIC = 0xABCD5432
CHIP_FIELDS = {
    'stm32': ('name', 'device', 'loader', 'flash_base', 'flash_size', 'sector_size', 'ram'),
    'esp': ('name', 'device', 'chip_id', 'boot_address'),
}


class RegistryError(Exception):
    pass


def crc32(data: bytes) -> int:
    return zlib.crc32(data) & 0xFFFFFFFF


def hex32(v: int) -> str:
    return f'0x{v:08X}'


def load_toml(path: Path, required: tuple[str, ...]) -> dict:
    try:
        with path.open('rb') as f:
            data = tomllib.load(f)
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise RegistryError(f'{path}: {e}') from None
    missing = [k for k in required if k not in data]
    if missing:
        raise RegistryError(f'{path}: missing {", ".join(missing)}')
    return data


def check_name(name, where: str) -> None:
    # The firmware trims spaces and accepts printable ASCII only.
    if (not isinstance(name, str) or not 1 <= len(name) <= NAME_MAX or name != name.strip()
            or any(not 32 <= ord(c) <= 126 for c in name)):
        raise RegistryError(f'{where}: name must be 1..{NAME_MAX} printable ASCII chars without edge spaces')


def version_key(v: str):
    major, minor, patch, pre = VERSION_RE.fullmatch(v).groups()
    return int(major), int(minor), int(patch), pre is None, pre or ''


def cstr(b: bytes) -> str:
    return b.split(b'\0', 1)[0].decode('ascii', 'replace').strip()


def esp_slots(chip: dict) -> list[tuple[str, int]]:
    """Fixed upload slots; ota-reset.bin is generated from the partition table."""
    return [('bootloader.bin', chip['boot_address']), ('partitions.bin', 0x8000), ('firmware.bin', 0x10000)]


def load_chips(reg: Path) -> dict:
    chips = {}
    for p in sorted((reg / 'chips').glob('*.toml')):
        kind = load_toml(p, ()).get('kind', 'stm32')
        if kind not in CHIP_FIELDS:
            raise RegistryError(f'{p}: kind must be one of {", ".join(CHIP_FIELDS)}')
        c = load_toml(p, CHIP_FIELDS[kind])
        c['id'], c['kind'] = p.stem, kind
        chips[p.stem] = c
    return chips


def load_loaders(reg: Path) -> dict:
    loaders = {}
    for p in sorted((reg / 'loaders').glob('*.toml')):
        ld = load_toml(p, ('name', 'sd_path', 'size', 'crc32', 'sha256', 'source', 'hosted'))
        ld['id'] = p.stem
        ld['file'] = Path(ld['sd_path']).name
        ld['data'] = None
        if ld['hosted']:
            path = p.parent / ld['file']
            data = path.read_bytes() if path.is_file() else b''
            if (len(data), crc32(data), hashlib.sha256(data).hexdigest()) != (ld['size'], ld['crc32'], ld['sha256']):
                raise RegistryError(f'{path}: missing or does not match {p.name}')
            ld['data'] = data
        loaders[p.stem] = ld
    return loaders


# ---------- STM32 ----------

def inspect_stm32_image(data: bytes, chip: dict) -> dict | None:
    """Same checks as progInspectImage; returns the embedded VER header, if any."""
    base = chip['flash_base']
    if not 8 <= len(data) <= chip['flash_size']:
        raise RegistryError(f'image size {len(data)} outside 8..{chip["flash_size"]} bytes')
    sp, reset = struct.unpack_from('<II', data)
    if sp & 7 or not any(lo < sp <= hi for lo, hi in chip['ram']):
        raise RegistryError(f'initial SP {hex32(sp)} is not in {chip["name"]} RAM')
    if not reset & 1 or not base <= (reset & ~1) < base + len(data):
        raise RegistryError(f'reset vector {hex32(reset)} outside image or not Thumb')
    if len(data) < VER_OFFSET + 72 or struct.unpack_from('<I', data, VER_OFFSET)[0] != VER_MAGIC:
        return None
    if struct.unpack_from('<I', data, VER_OFFSET + 68)[0] != base:
        raise RegistryError('embedded VER address differs from flash base')
    return {'version': cstr(data[VER_OFFSET + 4:VER_OFFSET + 36]),
            'name': cstr(data[VER_OFFSET + 36:VER_OFFSET + 68])}


def make_stm32_fw_txt(name: str, chip: dict, loader: dict, image_name: str, image: bytes) -> bytes:
    data = (f'name={name}\n'
            f'device={chip["device"]}\n'
            f'algo={loader["sd_path"]}\n'
            f'image={image_name} @ {hex32(chip["flash_base"])}\n'
            f'crc32={hex32(crc32(image))}\n'
            f'loader_crc32={hex32(loader["crc32"])}\n').encode('ascii')
    if len(data) > FW_TXT_MAX:
        raise RegistryError(f'fw.txt would be {len(data)} bytes, limit {FW_TXT_MAX}')
    return data


def build_stm32(proj: dict, chip: dict, loader: dict, vdir: Path, rel: dict) -> dict:
    image_name = rel.get('image', 'app.bin')
    if not FILE_RE.fullmatch(image_name) or '..' in image_name:
        raise RegistryError(f'{vdir}: image must be a plain file name up to 47 chars')
    path = vdir / image_name
    if not path.is_file():
        raise RegistryError(f'{path}: not found')
    image = path.read_bytes()
    try:
        embedded = inspect_stm32_image(image, chip)
    except RegistryError as e:
        raise RegistryError(f'{path}: {e}') from None
    if embedded and embedded['version'] and embedded['version'] not in (vdir.name, 'v' + vdir.name):
        print(f'warning: {path}: embedded version "{embedded["version"]}" differs from folder {vdir.name}')
    return {
        'images': [(image_name, chip['flash_base'], image)],
        'fw_txt': make_stm32_fw_txt(proj['name'], chip, loader, image_name, image),
        'erase': {'unit': chip['sector_size'], 'count': math.ceil(len(image) / chip['sector_size'])},
        'embedded': embedded,
        'extra': {},
    }


# ---------- ESP ----------

def inspect_esp_image(data: bytes, chip_id: int) -> int:
    """prepare_esp_sd.inspect_image: header, chip ID, checksum, appended SHA-256. Returns Flash size."""
    if len(data) < 24 or data[0] != 0xE9 or not 1 <= data[1] <= 16:
        raise RegistryError('invalid ESP image header')
    if struct.unpack_from('<H', data, 12)[0] != chip_id:
        raise RegistryError('image chip ID differs from the selected chip')
    offset, checksum = 24, 0xEF
    for _ in range(data[1]):
        if offset + 8 > len(data):
            raise RegistryError('truncated segment header')
        size = struct.unpack_from('<I', data, offset + 4)[0]
        offset += 8
        if size > len(data) - offset:
            raise RegistryError('truncated segment data')
        for byte in data[offset:offset + size]:
            checksum ^= byte
        offset += size
    end = (offset + 16) & ~15
    if end > len(data) or data[end - 1] != checksum:
        raise RegistryError('image checksum mismatch')
    if data[23] and (len(data) < end + 32 or hashlib.sha256(data[:end]).digest() != data[end:end + 32]):
        raise RegistryError('appended SHA-256 mismatch')
    size_code = data[3] >> 4
    if size_code > 4:
        raise RegistryError('Flash size setting must be 1..16 MiB')
    return 0x100000 << size_code


def inspect_esp_partitions(data: bytes, flash_size: int, app_size: int) -> tuple | None:
    """prepare_esp_sd.inspect_partitions. Returns the OTA data partition, if any."""
    entries = []
    for offset in range(0, len(data), 32):
        record = data[offset:offset + 32]
        if len(record) != 32:
            raise RegistryError('truncated partition entry')
        magic = struct.unpack_from('<H', record)[0]
        if magic == 0xFFFF:
            break
        if magic == 0xEBEB:
            if record[16:] != hashlib.md5(data[:offset]).digest():
                raise RegistryError('partition table MD5 mismatch')
            break
        if magic != 0x50AA:
            raise RegistryError('invalid partition entry')
        _, kind, subtype, address, size, _label, _flags = struct.unpack('<HBBII16sI', record)
        if not size or address & 4095 or size & 4095 or address + size > flash_size:
            raise RegistryError('invalid partition range')
        if any(address < old[2] + old[3] and old[2] < address + size for old in entries):
            raise RegistryError('overlapping partitions')
        entries.append((kind, subtype, address, size))
    apps = [e for e in entries if e[0] == 0 and e[2] == 0x10000]
    if len(apps) != 1 or app_size > apps[0][3] or apps[0][1] not in (0, 0x10):
        raise RegistryError('expected a factory/ota_0 app partition at 0x10000 that fits firmware.bin')
    ota = [e for e in entries if e[:2] == (1, 0)]
    if len(ota) > 1 or (ota and ota[0][3] != 0x2000):
        raise RegistryError('unexpected OTA data partition')
    if apps[0][1] == 0x10 and not ota:
        raise RegistryError('OTA app requires an OTA data partition')
    return ota[0] if ota else None


def esp_app_desc(app: bytes) -> dict | None:
    # esp_app_desc_t sits at the start of the first segment's data.
    if len(app) < 176 or struct.unpack_from('<I', app, 32)[0] != ESP_APP_DESC_MAGIC:
        return None
    return {'version': cstr(app[48:80]), 'name': cstr(app[80:112]), 'idf': cstr(app[144:176])}


def build_esp(proj: dict, chip: dict, vdir: Path, rel: dict) -> dict:
    baud = str(rel.get('baud', 'auto'))
    if baud not in ESP_BAUDS:
        raise RegistryError(f'{vdir}/release.toml: baud must be one of {", ".join(ESP_BAUDS)}')
    data = {}
    for name, _ in esp_slots(chip):
        path = vdir / name
        if not path.is_file():
            raise RegistryError(f'{path}: not found (ESP releases need bootloader.bin, partitions.bin, firmware.bin)')
        data[name] = path.read_bytes()
    boot, parts, app = data['bootloader.bin'], data['partitions.bin'], data['firmware.bin']
    try:
        flash_size = inspect_esp_image(boot, chip['chip_id'])
    except RegistryError as e:
        raise RegistryError(f'{vdir}/bootloader.bin: {e}') from None
    try:
        if inspect_esp_image(app, chip['chip_id']) != flash_size:
            raise RegistryError('Flash size setting differs from bootloader.bin')
    except RegistryError as e:
        raise RegistryError(f'{vdir}/firmware.bin: {e}') from None
    if chip['boot_address'] + len(boot) > 0x8000:
        raise RegistryError(f'{vdir}/bootloader.bin: runs past 0x8000')
    if len(parts) > 4096:
        raise RegistryError(f'{vdir}/partitions.bin: larger than 4 KiB')
    try:
        ota = inspect_esp_partitions(parts, flash_size, len(app))
    except RegistryError as e:
        raise RegistryError(f'{vdir}/partitions.bin: {e}') from None

    images = [(name, address, data[name]) for name, address in esp_slots(chip)]
    if ota:
        images.append(('ota-reset.bin', ota[2], b'\xff' * ota[3]))
    images.sort(key=lambda i: i[1])
    previous_end = 0
    for name, address, image in images:
        if address < previous_end:
            raise RegistryError(f'{vdir}: {name} overlaps the previous image erase range')
        previous_end = address + ((len(image) + ESP_SECTOR - 1) & ~(ESP_SECTOR - 1))
    lines = [f'name={proj["name"]}', f'device={chip["device"]}', f'baud={baud}', f'flash_size={hex32(flash_size)}']
    lines += [f'image={name},{hex32(address)},{hex32(len(image))},{hex32(crc32(image))}' for name, address, image in images]
    fw_txt = ('\n'.join(lines) + '\n').encode('ascii')
    if len(fw_txt) > FW_TXT_MAX:
        raise RegistryError(f'{vdir}: fw.txt would be {len(fw_txt)} bytes, limit {FW_TXT_MAX}')
    return {
        'images': images,
        'fw_txt': fw_txt,
        'erase': {'unit': ESP_SECTOR, 'count': sum(math.ceil(len(i[2]) / ESP_SECTOR) for i in images)},
        'embedded': esp_app_desc(app),
        'extra': {'flash_size': flash_size, 'baud': baud, 'ota_reset': ota is not None},
    }


# ---------- packaging ----------

def make_sd_readme(pid: str, ver: str, name: str, chip: dict, loader: dict | None, images: list) -> bytes:
    lines = [
        'HG-SWD-PROG SD 패키지',
        '',
        f'프로젝트 : {name} ({pid})',
        f'버전     : {ver}',
        f'대상 칩  : {chip["name"]}',
    ]
    for image_name, address, image in images:
        lines += [f'{image_name:<15}: {hex32(address)}, {len(image)} bytes, CRC32 {hex32(crc32(image))}',
                  f'{"":<15}  SHA-256 {hashlib.sha256(image).hexdigest()}']
    lines += ['', '1. 이 zip의 prog 폴더를 FAT32 SD카드 루트에 풉니다.']
    if loader is None:
        lines.append('2. ESP는 로더 파일이 필요 없습니다. RAM stub이 프로그래머 펌웨어에 들어 있습니다.')
    elif loader['data'] is None:
        lines += [
            '2. 카드에 로더가 없으면 직접 복사합니다. (라이선스상 이 패키지에 포함하지 않음)',
            f'   원본   : {loader["source"]}',
            f'   위치   : {loader["sd_path"]}',
            f'   SHA-256: {loader["sha256"]}',
        ]
    else:
        lines.append('2. 로더가 패키지에 포함되어 있습니다.')
    lines += [f'3. 프로그래머 메뉴 > Flash 에서 {pid} 를 선택하거나, Auto setup 에서 {chip["name"]} 프로젝트로 지정합니다.',
              f'   SD 파일만 점검하려면 CLI에서 prog check {pid}', '']
    return '\r\n'.join(lines).encode('utf-8')


def make_zip(files: dict[str, bytes], when: date) -> bytes:
    # Fixed timestamps keep the archive identical across rebuilds.
    stamp = (max(when.year, 1980), when.month, when.day, 0, 0, 0)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        for name, data in files.items():
            info = zipfile.ZipInfo(name, stamp)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, data)
    return buf.getvalue()


def build_version(pid: str, proj: dict, chip: dict, loader: dict | None, vdir: Path, out_files: dict) -> dict:
    ver = vdir.name
    rel = load_toml(vdir / 'release.toml', ('date',))
    when = rel['date']
    if not isinstance(when, date) or isinstance(when, datetime):
        raise RegistryError(f'{vdir}/release.toml: date must be a TOML date like 2026-10-12')
    built = build_esp(proj, chip, vdir, rel) if chip['kind'] == 'esp' else build_stm32(proj, chip, loader, vdir, rel)
    images, fw_txt = built['images'], built['fw_txt']

    sd = {f'prog/fw/{pid}/{name}': image for name, _, image in images}
    sd[f'prog/fw/{pid}/fw.txt'] = fw_txt  # last, like prepare_*_sd.py: no manifest without its images
    sd['prog/README.txt'] = make_sd_readme(pid, ver, proj['name'], chip, loader, images)
    if loader is not None and loader['data'] is not None:
        sd[loader['sd_path'].lstrip('/')] = loader['data']
    sd_zip = make_zip(sd, when)

    base = f'fw/{pid}/{ver}'
    zip_name = f'{pid}-{ver}-sd.zip'
    for name, _, image in images:
        out_files[f'{base}/{name}'] = image
    out_files[f'{base}/fw.txt'] = fw_txt
    out_files[f'{base}/{zip_name}'] = sd_zip
    return {
        'version': ver,
        'date': when.isoformat(),
        'prerelease': VERSION_RE.fullmatch(ver).group(4) is not None,
        'notes': str(rel.get('notes', '')).strip(),
        'size': sum(len(image) for _, _, image in images),
        'erase': built['erase'],
        'images': [{'name': name, 'url': f'{base}/{name}', 'address': hex32(address), 'size': len(image),
                    'crc32': hex32(crc32(image)), 'sha256': hashlib.sha256(image).hexdigest()}
                   for name, address, image in images],
        'embedded': built['embedded'],
        **{k: (hex32(v) if k == 'flash_size' else v) for k, v in built['extra'].items()},
        'fw_txt': {'url': f'{base}/fw.txt', 'size': len(fw_txt), 'crc32': hex32(crc32(fw_txt)),
                   'sha256': hashlib.sha256(fw_txt).hexdigest()},
        'sd_zip': {'url': f'{base}/{zip_name}', 'size': len(sd_zip),
                   'sha256': hashlib.sha256(sd_zip).hexdigest()},
    }


def make_latest_txt(pid: str, chip_id: str, v: dict) -> bytes:
    """Device-facing summary in fw.txt's key=value style.

    Download base + each file into staging, check size/CRC32/SHA-256, then publish.
    fw.txt is listed last: write it last so an interrupted copy is never a selectable project.
    """
    files = [*v['images'], {'name': 'fw.txt', **v['fw_txt']}]
    return (f'schema={SCHEMA}\n'
            f'id={pid}\n'
            f'chip={chip_id}\n'
            f'version={v["version"]}\n'
            f'date={v["date"]}\n'
            f'base=fw/{pid}/{v["version"]}/\n'
            + ''.join(f'file={f["name"]},{f["size"]},{f["crc32"]},{f["sha256"]}\n' for f in files)).encode('ascii')


def chip_entry(c: dict) -> dict:
    entry = {'id': c['id'], 'kind': c['kind'], 'name': c['name'], 'family': c.get('family', ''), 'device': c['device']}
    if c['kind'] == 'esp':
        entry.update({'chip_id': c['chip_id'], 'sector_size': ESP_SECTOR, 'max_flash_size': 0x1000000,
                      'slots': [{'name': n, 'address': hex32(a)} for n, a in esp_slots(c)],
                      'bauds': list(ESP_BAUDS)})
    else:
        entry.update({'loader': c['loader'], 'flash_base': hex32(c['flash_base']), 'flash_size': c['flash_size'],
                      'sector_size': c['sector_size'], 'ram': [[hex32(lo), hex32(hi)] for lo, hi in c['ram']]})
    return entry


def build(reg: Path, generated: str) -> tuple[dict, dict[str, bytes], list[str]]:
    errors: list[str] = []
    out_files: dict[str, bytes] = {}
    try:
        chips = load_chips(reg)
        loaders = load_loaders(reg)
    except (RegistryError, OSError) as e:
        return {}, {}, [str(e)]
    for c in chips.values():
        if c['kind'] == 'stm32' and c['loader'] not in loaders:
            errors.append(f'chip {c["id"]}: unknown loader {c["loader"]}')

    projects = []
    fw_root = reg / 'firmware'
    for pdir in sorted(d for d in fw_root.iterdir() if d.is_dir()) if fw_root.is_dir() else []:
        pid = pdir.name
        try:
            if not ID_RE.fullmatch(pid):
                raise RegistryError(f'{pdir}: project ID must be 1..24 of A-Z a-z 0-9 _ -')
            proj = load_toml(pdir / 'project.toml', ('name', 'chip'))
            check_name(proj['name'], f'{pdir}/project.toml')
            chip = chips.get(proj['chip'])
            if chip is None or (chip['kind'] == 'stm32' and chip['loader'] not in loaders):
                raise RegistryError(f'{pdir}/project.toml: unknown chip {proj["chip"]}')
            loader = loaders[chip['loader']] if chip['kind'] == 'stm32' else None
        except RegistryError as e:
            errors.append(str(e))
            continue

        versions = []
        for vdir in sorted(d for d in pdir.iterdir() if d.is_dir()):
            if not VERSION_RE.fullmatch(vdir.name):
                errors.append(f'{vdir}: version folder must be x.y.z or x.y.z-tag')
                continue
            try:
                versions.append(build_version(pid, proj, chip, loader, vdir, out_files))
            except (RegistryError, OSError) as e:
                errors.append(str(e))
        if not versions:
            errors.append(f'{pdir}: no valid versions')
            continue
        versions.sort(key=lambda v: version_key(v['version']), reverse=True)
        latest = next((v for v in versions if not v['prerelease']), versions[0])
        out_files[f'fw/{pid}/latest.txt'] = make_latest_txt(pid, chip['id'], latest)
        projects.append({
            'id': pid,
            'name': proj['name'],
            'chip': chip['id'],
            'description': str(proj.get('description', '')).strip(),
            'latest': latest['version'],
            'latest_url': f'fw/{pid}/latest.txt',
            'updated': max(v['date'] for v in versions),
            'versions': versions,
        })

    hosted = {ld['id']: f'loaders/{ld["file"]}' for ld in loaders.values() if ld['data'] is not None}
    for ld in loaders.values():
        if ld['data'] is not None:
            out_files[hosted[ld['id']]] = ld['data']
    manifest = {
        'schema': SCHEMA,
        'generated': generated,
        'chips': [chip_entry(c) for c in chips.values()],
        'loaders': [{'id': ld['id'], 'name': ld['name'], 'sd_path': ld['sd_path'], 'size': ld['size'],
                     'crc32': hex32(ld['crc32']), 'sha256': ld['sha256'], 'source': ld['source'],
                     'url': hosted.get(ld['id'])} for ld in loaders.values()],
        'projects': sorted(projects, key=lambda p: p['id']),
    }
    return manifest, out_files, errors


def write_site(out: Path, web: Path, manifest: dict, files: dict[str, bytes]) -> None:
    if out.exists():
        if any(out.iterdir()) and not (out / 'manifest.json').is_file():
            raise RegistryError(f'{out}: not empty and not a previous build; refusing to delete')
        shutil.rmtree(out)
    shutil.copytree(web, out)
    (out / '.nojekyll').write_bytes(b'')
    (out / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    for rel, data in files.items():
        dest = out / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--registry', type=Path, default=ROOT / 'registry')
    p.add_argument('--web', type=Path, default=ROOT / 'web')
    p.add_argument('--out', type=Path, default=ROOT / '_site')
    p.add_argument('--generated', help='ISO timestamp for manifest.json (default: now, UTC)')
    p.add_argument('--check', action='store_true', help='validate only; write nothing')
    a = p.parse_args(argv)

    generated = a.generated or datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    manifest, files, errors = build(a.registry, generated)
    for e in errors:
        print(f'error: {e}', file=sys.stderr)
    if errors:
        return 1
    n_ver = sum(len(pr['versions']) for pr in manifest['projects'])
    print(f'registry OK: {len(manifest["chips"])} chip(s), {len(manifest["projects"])} project(s), {n_ver} version(s)')
    if not a.check:
        try:
            write_site(a.out, a.web, manifest, files)
        except RegistryError as e:
            print(f'error: {e}', file=sys.stderr)
            return 1
        print(f'site written to {a.out}')
    return 0


if __name__ == '__main__':
    sys.exit(main())

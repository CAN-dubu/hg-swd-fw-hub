"""Validate the HG-SWD firmware registry and build the static site.

registry/  ->  _site/manifest.json, fw/<id>/latest.txt, fw/<id>/<ver>/{image, fw.txt, *-sd.zip}

fw.txt rules mirror HG-SWD-PROG firmware/H5_SWD_PRG/src/ap/modules/prog (prog.c, prog_inspect.c).
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
NAME_MAX = 47                                      # prog_manifest_t.name[48]
FW_TXT_MAX = 1024                                  # prog.c progLoadManifest
VER_OFFSET, VER_MAGIC = 0x400, 0x56455220          # 'VER ' image header


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


def load_chips(reg: Path) -> dict:
    chips = {}
    for p in sorted((reg / 'chips').glob('*.toml')):
        c = load_toml(p, ('name', 'device', 'loader', 'flash_base', 'flash_size', 'sector_size', 'ram'))
        c['id'] = p.stem
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


def inspect_image(data: bytes, chip: dict) -> dict | None:
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


def make_fw_txt(name: str, chip: dict, loader: dict, image_name: str, image: bytes) -> bytes:
    data = (f'name={name}\n'
            f'device={chip["device"]}\n'
            f'algo={loader["sd_path"]}\n'
            f'image={image_name} @ {hex32(chip["flash_base"])}\n'
            f'crc32={hex32(crc32(image))}\n'
            f'loader_crc32={hex32(loader["crc32"])}\n').encode('ascii')
    if len(data) > FW_TXT_MAX:
        raise RegistryError(f'fw.txt would be {len(data)} bytes, limit {FW_TXT_MAX}')
    return data


def make_sd_readme(pid: str, ver: str, name: str, chip: dict, loader: dict, image_name: str, image: bytes) -> bytes:
    lines = [
        'HG-SWD-PROG SD 패키지',
        '',
        f'프로젝트 : {name} ({pid})',
        f'버전     : {ver}',
        f'대상 칩  : {chip["name"]}',
        f'BIN      : {image_name}, {len(image)} bytes, CRC32 {hex32(crc32(image))}',
        f'SHA-256  : {hashlib.sha256(image).hexdigest()}',
        '',
        '1. 이 zip의 prog 폴더를 FAT32 SD카드 루트에 풉니다.',
    ]
    if loader['data'] is None:
        lines += [
            '2. 카드에 로더가 없으면 직접 복사합니다. (라이선스상 이 패키지에 포함하지 않음)',
            f'   원본   : {loader["source"]}',
            f'   위치   : {loader["sd_path"]}',
            f'   SHA-256: {loader["sha256"]}',
        ]
    else:
        lines.append('2. 로더가 패키지에 포함되어 있습니다.')
    lines += [f'3. 프로그래머 홈 > Flash 에서 {pid} 를 선택합니다.',
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


def build_version(pid: str, proj: dict, chip: dict, loader: dict, vdir: Path, out_files: dict) -> dict:
    ver = vdir.name
    rel = load_toml(vdir / 'release.toml', ('date',))
    when = rel['date']
    if not isinstance(when, date) or isinstance(when, datetime):
        raise RegistryError(f'{vdir}/release.toml: date must be a TOML date like 2026-10-12')
    image_name = rel.get('image', 'app.bin')
    if not FILE_RE.fullmatch(image_name) or '..' in image_name:
        raise RegistryError(f'{vdir}: image must be a plain file name up to 47 chars')
    path = vdir / image_name
    if not path.is_file():
        raise RegistryError(f'{path}: not found')
    image = path.read_bytes()
    try:
        embedded = inspect_image(image, chip)
    except RegistryError as e:
        raise RegistryError(f'{path}: {e}') from None
    if embedded and embedded['version'] and embedded['version'] not in (ver, 'v' + ver):
        print(f'warning: {path}: embedded version "{embedded["version"]}" differs from folder {ver}')

    fw_txt = make_fw_txt(proj['name'], chip, loader, image_name, image)
    sd = {f'prog/fw/{pid}/fw.txt': fw_txt, f'prog/fw/{pid}/{image_name}': image,
          'prog/README.txt': make_sd_readme(pid, ver, proj['name'], chip, loader, image_name, image)}
    if loader['data'] is not None:
        sd[loader['sd_path'].lstrip('/')] = loader['data']
    sd_zip = make_zip(sd, when)

    base = f'fw/{pid}/{ver}'
    zip_name = f'{pid}-{ver}-sd.zip'
    out_files[f'{base}/{image_name}'] = image
    out_files[f'{base}/fw.txt'] = fw_txt
    out_files[f'{base}/{zip_name}'] = sd_zip
    return {
        'version': ver,
        'date': when.isoformat(),
        'prerelease': VERSION_RE.fullmatch(ver).group(4) is not None,
        'notes': str(rel.get('notes', '')).strip(),
        'image': {
            'name': image_name,
            'url': f'{base}/{image_name}',
            'size': len(image),
            'crc32': hex32(crc32(image)),
            'sha256': hashlib.sha256(image).hexdigest(),
            'sectors': math.ceil(len(image) / chip['sector_size']),
            'embedded': embedded,
        },
        'fw_txt': {'url': f'{base}/fw.txt', 'crc32': hex32(crc32(fw_txt))},
        'sd_zip': {'url': f'{base}/{zip_name}', 'size': len(sd_zip),
                   'sha256': hashlib.sha256(sd_zip).hexdigest()},
    }


def make_latest_txt(pid: str, chip_id: str, v: dict) -> bytes:
    # Device-facing summary in the same key=value form as fw.txt; URLs are site-relative.
    img = v['image']
    return (f'schema={SCHEMA}\n'
            f'id={pid}\n'
            f'chip={chip_id}\n'
            f'version={v["version"]}\n'
            f'date={v["date"]}\n'
            f'image={img["url"]}\n'
            f'size={img["size"]}\n'
            f'crc32={img["crc32"]}\n'
            f'sha256={img["sha256"]}\n'
            f'fw_txt={v["fw_txt"]["url"]}\n').encode('ascii')


def build(reg: Path, generated: str) -> tuple[dict, dict[str, bytes], list[str]]:
    errors: list[str] = []
    out_files: dict[str, bytes] = {}
    try:
        chips = load_chips(reg)
        loaders = load_loaders(reg)
    except (RegistryError, OSError) as e:
        return {}, {}, [str(e)]
    for c in chips.values():
        if c['loader'] not in loaders:
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
            if chip is None or chip['loader'] not in loaders:
                raise RegistryError(f'{pdir}/project.toml: unknown chip {proj["chip"]}')
            loader = loaders[chip['loader']]
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
        'chips': [{'id': c['id'], 'name': c['name'], 'family': c.get('family', ''), 'device': c['device'],
                   'loader': c['loader'], 'flash_base': hex32(c['flash_base']), 'flash_size': c['flash_size'],
                   'sector_size': c['sector_size'], 'ram': [[hex32(lo), hex32(hi)] for lo, hi in c['ram']]}
                  for c in chips.values()],
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

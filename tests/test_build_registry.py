import hashlib
import io
import json
import shutil
import struct
import sys
import tempfile
import unittest
import zipfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tools'))
import build_registry as br  # noqa: E402


def image(size=0x1000, sp=0x24050000, reset=0x08000201, version=None):
    data = bytearray(size)
    struct.pack_into('<II', data, 0, sp, reset)
    if version is not None:
        struct.pack_into('<I32s32sI', data, 0x400, 0x56455220, version.encode(), b'demo', 0x08000000)
    return bytes(data)


class RegistryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.reg = self.tmp / 'registry'
        shutil.copytree(ROOT / 'registry' / 'chips', self.reg / 'chips')
        shutil.copytree(ROOT / 'registry' / 'loaders', self.reg / 'loaders')

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def add(self, pid='h723-gfx', ver='1.0.0', data=None, name='H723 GFX firmware', date='2026-10-12'):
        p = self.reg / 'firmware' / pid
        (p / ver).mkdir(parents=True, exist_ok=True)
        (p / 'project.toml').write_text(f'name = "{name}"\nchip = "stm32h723"\ndescription = "데모"\n', 'utf-8')
        (p / ver / 'release.toml').write_text(f'date = {date}\nnotes = "first"\n', 'utf-8')
        (p / ver / 'app.bin').write_bytes(image() if data is None else data)

    def build(self):
        return br.build(self.reg, '2026-10-12T00:00:00+00:00')

    def test_fw_txt_matches_programmer_format(self):
        data = image(0x30000)
        self.add(data=data)
        manifest, files, errors = self.build()
        self.assertEqual(errors, [])
        self.assertEqual(files['fw/h723-gfx/1.0.0/fw.txt'].decode('ascii'),
                         'name=H723 GFX firmware\n'
                         'device=STM32H72x/STM32H73x\n'
                         'algo=/prog/loaders/st/0x483.stldr\n'
                         'image=app.bin @ 0x08000000\n'
                         f'crc32=0x{zlib.crc32(data):08X}\n'
                         'loader_crc32=0x32674EA9\n')
        self.assertEqual(manifest['projects'][0]['versions'][0]['erase'], {'unit': 0x20000, 'count': 2})

    def test_sd_zip_layout(self):
        self.add()
        _, files, _ = self.build()
        z = zipfile.ZipFile(io.BytesIO(files['fw/h723-gfx/1.0.0/h723-gfx-1.0.0-sd.zip']))
        self.assertEqual(sorted(z.namelist()),
                         ['prog/README.txt', 'prog/fw/h723-gfx/app.bin', 'prog/fw/h723-gfx/fw.txt'])
        self.assertIn('0x483.stldr', z.read('prog/README.txt').decode('utf-8'))

    def test_latest_skips_prerelease(self):
        self.add(ver='1.0.0')
        self.add(ver='1.1.0')
        self.add(ver='2.0.0-rc.1')
        manifest, files, errors = self.build()
        self.assertEqual(errors, [])
        project = manifest['projects'][0]
        self.assertEqual([v['version'] for v in project['versions']], ['2.0.0-rc.1', '1.1.0', '1.0.0'])
        self.assertEqual(project['latest'], '1.1.0')
        latest = files['fw/h723-gfx/latest.txt'].decode('ascii')
        self.assertIn('version=1.1.0\ndate=2026-10-12\nbase=fw/h723-gfx/1.1.0/\nfile=app.bin,4096,', latest)
        self.assertTrue(latest.splitlines()[-1].startswith('file=fw.txt,'))

    def test_embedded_version_is_reported(self):
        self.add(data=image(version='1.0.0'))
        manifest, _, errors = self.build()
        self.assertEqual(errors, [])
        self.assertEqual(manifest['projects'][0]['versions'][0]['embedded'],
                         {'version': '1.0.0', 'name': 'demo'})

    def test_rejects_bad_images_and_names(self):
        cases = {
            'bad-sp': image(sp=0x10000000),
            'bad-reset': image(reset=0x08000200),
            'too-big': image(size=0x100004),
        }
        for pid, data in cases.items():
            self.add(pid=pid, data=data)
        self.add(pid='bad name')
        self.add(pid='korean', name='한글 이름')
        manifest, _, errors = self.build()
        self.assertEqual(manifest['projects'], [])
        text = '\n'.join(errors)
        for needle in ('initial SP', 'reset vector', 'image size', 'project ID', 'printable ASCII'):
            self.assertIn(needle, text)

    def test_rejects_datetime_and_bad_version(self):
        self.add(date='2026-10-12T10:00:00')
        self.add(pid='other', ver='v1')
        _, _, errors = self.build()
        self.assertTrue(any('TOML date' in e for e in errors))
        self.assertTrue(any('x.y.z' in e for e in errors))

    def test_write_site(self):
        self.add()
        out = self.tmp / 'site'
        code = br.main(['--registry', str(self.reg), '--out', str(out), '--generated', 'x'])
        self.assertEqual(code, 0)
        manifest = json.loads((out / 'manifest.json').read_text('utf-8'))
        self.assertEqual(manifest['loaders'][0]['url'], None)
        # The web upload form repeats the SP check from these ranges.
        h723 = next(c for c in manifest['chips'] if c['id'] == 'stm32h723')
        self.assertIn(['0x24000000', '0x24050000'], h723['ram'])
        for rel in ('index.html', 'fw/h723-gfx/latest.txt', 'fw/h723-gfx/1.0.0/app.bin'):
            self.assertTrue((out / rel).is_file(), rel)
        # A second build replaces the previous one; a foreign directory is never deleted.
        self.assertEqual(br.main(['--registry', str(self.reg), '--out', str(out)]), 0)
        foreign = self.tmp / 'foreign'
        foreign.mkdir()
        (foreign / 'keep.txt').write_text('x')
        self.assertEqual(br.main(['--registry', str(self.reg), '--out', str(foreign)]), 1)
        self.assertTrue((foreign / 'keep.txt').is_file())


def esp_image(chip_id=9, size_code=4, payload=b'\x11' * 100, sha=True):
    header = bytearray(24)
    header[0], header[1], header[3] = 0xE9, 1, size_code << 4
    struct.pack_into('<H', header, 12, chip_id)
    header[23] = int(sha)
    body = bytes(header) + struct.pack('<II', 0x3FC88000, len(payload)) + payload
    checksum = 0xEF
    for b in payload:
        checksum ^= b
    end = (len(body) + 16) & ~15
    body += b'\0' * (end - len(body) - 1) + bytes([checksum])
    return body + hashlib.sha256(body).digest() if sha else body


def partition_table(ota=True, app_size=0x100000):
    def row(kind, sub, addr, size, label):
        return struct.pack('<HBBII16sI', 0x50AA, kind, sub, addr, size, label, 0)
    rows = [row(1, 2, 0x9000, 0x5000, b'nvs')]
    if ota:
        rows += [row(1, 0, 0xE000, 0x2000, b'otadata'), row(0, 0x10, 0x10000, app_size, b'app0')]
    else:
        rows += [row(0, 0, 0x10000, app_size, b'factory')]
    data = b''.join(rows)
    data += struct.pack('<H', 0xEBEB) + b'\xff' * 14 + hashlib.md5(data).digest()
    return data + b'\xff' * (0xC00 - len(data))


class EspRegistryTest(unittest.TestCase):
    setUp = RegistryTest.setUp
    tearDown = RegistryTest.tearDown
    build = RegistryTest.build

    def add_esp(self, pid='rly4', chip='esp32s3', boot=None, parts=None, app=None, release=''):
        p = self.reg / 'firmware' / pid
        (p / '1.0.0').mkdir(parents=True, exist_ok=True)
        (p / 'project.toml').write_text(f'name = "HG-ESP32-S3-RLY4-PRO"\nchip = "{chip}"\n', 'utf-8')
        (p / '1.0.0' / 'release.toml').write_text(f'date = 2026-10-07\n{release}', 'utf-8')
        for name, data in (('bootloader.bin', boot or esp_image()), ('partitions.bin', parts or partition_table()),
                           ('firmware.bin', app or esp_image(payload=b'\x22' * 3000))):
            if data != b'skip':
                (p / '1.0.0' / name).write_bytes(data)

    def test_package_matches_prepare_esp_sd(self):
        boot, parts, app = esp_image(), partition_table(), esp_image(payload=b'\x22' * 3000)
        self.add_esp(boot=boot, parts=parts, app=app)
        manifest, files, errors = self.build()
        self.assertEqual(errors, [])
        ota = b'\xff' * 0x2000
        crc = lambda d: f'0x{zlib.crc32(d):08X}'
        self.assertEqual(files['fw/rly4/1.0.0/fw.txt'].decode('ascii'),
                         'name=HG-ESP32-S3-RLY4-PRO\ndevice=ESP32-S3\nbaud=auto\nflash_size=0x01000000\n'
                         f'image=bootloader.bin,0x00000000,0x{len(boot):08X},{crc(boot)}\n'
                         f'image=partitions.bin,0x00008000,0x00000C00,{crc(parts)}\n'
                         f'image=ota-reset.bin,0x0000E000,0x00002000,{crc(ota)}\n'
                         f'image=firmware.bin,0x00010000,0x{len(app):08X},{crc(app)}\n')
        z = zipfile.ZipFile(io.BytesIO(files['fw/rly4/1.0.0/rly4-1.0.0-sd.zip']))
        self.assertEqual(z.namelist()[-2:], ['prog/fw/rly4/fw.txt', 'prog/README.txt'])
        self.assertEqual(z.read('prog/fw/rly4/ota-reset.bin'), ota)
        latest = files['fw/rly4/latest.txt'].decode('ascii').splitlines()
        self.assertEqual([line.split(',')[0] for line in latest if line.startswith('file=')],
                         ['file=bootloader.bin', 'file=partitions.bin', 'file=ota-reset.bin', 'file=firmware.bin',
                          'file=fw.txt'])
        v = manifest['projects'][0]['versions'][0]
        self.assertEqual((v['baud'], v['flash_size'], v['erase']['unit']), ('auto', '0x01000000', 4096))

    def test_esp32_boot_address_and_factory_app(self):
        self.add_esp(chip='esp32', boot=esp_image(chip_id=0), app=esp_image(chip_id=0),
                     parts=partition_table(ota=False), release='baud = "460800"\n')
        _, files, errors = self.build()
        self.assertEqual(errors, [])
        text = files['fw/rly4/1.0.0/fw.txt'].decode('ascii')
        self.assertIn('baud=460800\n', text)
        self.assertIn('image=bootloader.bin,0x00001000,', text)
        self.assertNotIn('ota-reset', text)

    def test_rejections(self):
        bad_checksum = bytearray(esp_image(sha=False))
        bad_checksum[40] ^= 1
        bad_md5 = bytearray(partition_table())
        bad_md5[20] ^= 1  # label byte: only the MD5 entry catches it
        cases = {
            'chip': dict(boot=esp_image(chip_id=5)),
            'sum': dict(app=bytes(bad_checksum)),
            'size': dict(app=esp_image(size_code=3)),
            'md5': dict(parts=bytes(bad_md5)),
            'fit': dict(parts=partition_table(app_size=0x1000), app=esp_image(payload=b'\x22' * 5000)),
            'missing': dict(app=b'skip'),
            'baud': dict(release='baud = "9600"\n'),
        }
        for pid, kw in cases.items():
            self.add_esp(pid=pid, **kw)
        manifest, _, errors = self.build()
        self.assertEqual(manifest['projects'], [])
        text = '\n'.join(errors)
        for needle in ('chip ID', 'checksum mismatch', 'differs from bootloader', 'MD5 mismatch', 'fits firmware.bin',
                       'firmware.bin: not found', 'baud must be'):
            self.assertIn(needle, text)


if __name__ == '__main__':
    unittest.main()

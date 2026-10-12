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
        self.assertEqual(manifest['projects'][0]['versions'][0]['image']['sectors'], 2)

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
        self.assertIn(b'version=1.1.0\n', files['fw/h723-gfx/latest.txt'])

    def test_embedded_version_is_reported(self):
        self.add(data=image(version='1.0.0'))
        manifest, _, errors = self.build()
        self.assertEqual(errors, [])
        self.assertEqual(manifest['projects'][0]['versions'][0]['image']['embedded'],
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
        self.assertIn(['0x24000000', '0x24050000'], manifest['chips'][0]['ram'])
        for rel in ('index.html', 'fw/h723-gfx/latest.txt', 'fw/h723-gfx/1.0.0/app.bin'):
            self.assertTrue((out / rel).is_file(), rel)
        # A second build replaces the previous one; a foreign directory is never deleted.
        self.assertEqual(br.main(['--registry', str(self.reg), '--out', str(out)]), 0)
        foreign = self.tmp / 'foreign'
        foreign.mkdir()
        (foreign / 'keep.txt').write_text('x')
        self.assertEqual(br.main(['--registry', str(self.reg), '--out', str(foreign)]), 1)
        self.assertTrue((foreign / 'keep.txt').is_file())


if __name__ == '__main__':
    unittest.main()

import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

from archive import archive_fixture, restore_fixture, verify_archive


class ArchiveTests(unittest.TestCase):
    def fixture(self, root):
        source = root / 'old'
        source.mkdir(mode=0o700)
        (source / 'journal').mkdir(mode=0o700)
        (source / 'journal/receipt').write_bytes(b'completed\x00receipt')
        (source / 'config.json').write_text('{"token":"synthetic-private-value"}')
        (source / 'config.json').chmod(0o600)
        return source

    def test_round_trip_is_private_and_preserves_bytes_and_modes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = self.fixture(root)
            archive = root / 'old.tar'
            sha = archive_fixture(source, archive, {'writers_stopped': True, 'release': 'fixture'})
            self.assertEqual(archive.stat().st_mode & 0o777, 0o600)
            manifest = verify_archive(archive, sha)
            self.assertNotIn('synthetic-private-value', json.dumps(manifest))
            restored = root / 'restore'
            restore_fixture(archive, restored, sha)
            self.assertEqual((restored / 'journal/receipt').read_bytes(), b'completed\x00receipt')
            self.assertEqual((restored / 'config.json').stat().st_mode & 0o777, 0o600)
            with self.assertRaises(ValueError):
                restore_fixture(archive, restored, sha)
            self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(), sha)

    def test_refuses_unstopped_writers_or_links(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = self.fixture(root)
            with self.assertRaises(ValueError):
                archive_fixture(source, root / 'live.tar', {'writers_stopped': False})
            (source / 'escape').symlink_to(root.parent)
            with self.assertRaises(ValueError):
                archive_fixture(source, root / 'link.tar', {'writers_stopped': True})

    def test_corrupt_bytes_never_create_restore(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            sha = archive_fixture(self.fixture(root), root / 'old.tar', {'writers_stopped': True})
            data = bytearray((root / 'old.tar').read_bytes())
            data[600] ^= 1
            (root / 'old.tar').write_bytes(data)
            with self.assertRaises(ValueError):
                restore_fixture(root / 'old.tar', root / 'restore', sha)
            self.assertFalse((root / 'restore').exists())

    def test_inner_checksum_is_checked_even_with_a_matching_outer_checksum(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = self.fixture(root)
            archive_fixture(source, root / 'old.tar', {'writers_stopped': True})
            bad = root / 'bad.tar'
            with tarfile.open(root / 'old.tar') as original, tarfile.open(bad, 'w') as changed:
                for member in original:
                    data = original.extractfile(member).read() if member.isfile() else None
                    if member.name == 'journal/receipt':
                        data = b'x' * len(data)
                    changed.addfile(member, io.BytesIO(data) if data is not None else None)
            with self.assertRaisesRegex(ValueError, 'file checksum differs'):
                restore_fixture(bad, root / 'restore', hashlib.sha256(bad.read_bytes()).hexdigest())
            self.assertFalse((root / 'restore').exists())

    def test_traversal_and_unlisted_members_are_rejected(self):
        for name in ('../outside', '/absolute', 'unlisted'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                archive = root / 'bad.tar'
                with tarfile.open(archive, 'w') as target:
                    for path, value in [('manifest.json', b'{"format":"supertag-synthetic-cutover-v1","deployment":{},"entries":{}}'), (name, b'bad')]:
                        info = tarfile.TarInfo(path)
                        info.size = len(value)
                        target.addfile(info, io.BytesIO(value))
                with self.assertRaises(ValueError):
                    restore_fixture(archive, root / 'restore', hashlib.sha256(archive.read_bytes()).hexdigest())
                self.assertFalse((root / 'restore').exists())


if __name__ == '__main__':
    unittest.main()

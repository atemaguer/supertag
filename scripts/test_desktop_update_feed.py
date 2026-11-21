"""latest-mac.yml as the desktop app's updater reads it."""
import base64
import hashlib
from pathlib import Path
import tempfile
import unittest

from desktop_update_feed import FeedError, feed, main

DATE = '2026-11-20T12:00:00.000Z'


class DesktopUpdateFeed(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def zip(self, name, body=b'zip', blockmap=True):
        path = self.root / name
        path.write_bytes(body)
        if blockmap:
            Path(f'{path}.blockmap').write_bytes(b'map')
        return path

    def test_lists_the_zip_with_its_size_and_sha512(self):
        path = self.zip('SuperTag-0.3.6-darwin-arm64.zip', b'apple silicon')
        digest = base64.b64encode(hashlib.sha512(b'apple silicon').digest()).decode()
        self.assertEqual(feed('0.3.6', [path], DATE), '\n'.join([
            'version: 0.3.6',
            'files:',
            '  - url: SuperTag-0.3.6-darwin-arm64.zip',
            f'    sha512: {digest}',
            '    size: 13',
            'path: SuperTag-0.3.6-darwin-arm64.zip',
            f'sha512: {digest}',
            f"releaseDate: '{DATE}'",
        ]) + '\n')

    def test_lists_each_architecture_apple_silicon_first(self):
        intel = self.zip('SuperTag-0.3.6-darwin-amd64.zip', b'intel')
        arm = self.zip('SuperTag-0.3.6-darwin-arm64.zip', b'arm')
        text = feed('0.3.6', [intel, arm], DATE)
        urls = [line.split(': ')[1] for line in text.splitlines() if line.startswith('  - url:')]
        # electron-updater picks by "arm64" in the name; Intel's zip must not hold it.
        self.assertEqual(urls, ['SuperTag-0.3.6-darwin-arm64.zip', 'SuperTag-0.3.6-darwin-amd64.zip'])
        self.assertIn('path: SuperTag-0.3.6-darwin-arm64.zip', text)

    def test_refuses_what_the_updater_could_not_use(self):
        cases = {
            'another version': [self.zip('SuperTag-0.3.5-darwin-arm64.zip')],
            'unknown architecture': [self.zip('SuperTag-0.3.6-darwin-universal.zip')],
            'no blockmap': [self.zip('SuperTag-0.3.6-darwin-arm64.zip', blockmap=False)],
            'missing zip': [self.root / 'SuperTag-0.3.6-darwin-amd64.zip'],
            'nothing': [],
        }
        for case, zips in cases.items():
            with self.subTest(case), self.assertRaises(FeedError):
                feed('0.3.6', zips, DATE)
        arm = self.zip('SuperTag-0.3.6-darwin-arm64.zip')
        with self.assertRaisesRegex(FeedError, 'more than one'):
            feed('0.3.6', [arm, arm], DATE)
        with self.assertRaisesRegex(FeedError, 'release version'):
            feed('latest', [arm], DATE)

    def test_writes_the_feed_and_fails_without_one(self):
        self.zip('SuperTag-0.3.6-darwin-arm64.zip')
        output = self.root / 'latest-mac.yml'
        self.assertEqual(main(['--version', '0.3.6', '--output', str(output), '--release-date', DATE,
                               str(self.root / 'SuperTag-0.3.6-darwin-arm64.zip')]), 0)
        self.assertTrue(output.read_text().startswith('version: 0.3.6\n'))
        self.assertEqual(main(['--version', '0.3.7', '--output', str(self.root / 'other.yml'),
                               str(self.root / 'SuperTag-0.3.6-darwin-arm64.zip')]), 1)
        self.assertFalse((self.root / 'other.yml').exists())


if __name__ == '__main__':
    unittest.main()

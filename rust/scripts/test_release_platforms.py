"""Platform and complete verification provenance without running builds or providers."""
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from native_archive import ArchiveError
import native_release as release
import native_release_docker as docker_release
import native_release_macos_x64 as mac_tools


class ReleasePlatformContracts(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / 'package.json').write_text('{"packageManager":"pnpm@11.18.0"}')
        (self.root / 'rust').mkdir()
        (self.root / 'rust/rust-toolchain.toml').write_text('[toolchain]\nchannel="1.93.1"\n')

    def tools(self, node_arch='x64', rust_host='x86_64-apple-darwin'):
        def output(command, **kwargs):
            if command[0] == 'rustc':
                return f'rustc 1.93.1 (fixture)\nhost: {rust_host}\nrelease: 1.93.1\n'
            if command[0] == 'cargo':
                return 'cargo 1.93.1 (fixture)\n'
            if command[0] == 'node':
                return json.dumps({'version': 'v22.13.0', 'platform': 'darwin', 'arch': node_arch})
            if command[0] == 'pnpm':
                return '11.18.0\n'
            if command[0] == 'go':
                return json.dumps({'GOVERSION': 'go1.26.1', 'GOHOSTOS': 'darwin', 'GOHOSTARCH': 'arm64'})
            self.fail(f'unexpected tool probe: {command}')
        return output

    def test_emulated_mac_host_requires_matching_node_and_rust_but_records_cross_go(self):
        with patch.object(release.subprocess, 'check_output', side_effect=self.tools()):
            result = release.tool_versions(self.root, {'PATH': '/fixture'}, 'darwin-amd64')
        self.assertEqual(result['rust']['host'], 'x86_64-apple-darwin')
        self.assertEqual(result['node']['arch'], 'x64')
        self.assertEqual(result['go']['GOHOSTARCH'], 'arm64')
        for output in (self.tools(node_arch='arm64'), self.tools(rust_host='aarch64-apple-darwin')):
            with self.subTest(), patch.object(release.subprocess, 'check_output', side_effect=output):
                with self.assertRaisesRegex(ArchiveError, 'platform'):
                    release.tool_versions(self.root, {'PATH': '/fixture'}, 'darwin-amd64')

    def test_wrong_expected_platform_fails_before_source_or_output_is_touched(self):
        with patch.object(release, 'native_platform', return_value='linux-arm64'), \
             patch.object(release, 'snapshot') as snapshot:
            with self.assertRaisesRegex(ArchiveError, 'expected platform'):
                release.assemble(self.root, 'a'*40, self.root/'out', expected_platform='linux-amd64')
        snapshot.assert_not_called()
        self.assertFalse((self.root/'out').exists())


    def test_docker_source_mismatch_cannot_create_output_or_start_a_builder(self):
        with patch.object(docker_release.subprocess, 'check_output', return_value='b'*40+'\n'), \
             patch.object(docker_release.subprocess, 'run') as run:
            with self.assertRaisesRegex(ArchiveError, 'HEAD differs'):
                docker_release.package(self.root, 'a'*40, self.root/'out', 'linux-amd64')
        run.assert_not_called()
        self.assertFalse((self.root/'out').exists())

    def test_tool_download_is_bounded_and_checked_before_extraction(self):
        contents=b'fixture archive bytes'
        with patch.object(mac_tools.urllib.request, 'urlopen', return_value=io.BytesIO(contents)):
            mac_tools.download('https://fixture.invalid/tool', self.root/'verified', hashlib.sha256(contents).hexdigest())
        self.assertEqual((self.root/'verified').read_bytes(),contents)
        with patch.object(mac_tools.urllib.request, 'urlopen', return_value=io.BytesIO(contents)):
            with self.assertRaisesRegex(ArchiveError,'checksum differs'):
                mac_tools.download('https://fixture.invalid/tool', self.root/'corrupt', '0'*64)
        with patch.object(mac_tools.urllib.request, 'urlopen', return_value=io.BytesIO(contents)), \
             patch.object(mac_tools, 'MAX_DOWNLOAD', 3):
            with self.assertRaisesRegex(ArchiveError,'exceeds its bound'):
                mac_tools.download('https://fixture.invalid/tool', self.root/'large', '0'*64)


if __name__ == '__main__':
    unittest.main()

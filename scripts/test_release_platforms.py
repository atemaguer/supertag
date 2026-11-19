"""Platform and complete verification provenance without running builds or providers."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import native_archive
from native_archive import ArchiveError
import native_release as release
import native_release_docker as docker_release


class ReleasePlatformContracts(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / 'package.json').write_text('{"packageManager":"pnpm@11.18.0"}')
        (self.root / 'core').mkdir()
        (self.root / 'core/rust-toolchain.toml').write_text('[toolchain]\nchannel="1.93.1"\n')
        (self.root / '.bun-version').write_text('1.4.5\n')

    def tools(self, node_arch='arm64', rust_host='aarch64-apple-darwin', bun_arch='arm64'):
        def output(command, **kwargs):
            if command[0] == 'rustc':
                return f'rustc 1.93.1 (fixture)\nhost: {rust_host}\nrelease: 1.93.1\n'
            if command[0] == 'cargo':
                return 'cargo 1.93.1 (fixture)\n'
            if command[0] == 'node':
                return json.dumps({'version': 'v22.13.0', 'platform': 'darwin', 'arch': node_arch})
            if command[0] == 'pnpm':
                return '11.18.0\n'
            if command[:2] == ['bun', '--version']:
                return '1.4.5\n'
            if command[0] == 'bun':
                return json.dumps({'platform': 'darwin', 'arch': bun_arch})
            self.fail(f'unexpected tool probe: {command}')
        return output

    def test_mac_build_requires_arm64_node_and_rust(self):
        with patch.object(release.subprocess, 'check_output', side_effect=self.tools()):
            result = release.tool_versions(self.root, {'PATH': '/fixture'}, 'darwin-arm64')
        self.assertEqual(result['rust']['host'], 'aarch64-apple-darwin')
        self.assertEqual(result['node']['arch'], 'arm64')
        self.assertEqual(result['bun'], '1.4.5')
        # Rosetta tools on Apple silicon report x64; they must not build the arm64 archive.
        for output in (self.tools(node_arch='x64'), self.tools(rust_host='x86_64-apple-darwin'),
                       self.tools(bun_arch='x64')):
            with self.subTest(), patch.object(release.subprocess, 'check_output', side_effect=output):
                with self.assertRaisesRegex(ArchiveError, 'platform'):
                    release.tool_versions(self.root, {'PATH': '/fixture'}, 'darwin-arm64')

    def test_intel_mac_is_not_a_release_platform(self):
        self.assertNotIn('darwin-amd64', native_archive.PLATFORMS)
        with patch.object(native_archive.host_platform, 'system', return_value='Darwin'), \
             patch.object(native_archive.host_platform, 'machine', return_value='x86_64'):
            with self.assertRaisesRegex(ArchiveError, 'macOS on arm64'):
                native_archive.native_platform()

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

    def test_builder_image_builds_locally_or_through_the_actions_cache(self):
        context = self.root / 'context'
        self.assertEqual(docker_release.build_command('linux/amd64', 'builder:x', context),
                         ['docker', 'build', '--platform', 'linux/amd64', '--tag', 'builder:x', str(context)])
        read = docker_release.build_command('linux/arm64', 'builder:x', context, 'release-builder-linux-arm64')
        self.assertEqual(read[:3], ['docker', 'buildx', 'build'])
        self.assertIn('--load', read)
        self.assertIn('type=gha,scope=release-builder-linux-arm64', read)
        self.assertNotIn('--cache-to', read)
        saved = docker_release.build_command('linux/arm64', 'builder:x', context, 'release-builder-linux-arm64', True)
        self.assertEqual(saved[saved.index('--cache-to') + 1], 'type=gha,scope=release-builder-linux-arm64,mode=max')
        self.assertEqual(saved[-1], str(context))
        with self.assertRaisesRegex(ArchiveError, 'needs a cache scope'):
            docker_release.build_command('linux/amd64', 'builder:x', context, None, True)
        with self.assertRaisesRegex(ArchiveError, 'invalid builder cache scope'):
            docker_release.build_command('linux/amd64', 'builder:x', context, 'scope,mode=max')

    def test_every_builder_uses_the_pinned_bun(self):
        pin = (native_archive.REPO / '.bun-version').read_text().strip()
        dockerfile = (native_archive.REPO / 'deploy/docker/rust-release.Dockerfile').read_text()
        self.assertIn(f'/bun-v{pin}/', dockerfile)
        self.assertEqual(dockerfile.count('bun_sha='), 2, 'both Linux builders verify their download')
        for workflow in ('ci.yml', 'core.yml', 'native-release-check.yml'):
            text = (native_archive.REPO / '.github/workflows' / workflow).read_text()
            self.assertIn('bun-version-file: .bun-version', text, workflow)

    def test_the_terminal_ui_gets_only_allow_jit(self):
        import plistlib
        entitlements = plistlib.loads((native_archive.REPO / 'scripts/supertag-tui.entitlements').read_bytes())
        self.assertEqual(entitlements, {'com.apple.security.cs.allow-jit': True})


if __name__ == '__main__':
    unittest.main()

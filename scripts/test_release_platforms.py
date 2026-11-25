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

    def test_intel_mac_build_requires_x64_node_rust_and_bun(self):
        intel = dict(node_arch='x64', rust_host='x86_64-apple-darwin', bun_arch='x64')
        with patch.object(release.subprocess, 'check_output', side_effect=self.tools(**intel)):
            result = release.tool_versions(self.root, {'PATH': '/fixture'}, 'darwin-amd64')
        self.assertEqual(result['rust']['host'], 'x86_64-apple-darwin')
        self.assertEqual(result['node']['arch'], 'x64')
        # Any Apple silicon tool would build or embed arm64 code in the Intel archive.
        for key, value in (('node_arch', 'arm64'), ('rust_host', 'aarch64-apple-darwin'), ('bun_arch', 'arm64')):
            with self.subTest(key), patch.object(release.subprocess, 'check_output',
                                                 side_effect=self.tools(**{**intel, key: value})):
                with self.assertRaisesRegex(ArchiveError, 'platform'):
                    release.tool_versions(self.root, {'PATH': '/fixture'}, 'darwin-amd64')

    def test_intel_mac_is_a_release_platform(self):
        self.assertEqual(native_archive.PLATFORMS, {'linux-arm64', 'linux-amd64', 'darwin-arm64', 'darwin-amd64'})
        self.assertEqual(native_archive.OPENTUI_PACKAGES['darwin-amd64'], ('core-darwin-x64', 'libopentui.dylib'))
        with patch.object(native_archive.host_platform, 'system', return_value='Darwin'), \
             patch.object(native_archive.host_platform, 'machine', return_value='x86_64'), \
             patch.object(native_archive, 'apple_silicon', return_value=False):
            self.assertEqual(native_archive.native_platform(), 'darwin-amd64')
        with patch.object(native_archive.host_platform, 'system', return_value='Windows'), \
             patch.object(native_archive.host_platform, 'machine', return_value='AMD64'):
            with self.assertRaisesRegex(ArchiveError, 'Linux and macOS'):
                native_archive.native_platform()

    def test_an_intel_python_under_rosetta_reports_the_macs_own_platform(self):
        # uv may run an x86_64 Python on Apple silicon, where it reports x86_64.
        with patch.object(native_archive.host_platform, 'system', return_value='Darwin'), \
             patch.object(native_archive.host_platform, 'machine', return_value='x86_64'), \
             patch.object(native_archive, 'apple_silicon', return_value=True):
            self.assertEqual(native_archive.native_platform(), 'darwin-arm64')
        # Linux is never asked: hw.optional.arm64 is a macOS sysctl.
        with patch.object(native_archive.host_platform, 'system', return_value='Linux'), \
             patch.object(native_archive.host_platform, 'machine', return_value='x86_64'), \
             patch.object(native_archive, 'apple_silicon', side_effect=AssertionError):
            self.assertEqual(native_archive.native_platform(), 'linux-amd64')

    def test_apple_silicon_reads_the_machines_arm64_sysctl(self):
        def answer(code, stdout=''):
            return native_archive.subprocess.CompletedProcess([], code, stdout, '')
        cases = ((answer(0, '1\n'), True), (answer(0, '0\n'), False),
                 # An Intel Mac has no hw.optional.arm64, so sysctl fails.
                 (answer(1), False), (OSError('no sysctl'), False))
        for result, expected in cases:
            with self.subTest(result=result), patch.object(native_archive.subprocess, 'run',
                                                           side_effect=[result]) as run:
                self.assertIs(native_archive.apple_silicon(), expected)
                self.assertEqual(run.call_args.args[0], ['/usr/sbin/sysctl', '-n', 'hw.optional.arm64'])

    def test_an_intel_release_builder_is_still_an_intel_platform(self):
        # The darwin-amd64 archive is built on an Intel runner, and --expect-platform still holds.
        with patch.object(native_archive.host_platform, 'system', return_value='Darwin'), \
             patch.object(native_archive.host_platform, 'machine', return_value='x86_64'), \
             patch.object(native_archive.subprocess, 'run',
                          return_value=native_archive.subprocess.CompletedProcess([], 1, '', '')):
            self.assertEqual(release.native_platform(), 'darwin-amd64')

    def test_mach_o_architecture_matches_the_mac_platform(self):
        arm64 = b'\xcf\xfa\xed\xfe' + (0x100000C).to_bytes(4, 'little') + bytes(24)
        x86_64 = b'\xcf\xfa\xed\xfe' + (0x1000007).to_bytes(4, 'little') + bytes(24)
        native_archive.check_architecture(arm64, 'darwin-arm64')
        native_archive.check_architecture(x86_64, 'darwin-amd64')
        for header, platform in ((arm64, 'darwin-amd64'), (x86_64, 'darwin-arm64')):
            with self.subTest(platform), self.assertRaisesRegex(ArchiveError, 'architecture'):
                native_archive.check_architecture(header, platform)

    def test_every_platform_is_built_released_and_checked(self):
        import yaml
        workflows = native_archive.REPO / '.github/workflows'
        check = yaml.safe_load((workflows / 'native-release-check.yml').read_text())
        built = {entry['platform']: entry['runner'] for entry in check['jobs']['package']['strategy']['matrix']['include']}
        # Each archive is built and smoked by native tools on its own hardware, never under Rosetta.
        self.assertEqual(built, {'linux-amd64': 'ubuntu-24.04', 'linux-arm64': 'ubuntu-24.04-arm',
                                 'darwin-arm64': 'macos-15', 'darwin-amd64': 'macos-15-intel'})
        self.assertEqual(set(built), native_archive.PLATFORMS)
        release_workflow = yaml.safe_load((workflows / 'release.yml').read_text())
        desktop = {entry['platform']: entry['runner']
                   for entry in release_workflow['jobs']['desktop']['strategy']['matrix']['include']}
        self.assertEqual(desktop, {'darwin-arm64': 'macos-15', 'darwin-amd64': 'macos-15-intel'})
        publish = '\n'.join(step.get('run', '') for step in release_workflow['jobs']['publish']['steps'])
        checked = publish.split('archive="supertag-$VERSION-$platform-complete.tar.gz"', 1)[0]
        self.assertEqual(set(checked.rsplit('for platform in ', 1)[1].split('; do', 1)[0].split()),
                         native_archive.PLATFORMS)
        ffmpeg = publish.split('supertag-"$VERSION"-{', 1)[1].split('}', 1)[0]
        self.assertEqual(set(ffmpeg.split(',')), native_archive.PLATFORMS)
        self.assertIn('test "$(wc -l < SHA256SUMS)" -eq 4\n', publish)
        self.assertIn('test "$(wc -l < SHA256SUMS)" -eq 5\n', publish)
        assets = (native_archive.REPO / 'scripts/check-release-assets.sh').read_text()
        for platform in native_archive.PLATFORMS:
            self.assertIn(f'supertag-$version-{platform}-complete.tar.gz', assets)
        self.assertIn('for platform in darwin-arm64 darwin-amd64; do\n'
                      '  if ! grep -Fxq -- "SuperTag-$version-$platform.dmg"', assets)

    def test_the_release_publishes_the_hosted_image_and_lists_its_reference(self):
        # `supertag deploy` resolves a release's version to ghcr.io/atemaguer/supertag-hosted by
        # digest through the asset this job writes (core/crates/cli/src/deploy/image.rs).
        import yaml
        workflow = yaml.safe_load((native_archive.REPO / '.github/workflows/release.yml').read_text())
        image = workflow['jobs']['hosted-image']
        self.assertEqual(image['needs'], ['source', 'package'])
        self.assertEqual(image['permissions'], {'contents': 'read', 'packages': 'write'})
        # Pushed only when the release's assets are attached.
        self.assertEqual(image['if'], "github.event_name == 'push' || inputs.upload_assets")
        steps = image['steps']
        self.assertIn({'name': 'supertag-native-linux-amd64', 'path': '${{ runner.temp }}/native'},
                      [step.get('with') for step in steps])
        build, push = (step['run'] for step in steps if 'buildx build' in step.get('run', ''))
        for run in (build, push):
            self.assertIn('--platform linux/amd64', run)
            self.assertIn('--file deploy/docker/rust-service.Dockerfile --target hosted', run)
            # One manifest, so the recorded digest is the image's own.
            self.assertIn('--provenance=false --sbom=false', run)
        self.assertIn('image="ghcr.io/${GITHUB_REPOSITORY,,}-hosted"', build)
        self.assertIn('sha256sum --check "$archive.sha256"', build)
        self.assertNotIn('--push', build)
        self.assertIn("printf '%s@%s\\n' \"$IMAGE\" \"$digest\" > supertag-hosted-image.txt", push)
        publish = workflow['jobs']['publish']
        self.assertIn('hosted-image', publish['needs'])
        listed = '\n'.join(step.get('run', '') for step in publish['steps'])
        self.assertIn('cat supertag-hosted-image.txt.sha256 >> SHA256SUMS', listed)
        self.assertIn('./supertag-hosted-image.txt', listed)
        cli = (native_archive.REPO / 'core/crates/cli/src/deploy/image.rs').read_text()
        self.assertIn('const ASSET: &str = "supertag-hosted-image.txt";', cli)
        self.assertIn('const OFFICIAL: &str = "ghcr.io/atemaguer/supertag-hosted@sha256:";', cli)

    def test_the_intel_mac_terminal_ui_embeds_the_baseline_bun(self):
        # Bun embeds its own runtime in supertag-tui; the baseline build runs on Intel Macs without
        # AVX2, as on linux-amd64. Its download is pinned to .bun-version and a checksum.
        pin = (native_archive.REPO / '.bun-version').read_text().strip()
        text = (native_archive.REPO / '.github/workflows/native-release-check.yml').read_text()
        self.assertIn(f'/bun-v{pin}/bun-darwin-x64-baseline.zip', text)
        self.assertRegex(text, r'bun_sha=[0-9a-f]{64}')

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

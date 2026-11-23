"""The desktop disk image's drag-to-install layout, without building an image."""
import os
from pathlib import Path
import plistlib
import struct
import tempfile
import unittest
from unittest.mock import patch

import dmg_layout
from dmg_layout import LayoutError

REPO = Path(__file__).resolve().parent.parent


class DiskImageLayout(unittest.TestCase):
    def volume(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        (root / 'SuperTag.app/Contents/MacOS').mkdir(parents=True)
        os.symlink('/Applications', root / 'Applications')
        (root / '.DS_Store').write_bytes(dmg_layout.build_store())
        return root

    def test_the_layout_puts_the_app_left_of_applications_in_a_bare_icon_window(self):
        data = dmg_layout.build_store()
        self.assertEqual(data, dmg_layout.build_store())
        found = dmg_layout.parse_store(data)
        self.assertEqual(sorted(found), [('.', 'bwsp'), ('.', 'icvl'), ('.', 'icvp'), ('.', 'vSrn'),
                                         ('Applications', 'Iloc'), ('SuperTag.app', 'Iloc')])
        self.assertEqual(found[('.', 'icvl')], 'icnv')
        window = plistlib.loads(found[('.', 'bwsp')])
        self.assertEqual(window['WindowBounds'], '{{200, 120}, {600, 400}}')
        for key in ('ShowToolbar', 'ShowSidebar', 'ShowPathbar', 'ShowStatusBar', 'ShowTabView'):
            self.assertIs(window[key], False)
        view = plistlib.loads(found[('.', 'icvp')])
        self.assertEqual((view['iconSize'], view['arrangeBy'], view['backgroundType']), (128, 'none', 0))
        app = struct.unpack('>II', found[('SuperTag.app', 'Iloc')][:8])
        applications = struct.unpack('>II', found[('Applications', 'Iloc')][:8])
        self.assertEqual((app, applications), ((160, 170), (440, 170)))
        dmg_layout.check_store(data)

    def test_the_file_is_one_buddy_allocated_leaf_as_finder_reads_it(self):
        data = dmg_layout.build_store()
        self.assertEqual(len(data), 4 + 16384)
        self.assertEqual(struct.unpack('>I4sIII', data[:20]), (1, b'Bud1', 2048, 2048, 2048))
        # The superblock: root node 2, no levels above it, six records, one node, 4096-byte pages.
        self.assertEqual(struct.unpack('>IIIII', data[36:56]), (2, 0, 6, 1, 4096))
        # The allocator's block table: itself, the superblock, and the node.
        self.assertEqual(struct.unpack('>II3I', data[2052:2072]), (3, 0, 2048 | 11, 32 | 5, 8192 | 13))
        self.assertEqual(struct.unpack('>II', data[8196:8204]), (0, 6))

    def test_a_layout_that_moves_or_shrinks_the_icons_is_refused(self):
        for name, value, message in (
                ('POSITIONS', {'SuperTag.app': (440, 170), 'Applications': (160, 170)}, 'is at'),
                ('ICON_VIEW_SETTINGS', dict(dmg_layout.ICON_VIEW_SETTINGS, iconSize=64.0), 'points'),
                ('ICON_VIEW_SETTINGS', dict(dmg_layout.ICON_VIEW_SETTINGS, arrangeBy='name'), 'rearrange'),
                ('WINDOW_SETTINGS', dict(dmg_layout.WINDOW_SETTINGS, ShowToolbar=True), 'ShowToolbar'),
                ('WINDOW_SETTINGS', dict(dmg_layout.WINDOW_SETTINGS, ShowSidebar=True), 'ShowSidebar')):
            with patch.object(dmg_layout, name, value):
                data = dmg_layout.build_store()
            with self.assertRaisesRegex(LayoutError, message):
                dmg_layout.check_store(data)
        with self.assertRaisesRegex(LayoutError, 'not a .DS_Store'):
            dmg_layout.check_store(bytes(64))
        with self.assertRaisesRegex(LayoutError, 'truncated'):
            dmg_layout.check_store(dmg_layout.build_store()[:9000])

    def test_a_volume_holds_exactly_the_app_the_applications_link_and_the_layout(self):
        dmg_layout.check_volume(self.volume())
        # What macOS adds on its own does not count.
        root = self.volume()
        (root / '.fseventsd').mkdir()
        dmg_layout.check_volume(root)

        root = self.volume()
        (root / 'README.txt').write_text('extra')
        with self.assertRaisesRegex(LayoutError, r"unexpected \['README.txt'\]"):
            dmg_layout.check_volume(root)
        root = self.volume()
        (root / '.background').mkdir()
        with self.assertRaisesRegex(LayoutError, 'unexpected'):
            dmg_layout.check_volume(root)
        root = self.volume()
        (root / '.DS_Store').unlink()
        with self.assertRaisesRegex(LayoutError, r"lacks \['.DS_Store'\]"):
            dmg_layout.check_volume(root)

    def test_applications_must_be_a_link_to_exactly_the_applications_folder(self):
        for target in ('/Applications/', '/Applications/Utilities', 'Applications', '/tmp'):
            root = self.volume()
            (root / 'Applications').unlink()
            os.symlink(target, root / 'Applications')
            with self.assertRaisesRegex(LayoutError, 'not /Applications'):
                dmg_layout.check_volume(root)
        root = self.volume()
        (root / 'Applications').unlink()
        (root / 'Applications').mkdir()
        with self.assertRaisesRegex(LayoutError, 'not a symbolic link'):
            dmg_layout.check_volume(root)
        root = self.volume()
        (root / 'SuperTag.app/Contents/MacOS').rmdir()
        (root / 'SuperTag.app/Contents').rmdir()
        (root / 'SuperTag.app').rmdir()
        os.symlink('/Applications', root / 'SuperTag.app')
        with self.assertRaisesRegex(LayoutError, 'not a folder'):
            dmg_layout.check_volume(root)

    def test_the_release_builds_and_checks_the_layout_and_the_update_zip_holds_only_the_app(self):
        script = (REPO / 'scripts/package-desktop-macos.sh').read_text()
        create = script.split('create_image() {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('ditto "$app" "$scratch/volume/SuperTag.app"\n', create)
        self.assertIn('ln -s /Applications "$scratch/volume/Applications"\n', create)
        self.assertIn('python3 "$layout" write "$scratch/volume"\n', create)
        self.assertIn('-srcfolder "$scratch/volume" ', create)
        # Both the unsigned and the signed path check the finished image.
        self.assertEqual(script.count('\ncheck_image\n') + script.count('\n  check_image\n'), 2)
        self.assertIn('with_mounted_image python3 "$layout" check', script)
        # The update zip is the app alone, never the staged volume.
        zipped = script.split('create_zip() {', 1)[1].split('\n}\n', 1)[0]
        self.assertIn('ditto -c -k --sequesterRsrc --keepParent "$app" "$zip"', zipped)
        self.assertNotIn('volume', zipped)
        workflow = (REPO / '.github/workflows/release.yml').read_text()
        self.assertIn('python3 scripts/dmg_layout.py check "$mount"\n', workflow)
        self.assertIn('test "$(readlink "$mount/Applications")" = /Applications\n', workflow)


if __name__ == '__main__':
    unittest.main()

#!/usr/bin/env python3
"""Installer collection rejects absent and ambiguous outputs."""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

class CollectionTests(unittest.TestCase):
    def test_requires_exactly_one_installer(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for count in (0, 2):
                with self.subTest(count=count):
                    for index in range(count):
                        (root / f'{index}.dmg').touch()
                    result = subprocess.run([sys.executable, str(Path(__file__).with_name('collect-installers.py')), 'macos-arm64', str(root), str(root)], capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(f'Expected one fresh dmg installer, found {count}', result.stderr)

if __name__ == '__main__':
    unittest.main()

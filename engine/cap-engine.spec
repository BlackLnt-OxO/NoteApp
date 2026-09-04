# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec — freeze the long-screenshot capture daemon into a single
# onedir Windows exe ("cap-engine"). Bundles Python + cv2 + numpy + the vendored
# mss library, so an end-user machine needs zero Python.
#
# Source of truth: electron/longshot/capture_daemon.py (JSON-lines protocol over
# stdin/stdout: configure / tick / finish / shutdown). The frozen exe implements
# exactly that protocol — wire format must stay byte-identical with the dev path.
#
# Build (needs Python + PyInstaller on the build machine only):
#   npm run build:engine
# Output: engine/dist/cap-engine/{cap-engine.exe,_internal/}
# Ship via electron-builder extraResources -> resources/engine (see package.json).

import os

# PyInstaller exec's the spec without __file__; it exposes SPECPATH (dir of the spec).
HERE = os.path.abspath(SPECPATH)                             # repo/engine
PROJECT = os.path.dirname(HERE)                              # repo root
DAEMON = os.path.join(PROJECT, 'electron', 'longshot', 'capture_daemon.py')
MSS_DIR = os.path.join(PROJECT, 'electron', 'mss')           # vendored mss (pure ctypes)

# Output dirs are pinned via CLI (--distpath engine/dist --workpath engine/build)
# in npm run build:engine — PyInstaller 6 ignores spec-level DISTPATH/WORKPATH.

a = Analysis(
    [DAEMON],
    # Resolve `import mss` to the VENDORED copy (electron/mss), not a pip install.
    pathex=[MSS_DIR],
    binaries=[],
    datas=[],
    # mss dispatches to its platform backend lazily inside function bodies —
    # make sure the Windows GDI backend is pulled in explicitly.
    hiddenimports=['mss.windows', 'mss.windows.gdi'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Exclude non-Windows mss backends + heavy/unused stdlib extras.
    # Do NOT exclude mss.tools: mss/base.py imports it at module top level.
    excludes=[
        'mss.darwin',
        'mss.linux',
        'tkinter',
        'matplotlib',
        'scipy',
        'PIL',
        'pydoc_data',
    ],
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='cap-engine',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    # upx=False avoids antivirus heuristics on the numpy/cv2 DLLs.
    upx=False,
    # Console subsystem keeps piped stdout/stderr real; main.js spawns with
    # windowsHide:true so no console flashes for the user.
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='cap-engine',  # -> engine/dist/cap-engine/{cap-engine.exe,_internal/}
)

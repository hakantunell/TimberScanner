# TimberScanner

Local web application for scanning timber geometry with a camera, a line laser, and a rotation marker.

## Current prototype

The first version provides:

- a local FastAPI web application,
- live MJPEG video from a USB camera,
- red laser-line detection,
- a browser view with detection confidence and point count,
- separated domain, vision, service, API, and web modules,
- a unit test for the laser detector.

The current detector is deliberately simple. It is intended to validate the Logitech C920/C922 and red line-laser setup before camera calibration, rotation-marker tracking, and 3D reconstruction are added.

## Run locally

Requires Python 3.11 or newer.

```bash
python -m venv .venv

# Windows
.venv\Scripts\activate

# Linux/macOS
source .venv/bin/activate

pip install -e ".[dev]"
uvicorn timber_scanner.main:app --reload
```

Open `http://localhost:8000`.

The default camera index is `0`. Runtime settings can be overridden with environment variables, for example:

```bash
TIMBER_SCANNER_CAMERA_INDEX=1 uvicorn timber_scanner.main:app
```

## Planned modules

1. Camera calibration and sawbench coordinate system.
2. Rotation-marker detection at the log end.
3. Scan-session recording and occlusion filtering.
4. Laser triangulation to 3D profiles.
5. Log surface reconstruction.
6. Support-height and sawing optimisation.

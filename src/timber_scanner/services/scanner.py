from collections.abc import Iterator

import numpy as np

from timber_scanner.vision.camera import CameraService
from timber_scanner.vision.laser_detector import RedLaserDetector


class ScannerService:
    """Coordinates camera capture and vision components."""

    def __init__(self, camera: CameraService, laser_detector: RedLaserDetector) -> None:
        self._camera = camera
        self._laser_detector = laser_detector
        self._last_confidence = 0.0
        self._last_point_count = 0

    def process_frame(self, frame: np.ndarray) -> np.ndarray:
        profile, _ = self._laser_detector.detect(frame)
        self._last_confidence = profile.confidence
        self._last_point_count = len(profile.points_px)
        return self._laser_detector.overlay(frame, profile)

    def stream_frames(self) -> Iterator[bytes]:
        return self._camera.mjpeg_frames(self.process_frame)

    def status(self) -> dict[str, object]:
        return {
            "laserConfidence": self._last_confidence,
            "laserPointCount": self._last_point_count,
            "phase": "prototype",
        }

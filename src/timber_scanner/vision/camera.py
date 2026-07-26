from collections.abc import Iterator
from threading import Lock

import cv2
import numpy as np

from timber_scanner.config import Settings


class CameraError(RuntimeError):
    """Raised when the configured camera cannot be used."""


class CameraService:
    """Owns the OpenCV camera and provides thread-safe frame access."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._capture: cv2.VideoCapture | None = None
        self._lock = Lock()

    def start(self) -> None:
        if self._capture is not None:
            return

        capture = cv2.VideoCapture(self._settings.camera_index)
        capture.set(cv2.CAP_PROP_FRAME_WIDTH, self._settings.camera_width)
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, self._settings.camera_height)
        capture.set(cv2.CAP_PROP_FPS, self._settings.camera_fps)

        if not capture.isOpened():
            capture.release()
            raise CameraError(f"Could not open camera index {self._settings.camera_index}")

        self._capture = capture

    def stop(self) -> None:
        if self._capture is not None:
            self._capture.release()
            self._capture = None

    def read(self) -> np.ndarray:
        if self._capture is None:
            self.start()

        assert self._capture is not None
        with self._lock:
            ok, frame = self._capture.read()

        if not ok or frame is None:
            raise CameraError("Could not read a frame from the camera")
        return frame

    def mjpeg_frames(self, frame_processor=None) -> Iterator[bytes]:
        while True:
            frame = self.read()
            if frame_processor is not None:
                frame = frame_processor(frame)
            ok, encoded = cv2.imencode(
                ".jpg",
                frame,
                [cv2.IMWRITE_JPEG_QUALITY, self._settings.jpeg_quality],
            )
            if not ok:
                continue
            yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + encoded.tobytes() + b"\r\n"

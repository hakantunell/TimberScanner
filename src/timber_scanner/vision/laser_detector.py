from datetime import datetime, timezone

import cv2
import numpy as np

from timber_scanner.domain.models import LaserProfile


class RedLaserDetector:
    """Detects a red laser centreline using colour contrast and morphology."""

    def __init__(self, min_red_excess: int = 45, min_brightness: int = 110) -> None:
        self._min_red_excess = min_red_excess
        self._min_brightness = min_brightness

    def detect(self, frame_bgr: np.ndarray) -> tuple[LaserProfile, np.ndarray]:
        blue, green, red = cv2.split(frame_bgr)
        red_i = red.astype(np.int16)
        excess = red_i - np.maximum(blue, green).astype(np.int16)
        mask = ((excess >= self._min_red_excess) & (red >= self._min_brightness)).astype(np.uint8) * 255
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))

        points: list[tuple[float, float]] = []
        for x in range(mask.shape[1]):
            ys = np.flatnonzero(mask[:, x])
            if ys.size:
                weights = red[ys, x].astype(np.float32)
                y = float(np.average(ys, weights=weights))
                points.append((float(x), y))

        points_px = np.asarray(points, dtype=np.float32).reshape((-1, 2))
        confidence = min(1.0, len(points) / max(1, frame_bgr.shape[1] * 0.35))
        profile = LaserProfile(datetime.now(timezone.utc), points_px, confidence)
        return profile, mask

    @staticmethod
    def overlay(frame_bgr: np.ndarray, profile: LaserProfile) -> np.ndarray:
        output = frame_bgr.copy()
        for x, y in profile.points_px[::4]:
            cv2.circle(output, (int(x), int(y)), 2, (0, 255, 255), -1)
        cv2.putText(
            output,
            f"Laser confidence: {profile.confidence:.0%}",
            (20, 35),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.8,
            (0, 255, 255),
            2,
        )
        return output

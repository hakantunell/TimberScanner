import cv2
import numpy as np

from timber_scanner.vision.laser_detector import RedLaserDetector


def test_detects_red_line() -> None:
    frame = np.zeros((120, 200, 3), dtype=np.uint8)
    cv2.line(frame, (10, 60), (190, 60), (0, 0, 255), 2)

    profile, mask = RedLaserDetector().detect(frame)

    assert len(profile.points_px) > 150
    assert profile.confidence > 0.9
    assert mask[60, 100] == 255

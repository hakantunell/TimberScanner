from dataclasses import dataclass
from datetime import datetime, timezone

import numpy as np


@dataclass(frozen=True, slots=True)
class LaserProfile:
    """Detected laser centreline in image coordinates for one frame."""

    captured_at: datetime
    points_px: np.ndarray
    confidence: float

    @classmethod
    def empty(cls) -> "LaserProfile":
        return cls(
            captured_at=datetime.now(timezone.utc),
            points_px=np.empty((0, 2), dtype=np.float32),
            confidence=0.0,
        )


@dataclass(frozen=True, slots=True)
class RotationObservation:
    """Observed log rotation for one frame."""

    angle_degrees: float
    confidence: float

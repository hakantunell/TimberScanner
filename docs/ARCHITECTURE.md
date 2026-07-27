# Mobile scanning architecture

TimberScanner treats camera images as the mandatory input and depth as optional supporting evidence.

## Capture sources

- `RgbCaptureSource`: ordinary iPhone/Android/browser camera images.
- `DepthCaptureSource`: optional ARKit/ARCore/native-app depth maps when available.
- `ScaleReference`: known physical dimensions from a calibration ruler or coded marker rail.
- `PithMarker`: asymmetric T marker locating the pith and rotation at each end.

## Processing pipeline

1. Capture overlapping images for one stationary rotation.
2. Detect scale references and end markers.
3. Estimate camera poses and reconstruct a surface from RGB images.
4. Fuse optional depth observations without making them authoritative.
5. Rotate the specimen and start another capture pass.
6. Register passes using shared bark features, scale references, and pith-marker orientation.
7. Store coverage and uncertainty separately from the reconstructed surface.
8. Produce a digital timber model with surface, pith endpoints, centreline, taper, curvature, and confidence.

## Design rule

The reconstruction must work without LiDAR. Depth data may improve initial pose, scale, and robustness, but the scale rail remains the metrological reference.

## Initial prototype scope

The GitHub Pages prototype only captures and groups images by rotation. Marker detection, reconstruction, depth fusion, and saw optimisation are separate future modules rather than being placed in the UI file.
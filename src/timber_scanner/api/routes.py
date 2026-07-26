from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

router = APIRouter()


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/camera/stream")
def camera_stream(request: Request) -> StreamingResponse:
    scanner = request.app.state.scanner
    return StreamingResponse(
        scanner.stream_frames(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


@router.get("/scanner/status")
def scanner_status(request: Request) -> dict[str, object]:
    return request.app.state.scanner.status()

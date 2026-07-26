from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from timber_scanner.api.routes import router
from timber_scanner.config import get_settings
from timber_scanner.services.scanner import ScannerService
from timber_scanner.vision.camera import CameraService
from timber_scanner.vision.laser_detector import RedLaserDetector

STATIC_DIR = Path(__file__).parent / "web"


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    camera = CameraService(settings)
    app.state.scanner = ScannerService(camera, RedLaserDetector())
    yield
    camera.stop()


settings = get_settings()
app = FastAPI(title=settings.app_name, lifespan=lifespan)
app.include_router(router, prefix="/api")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")

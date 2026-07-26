from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration for the local scanner application."""

    app_name: str = "TimberScanner"
    camera_index: int = 0
    camera_width: int = 1920
    camera_height: int = 1080
    camera_fps: int = 30
    jpeg_quality: int = 85

    model_config = SettingsConfigDict(
        env_prefix="TIMBER_SCANNER_",
        env_file=".env",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()

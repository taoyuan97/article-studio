"""Shared request models for the publish line (REST + MCP).

The block-anchor placement contract is the single source of truth for both
entry points: the REST wizard and MCP tools validate with the same model.
"""

from __future__ import annotations

import re

from pydantic import BaseModel, Field, field_validator

POSITION_PATTERN = re.compile(
    r"^(top|bottom|after_section_[1-9]\d*|after_block_[1-9]\d*)$"
)


class ImagePlacement(BaseModel):
    """A single image insertion anchor in the article body."""

    asset_id: str = Field(min_length=1)
    position: str = Field(min_length=1)
    order: int = 0

    @field_validator("position")
    @classmethod
    def check_position(cls, value: str) -> str:
        if not POSITION_PATTERN.match(value):
            raise ValueError(
                "position 必须是 top、bottom、after_section_{n} 或 after_block_{n}（n>=1）"
            )
        return value

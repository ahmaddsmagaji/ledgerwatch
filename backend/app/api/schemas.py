from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class ActionRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    action: Literal["resolve", "escalate", "reopen", "note"]
    actor: str = Field(min_length=1, max_length=80)
    note: str = Field(min_length=3, max_length=2000)


class LoadSampleRequest(BaseModel):
    confirm: bool

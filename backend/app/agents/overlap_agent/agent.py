"""Google ADK overlap agent definition."""

from google.adk.agents import Agent

from backend.app.core.config import Settings, get_settings

from .tools import get_overlap, list_overlaps, score_project_names


def build_agent(settings: Settings) -> Agent:
    """Build the agent without contacting a model provider."""
    return Agent(
        name="overlap_agent",
        model=settings.agent_model,
        description="Explains utility-project overlap records and semantic name similarity.",
        instruction=(
            "Explain utility project overlaps clearly. Always call a tool to obtain "
            "similarity scores or overlap details; never invent a score. Scores are "
            "cosine similarity from sentence-transformers/all-MiniLM-L6-v2 and range "
            "from -1 to 1."
        ),
        tools=[score_project_names, get_overlap, list_overlaps],
    )


root_agent = build_agent(get_settings())

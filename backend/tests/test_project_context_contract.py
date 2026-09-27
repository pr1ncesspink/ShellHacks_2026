import ast
from pathlib import Path

from backend.app.schemas.diagnosis import ProjectContext


def project_field_names(source: str) -> set[str]:
    module = ast.parse(source)
    project = next(
        node for node in module.body if isinstance(node, ast.ClassDef) and node.name == "Project"
    )
    return {
        statement.target.id
        for statement in project.body
        if isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name)
    }


def test_project_context_whitelist_matches_documentparsing_project_without_importing_it():
    source = Path("backend/documentparsing/extraction.py").read_text(encoding="utf-8")
    fields = project_field_names(source)
    assert set(ProjectContext.model_fields).issubset(fields)


def test_project_context_drift_guard_detects_a_renamed_source_field():
    source = Path("backend/documentparsing/extraction.py").read_text(encoding="utf-8")
    fields = project_field_names(source.replace("description: str | None", "scope: str | None", 1))
    assert "description" not in fields
    assert not set(ProjectContext.model_fields).issubset(fields)

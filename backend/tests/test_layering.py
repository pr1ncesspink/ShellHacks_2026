import ast
from pathlib import Path


ROOT = Path("backend/app")


def imported_modules(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module)
    return names


def test_services_and_core_do_not_import_fastapi_or_agent_runtime():
    for directory in [ROOT / "services", ROOT / "core"]:
        for path in directory.glob("*.py"):
            imports = imported_modules(path)
            assert not any(name == "fastapi" or name.startswith("fastapi.") for name in imports)
            assert not any(
                name == "google.adk" or name.startswith("google.adk.") or name == "a2a" or name.startswith("a2a.")
                for name in imports
            )


def test_agents_do_not_import_fastapi_or_api():
    for path in (ROOT / "agents").rglob("*.py"):
        imports = imported_modules(path)
        assert not any(name == "fastapi" or name.startswith("fastapi.") for name in imports)
        assert not any(name == "backend.app.api" or name.startswith("backend.app.api.") for name in imports)


def test_cli_does_not_import_fastapi():
    assert not any(name == "fastapi" or name.startswith("fastapi.") for name in imported_modules(ROOT / "cli.py"))

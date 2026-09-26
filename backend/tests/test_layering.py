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


def test_services_and_core_do_not_import_fastapi():
    for directory in [ROOT / "services", ROOT / "core"]:
        for path in directory.glob("*.py"):
            assert not any(name == "fastapi" or name.startswith("fastapi.") for name in imported_modules(path))


def test_cli_does_not_import_fastapi():
    assert not any(name == "fastapi" or name.startswith("fastapi.") for name in imported_modules(ROOT / "cli.py"))

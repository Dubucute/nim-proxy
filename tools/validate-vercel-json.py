"""Validate vercel.json against the schema Vercel publishes for it.

The schema is draft-04, which ajv 8 refuses to load; jsonschema handles it.
Run: python tools/validate-vercel-json.py
"""
import json
import re
import sys
import tempfile
import urllib.request
from pathlib import Path

SCHEMA_URL = "https://openapi.vercel.sh/vercel.json"
DEFAULT_CONFIG = Path(__file__).resolve().parent.parent / "vercel.json"
CONFIG = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else DEFAULT_CONFIG
CACHE = Path(tempfile.gettempdir()) / "vercel-schema.cache.json"

# The published schema types `runtime` as a bare string, so it happily accepts
# "nodejs22.x" — which Vercel then rejects at deploy time with
#   [invalid_function_runtime] Function Runtimes must have a valid version,
#   for example `now-php@1.0.0`
# The real rule is: an npm package spec *with* a version.
PKG_SPEC = re.compile(r"^(?:@[^/@]+/[^/@]+|[^@/]+)@\d+\.\d+\.\d+")


def semantic_checks(config):
    """Constraints Vercel enforces that its JSON schema does not describe."""
    problems = []

    for glob, options in (config.get("functions") or {}).items():
        if not isinstance(options, dict):
            continue
        runtime = options.get("runtime")
        if runtime is not None and not PKG_SPEC.match(str(runtime)):
            problems.append(
                f"functions[{glob!r}].runtime = {runtime!r}: must be an npm package spec "
                "including a version, e.g. '@vercel/node@5.0.0'. Vercel's error is "
                "'Function Runtimes must have a valid version'. Omit the key entirely to "
                "let Vercel pick the Node.js runtime."
            )

    for index, build in enumerate(config.get("builds") or []):
        use = (build or {}).get("use")
        if use is not None and not PKG_SPEC.match(str(use)):
            problems.append(
                f"builds[{index}].use = {use!r}: must be an npm package spec including a "
                "version, e.g. '@vercel/node@5.0.0'."
            )

    return problems


def load_schema():
    if CACHE.exists():
        return json.loads(CACHE.read_text(encoding="utf-8"))
    with urllib.request.urlopen(SCHEMA_URL, timeout=30) as resp:
        raw = resp.read().decode("utf-8")
    CACHE.write_text(raw, encoding="utf-8")
    return json.loads(raw)


def main():
    import jsonschema

    if not CONFIG.exists():
        print(f"{CONFIG} not found")
        return 1

    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    schema = load_schema()

    validator_cls = jsonschema.validators.validator_for(schema)
    validator = validator_cls(schema)

    errors = sorted(validator.iter_errors(config), key=lambda e: list(e.absolute_path))
    problems = semantic_checks(config)

    if not errors and not problems:
        print(f"vercel.json is valid against {schema.get('$schema')} "
              f"({validator_cls.__name__}); {len(config)} top-level keys")
        return 0

    if errors:
        print(f"vercel.json has {len(errors)} schema problem(s):")
        for err in errors:
            path = "/".join(str(p) for p in err.absolute_path) or "(root)"
            print(f"  - {path}: {err.message}")
            if err.context:
                for sub in err.context[:5]:
                    print(f"      {sub.message}")

    if problems:
        print(f"vercel.json has {len(problems)} rule violation(s) the schema cannot express:")
        for problem in problems:
            print(f"  - {problem}")

    return 1


if __name__ == "__main__":
    sys.exit(main())

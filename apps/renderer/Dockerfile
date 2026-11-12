# The renderer of Octobrief, built from the root of the repository (see .dockerignore):
#   docker build -f apps/renderer/Dockerfile -t octobrief-renderer .
# The last stage is what runs: no test, no tool, no secret, a user that is not root.
FROM python:3.13.16-slim-bookworm@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641 AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
COPY apps/renderer/requirements.txt /tmp/requirements.txt
RUN pip install --require-hashes --only-binary=:all: -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt \
    && groupadd --system --gid 10001 renderer \
    && useradd --system --uid 10001 --gid renderer --no-create-home --shell /usr/sbin/nologin renderer
WORKDIR /app
COPY packages/domain/schemas/octobrief.document-1.schema.json packages/domain/schemas/formula-functions.json /app/schemas/
COPY apps/renderer/renderer /app/renderer

# Tests and lint: pytest and ruff on the code, the shared fixtures and the hostile corpus.
FROM base AS test
COPY apps/renderer/requirements-dev.txt /tmp/requirements-dev.txt
RUN pip install --require-hashes --only-binary=:all: -r /tmp/requirements-dev.txt \
    && rm /tmp/requirements-dev.txt
COPY apps/renderer/pyproject.toml /app/pyproject.toml
COPY apps/renderer/tests /app/tests
COPY packages/domain/test/fixtures/render /app/fixtures/render
COPY packages/domain/test/fixtures/formulas.json /app/fixtures/formulas.json
COPY apps/renderer/fixtures/corpus /app/fixtures/corpus
COPY templates /app/fixtures/neutral
COPY apps/renderer/fixtures/neutral.py /app/tools/neutral.py
USER 10001:10001
CMD ["python", "-m", "pytest", "-p", "no:cacheprovider", "-q", "tests"]

FROM base AS runtime
USER 10001:10001
EXPOSE 8080
CMD ["python", "-m", "renderer.server"]

FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/opt/hf

WORKDIR /app

COPY backend/requirements.txt backend/requirements.txt
RUN pip install --require-hashes -r backend/requirements.txt

# Resolve the optional document/matching integration together. The connector
# requires filelock<4, so this overlay can downgrade the legacy app lock's pin.
COPY backend/requirements-documentparsing.txt backend/requirements-projectdata.txt backend/
RUN pip install -r backend/requirements-projectdata.txt && pip check

ARG HF_MODEL_ID=sentence-transformers/all-MiniLM-L6-v2
ARG HF_MODEL_REVISION=1110a243fdf4706b3f48f1d95db1a4f5529b4d41
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('${HF_MODEL_ID}', revision='${HF_MODEL_REVISION}', device='cpu')"

RUN useradd --create-home --uid 10001 appuser
COPY --chown=appuser:appuser backend/__init__.py /app/backend/__init__.py
COPY --chown=appuser:appuser backend/app /app/backend/app
COPY --chown=appuser:appuser backend/documentparsing /app/backend/documentparsing
COPY --chown=appuser:appuser backend/projectdata /app/backend/projectdata
COPY --chown=appuser:appuser backend/data /app/backend/data
RUN chown -R appuser:appuser /opt/hf && chmod -R a-w /opt/hf

ENV HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    HF_MODEL_ID=${HF_MODEL_ID} \
    HF_MODEL_REVISION=${HF_MODEL_REVISION} \
    PORT=8080

USER appuser
EXPOSE 8080
CMD ["sh", "-c", "exec uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT:-8080}"]

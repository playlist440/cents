FROM python:3.12-slim

LABEL org.opencontainers.image.title="Cents" \
      org.opencontainers.image.source="https://github.com/playlist440/cents" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/backend \
    CENTS_DATA_DIR=/data \
    TZ=Europe/Amsterdam

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ backend/
COPY frontend/ frontend/
COPY LICENSE THIRD-PARTY-NOTICES.md ./

# Run as a normal user; a fresh named volume inherits this ownership.
# The code stays owned by root (read-only for the app); only /data is writable.
RUN useradd --uid 1000 --create-home cents \
    && mkdir -p /data \
    && chown cents:cents /data
USER cents

VOLUME /data
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/healthz', timeout=4).status == 200 else 1)"

CMD ["uvicorn", "cents.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]

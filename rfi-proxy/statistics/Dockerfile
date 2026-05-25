FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .
COPY statistics_core ./statistics_core

EXPOSE 8081

CMD ["sh", "-c", "exec gunicorn -w 1 --threads ${STATISTICS_GUNICORN_THREADS:-4} --timeout ${STATISTICS_GUNICORN_TIMEOUT_SECONDS:-3600} -b 0.0.0.0:8081 app:app"]

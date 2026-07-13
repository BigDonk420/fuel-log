# FuelLog — tiny, dependency-free image (Python stdlib only).
FROM python:3.12-slim

WORKDIR /app
COPY . /app

# SQLite lives on a mounted volume so data survives rebuilds.
ENV DB_PATH=/data/fuellog.db
ENV PORT=8137
EXPOSE 8137

CMD ["python", "server.py"]

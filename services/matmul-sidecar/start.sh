#!/bin/bash
cd "$(dirname "$0")"
exec uvicorn main:app --host 0.0.0.0 --port 7901 --workers 1 --no-access-log

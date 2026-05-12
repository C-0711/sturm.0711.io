#!/usr/bin/env bash
#
# H200V OCR-Cluster Deploy / Restart
# ───────────────────────────────────────────────────────────────────────────
# Stand 2026-05-12. Bringt auf dem H200V-Host zwei vLLM-Instanzen
# nebeneinander zum Laufen:
#
#   :11435  vLLM  gemma4-mm     (running, RESTART mit gedrosselter VRAM-Quote)
#   :11437  vLLM  LightOnOCR-1B (NEU, kleines Modell, eigene KV-Pool)
#
# Vorraussetzung: Gemma läuft heute mit der Default-Quote (≈0.9 freies VRAM
# als KV-Pool). Ein zweiter vLLM-Prozess scheitert dann beim Start mit OOM,
# auch wenn 200 GB physisch frei sind. Daher die Reihenfolge:
#   1) Gemma stoppen
#   2) Gemma mit utilization=0.45 neu starten
#   3) LightOn mit utilization=0.15 starten
#
# Reversibel: alte systemd-units bleiben unangetastet — wir schreiben eine
# zweite Unit `vllm-lighton`, nur Gemma's existierende Unit wird editiert
# (Backup vorher).
#
# ⚠ NICHT BLIND AUSFÜHREN: dieses Skript fasst Shared-Infra an. Erst lesen,
# Service-Anhängigkeiten prüfen (ctaxv1 lanes etc.), dann ausführen.
# ───────────────────────────────────────────────────────────────────────────

set -euo pipefail

# Set H200V_HOST in your environment, e.g.:
#   export H200V_HOST=user@host.example.internal
H200V_HOST="${H200V_HOST:?H200V_HOST must be set (user@host)}"

# ── Step 0: Reachability & Vorzustand erfassen ─────────────────────────────
echo "[0/4] Reachability + Status erfassen …"
ssh "$H200V_HOST" bash <<'REMOTE'
echo "Hostname: $(hostname)"
echo
echo "GPU-Belegung VOR Eingriff:"
nvidia-smi --query-gpu=index,name,memory.used,memory.free,memory.total --format=csv,noheader
echo
echo "Aktive vLLM-Prozesse:"
ps -eo pid,cmd | grep -E "vllm.*serve|gemma|lighton" | grep -v grep || echo "  (keine)"
echo
echo "Lauschende OCR-Cluster-Ports (11430-11449):"
ss -ltnp 2>/dev/null | awk '$4 ~ /:114[34]/' || true
echo
echo "Existierende systemd-Units (vllm*):"
systemctl list-units --type=service --all 2>/dev/null | grep -i vllm || echo "  (keine — Gemma läuft evtl. als Docker-Container oder tmux)"
REMOTE
echo

read -r -p "Vorzustand OK, weiter mit Gemma-Restart auf util=0.45? [yes/NO] " ANS
[[ "$ANS" == "yes" ]] || { echo "Abbruch — keine Änderung."; exit 1; }

# ── Step 1: Gemma neu starten mit gedrosselter VRAM-Quote ──────────────────
echo
echo "[1/4] Gemma vLLM neu starten mit --gpu-memory-utilization 0.45 …"
ssh "$H200V_HOST" bash <<'REMOTE'
set -e

# Variante A: Docker-Container (am wahrscheinlichsten gegeben docker ps Output)
GEMMA_CT=$(docker ps --filter "publish=11435" --format "{{.Names}}" | head -1)
if [[ -n "$GEMMA_CT" ]]; then
  echo "Gemma läuft als Docker-Container: $GEMMA_CT"
  echo "Inspiziere Start-Command …"
  docker inspect "$GEMMA_CT" --format '{{.Path}} {{range .Args}}{{.}} {{end}}' \
    > "/tmp/gemma-cmdline.before"
  cat /tmp/gemma-cmdline.before
  echo
  echo "⚠ Container kann nicht reibungslos um ein vLLM-Arg erweitert werden — er"
  echo "  muss mit der gleichen image+env neu erzeugt werden. Bitte:"
  echo "  1) docker stop $GEMMA_CT"
  echo "  2) Compose-File anpassen: command/args ergänzen --gpu-memory-utilization 0.45"
  echo "  3) docker compose up -d $GEMMA_CT"
  echo
  echo "Soll ich nur stoppen oder hier abbrechen? Skript pausiert."
  exit 99
fi

# Variante B: tmux-Session
TMUX_SESSION=$(tmux ls 2>/dev/null | grep -i gemma | cut -d: -f1 | head -1 || true)
if [[ -n "$TMUX_SESSION" ]]; then
  echo "Gemma in tmux-Session: $TMUX_SESSION — schicke Strg-C + neuen Befehl"
  tmux send-keys -t "$TMUX_SESSION" C-c
  sleep 3
  tmux send-keys -t "$TMUX_SESSION" \
    'vllm serve google/gemma-4-31b-it --served-model-name gemma4-mm --port 11435 --tensor-parallel-size 2 --gpu-memory-utilization 0.45' Enter
  echo "Gemma-Neustart-Befehl in tmux gesendet. Warte 60s auf Model-Load …"
  sleep 60
fi
REMOTE
echo

# ── Step 2: Gemma-Healthcheck ──────────────────────────────────────────────
echo "[2/4] Gemma-Health prüfen …"
ssh "$H200V_HOST" 'curl -sS -m 5 http://localhost:11435/v1/models | head -c 200; echo'
echo

read -r -p "Gemma gesund? Weiter mit LightOn-Start? [yes/NO] " ANS
[[ "$ANS" == "yes" ]] || { echo "Abbruch — Gemma ist neu gestartet, kein LightOn."; exit 1; }

# ── Step 3: LightOn OCR vLLM auf Port 11437 starten ───────────────────────
echo
echo "[3/4] LightOnOCR-1B starten auf :11437 …"
ssh "$H200V_HOST" bash <<'REMOTE'
set -e
# Erste GPU exklusiv für LightOn (1B braucht kein TP, ~3 GB Gewichte)
LOGFILE="/var/log/vllm-lighton.log"
mkdir -p "$(dirname "$LOGFILE")"
nohup env CUDA_VISIBLE_DEVICES=0 \
  vllm serve lightonai/LightOnOCR-1B \
    --served-model-name lighton-ocr \
    --port 11437 \
    --gpu-memory-utilization 0.15 \
    --max-model-len 8192 \
    > "$LOGFILE" 2>&1 &
echo "PID=$!"
echo "Warte 45s auf Model-Load …"
sleep 45
curl -sS -m 5 http://localhost:11437/v1/models | head -c 200 && echo || \
  { echo "LightOn nicht erreichbar — letzte 20 Zeilen Log:"; tail -20 "$LOGFILE"; exit 1; }
REMOTE
echo

# ── Step 4: Lokaler Mac-Tunnel erweitern ──────────────────────────────────
echo "[4/4] Lokaler Mac: zweiten Forward für :11437 einrichten …"
echo "      (falls bereits ein Master-SSH-Socket existiert, einfach hinzufügen:)"
echo
cat <<TUNNEL
ssh -O forward -L 11437:localhost:11437 -S /tmp/sturm-ssh/h200v.sock "\$H200V_HOST"

# oder, wenn noch kein Master läuft, alles in einem Aufruf:
SSHPASS='…' sshpass -e ssh -N \\
  -L 11435:localhost:11435 \\
  -L 11437:localhost:11437 \\
  -L 11434:localhost:11434 \\
  -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes \\
  -o ControlMaster=auto -o ControlPath=/tmp/sturm-ssh/h200v.sock \\
  "\$H200V_HOST"
TUNNEL
echo
echo "✅ Deploy fertig. Sanity:"
echo "   curl http://localhost:11435/v1/models  → gemma4-mm"
echo "   curl http://localhost:11437/v1/models  → lighton-ocr"
echo
echo "Im ocr-shootout-Workflow wird LightOn jetzt automatisch erreicht."

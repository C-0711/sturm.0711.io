#!/bin/bash
# Bootstrap officer SSH config for 0711 fleet
set -euo pipefail
mkdir -p ~/.ssh && chmod 700 ~/.ssh
grep -q Host reactor ~/.ssh/config 2>/dev/null || cat >> ~/.ssh/config << SSHEOF

# REACTOR (H200V) — 0711 Fleet
Host reactor h200v
    HostName 192.168.145.10
    Port 443
    User christoph.bertsch
    IdentityFile ~/.ssh/id_ed25519_h200v
    StrictHostKeyChecking no

Host bombas bridge
    HostName 62.210.150.229
    User m1
    IdentityFile ~/.ssh/id_ed25519_h200v
SSHEOF
echo SSH bootstrap complete. Test: ssh reactor echo REACTOR_OK

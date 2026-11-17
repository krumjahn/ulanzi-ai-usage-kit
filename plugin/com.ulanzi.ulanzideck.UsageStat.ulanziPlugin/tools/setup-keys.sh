#!/bin/bash
# Secrets are collected by Python from the terminal, never from CLI arguments.
set -euo pipefail
umask 077
exec python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/setup-keys.py" "$@"

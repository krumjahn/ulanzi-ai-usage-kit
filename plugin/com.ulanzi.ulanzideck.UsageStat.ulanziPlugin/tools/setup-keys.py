#!/usr/bin/env python3
"""Interactive local setup. No network calls; no secrets in process arguments."""
import argparse
import getpass
import json
import os
from pathlib import Path
import stat
import tempfile

FIELDS = {
    "stripe": [("secretKey", "Restricted read-only Stripe key", True)],
    "revenuecat": [("secretKey", "Read-only RevenueCat secret key", True), ("projectId", "Project ID", False)],
    "minimax": [("apiKey", "MiniMax API key", True)],
    "gemini": [("clientId", "Your Gemini OAuth client ID", False), ("clientSecret", "Your Gemini OAuth client secret", True)],
    "ga": [("propertyId", "GA4 numeric property ID", False), ("serviceAccountFile", "Path to GA Viewer service-account JSON", False)],
    "social": [("platform", "Platform (threads or instagram)", False), ("token", "Meta access token", True), ("userId", "Your user ID", False)],
    "social-handle": [("platform", "Platform (threads or instagram)", False), ("handle", "Public handle", False)],
}

def save(path, data):
    directory = path.parent
    if directory.is_symlink() or path.is_symlink():
        raise ValueError("Refusing a symlinked configuration path")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
    fd, temporary = tempfile.mkstemp(prefix=".stats-", dir=directory)
    try:
        with os.fdopen(fd, "w") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(data, stream, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)

def main():
    class SafeParser(argparse.ArgumentParser):
        def error(self, message):
            self.print_usage()
            self.exit(2, "Invalid arguments. Supply a service name only; never put secrets on the command line.\n")
    parser = SafeParser(description=__doc__)
    parser.add_argument("service", choices=[*FIELDS, "show"], nargs="?", default="show")
    args = parser.parse_args()
    path = Path.home() / ".ulanzi/stats.json"
    if path.is_symlink() or path.parent.is_symlink():
        raise ValueError("Refusing a symlinked configuration path")
    data = json.loads(path.read_text()) if path.exists() else {}
    if not isinstance(data, dict): raise ValueError("Configuration must be a JSON object")
    if args.service == "show":
        print("Local configuration present" if path.exists() else "No local configuration yet")
        if path.exists(): print("Permissions:", oct(stat.S_IMODE(path.stat().st_mode)))
        for service in FIELDS:
            if service in data: print(service + ": configured (values hidden)")
        return
    # getpass can echo on redirected input; require a terminal for secret entry.
    import sys
    if not sys.stdin.isatty(): raise ValueError("Run interactive setup in a terminal")
    updates = {}
    for key, label, secret in FIELDS[args.service]:
        value = (getpass.getpass(label + ": ") if secret else input(label + ": ")).strip()
        if not value or any(c in value for c in "\r\n\0"):
            raise ValueError("Values must be nonempty single lines")
        updates[key] = value
    if "platform" in updates and updates["platform"] not in ("threads", "instagram"):
        raise ValueError("Platform must be threads or instagram")
    if args.service == "ga":
        if not updates["propertyId"].isdigit(): raise ValueError("Property ID must be numeric")
        account = Path(updates["serviceAccountFile"]).expanduser().resolve(strict=True)
        if stat.S_IMODE(account.stat().st_mode) & 0o077:
            raise ValueError("Service-account file must be owner-only; run chmod 600 on that file")
        key = json.loads(account.read_text())
        if not key.get("client_email") or not key.get("private_key"):
            raise ValueError("Service-account file requires client_email and private_key")
        updates["serviceAccountFile"] = str(account)
    if "handle" in updates: updates["handle"] = updates["handle"].lstrip("@")
    section = "social" if args.service == "social-handle" else args.service
    if not isinstance(data.get(section, {}), dict): raise ValueError("Existing section must be an object")
    data.setdefault(section, {}).update(updates)
    save(path, data)
    print("Saved locally with mode 0600. This is plaintext, not encrypted.")

if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, EOFError, KeyboardInterrupt):
        raise SystemExit("Setup failed; check inputs, file permissions and JSON. No values were printed.")

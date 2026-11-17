#!/usr/bin/env python3
"""Generate original geometric icons using only Python's standard library."""
from pathlib import Path
import struct
import zlib

ROOT = Path(__file__).resolve().parents[1]
ICONS = ['ai_usage_logo', 'category', 'claude', 'openai', 'cursor', 'grokbot',
         'attention', 'disk', 'skool', 'stripe', 'revenuecat', 'eth', 'ga',
         'social', 'grokit', 'calendar']

def icon(index):
    size = 128
    accent = [(72, 196, 180), (115, 160, 244), (242, 171, 91), (175, 143, 237)][index % 4]
    pixels = bytearray()
    for y in range(size):
        pixels.append(0)
        for x in range(size):
            color = (20, 25, 34)
            if 12 <= x < 116 and 12 <= y < 116 and (x < 15 or x >= 113 or y < 15 or y >= 113):
                color = accent
            for bar in range(4):
                height = 20 + ((index + bar * 3) % 7) * 8
                if 26 + bar * 20 <= x < 39 + bar * 20 and 98 - height <= y < 98:
                    color = accent
            pixels.extend(color)
    def chunk(name, data):
        return struct.pack('!I', len(data)) + name + data + struct.pack('!I', zlib.crc32(name + data))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', size, size, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(bytes(pixels), 9)) + chunk(b'IEND', b'')

def main():
    plugin = next((ROOT / 'plugin').iterdir())
    for index, name in enumerate(ICONS):
        (plugin / 'assets/icons' / (name + '.png')).write_bytes(icon(index))
    (ROOT / 'profile/ai-usage-kit.ulanziProfile/AI Usage Kit.png').write_bytes(icon(0))

if __name__ == '__main__': main()

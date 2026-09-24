#!/usr/bin/env python3
"""Damage for the cross-check: parses just enough of a real exFAT volume — one the operating
system made and wrote — to damage it on purpose, on a disk image or loop device only.

  crosscheck.py <device> free <file>     marks the file's clusters free in the bitmap
  crosscheck.py <device> lost            marks 64 unused clusters in use
  crosscheck.py <device> boot            zeroes the main boot region's checksum sector
  crosscheck.py <device> crosslink <a> <b>   points file b at file a's first cluster
"""
import struct, sys

def main():
    path, action, *names = sys.argv[1:]
    with open(path, "r+b") as disk:
        mbr = disk.read(512)
        start = struct.unpack_from("<I", mbr, 0x1be + 8)[0] if mbr[3:11] != b"EXFAT   " else 0
        disk.seek(start * 512); vbr = disk.read(512)
        fat_off, fat_len, heap, count, root = struct.unpack_from("<IIIII", vbr, 0x50)
        spc = 1 << vbr[0x6d]; cluster_bytes = 512 * spc
        def sector(c): return start + heap + (c - 2) * spc
        def fat(c):
            disk.seek((start + fat_off) * 512 + c * 4); return struct.unpack("<I", disk.read(4))[0]
        def chain(first, contiguous, length):
            n = (length + cluster_bytes - 1) // cluster_bytes
            if contiguous: return list(range(first, first + n))
            out, c = [], first
            while len(out) < n and 2 <= c < 0xfffffff7: out.append(c); c = fat(c)
            return out
        # The root directory's entries.
        entries, bitmap = [], None
        for c in chain(root, False, 1 << 30):
            disk.seek(sector(c) * 512); data = disk.read(cluster_bytes)
            for off in range(0, len(data), 32): entries.append((c, off, data[off:off + 32]))
            if any(e[2][0] == 0 for e in entries): break
        files = {}
        for i, (c, off, e) in enumerate(entries):
            if e[0] == 0x81: bitmap = struct.unpack_from("<I", e, 20)[0]
            if e[0] == 0x85:
                stream = entries[i + 1][2]; n = stream[3]
                name = b"".join(entries[i + 2 + k][2][2:32] for k in range((n + 14) // 15)).decode("utf-16-le")[:n]
                files[name] = (i, stream[1] & 2 != 0, struct.unpack_from("<I", stream, 20)[0], struct.unpack_from("<Q", stream, 24)[0])
        def set_bit(c, used):
            disk.seek(sector(bitmap) * 512 + (c - 2) // 8); b = disk.read(1)[0]
            b = b | (1 << ((c - 2) % 8)) if used else b & ~(1 << ((c - 2) % 8))
            disk.seek(sector(bitmap) * 512 + (c - 2) // 8); disk.write(bytes([b]))
        if action == "free":
            _, contiguous, first, length = files[names[0]]
            for c in chain(first, contiguous, length)[2:10]: set_bit(c, False)
        elif action == "lost":
            for c in range(count - 100, count - 36): set_bit(c, True)
        elif action == "boot":
            disk.seek((start + 11) * 512); disk.write(bytes(512))
        elif action == "crosslink":
            a, b = files[names[0]], files[names[1]]
            i = b[0]; c, off, stream = entries[i + 1]
            stream = bytearray(stream); struct.pack_into("<I", stream, 20, a[2])
            # The entry set's checksum, so only the sharing is wrong.
            k = entries[i][2][1] + 1
            data = bytearray(b"".join(e[2] for e in entries[i:i + k])); data[32:64] = stream
            s = 0
            for j, byte in enumerate(data):
                if j in (2, 3): continue
                s = (((s << 15) | (s >> 1)) & 0xffff) + byte & 0xffff
            struct.pack_into("<H", data, 2, s)
            for j in range(k):
                ec, eo, _ = entries[i + j]; disk.seek(sector(ec) * 512 + eo); disk.write(data[j * 32:(j + 1) * 32])
        print(f"damaged: {action} {' '.join(names)}")

main()

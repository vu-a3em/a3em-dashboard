"""Makes a file on a test card's exFAT volume record fewer bytes than it holds, as a recorder that
lost power before syncing leaves its log: the data stays on the card, past the recorded end.

    python3 shorten.py <disk image> <path on the card> <bytes to record>

Only the file's directory entry changes — its two lengths, and the entry set's checksum. The
volume starts where the helper's layout puts it, at sector 4096. Disk images only.
"""
import struct
import sys

SECTOR = 512
VOLUME = 4096 * SECTOR


def checksum(entries: bytes) -> int:
    value = 0
    for index, byte in enumerate(entries):
        if index in (2, 3):
            continue
        value = (((value >> 1) | ((value & 1) << 15)) + byte) & 0xFFFF
    return value


def main(image: str, path: str, length: int) -> None:
    with open(image, "r+b") as disk:
        disk.seek(VOLUME)
        boot = disk.read(SECTOR)
        heap = struct.unpack_from("<I", boot, 0x58)[0]
        root = struct.unpack_from("<I", boot, 0x60)[0]
        cluster_bytes = SECTOR << boot[0x6D]

        def cluster_at(cluster: int) -> int:
            return VOLUME + heap * SECTOR + (cluster - 2) * cluster_bytes

        directory = root
        parts = path.split("/")
        for depth, part in enumerate(parts):
            disk.seek(cluster_at(directory))
            data = disk.read(cluster_bytes)
            for offset in range(0, len(data), 32):
                if data[offset] != 0x85:
                    continue
                count = data[offset + 1]
                entries = bytearray(data[offset : offset + 32 * (count + 1)])
                length_chars = entries[32 + 3]
                name = "".join(entries[64 + 32 * (i // 15) + 2 + 2 * (i % 15) : 64 + 32 * (i // 15) + 4 + 2 * (i % 15)].decode("utf-16-le") for i in range(length_chars))
                if name.lower() != part.lower():
                    continue
                if depth < len(parts) - 1:
                    directory = struct.unpack_from("<I", entries, 32 + 20)[0]
                    break
                struct.pack_into("<Q", entries, 32 + 8, length)
                struct.pack_into("<Q", entries, 32 + 24, length)
                struct.pack_into("<H", entries, 2, checksum(bytes(entries)))
                disk.seek(cluster_at(directory) + offset)
                disk.write(entries)
                return
            else:
                sys.exit(f"{part} not found on the card")
        sys.exit(f"{path} not found on the card")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]))

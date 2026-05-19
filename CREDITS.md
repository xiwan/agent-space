# Credits

Agent Space relies on third-party assets that require attribution.

## Pixel Viewer (`/pixel.html`)

### Character Sprites — `public/pixel/characters/char_0.png` … `char_5.png`

- **Pack**: MetroCity — Free Topdown Character Pack
- **Author**: JIK-a-4
- **Source**: https://jik-a-4.itch.io/metrocity-free-topdown-character-pack
- **License**: free with attribution required

### Visual Reference

The pixel office layout, character animation conventions (7×3 frame grid:
down/up/right rows × 3 walk frames + sit frame), and overall aesthetic are
derived from the open-source project:

- **Project**: [piraminet/pixel-office](https://github.com/piraminet/pixel-office)
- **License**: MIT

We do not vendor pixel-office source code; only the visual convention is
re-implemented in `src/pixel/PixelRenderer.js`.

### Background

`public/pixel/oficina-placeholder.png` is a generated placeholder included
in this repository. The original `oficina.png` referenced by pixel-office is
a paid asset by Donarg and is **not** distributed here. The renderer falls
back to the placeholder automatically if `oficina.png` is absent.

---

## Phaser

`index.html` (the Phaser-based Agent Space view) uses **Phaser 4**, MIT licensed.
See https://github.com/phaserjs/phaser.

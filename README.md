# traces — interface

Screens for the Traces app, converted from Figma into plain HTML/CSS/JS.

## Structure

```
traces/
├── index.html            S01 — Welcome (default)
├── css/
│   ├── base.css          Shared fonts, design tokens, reset (used by every screen)
│   └── s01-welcome.css   Screen-specific styles
├── screens/              Additional screens will live here (S02–S40)
└── assets/
    ├── fonts/            Vito Extended / Vito Wide (.otf)
    └── images/           Photos and textures exported from Figma
```

## Running

Open `index.html` in a browser, or serve the folder:

```
python3 -m http.server 8000
```

## Notes

- **Fonts**: Vito Extended (Regular/Medium) and Vito Wide (Regular/Medium) are included.
  The handwritten blue captions use **Lumend Blur Demo** — drop
  `LumendBlur-Regular_demo.otf` into `assets/fonts/` and it is picked up
  automatically (a script fallback is used until then).
- **Images**: all Figma assets are stored locally in `assets/images/` (the
  Figma-hosted URLs expire after 7 days, so they are not referenced).
- Design source: Figma file `Untitled (Copy)`, frame `S01--Welcome--Default`.

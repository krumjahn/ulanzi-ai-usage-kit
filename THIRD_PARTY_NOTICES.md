# Third-party notices

The root MIT license covers the original kit code, documentation, and new
geometric icons. It does not relicense third-party software or grant rights to
service names or trademarks.

## ws 8.20.1

`plugin/com.ulanzi.ulanzideck.UsageStat.ulanziPlugin/node_modules/ws/` contains
[ws 8.20.1](https://github.com/websockets/ws/tree/8.20.1), distributed under MIT.
Its original `LICENSE` is included unchanged (copyright 2011 Einar Otto Stangvik;
copyright 2013 Arnout Kazemier and contributors; copyright 2016 Luigi Pinca and contributors).

All 19 included files were compared byte-for-byte using Git blob hashes against
upstream tag `8.20.1`, tree `5d9b316230ea931532a6671cc450f18c11edd02f`.
The package is vendored so the installer does not run npm or download code.
Optional native accelerators are not bundled.

## Excluded material

The original Ulanzi Node SDK package declared MIT in its package metadata, but
was unused by the main plugin and lacked a bundled license text. It is omitted.
The adjacent browser SDK scripts and CSS had no established license in the
source kit; they are omitted and replaced with a small original inspector
client and styles. This is not the official Ulanzi SDK.

All original raster artwork and profile images were omitted because their
provenance was not established. Replacement icons are reproducible from
`tools/generate-icons.py` and contain no third-party logos, fonts, or metadata.
The separate YouTube statistics plugin, Ulanzi Studio, OpenUsage, AttentionLedger,
and service-provider applications are not distributed here. Obtain and use
those separately under their own terms.

## Documentation images

Images in `docs/images/` were supplied by Keith for publication as documentation
of his setup. They are not reusable plugin icon assets. Third-party interfaces,
service marks, and logos visible in them remain the property of their respective
owners; publication does not imply endorsement or grant rights to those marks.
The original Library uploads are preserved. Published images are checked for
private metadata, and their reviewed bytes are recorded in
`tests/documentation-images.json`.

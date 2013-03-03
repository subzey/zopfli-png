zopfli-png
==========

PNG optimizer using zopfli deflate packer

Description
-----------

Recently [zopfli](https://code.google.com/p/zopfli/) DEFLATE algorithm was announced. As PNG IDAT section are actually DEFLATE compressed, this algorithm can be used for compressing PNG. This script actually does it.

Please note that neither pixel data, not filters applied to image data are not changed. This script may be treated mostly like DeflOpt replacemnt. That means, PngOUT or other PNG compressing tools must be applied before this one.

Requirements
------------

This is a node.js script. So it requires [node.js](http://nodejs.org/) first of all.

This package includes zopfli.exe. In other OSes it is much easier to use `gcc`, so go ahead, `git pull` https://code.google.com/p/zopfli/ and `make` it.

Zopfli binary may be placed in `bin/` subdirectory or set in `path`.

Usage
-----

`node zopfli-png.js [zopfli modifiers] file1.png [file2.png ...]`

where `zopfli modifiers` is one or more zopfli modifiers. All arguments starting with '-' will be passed to zopfli as-is.

Actually, there are only a few of them that makes sense in this script: `-v` (verbose) and iteration count modifiers: 
`--i5`
`--i10`
`--i15`
`--i25`
`--i50`
`--i100`
`--i250`
`--i500`
`--i1000`

Licence
-------

Awesome zopfli algorithm and implementation are authored by Jyrki Alakuijala, Ph.D. and Lode Vandevenne, M.Sc. and licensed with [Apache Licence 2.0](http://www.apache.org/licenses/LICENSE-2.0).

Other wrapping code (i.e., `zopfli-png.js`, `crc32crypto.js` and `pngstream.js`) is licenced with [WTFPL Licence 2.0](http://www.wtfpl.net/txt/copying/)
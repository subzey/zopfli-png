zopfli-png
==========

PNG optimizer using zopfli deflate packer

Description
-----------

Recently [zopfli](https://code.google.com/p/zopfli/) DEFLATE algorithm was announced.
As PNG IDAT section are actually DEFLATE compressed, this algorithm can be used for
compressing PNG. This script actually does it.

Please note that neither pixel data, not filters applied to image data are not changed.
This script may be treated mostly like DeflOpt replacement. That means, PngOUT or other
PNG compressing tools must be applied before this one.

Requirements
------------

This is a node.js script. So it requires [node.js](http://nodejs.org/) first of all.

This package includes zopfli.exe. In other OSes it is much easier to use `gcc`, so go ahead,
`git clone https://code.google.com/p/zopfli/` and `make` it.

Zopfli binary may be placed in `bin/` subdirectory or set in `path`.

Usage
-----

`node zopfli-png.js [options] file1.png [file2.png ...]`

where `options` is one or more modifiers.

The most important are iteration count modifiers, these are passed to zopfli binary:
`--i5`
`--i10`
`--i15`
`--i25`
`--i50`
`--i100`
`--i250`
`--i500`
`--i1000`

Higher the number, slower and better the compression.

Other options:

`--force`, force write even if resulting PNG file is bigger. Zopfli is darn good, but it is not a silver bullet.

`--silent`, do not show any messages. Except maybe most wild errors.

`--splitlast`, do block splitting last instead of first. This option may reduce the size of output file. Requires Zopfli 1.0.0 (April 25, 2013)

`--help`, if you want to read this section once again.


Licence
-------

Awesome zopfli algorithm and implementation are authored by Jyrki Alakuijala, Ph.D.
and Lode Vandevenne, M.Sc. and licensed with [Apache Licence 2.0](http://www.apache.org/licenses/LICENSE-2.0).

Other wrapping code (i.e., `zopfli-png.js`, `crc32crypto.js` and `pngstream.js`)
is licenced with [WTFPL Licence 2.0](http://www.wtfpl.net/txt/copying/)

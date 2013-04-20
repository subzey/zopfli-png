0.1.2
-----

* New file size now examined chunk-wise. In other words, file is written if any of the chunks is smaller after recompression (previous behavior: if summary size of all chunks is smaller). And if any chunk became bigger, the original one is used.
* Fixed multiple IDAT chunks regression.


0.1.1
-----

* Added APNG support.
* Added `--force` and `--silent` command line options.
* Unrecognized options will not be passed to zopfli binary anymore.
* Slightly less shitcode.
* Slightly more comments in source.

Unversioned (well, let it be 0.1.0)
-----------------------------------

Initial commit

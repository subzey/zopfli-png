#!/usr/bin/env node

var VERSION = '0.1.3';
var RE_IS_DATA_CHUNK = /^(?:IDAT|fdAT)$/;
var RE_IS_APNG_ORDERED_CHUNK = /^(?:fcTL|fdAT)$/;

var ZOPFLI_MODIFIERS = [
	'--i5',
	'--i10',
	'--i15',
	'--i25',
	'--i50',
	'--i100',
	'--i250',
	'--i500',
	'--i1000'
];

var returnCodes = {
	'OK': 0,
	'HELP': 1,
	'UNKNOWN_OPTIONS': 2,
	'BINARY_LOST': 3
};

var Fs = require('fs');
var Path = require('path');
var Os = require('os');
var Zlib = require('zlib');
var ChildProcess = require('child_process');

var PNGStream = require('./node_modules/pngstream');
var Crc32 = require('./node_modules/crc32crypto');

/**
 * Execute not more than one heavy process at given time
 * @constructor
 */
function LaunchQueue(){
	this._queue = [];
}

/**
 * Similar to ChildProcess.spawn
 *
 * @arg {string} executable
 * @arg {Array} args
 * @arg {Function} callback Will be inoked when spawn is actually called
 */
LaunchQueue.prototype.spawn = function(executable, args, callback){
	var self = this;
	if (this._isBusy){
		this._queue.push(arguments);
		return;
	}
	self._isBusy = true;
	var process = ChildProcess.spawn(executable, args);
	callback(process);
	process.on('exit', function(){
		self._isBusy = false;
		if (self._queue.length){
			self.spawn.apply(self, self._queue.shift());
		}
	});
};

LaunchQueue.prototype._isBusy = false;

LaunchQueueInstance = new LaunchQueue();

/**
 * Passing data to zopfli binary via stdin/stdout is a pure headache
 * Workaround via temporary files
 *
 * @constructor
 * @arg {Object} [options]
 */
function RecompressStream (options){
	var self = this;
	this._options = options || {};

	this._appTmpDir = Os.tmpDir() + '/zopflipng';
	// Ensure temporary directory exists (synchronous)
	if (!Fs.existsSync(this._appTmpDir)){
		Fs.mkdirSync(this._appTmpDir);
	}
	// Pick raw data filename (synchronous)
	var baseName = Path.basename(typeof this._options.filename === 'string' ? this._options.filename : 'idat');
	var i = 0;
	do {
		this._rawFilename = this._appTmpDir + '/' + baseName + (i !== 0 ? '[' + i + ']': '') + '.raw';
		i++;
	} while (Fs.existsSync(this._rawFilename));

	// Create file synchronously (File existence is a kinda mutex)
	var fd = Fs.openSync(this._rawFilename, 'w');
	Fs.closeSync(fd);
	fd = null;

	// Create zlib stream piped to write stream
	this._rawWriteStream = Fs.createWriteStream(this._rawFilename);
	this._zlibStream = Zlib.createInflate();
	this._zlibStream.pipe(this._rawWriteStream);

	// Once raw data completed
	this._rawWriteStream.on('close', function(){
		// Sanitize object
		delete self._zlibStream;
		delete self._rawWriteStream;

		// Get real FS filename
		Fs.realpath(self._rawFilename, function(err, realPath){
			if (err){
				if (!self._isDestroyed){
					self.emit('error', 'Could not open temporary file ' + self._rawFilename);
				}
				return;
			}
			self._rawFilename = realPath;
			// Once it done start zopfli binary (maybe delayed)
			LaunchQueueInstance.spawn('zopfli', (options.modifiers || []).concat(['--zlib', realPath]), function(zopfli){
				// Pipe process
				zopfli.stdout.pipe(process.stdout);
				zopfli.stderr.pipe(process.stderr);
				zopfli.on('error', function(e){
					self.emit('error', 'Cannot start zopfli. Please ensure it is in bin directory or somewhere in path');
					return;
				});
				zopfli.on('exit', function(code){
					if (code !== 0){
						self.emit('error', 'Zopfli returned non-zero code ' + code);
					}
					var outFileName = realPath + '.zlib';
					// Ensure file exists, get its stats and emit "done"
					Fs.stat(outFileName, function(error, stat){
						if (error){
							self.emit('error', 'Could not find Zopfli output file');
						} else {
							self.outFileName = outFileName;
							self.size = stat.size;
							self.done = true;
							self.emit('done', outFileName, stat);
						}
					});
				});
			});
		});
	});

	if (this._options.bubbleError){
		self.on('error', function(description){
			self._options.bubbleError.emit('error', description);
		});
	}
}

require('util').inherits(RecompressStream, require('events').EventEmitter);

/**
 * Clean up temporary files
 */
RecompressStream.prototype.destroy = function(){
	var self = this;

	this._isDestroyed = true;

	if (this._rawWriteStream){
		this._rawWriteStream.removeAllListeners();
		this._rawWriteStream.end(undefined, undefined, function(){
			if (self._rawFilename){
				Fs.unlink(self._rawFilename);
				delete self._rawFilename;
			}
		});
		delete this._rawWriteStream;
	} else if (this._rawFilename){
		Fs.unlink(this._rawFilename);
		delete this._rawFilename;
	}
	if (this.outFileName){
		Fs.unlink(this.outFileName);
		delete this.outFileName;
	}
};

RecompressStream.prototype.write = function(buf){
	this._zlibStream.write(buf);
};

RecompressStream.prototype.end = function(){
	this._zlibStream.end();
};


/**
 * Main png processing object
 * @constructor
 * @arg {string} filename
 * @arg {Object} options
 */
function ZopfliPng (filename, options){
	var self = this;
	options = options || {};

	var readStream = Fs.createReadStream(filename);
	readStream.on('error', function(){
		self.emit('error', 'Could not open file ' + filename);
	});

	this._pngHeader = null;
	this._chunks = [];

	var pngStream = new PNGStream.ParserStream();
	readStream.pipe(pngStream);

	pngStream.on('error', function(){
		self.emit('error', 'Error parsing PNG format');
		readStream.destroy();
	});

	this._lastChunk = null;

	pngStream.on('png-header', function(buf){
		self._pngHeader = buf;
	});

	pngStream.on('chunk-header', function(buf, meta){
		var isDataChunk = RE_IS_DATA_CHUNK.test(meta.name);
		if (!self._lastChunk || meta.name !== self._lastChunk.name || !isDataChunk){
			if (self._lastChunk && self._lastChunk.recompressStream){
				self._lastChunk.recompressStream.end();
			}
			self._lastChunk = {
				'name': meta.name,
				'length': meta.length,
				'isData': isDataChunk,
				'isApng': RE_IS_APNG_ORDERED_CHUNK.test(meta.name)
			};
			self._chunks.push(self._lastChunk);
		}
		if (self._lastChunk.isApng){
			self._lastChunk._chopApngIndex = true;
		}
	});

	pngStream.on('chunk-body', function(buf){
		var currentChunk = self._lastChunk;
		if (currentChunk._chopApngIndex){
			if (currentChunk._stashedBuffer){
				buf = Buffer.concat([currentChunk._stashedBuffer, buf]);
				delete currentChunk._stashedBuffer;
			}
			if (buf.length < 4){
				currentChunk._stashedBuffer = buf;
				return;
			}
			delete currentChunk._chopApngIndex;
			currentChunk.apngIndex = buf.readUInt32BE(0);
			buf = buf.slice(4);
		}
		if (currentChunk.isData){
			if (!currentChunk.recompressStream){
				currentChunk.recompressStream = new RecompressStream({
					'filename': filename,
					'modifiers': options.modifiers,
					'bubbleError': self
				});
			}
			currentChunk.recompressStream.write(buf);
		}
		if (!currentChunk.data){
			currentChunk.data = buf;
		} else {
			currentChunk.data = Buffer.concat([currentChunk.data, buf]);
		}
	});

	pngStream.on('chunk-crc', function(buf){
		self._lastChunk.crc = buf;
	});

	pngStream.on('close', function(){
		var pendingTasks = self._chunks.map(function(chunk){
			return chunk.recompressStream;
		}).filter(function(stream){
			return stream && typeof stream.outFileName !== undefined;
		});
		var pendingTasksCount = pendingTasks.length;
		if (pendingTasksCount === 0){
			assemble();
		} else {
			pendingTasks.forEach(function(stream){
				stream.on('done', function(){
					pendingTasksCount--;
					if (pendingTasksCount === 0){
						assemble();
					}
				});
			});
		}
	});

	function assemble(){
		// Detect if new IDAT size is smaller
		if (!options.force){
			var originalIdatSize = 0;
			var newIdatSize = 0;
			for (var i=self._chunks.length; i--; ){
				var chunk = self._chunks[i];
				if (!chunk.isData){
					continue;
				}
				originalIdatSize += chunk.data.length;
				newIdatSize += Math.min(chunk.recompressStream.size, chunk.data.length);
			}
			if (newIdatSize >= originalIdatSize){
				self.emit('skip');
				return;
			}
		}
		var writeStream = Fs.createWriteStream(filename);
		writeStream.write(self._pngHeader);

		var chunkPointer = -1;
		var apngChunkIndex = -1;
		function writeNextChunk(){
			// Drop call stack
			process.nextTick(function(){
				chunkPointer++;
				var chunk = self._chunks[chunkPointer];
				if (!chunk){
					self.emit('done');
					return;
				}
				var crc32 = Crc32.createHash('crc32');

				// Decide which chunk is used: original one or rcompressed one
				var writeRecompressed = false;
				if (chunk.isData){
					if (!options.force && chunk.data.length > chunk.recompressStream.size){
						writeRecompressed = true;
					}
					self.emit('write-progress', {
						'chunkName': chunk.name,
						'action': writeRecompressed ? 'write' : 'skip',
						'oldSize': chunk.data.length,
						'newSize': chunk.recompressStream.size
					});
				}


				// Write chunk length
				var length = 0;
				if (writeRecompressed){
					length = chunk.recompressStream.size;
				} else if (chunk.data){
					length = chunk.data.length;
				}
				if (chunk.isApng){
					length += 4;
				}
				var lengthBuf = new Buffer(4);
				lengthBuf.writeUInt32BE(length, 0);
				writeStream.write(lengthBuf);

				// Write chunk name
				writeStream.write(chunk.name);
				crc32.update(chunk.name);

				// Write APNG-specific chunk index that was chopped
				if (chunk.isApng){
					apngChunkIndex++;
					var chunkIndexBuffer = new Buffer(4);
					chunkIndexBuffer.writeUInt32BE(apngChunkIndex, 0);
					writeStream.write(chunkIndexBuffer);
					crc32.update(chunkIndexBuffer);
				}
				// Write raw data
				if (writeRecompressed){
					var readStream = Fs.createReadStream(chunk.recompressStream.outFileName);
					readStream.on('data', function(buf){
						writeStream.write(buf);
						crc32.update(buf);
					});
					readStream.on('end', function(){
						// "binary" string encoding is deprecated
						writeStream.write(new Buffer(crc32.digest('hex'), 'hex'));
						return writeNextChunk();
					});
				} else {
					if (chunk.data){
						writeStream.write(chunk.data);
						crc32.update(chunk.data);
					}

					writeStream.write(new Buffer(crc32.digest('hex'), 'hex'));
					return writeNextChunk();
				}
			});
		}
		writeNextChunk();
	}

	function cleanup(){
		for (var i=this._chunks.length; i--; ){
			if (this._chunks[i].recompressStream){
				this._chunks[i].recompressStream.destroy();
			}
		}
	}

	this.on('error', cleanup);
	this.on('done', cleanup);
	this.on('skip', cleanup);
}
require('util').inherits(ZopfliPng, require('events').EventEmitter);

var files = [];
var compressionModifiers = [];
var options = {};
var unknownKeys = [];

process.argv.slice(2).forEach(function(arg){
	if (arg[0] === '-'){
		if (ZOPFLI_MODIFIERS.indexOf(arg) !== -1){
			compressionModifiers.push(arg);
		} else if (arg === '--help'){
			options.help = true;
		} else if (arg === '--force'){
			options.force = true;
		} else if (arg === '--silent'){
			options.silent = true;
		} else {
			unknownKeys.push(arg);
		}
	} else {
		files.push({filename: arg});
	}
});

if (compressionModifiers.length > 1){
	process.stderr.write('More than one compression options provided:\n  ' + compressionModifiers.join('\n  ') + '\n');
	process.exit(returnCodes.UNKNOWN_OPTIONS);
}

if (unknownKeys.length){
	process.stderr.write('Unknown options:\n  ' + unknownKeys.join('\n  ') + '\nUse --help to get list of options\n');
	process.exit(returnCodes.UNKNOWN_OPTIONS);
}

if (files.length === 0 || options.help){
	process.stdout.write('zopfli-png v.' + VERSION + '\n\n');
	process.stdout.write('Usage:\nnode ' + Path.basename(process.argv[1]) + ' [options] file1.png [file2.png ...]\n\n');
	process.stdout.write('Options:\n');
	process.stdout.write('  --help  Show this help\n');
	process.stdout.write('  --force  Force write file even if bigger\n');
	process.stdout.write('  --silent  Execute silently (do not show messages in console)\n');
	process.stdout.write('Compression, faster (less compression) to slower (more compression):\n');
	process.stdout.write('  ' + ZOPFLI_MODIFIERS.join('\n  ') + '\n');
	process.exit(returnCodes.HELP);
}

var realpathRequests = files.length;
files.forEach(function(filenameProps){
	Fs.realpath(filenameProps.filename, function(err, resolved){
		if (!err){
			filenameProps.resolved = resolved;
		}
		if (--realpathRequests === 0){
			try {
				process.chdir(process.argv[1] + '/../bin');
			} catch (e) {}
			nextFile();
		}
	});
});

function nextFile(){
	var filenameProps = files.shift();
	if (!filenameProps){
		return;
	}
	if (!options.silent){
		process.stdout.write(filenameProps.filename + '...\n');
	}
	var z = new ZopfliPng(filenameProps.resolved || filenameProps.filename, {'modifiers': compressionModifiers, 'force': !!options.force});
	z.on('error', function(e){
		if (!options.silent){
			process.stderr.write(e + '\n');
		}
		nextFile();
	});
	z.on('done', function(){
		if (!options.silent){
			process.stdout.write('Done.\n');
		}
		nextFile();
	});
	z.on('skip', function(){
		if (!options.silent){
			process.stdout.write('Recompessed chunk sizes are not less than original ones. Orginal file unchanged.\n');
		}
		nextFile();
	});
	z.on('write-progress', function(stats){
		if (!options.silent){
			process.stdout.write('  ' + stats.chunkName + ': ' + stats.oldSize + ' -> ' + stats.newSize + ', ' + (stats.action === 'write' ? 'writing' : 'skipping') +  '...\n');
		}
	});
}
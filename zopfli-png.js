#!/usr/bin/env node

var VERSION = '0.1.1a';
var RE_IS_DATA_CHUNK = /^(?:IDAT|fdAT)$/;
var RE_IS_APNG_ORDERED_CHUNK = /^(?:fcTL|fdAT)$/;

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
 * Similar to ChildPrecess.spawn
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
				self.emit('error', 'Could not open temporary file ' + self._rawFilename);
				return;
			}
			// Once it done start zopfli binary (maybe delayed)
			LaunchQueueInstance.spawn('zopfli', (options.modifiers || []).concat(['--zlib', realPath]), function(zopfli){
				// Pipe process
				zopfli.stdout.pipe(process.stdout);
				zopfli.stderr.pipe(process.stderr);
				zopfli.on('exit', function(code){
					// Remove raw data file
					Fs.unlink(realPath);
					if (code !== 0){
						self.emit('error', 'Zopfli returned non-zero code ' + code);
					}
					var outFileName = realPath + '.zlib';
					// Ensure file exists, get its stats and emit "done"
					Fs.stat(outFileName, function(error, stat){
						if (error){
							self.emit('error', 'Could notfind Zopfli output file');
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
	// TODO: actually destroy anything
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
			console.log(currentChunk.apngIndex, buf);
			currentChunk.originalRawBytes = (currentChunk.originalRawBytes || 0) + buf.length;
		} else {
			if (!currentChunk.data){
				currentChunk.data = buf;
			} else {
				currentChunk.data = Buffer.concat([currentChunk.data, buf]);
			}
		}
	});

	pngStream.on('chunk-crc', function(buf){
		if (self._lastChunk.recompressStream){
			self._lastChunk.recompressStream.end();
		}
		self._lastChunk.crc = buf;
	});

	pngStream.on('close', function(){
		var pendingTasks = self._chunks.map(function(chunk){
			return chunk.recompressStream;
		}).filter(function(stream){
			return stream && typeof stream.outFileName !== undefined;
		});
		var pendingTasksCount = pendingTasks.length;
		console.log(pendingTasksCount);
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
		var originalIdatSize = 0;
		var newIdatSize = 0;
		for (var i=self._chunks.length; i--; ){
			var chunk = self._chunks[i];
			if (!chunk.isData){
				continue;
			}
			originalIdatSize += chunk.originalRawBytes;
			newIdatSize += chunk.recompressStream.size;
		}
		console.log(originalIdatSize + ' -> ' + newIdatSize);
	}
}
require('util').inherits(ZopfliPng, require('events').EventEmitter);

var modifiers = [];
var files = [];

process.argv.slice(2).forEach(function(arg){
	if (arg[0] === '-'){
		modifiers.push(arg);
	} else {
		files.push({filename: arg});
	}
});

if (files.length === 0){
	process.stdout.write('Usage:\nnode ' + Path.basename(process.argv[1]) + ' [zopfli modifiers] file1.png [file2.png ...]');
	process.exit(1);
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
	console.log(filenameProps.filename + '...');
	var z = new ZopfliPng(filenameProps.resolved || filenameProps.filename, {modifiers: modifiers});
	z.on('error', function(e){
		console.error(e);
		nextFile();
	});
	z.on('done', function(stats){
		console.log('Done. IDAT size: ' + stats.oldIdatLength + ' -> ' + stats.newIdatLength);
		nextFile();
	});
}
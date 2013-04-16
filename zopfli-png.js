#!/usr/bin/env node

var VERSION = '0.1.1a';

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
	var baseName = Path.basename(typeof this.options.filename === 'string' ? this.options.filename : 'idat');
	var i = 0;
	do {
		this._rawFilename = appTmpDir + '/' + baseName + (i !== 0 ? '[' + i + ']': '') + '.raw';
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
					Fs.unlink(self._rawFilename);
					if (code !== 0){
						self.emit('error', 'Zopfli returned non-zero code ' + code);
					}
					var outFileName = realPath + '.zlib';
					// Ensure file exists, get its stats and emit "done"
					Fs.stat(outFileName, function(stat){
						if (stat.errno){
							self.emit('error', 'Could notfind Zopfli output file');
						} else {
							self.emit('done', outFileName, stat);
						}
					});
				});
			});
		});
	});
}

/**
 * Clean up temporary files
 */
RecompressStream.prototype.destroy = function(){
	// TODO: actually destroy anything
};

require('util').inherits(RecompressStream, require('events').EventEmitter);

function ZopfliPng (filename, options){
	var readStream = Fs.createReadStream(filename);
	readStream.on('error', function(){
		self.emit('error', 'Could not open file ' + filename);
	});
	
	this._chunks = [];

	var pngStream = new PNGStream.ParserStream();
	readStream.pipe(pngStream);

	pngStream.on('error', function(){
		self.emit('error', 'Error parsing PNG format');
		readStream.destroy();
	});

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
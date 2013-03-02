#!/usr/bin/env node

var Fs = require('fs');
var Path = require('path');
var Os = require('os');
var Zlib = require('zlib');
var ChildProcess = require('child_process');

var PNGStream = require('./node_modules/pngstream');
var Crc32 = require('./node_modules/crc32crypto');

function ZopfliPng (filename, options){
	var self = this;
	options = options || {};

	var STATE_PROLOGUE = 1;
	var STATE_IDAT = 2;
	var STATE_EPILOGUE = 3;

	var state = STATE_PROLOGUE;

	var prologue = []; // of Buffers
	var epilogue = []; // of Buffers
	var newIdat = [];
	var newIdatLength = 0;
	var newIdatHash = Crc32.createHash('crc32');

	var oldIdatLength = 0;

	var tmpFileName;
	var zlibStream = null;
	var tmpFileStream = null;

	var pngReadDone = false;
	var newIdatDone = false;

	function write(buf){
		switch (state){
			case STATE_PROLOGUE:
				prologue.push(buf);
			break;
			case STATE_IDAT:
				oldIdatLength += buf.length;
				zlibStream.write(buf);
			break;
			case STATE_EPILOGUE:
				epilogue.push(buf);
			break;
		}
	}

	var readStream = Fs.createReadStream(filename);
	readStream.on('error', function(){
		self.emit('error', 'Could not open file ' + filename);
	});

	var pngStream = new PNGStream.ParserStream();
	readStream.pipe(pngStream);

	pngStream.on('error', function(){
		self.emit('error', 'Error parsing PNG format');
		readStream.destroy();
	});

	pngStream.on('png-header', write);
	pngStream.on('chunk-header', function(data, parsed){
		if (state === STATE_PROLOGUE && parsed.name === 'IDAT'){
			onIdatStart();
			return;
		}
		if (state === STATE_IDAT && parsed.name !== 'IDAT'){
			onIdatEnd();
		}
		write(data);
	});
	pngStream.on('chunk-body', write);
	pngStream.on('chunk-crc', function(data){
		if (state !== STATE_IDAT){
			write(data);
		}
	});
	pngStream.on('close', function(){
		pngReadDone = true;
		onNewIdatOrPngReadComplete();
	});

	function onIdatStart(){
		state = STATE_IDAT;
		var appTmpDir = Os.tmpDir() + '/zopflipng';
		if (!Fs.existsSync(appTmpDir)){
			Fs.mkdirSync(appTmpDir);
		}
		var baseName = Path.basename(filename);
		var i = 0;
		do {
			tmpFileName = appTmpDir + '/' + baseName + (i !== 0 ? '[' + i + ']': '') + '.raw';
			i++;
		} while (Fs.existsSync(tmpFileName));
		tmpFileStream = Fs.createWriteStream(tmpFileName);
		zlibStream = Zlib.createInflate();
		zlibStream.pipe(tmpFileStream);
		tmpFileStream.on('close', function(){
			Fs.realpath(tmpFileName, function(err, realPath){
				if (err){
					self.emit('error', 'Could not open zopfli optput file ' + tmpFileName);
					return;
				}
				tmpFileName = realPath;
				onTmpFileDone();
			});
		});
	}

	function onIdatEnd(){
		state = STATE_EPILOGUE;
		zlibStream.end();
	}

	function onTmpFileDone(){
		// -c is buggy on windows: returns \r\n instead of \n in binary data
		var args = (options.modifiers || []).concat(['--zlib', tmpFileName]);
		var zopfli = ChildProcess.spawn('zopfli', args);
		zopfli.stdout.pipe(process.stdout);
		zopfli.stderr.pipe(process.stderr);
		zopfli.on('exit', function(code){
			if (code !== 0){
				throw new Error('Zopfli exited with non-zero code ' + code);
			}
			Fs.unlink(tmpFileName);
			var outFileName = tmpFileName + '.zlib';
			Fs.createReadStream(tmpFileName + '.zlib').on('data', function(data){
				newIdat.push(data);
				newIdatLength += data.length;
				newIdatHash.update(data);
			}).on('end', function(){
				Fs.unlink(outFileName);
				newIdatDone = true;
				onNewIdatOrPngReadComplete();
			});
		});
	}

	function onNewIdatOrPngReadComplete(){
		if (!newIdatDone || !pngReadDone){
			return;
		}
		if (newIdatLength >= oldIdatLength){
			onComplete();
			return;
		}

		var writeStream = Fs.createWriteStream(filename);
		writeStream.on('close', onComplete);
		prologue.forEach(function(data){
			writeStream.write(data);
		});
		var buf = new Buffer(4);
		buf.writeUInt32BE(newIdatLength, 0);

		writeStream.write(buf);
		writeStream.write(new Buffer('IDAT'));
		newIdat.forEach(function(data){
			writeStream.write(data);
		});
		writeStream.write(new Buffer(newIdatHash.digest('hex'), 'hex'));
		epilogue.forEach(function(data){
			writeStream.write(data);
		});
		writeStream.end();
	}

	function onComplete(){
		self.emit('done', {oldIdatLength: oldIdatLength, newIdatLength: newIdatLength});
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
'use strict'

var util		= require('util')
  , fs			= require('fs')
  , crypto		= require('crypto')
  , vm			= require('vm')

var lib_paths = process.env.NODE_PATH.split(':')
var modules = { 'smart-require': { exports: startup } }, filesMap = { }, config = { debug: { } }
var loadKey = '', debugPrefixRE = /^\s*\/\*\s*debug\:\s+([a-zA-Z\d\-\._]+)\s*/
var debugEndPrefixRE = /^\s*\*\//
var debugVarRE = /\%([a-zA-Z\d\-_]+)\%/
var cleanPathRE = /\((\/[a-zA-Z-_\d\.\/]+)\:(\d+)\:(\d+)\)/

global.debugConsoleMarker = function(marker) {
	return '[' + marker + '] '
}

function allowDebugTags(tag) {

	if(!('debugList' in config)) {
		config.debugList = config.debug.length > 0 ? config.debug.split(',') : []
	}

	var c = config.debugList, l = c.length; while(l--) {
		var t = c[l]
		if('*' === t) return true
		if(tag.length >= t.length && tag.substr(0, t.length) === t) return true
	}

	return false
}

function makeLoadKey() {
	loadKey = crypto.createHash('md5').update(JSON.stringify(config.debug ? config.debug : "")).digest('hex')
}

function Parser(path) {

	var body = '' + fs.readFileSync(path), state = 0, debugTags = 0, a
	this.lines = body.split('\n')
	this.parsed = []	

	var openDebugSection = false

	while(this.lines.length) {
		var line = this.lines.shift()
		line = line.replace(/[\r\n]+$/, '')
		switch(state) {

		// reading
		case 0:
			if(a = debugPrefixRE.exec(line)) {
				state = 1
				debugTags = a[1]
				if(allowDebugTags(debugTags)) {
					this.currentTag = debugTags
					openDebugSection = true
					this.pushLine(line + ' */')
				}
				else {
					this.pushLine(line)
				}
			}
			else {
				this.pushLine(line)
			}
		break

		case 1:
			if(openDebugSection && (a = debugEndPrefixRE.exec(line))) {
				this.pushLine('')
				state = 0
				openDebugSection = false
			}
			else {
				if(openDebugSection) {
					this.pushLine(this.parseDebugLine(line))
				}
				else {
					this.pushLine(line)
				}
			}
			break
		}
	}

	this.content = this.parsed.join('\n')
	// this.linesMap = JSON.stringify(this.linesMap)
}

Parser.prototype = {

	pushLine: function(line) {
		this.parsed.push(line)
	},

	parseDebugLine: function(line) {
		var a = debugVarRE.exec(line)
		if(a) {
			if(a[1] === 'dt') {
				line = line.substr(0, a.index) + 'debugConsoleMarker("' + this.currentTag + '")' + line.substr(a.index + a[0].length)
			}
		}
		return line
	}
}

function smartRequire(module) {

	// var formattedModule = module[0] !== '.' ? module.replace(/\/\.\//g, '\/') : module
	var formattedModule = module

	if(formattedModule in modules) {
		return modules[formattedModule].exports
	}
	// stage 1. format
	var filePath = null, err = new Error(), stack = err.stack.split('\n')
	if(formattedModule[0] === '.') {
		formattedModule = (cleanPathRE.exec(stack[2])[1].replace(/\/[^\/]+$/, '') + '/' + module).replace(/\/\.\//g, '\/')
		while(true) {
			var index
			if( (index = formattedModule.indexOf('/../')) !== -1 ) {
				var i = index; while(i--) {
					if(formattedModule[i] === '/') {
						formattedModule = formattedModule.substr(0, i) + formattedModule.substr(index + 3)
						break
					}
				}
				continue
			}
			break
		}
	}
	// console.log('filePath '+filePath)

	if(formattedModule in modules) {
		return modules[formattedModule].exports
	}

	var moduleObject = null	

	// stage 2. find module as directori
	if('/' !== formattedModule[0]) {

		// search in upper dirs
		var checkDirs = []

		var path = cleanPathRE.exec(stack[2])[1].split('/')
		for(var i = path.length - 2; i != 0; i--) {
			var part = '/'
			for(var j = 1; j <= i; j ++) {
				part += path[j] + '/'
			}
			checkDirs.push(part + 'node_modules/' + formattedModule)
		}

		for(var i = 0, c = lib_paths.length; i < c; i ++) {
			var modulePath = lib_paths[i] + '/' + module
			checkDirs.push(modulePath)
		}

		for(var i = 0, l = checkDirs.length; i < l; i++) {

			var p = checkDirs[i], f = p + '/index.js'
			if(fs.existsSync(f)) {
				filePath = f
				break
			}

			f = p + '/package.json'
			if(fs.existsSync(f)) {
				module = f
				break
			}
		}
		
	}
	else {
		if('.js' === formattedModule.substr(-3)) {
			filePath = formattedModule
		}
		else {
			// try to load .so
			if('.node' !== formattedModule.substr(-5)) formattedModule += '.node'
			// console.log('.so ' + formattedModule)
			moduleObject = { exports: {} }
			process.dlopen(moduleObject, formattedModule)
		}
		
	}

	if(null !== filePath) {

		var cacheFile = config.cachePath + '/' + loadKey + '.' + crypto.createHash('md5').update(filePath).digest('hex') + '.js'
		// console.log(cacheFile)
		var mtime = fs.statSync(filePath).mtime.getTime()
		// filesMap[cacheFile] = filePath

		if(!fs.existsSync(cacheFile) || fs.statSync(cacheFile).mtime.getTime() !== mtime) {

			var parser = new Parser(filePath)
			
			// fs.writeFileSync(cacheFile + '.lines', parser.linesMap)
			fs.writeFileSync(cacheFile, parser.content)

			fs.utimesSync(cacheFile, Math.floor(mtime / 1000), Math.floor(mtime / 1000))
		}

		// console.log('load ' + filePath)
		filesMap[filePath] = cacheFile
		moduleObject = new Module(cacheFile, filePath)
		moduleObject.loadAndExecuteScript()
	}


	if(null === moduleObject) {
		moduleObject = { exports: startup.originalRequire(module) }
	}

	modules[formattedModule] = moduleObject
	return moduleObject.exports
}

/*
global.getCallerFilePath = function() {
	var err = new Error(), stack = err.stack.split('\n'), path = cleanPathRE.exec(stack[3])[1]
	// console.dir(stack)
	// console.dir(filesMap)
	// if(path in filesMap) path = filesMap[path]
	return path
}
*/


function Module(path, titlePath) {
	this.path = path
	this.titlePath = titlePath ? titlePath : path
	this.exports = {}
}

Module.prototype = {
	loadAndExecuteScript: function() {
		var wrap = vm.runInThisContext('(function (exports, require, module, __filename, __dirname) { ' + fs.readFileSync(this.path) + '\n});', { filename: this.titlePath })
		var args = [this.exports, smartRequire, this, this.titlePath, this.titlePath.replace(/\/[^\/]+$/, '')]
		wrap.apply(this.exports, args)
	}
}


function startup(_config) {
	config = _config
	if(!fs.existsSync(config.cachePath)) {
		fs.mkdirSync(config.cachePath)
	}
	makeLoadKey()
	console.log('loadKey '+loadKey)
	return smartRequire
}

startup.originalRequire = require
startup.filenameFromStack = function(depth, dontClean) {
	var err = new Error(), stack = err.stack.split('\n')
	// console.log(stack.join('\n'))
	var path = dontClean ? stack[depth + 1].replace(/^\s+/,'') : cleanPathRE.exec(stack[depth + 1])[1]
	return path
}

module.exports = startup

var async = require('async');
var ftp = require('ftp');
var fs = require('fs');
var path = require('path');

function createFtpQueue(opts) {

    var client;
    var queue = [];

    function initClient(cb) {
        client = new ftp();
        client.on('ready', cb);
        client.connect(opts.connect);
    }

    function getRemoteName(filename) {
        return path.join(opts.remoteDir, path.relative(opts.dir, filename)).replace(/\\/g, '/'); 
    }

    function doSend(filename) {
        if (!client) {
            initClient(doSend.bind(null, filename));
            return;
        }
        var remoteName = getRemoteName(filename);
        console.log("Uploading " + filename + " as " + remoteName + ".");
        client.put(filename, remoteName, function(err) {
            console.log(err ? "Couldn't upload " + filename + ":\n" + err : filename + ' uploaded.');
            advanceQueue(err);
        });
    }

    function doDelete(filename) {
        if (!client) {
            initClient(doDelete.bind(null, filename));
            return;
        }
        var remoteName = getRemoteName(filename);
        console.log("Deleting  " + remoteName + ".");
        client.delete(remoteName, function(err) {
            console.log(err ? "Couldn't delete " + filename + ":\n" + err : filename + ' deleted.');
            advanceQueue(err);
        });
    }

    function doMkdir(filename) {
        if (!client) {
            initClient(doMkdir.bind(null, filename));
            return;
        }
        var remoteName = getRemoteName(filename);
        console.log("Adding  " + remoteName + ".");
        client.mkdir(remoteName, function(err) {
            console.log(err ? "Couldn't add " + filename + ":\n" + err : filename + ' added.');
            advanceQueue(err);
        });
    }

    function doRmdir(filename) {
        if (!client) {
            initClient(doMkdir.bind(null, filename));
            return;
        }
        var remoteName = getRemoteName(filename);
        console.log("Deleting  " + remoteName + ".");
        client.rmdir(remoteName, function(err) {
            console.log(err ? "Couldn't delete " + filename + ":\n" + err : filename + ' deleted.');
            advanceQueue(err);
        });
    }

    function doList(dirname) {
        if (!client) {
            initClient(doList.bind(null, dirname));
            return;
        }
        var remoteName = getRemoteName(dirname);
        console.log("Listing  " + remoteName + ".");

        // some bs to deal with this callback possibly being called multiple times.
        // the result we want is not always the first or last one called.
        var result = [], resultTimer;
        client.list(remoteName, function(err, list) {
            if (err) {
                result = true;
                console.log("Couldn't list " + dirname + ":\n" + err);
                advanceQueue(err, list);
            }
            if (result === true || result.length) return;
            
            if (list && list.length) {
                result = list;
            }
            if (resultTimer) return;
            resultTimer = setTimeout(function() {
                console.log(dirname + ' listed.');
                advanceQueue(null, result);
            }, 100);
        });
    }

    function execute(entry) {
        var file = entry.file;
        var action = entry.action;
        switch(action) {
            case 'upsert' : doSend(file); break;
            case 'delete' : doDelete(file); break;
            case 'mkdir' : doMkdir(file); break;
            case 'rmdir' : doRmdir(file); break;
            case 'list'   : doList(file); break;
            default       : throw new Error("Unexpected action " + action); break;
        }
    }

    function entryEquals(a, b) {
        return a.action === b.action &&
               a.file === b.file
               a.callback === b.callback;
    }

    function addToQueue(entry) {
        if (queue.slice(1).some(entryEquals.bind(null, entry))) {
            return;
        }
        queue.push(entry);
        if (queue.length === 1) {
            execute(entry);
        }
    }

    function advanceQueue(err, currentResult) {
        var finished = queue.shift();
        if (finished.callback) {
            finished.callback(err, currentResult);
        }
        if (queue.length) {
            execute(queue[0]);
        }
    }

    function addFile(filename) {
        addToQueue({ file : filename, action : 'upsert' });
    }

    function removeFile(filename) {
        addToQueue({ file : filename, action : 'delete' });
    }

    function addDir(filename) {
        addToQueue({ file : filename, action : 'mkdir' });
    }

    function removeDir(filename) {
        addToQueue({ file : filename, action : 'rmdir' });
    }

    function listFiles(dirname, callback) {
        addToQueue({ file : dirname, action : 'list', callback : callback });
    }

    return {
        addFile : addFile,
        removeFile : removeFile,
        addDir : addDir,
        removeDir : removeDir,
        listFiles : listFiles
    };
}

function watchRecursive(dir, opts, onchange, cb) {
    fs.watch(dir, opts, function(event, filename) {
        onchange(event, filename, path.join(dir, filename));
    });
    fs.readdir(dir, function(err, files) {
        function recurse(file, cb) {
            file = path.join(dir, file);
            fs.stat(file, function(err, stat) {
                if (err) return cb(err);

                if (stat.isDirectory()) {
                    return watchRecursive(file, opts, onchange, cb);
                }

                return cb();
            });
        }
        async.each(files, recurse, cb);
    });
}

function makeFile(name, type) {
    return {
        name : name.name || name,
        type : name.type || type
    };
}

function makeFilesViaStat(dirname, files, cb) {
    async.map(files, function(file, cb) {
        fs.stat(path.join(dirname, file), function(err, stat) {
            if (err) return cb(err, stat);
            cb(null, makeFile(file, stat.isDirectory() ? 'd' : '-'));
        })
    }, cb);
}

function fileEqual(a, b) {
    return a.name === b.name && a.type === b.type;
}

function getDirectoryDiff(oldFiles, newFiles) {
    var removed = oldFiles.filter(function(oldFile) {
        return !newFiles.some(fileEqual.bind(null, oldFile));
    });
    var added = newFiles.filter(function(newFile) {
        return !oldFiles.some(fileEqual.bind(null, newFile));
    });

    return {
        added : added,
        removed : removed
    };
}

module.exports = function(opts, cb) {
    var filter = opts.filter;

    var ftpQueue = createFtpQueue(opts);

    var dir = path.resolve('.', opts.dir);

    var firedRecently = {};
    function getAndSetFiredRecently(pathname) {
        if (firedRecently[pathname]) return true;
        firedRecently[pathname] = true;
        setTimeout(function() { delete firedRecently[pathname]; }, opts.minChangePeriod || 250);
        return false;
    }

    function handleDirectoryChange(pathname) {
        async.parallel([
            async.waterfall.bind(async, [
                fs.readdir.bind(fs, pathname),
                makeFilesViaStat.bind(null, pathname)
            ]),
            async.waterfall.bind(async, [
                ftpQueue.listFiles.bind(ftpQueue, pathname),
                function normalizeRemoteFiles(remoteFiles, cb) {
                    cb(null, remoteFiles.map(makeFile)
                        .filter(function(obj) {
                            return obj.name !== '.' &&
                                   obj.name !== '..';
                        }));
                }
            ])
        ], function(err, results) {
            if (err) throw err;
            var localFiles = results[0];
            var remoteFiles = results[1];
            var dirDiff = getDirectoryDiff(remoteFiles, localFiles);
            //console.log(localFiles, remoteFiles, dirDiff);

            dirDiff.added.forEach(function(file) {
                var fullname = path.join(pathname, file.name);
                
                if (getAndSetFiredRecently(fullname)) return;

                if (file.type === 'd') {
                    ftpQueue.addDir(fullname);
                } else {
                    ftpQueue.addFile(fullname);
                }
            });

            dirDiff.removed.forEach(function(file) {
                var fullname = path.join(pathname, file.name);
                
                if (getAndSetFiredRecently(fullname)) return;

                if (file.type === 'd') {
                    ftpQueue.removeDir(fullname);
                } else {
                    ftpQueue.removeFile(fullname);
                }
            });
        });
    }

    watchRecursive(dir || '.', {
        persistent : opts.hasOwnProperty('persistent') ?
            opts.persistent :
            true
    }, function(event, filename, pathname) {
        var ignored = opts.ignored || [];
        var extension;
        if (!filename) {
            // happens on adds and deletes - no filename provided
            return;
        }

        if (getAndSetFiredRecently(pathname)) return;

        extension = pathname.split('.').pop();
        console.log(pathname + ' changed.');

        if(ignored.indexOf(extension) !== -1) {
            console.log(filename + " ignored.");
            return;
        }

        fs.stat(pathname, function(err, stat) {
            if (err) throw err;

            if (stat.isDirectory()) {
                handleDirectoryChange(pathname);
            } else {
                ftpQueue.addFile(pathname);
            }
        });
    }, cb || function() {});
};
module.exports.exampleOpts = {
    dir : '.',
    remoteDir : '/',
    filter : null,
    persistent : true,
    ignored: ["tmp"],
    connect : {
        host : 'remote.com',
        port : '1337',
        secure : true,
        user : 'name',
        password : 'god'
    }
};

var ftp = require('ftp');
var fs = require('fs');
var path = require('path');

function createFtpQueue(opts) {

    var client;

    var current;
    var queue = [];

    function isBusy() { return current; }

    function initClient(cb) {
        client = new ftp();
        client.on('ready', cb);
        client.connect(opts.connect);
    }

    function doSend(filename) {
        current = filename;
        if (!client) {
            initClient(doSend.bind(null, filename));
            return;
        }
        var remoteName = path.join(opts.remoteDir, path.relative(opts.dir, filename)).replace(/\\/g, '/');
        console.log("Uploading " + filename + " as " + remoteName + ".");
        client.put(filename, remoteName, function(err) {
            if (err) throw err;

            console.log(filename + ' uploaded.')

            current = null;
            if (queue.length) {
                doSend(queue.shift());
            }
        });
    }

    return {
        sendFile : function(filename) {
            if (isBusy()) {
                queue.push(filename);
                return;
            }
            doSend(filename);
        }
    };
}

module.exports = function(opts) {
    var filter = opts.filter;

    var ftpQueue = createFtpQueue(opts);

    fs.watch(opts.dir || '.', {
        persistent : opts.hasOwnProperty('persistent') ?
            opts.persistent :
            true
    }, function(event, filename) {
        if (!filename) {
            console.error("Couldn't upload file. NodeJS can't determine " +
                "the changed filename on your OS.");
            return;
        }

        var fullname = path.normalize(path.resolve(opts.dir, filename));

        console.log(fullname + ' changed.');

        ftpQueue.sendFile(fullname);
    });
};
module.exports.exampleOpts = {
    dir : '.',
    remoteDir : '/',
    filter : null,
    persistent : true,
    connect : {
        host : 'remote.com',
        port : '1337',
        secure : true,
        user : 'name',
        password : 'god'
    }
};
